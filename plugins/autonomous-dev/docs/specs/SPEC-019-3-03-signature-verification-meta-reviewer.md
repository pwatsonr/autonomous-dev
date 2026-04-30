# SPEC-019-3-03: Ed25519 Signature Verification & Agent-Meta-Reviewer Trigger

## Metadata
- **Parent Plan**: PLAN-019-3
- **Tasks Covered**: Task 6 (signature verification), Task 7 (agent-meta-reviewer trigger)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-3-03-signature-verification-meta-reviewer.md`

## Description
Deliver the two security-critical components of the trust pipeline: (1) Ed25519 signature verification using Node's built-in `crypto.verify()` against trusted public keys in `~/.claude/trusted-keys/`, and (2) the `agent-meta-reviewer` trigger that auto-invokes a security review for high-privilege plugins per TDD-019 §10.3. Both replace stubs from earlier specs: the `verifySignature` stub from SPEC-019-3-02 is replaced by a call to a new `SignatureVerifier` class; the `stepMetaReviewerAudit` stub from SPEC-019-3-01 is replaced by a real implementation that evaluates six trigger conditions, invokes the meta-reviewer agent when matched, and gates registration on the verdict.

The meta-review verdict is cached at `~/.autonomous-dev/meta-review-cache/<plugin-id>-<version>.json` so that re-discovery of the same plugin version does not re-trigger the agent. Cache invalidation is automatic: any version bump in the manifest forces re-review.

This spec is security-critical. The acceptance criteria include adversarial fixtures (corrupted signatures, wrong-key signatures, key removed mid-verification). Use Node's built-in crypto only — no third-party libraries.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/signature-verifier.ts` | Create | `SignatureVerifier` class with `verify(manifestPath, sigPath)` |
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Modify | Replace `verifySignature` stub; implement `stepMetaReviewerAudit` |
| `plugins/autonomous-dev/src/hooks/meta-review-cache.ts` | Create | File-backed cache for verdicts |
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Modify | Add `evaluateMetaReviewTriggers(manifest)` private helper |
| `plugins/autonomous-dev/tests/fixtures/keys/` | Create | Fixture key pairs (gen via openssl), see Notes |
| `plugins/autonomous-dev/tests/fixtures/manifests/signed/` | Create | Signed fixture manifests for tests |

## Implementation Details

### `SignatureVerifier` Class

```ts
// src/hooks/signature-verifier.ts
import { verify, createPublicKey } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export class SignatureVerifier {
  constructor(private readonly trustedKeysDir: string) {}

  /**
   * Verifies the detached signature for a manifest file.
   * @returns true iff the signature was produced by a trusted key over the manifest bytes.
   */
  async verify(manifestPath: string, signaturePath: string): Promise<boolean> {
    let manifestBytes: Buffer, sigBytes: Buffer;
    try {
      [manifestBytes, sigBytes] = await Promise.all([
        fs.readFile(manifestPath),
        fs.readFile(signaturePath),
      ]);
    } catch {
      return false; // missing manifest or signature file
    }

    const keyFiles = await this.listTrustedKeys();
    if (keyFiles.length === 0) return false;

    for (const keyPath of keyFiles) {
      try {
        const pem = await fs.readFile(keyPath);
        const publicKey = createPublicKey({ key: pem, format: 'pem' });
        // Ed25519: verify(null, data, key, signature). RSA-PSS: verify('sha256', ...).
        const algo = publicKey.asymmetricKeyType === 'ed25519' ? null : 'sha256';
        if (verify(algo, manifestBytes, publicKey, sigBytes)) return true;
      } catch {
        continue; // bad key file; try next
      }
    }
    return false;
  }

  private async listTrustedKeys(): Promise<string[]> {
    try {
      await this.assertSafePerms();
      const entries = await fs.readdir(this.trustedKeysDir);
      return entries.filter(e => e.endsWith('.pub')).map(e => join(this.trustedKeysDir, e));
    } catch {
      return [];
    }
  }

  private async assertSafePerms(): Promise<void> {
    const stat = await fs.stat(this.trustedKeysDir);
    // Refuse if world- or group-writable: bits 0o022.
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`trusted-keys directory has unsafe permissions: ${this.trustedKeysDir}`);
    }
  }
}
```

### `verifySignature` Replacement in `TrustValidator`

```ts
// src/hooks/trust-validator.ts (replace stub from SPEC-019-3-02)
protected async verifySignature(manifest: HookManifest, manifestPath: string): Promise<boolean> {
  const sigPath = `${manifestPath}.sig`;
  return this.signatureVerifier.verify(manifestPath, sigPath);
}
```

The `SignatureVerifier` is injected via the constructor (extend the constructor signature added in SPEC-019-3-01).

### Meta-Review Trigger Conditions

A plugin triggers `agent-meta-reviewer` if it matches ANY of:

1. Declares a reviewer slot of `code-review` or `security-review`.
2. Declares `filesystem-write` capability targeting any path NOT under `/tmp/`.
3. Declares `network` capability.
4. Declares `privileged-env` capability.
5. Declares `allow_child_processes: true` in any hook descriptor.
6. Declares `failure_mode: "block"` on a critical hook point (defined in TDD-019 §6 — `pre-tool-use`, `pre-commit`, `pre-push`).

```ts
private evaluateMetaReviewTriggers(manifest: HookManifest): { triggered: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const slots = manifest.reviewer_slots ?? [];
  if (slots.some(s => s === 'code-review' || s === 'security-review')) reasons.push('privileged reviewer slot');

  const caps = manifest.capabilities ?? [];
  if (caps.includes('network')) reasons.push('network capability');
  if (caps.includes('privileged-env')) reasons.push('privileged-env capability');

  const fsWrites = manifest.filesystem_write_paths ?? [];
  if (fsWrites.some(p => !p.startsWith('/tmp/'))) reasons.push('filesystem-write outside /tmp');

  const hooks = manifest.hooks ?? [];
  if (hooks.some(h => h.allow_child_processes === true)) reasons.push('allow_child_processes');
  const CRITICAL = new Set(['pre-tool-use', 'pre-commit', 'pre-push']);
  if (hooks.some(h => h.failure_mode === 'block' && CRITICAL.has(h.hook_point))) {
    reasons.push('failure_mode=block on critical hook');
  }

  return { triggered: reasons.length > 0, reasons };
}
```

### `stepMetaReviewerAudit` Implementation

```ts
private async stepMetaReviewerAudit(manifest: HookManifest): Promise<TrustVerdict> {
  const { triggered, reasons } = this.evaluateMetaReviewTriggers(manifest);
  if (!triggered) return { trusted: true, requiresMetaReview: false };

  const cached = await this.metaReviewCache.get(manifest.id, manifest.version);
  if (cached) {
    return cached.pass
      ? { trusted: true, requiresMetaReview: true, metaReviewVerdict: cached }
      : { trusted: false, reason: `meta-review FAIL (cached): ${cached.findings.join('; ')}`, requiresMetaReview: true, metaReviewVerdict: cached };
  }

  const verdict = await this.invokeMetaReviewer(manifest, reasons);
  await this.metaReviewCache.set(manifest.id, manifest.version, verdict);
  return verdict.pass
    ? { trusted: true, requiresMetaReview: true, metaReviewVerdict: verdict }
    : { trusted: false, reason: `meta-review FAIL: ${verdict.findings.join('; ')}`, requiresMetaReview: true, metaReviewVerdict: verdict };
}

private async invokeMetaReviewer(manifest: HookManifest, triggerReasons: string[]) {
  // Delegates to existing agent-spawn helper from PLAN-005 / agent registry.
  // The helper invokes the `agent-meta-reviewer` agent with manifest + reasons as input;
  // returns { pass: boolean, findings: string[] }.
  return this.agentSpawner.invoke('agent-meta-reviewer', { manifest, triggerReasons });
}
```

### Meta-Review Cache

```ts
// src/hooks/meta-review-cache.ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface MetaReviewVerdict { pass: boolean; findings: string[]; reviewedAt: string; }

export class MetaReviewCache {
  constructor(private readonly cacheDir: string) {}

  private path(id: string, version: string): string {
    return join(this.cacheDir, `${id}-${version}.json`);
  }

  async get(id: string, version: string): Promise<MetaReviewVerdict | null> {
    try { return JSON.parse(await fs.readFile(this.path(id, version), 'utf8')); }
    catch { return null; }
  }

  async set(id: string, version: string, verdict: { pass: boolean; findings: string[] }): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const entry: MetaReviewVerdict = { ...verdict, reviewedAt: new Date().toISOString() };
    const tmp = `${this.path(id, version)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2));
    await fs.rename(tmp, this.path(id, version));
  }
}
```

Cache directory: `~/.autonomous-dev/meta-review-cache/`.

## Acceptance Criteria

### Signature Verification
- [ ] A manifest signed with an Ed25519 key whose `.pub` lives in `trusted-keys/` verifies (`verify()` returns true).
- [ ] A manifest signed with a key NOT in `trusted-keys/` fails (`verify()` returns false).
- [ ] A manifest with a corrupted signature byte (single-byte flip) fails.
- [ ] A manifest with the `.sig` file deleted between read and verify fails (no exception thrown).
- [ ] A trusted-keys directory with mode 0o777 (world-writable) causes `verify()` to return false (and the daemon logs an error per Notes).
- [ ] An RSA-PSS public key (PEM, `id-RSASSA-PSS`) is supported as a fallback alongside Ed25519.
- [ ] Tests use fixture key pairs generated via `openssl genpkey -algorithm ed25519`; both keys and signed manifests are committed to `tests/fixtures/`.
- [ ] No third-party crypto library is added; `package.json` shows only Node built-ins for crypto.

### Meta-Review Trigger Truth Table
- [ ] Plugin with `capabilities: []`, `reviewer_slots: []`, no fs-write outside `/tmp`, no `allow_child_processes`, no `failure_mode: block`: `evaluateMetaReviewTriggers` returns `{ triggered: false, reasons: [] }`.
- [ ] Plugin with `capabilities: ['network']`: triggered, reason includes `'network capability'`.
- [ ] Plugin with `reviewer_slots: ['code-review']`: triggered.
- [ ] Plugin with `reviewer_slots: ['security-review']`: triggered.
- [ ] Plugin with `filesystem_write_paths: ['/tmp/foo']`: NOT triggered.
- [ ] Plugin with `filesystem_write_paths: ['/var/log/foo']`: triggered.
- [ ] Plugin with a hook descriptor `allow_child_processes: true`: triggered.
- [ ] Plugin with `failure_mode: 'block'` on `pre-commit`: triggered.
- [ ] Plugin with `failure_mode: 'block'` on a non-critical hook (e.g. `post-tool-use`): NOT triggered.
- [ ] All six trigger conditions tested independently and in combinations.

### Meta-Reviewer Invocation
- [ ] When triggered, `invokeMetaReviewer` is called with `(manifest, triggerReasons)`. PASS verdict yields `{ trusted: true, requiresMetaReview: true, metaReviewVerdict: { pass: true, findings: [...] } }`.
- [ ] FAIL verdict yields `{ trusted: false, reason: 'meta-review FAIL: <findings>', ... }`.
- [ ] Meta-reviewer is mocked in unit tests via injected `agentSpawner`. No real agent is invoked.

### Cache
- [ ] On first invocation, the meta-reviewer is called and the verdict is written to `~/.autonomous-dev/meta-review-cache/<id>-<version>.json`.
- [ ] On second invocation with the same id+version, the meta-reviewer is NOT called; the cached verdict is returned (verified via call-count assertion on the spy).
- [ ] On invocation with a bumped version, the meta-reviewer IS called again.
- [ ] Cache writes are atomic (temp file + rename).

### Performance
- [ ] Signature verification of a 4 KB manifest completes in <5ms (Ed25519); benchmark logged in test output.
- [ ] Meta-review trigger evaluation completes in <1ms per plugin.

## Dependencies

- **SPEC-019-3-01, SPEC-019-3-02** (blocking): provide the validator skeleton, mode logic, and stub interfaces being replaced.
- TDD-005 / PLAN-005-X agent-spawn helper (`agentSpawner`): consumed to invoke `agent-meta-reviewer`. Inject as constructor dependency.
- Node ≥ 18 for built-in Ed25519 in `crypto.verify`/`crypto.createPublicKey`.
- No new npm packages.

## Notes

- **Security**: `crypto.verify()` is used in single-shot mode (entire manifest in memory). For Ed25519 the `algorithm` parameter MUST be `null`; passing a string for Ed25519 throws `ERR_CRYPTO_INVALID_DIGEST`. Document this in code comments.
- **Adversarial fixtures**: the test suite must include a "corrupted signature" fixture (one byte flipped from a valid signature) and a "wrong key" fixture (signed by a key whose `.pub` is NOT in `trusted-keys/`). Both must fail. Auto-generate these in test setup so they cannot drift.
- **Permission check**: when the trusted-keys dir is unsafe, `verify()` returns false and the daemon logs an `ERROR` audit entry. The daemon's startup check (defined in 019-3-04) refuses to start in this case; this verifier returns false defensively in case the dir is mutated mid-run.
- **Cache invalidation**: cache key is `<id>-<version>`. The version field comes from the manifest, so any operator-driven manifest update bumps the cache. There is no TTL — security verdicts are deterministic functions of the manifest.
- **Critical hooks list** (`pre-tool-use`, `pre-commit`, `pre-push`) is mirrored from TDD-019 §6. If TDD-019 changes this list, update the constant in `evaluateMetaReviewTriggers`.
- **Privileged-reviewers does NOT skip meta-review** (per PLAN-019-3 risks): even a manually-trusted privileged plugin in strict mode must pass meta-review. The two checks are independent and both must pass. Document this in JSDoc on `stepMetaReviewerAudit` and `stepCapabilityValidation`.
- **Fixture key generation** (one-time, committed): `openssl genpkey -algorithm ed25519 -out tests/fixtures/keys/test-ed25519.key && openssl pkey -in test-ed25519.key -pubout -out test-ed25519.pub`. Document the regeneration procedure in `tests/fixtures/keys/README.md`.
- The cache file format is JSON for human inspectability; operators can `cat` a cache entry to see exactly what verdict the meta-reviewer returned.
