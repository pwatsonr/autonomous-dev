# SPEC-022-3-02: HMAC + Ed25519 Artifact Signing & Sanitization

## Metadata
- **Parent Plan**: PLAN-022-3
- **Tasks Covered**: Task 3 (HMAC artifact signing), Task 4 (Ed25519 signing for privileged chains), Task 5 (sanitization at the artifact-content level)
- **Estimated effort**: 11 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-3-02-artifact-signing-sanitization.md`

## Description
Add cryptographic integrity, optional plugin authenticity, and content-level sanitization to chain artifacts. Every artifact persisted via `ArtifactRegistry.persist()` is signed with HMAC-SHA256 over its canonical JSON; consumers verify the HMAC before parsing. When BOTH the producer and consumer are listed in `extensions.privileged_chains[]`, the producer additionally signs the artifact with its plugin Ed25519 key (PLAN-019-3 trusted-keys), giving consumers cryptographic proof of the producer's identity. After signature verification and schema validation, every string field undergoes a sanitization pass that rejects path traversal, non-https URIs, and shell metacharacters in fields not declared as `format: shell-command`.

This spec composes with SPEC-022-3-01: the read() pipeline becomes capability-check → load → HMAC verify → (privileged) Ed25519 verify → strict-schema validate → sanitize. Each layer has its own error class so callers can distinguish between integrity, authenticity, and content-policy failures.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/chains/artifact-registry.ts` | Modify | Add HMAC sign on persist; add HMAC + Ed25519 verify on read; call sanitizer post-validate |
| `plugins/autonomous-dev/src/chains/sanitizer.ts` | Create | `sanitizeArtifact(artifactType, payload, schema)` with path/URI/shell rules |
| `plugins/autonomous-dev/src/chains/canonical-json.ts` | Create | Deterministic JSON serialization for HMAC input |
| `plugins/autonomous-dev/src/chains/chain-key.ts` | Create | `CHAIN_HMAC_KEY` resolution: env → keychain → first-run generation |
| `plugins/autonomous-dev/src/hooks/signature-verifier.ts` | Modify | Add `verifyArtifact(payload, signature, publicKey): boolean` |
| `plugins/autonomous-dev/src/chains/types.ts` | Modify | Add `ArtifactTamperedError`, `ArtifactUnsignedError`, `SanitizationError`, `PrivilegedSignatureError` |
| `plugins/autonomous-dev/tests/chains/test-artifact-signing.test.ts` | Create | Unit tests for HMAC + Ed25519 signing/verification |
| `plugins/autonomous-dev/tests/chains/test-sanitizer.test.ts` | Create | Unit tests for each sanitization rule |
| `plugins/autonomous-dev/tests/chains/fixtures/keys/` | Create | Test Ed25519 keypairs for privileged-chain tests |

## Implementation Details

### Artifact On-Disk Shape

```json
{
  "artifact_type": "security-findings",
  "schema_version": "1.0",
  "producer_plugin_id": "rule-set-enforcement",
  "produced_at": "2026-04-29T12:00:00Z",
  "payload": { "...": "..." },
  "_chain_hmac": "<base64 hmac-sha256 of canonical JSON of all fields above>",
  "_chain_signature": "<base64 ed25519 signature; present only for privileged chains>"
}
```

### HMAC Signing (`persist()` extension)

```typescript
async persist(artifact: RawArtifact, producerCtx: ProducerContext): Promise<ArtifactId> {
  const envelope = {
    artifact_type: artifact.artifact_type,
    schema_version: artifact.schema_version,
    producer_plugin_id: producerCtx.pluginId,
    produced_at: new Date().toISOString(),
    payload: artifact.payload,
  };
  const canonical = canonicalJSON(envelope);
  const hmac = createHmac('sha256', getChainHmacKey()).update(canonical).digest('base64');

  let signature: string | undefined;
  if (this.isPrivilegedChain(producerCtx.chainId, producerCtx.pluginId)) {
    signature = signEd25519(canonical, producerCtx.pluginId);  // throws if no signing key
  }

  const final = { ...envelope, _chain_hmac: hmac, ...(signature ? { _chain_signature: signature } : {}) };
  return await this.write(final);
}
```

### HMAC Verification (`read()` extension; runs BEFORE schema validation)

```typescript
const raw = await this.load(artifactType, artifactId);  // existing
if (!raw._chain_hmac) throw new ArtifactUnsignedError(artifactType, artifactId);
const { _chain_hmac, _chain_signature, ...envelope } = raw;
const expected = createHmac('sha256', getChainHmacKey()).update(canonicalJSON(envelope)).digest('base64');
if (!timingSafeEqual(Buffer.from(_chain_hmac, 'base64'), Buffer.from(expected, 'base64'))) {
  throw new ArtifactTamperedError(artifactType, artifactId);
}
```

### Ed25519 Verification (privileged chains only)

After HMAC passes, if `this.isPrivilegedChain(consumerCtx.chainId, raw.producer_plugin_id)`:

```typescript
if (!_chain_signature) throw new PrivilegedSignatureError(artifactType, artifactId, 'missing');
const publicKey = trustedKeys.lookup(raw.producer_plugin_id);
if (!publicKey) throw new PrivilegedSignatureError(artifactType, artifactId, 'unknown_producer');
if (!signatureVerifier.verifyArtifact(canonicalJSON(envelope), _chain_signature, publicKey)) {
  throw new PrivilegedSignatureError(artifactType, artifactId, 'invalid');
}
```

For non-privileged chains, `_chain_signature` is ignored (presence is fine; absence is fine).

### Canonical JSON (`canonical-json.ts`)

Deterministic serialization required so the HMAC is reproducible across producer and consumer:
- Object keys sorted lexicographically at every nesting level.
- No whitespace.
- Strings JSON-escaped per RFC 8259.
- Numbers serialized via `JSON.stringify` (no normalization beyond JS defaults).
- Arrays preserve insertion order.
- Throws `TypeError` on non-serializable input (functions, symbols, undefined values).

Implementation may delegate to `safe-stable-stringify` if it is already a transitive dep; otherwise hand-roll a ~30-line recursive function. Add a unit test: `canonicalJSON({b:1, a:{c:2, b:1}}) === '{"a":{"b":1,"c":2},"b":1}'`.

### Chain HMAC Key Resolution (`chain-key.ts`)

Order of resolution (cached after first call):
1. `process.env.CHAIN_HMAC_KEY` (base64-encoded 32 bytes) — primary.
2. `~/.autonomous-dev/chain-hmac.key` (base64, file mode 0600) — generated on first run if not present.
3. Falls back to NEW key generation: 32 random bytes via `crypto.randomBytes(32)`, write to file with mode 0600, log a CRITICAL warning ("CHAIN_HMAC_KEY generated; existing artifacts will be unverifiable. Set CHAIN_HMAC_KEY env var to suppress.").

Return type: `Buffer`.

### Sanitizer (`sanitizer.ts`)

```typescript
export function sanitizeArtifact(
  artifactType: string,
  payload: Record<string, unknown>,
  schema: object,            // the JSON Schema used for validation
  worktreePath: string,      // request's worktree, for path containment checks
): void  // throws SanitizationError on violation; mutates nothing
```

Walk the payload, cross-referencing field paths against schema `format` declarations:

| Schema `format` | Validation rule |
|----------------|-----------------|
| `path` | Must NOT contain `..`. If absolute, must be inside `worktreePath`. Reject empty string. |
| `uri` | Must start with `https://`. (Reject `http://`, `file://`, `javascript:`, `data:`, `ftp://`, etc.) |
| `shell-command` | No restrictions on metacharacters (this format opts the field IN to permissive content). |
| (none) on string field | Reject any of: `;`, `|`, `&`, `` ` ``, `$(`, `${`, `>`, `<` (newline-separated literals). |

Recursion: descend into nested objects and arrays; resolve schema for each subschema using JSON Pointer-style traversal of `properties` and `items`. If schema for a path is unknown, fall back to "no format" rules (default-deny).

On first violation, throw:

```typescript
export class SanitizationError extends Error {
  readonly code = 'SANITIZATION_FAILED';
  constructor(
    public artifactType: string,
    public fieldPath: string,
    public rule: 'path-traversal' | 'absolute-path-outside-worktree' | 'non-https-uri' | 'shell-metacharacter',
    public offendingValue: string,
  ) {
    super(`Artifact ${artifactType} field '${fieldPath}' violated ${rule}: ${truncate(offendingValue, 80)}`);
  }
}
```

### Updated `read()` Pipeline (composition with SPEC-022-3-01)

```
1. Capability check (SPEC-022-3-01)
2. Load raw artifact from disk
3. HMAC verify (this spec) — throws ArtifactUnsignedError | ArtifactTamperedError
4. Ed25519 verify if privileged (this spec) — throws PrivilegedSignatureError
5. Strict-schema validate (SPEC-022-3-01) — throws SchemaValidationError
6. Sanitize (this spec) — throws SanitizationError
7. Return ValidatedArtifact
```

### `signature-verifier.ts` Extension

```typescript
verifyArtifact(canonicalPayload: string, base64Signature: string, publicKeyPem: string): boolean
```

Reuses existing Ed25519 plumbing from PLAN-019-3 (the same code that verifies plugin manifests). Returns boolean; logs verification failures at DEBUG only.

## Acceptance Criteria

### HMAC Signing (Task 3)

- [ ] `persist()` writes `_chain_hmac` field on every artifact; HMAC is base64-encoded SHA-256 over canonical JSON of envelope (excluding the hmac field itself).
- [ ] Two producers persisting the same payload produce IDENTICAL `_chain_hmac` (verifies canonical JSON is deterministic).
- [ ] `read()` of an artifact with no `_chain_hmac` throws `ArtifactUnsignedError`.
- [ ] `read()` of an artifact with mutated `payload` throws `ArtifactTamperedError`.
- [ ] `read()` of an artifact with mutated `_chain_hmac` (random bytes) throws `ArtifactTamperedError`.
- [ ] HMAC comparison uses `timingSafeEqual` (not `===`).
- [ ] First call to `getChainHmacKey()` with no env var and no key file generates a 32-byte random key, writes to `~/.autonomous-dev/chain-hmac.key` with mode 0600, and logs a CRITICAL warning.
- [ ] Subsequent calls return the cached key (no I/O); verified by spying on `fs.readFileSync`.

### Ed25519 Privileged Signing (Task 4)

- [ ] When chain is in `privileged_chains[]` AND producer is also in the allowlist, `persist()` adds `_chain_signature` to the artifact.
- [ ] When the chain is NOT privileged, `persist()` does NOT add `_chain_signature` (field absent, not null).
- [ ] `read()` from a privileged-chain context with valid signature succeeds.
- [ ] `read()` from a privileged-chain context with MISSING `_chain_signature` throws `PrivilegedSignatureError` with `reason === 'missing'`.
- [ ] `read()` from a privileged-chain context with TAMPERED signature throws `PrivilegedSignatureError` with `reason === 'invalid'`.
- [ ] `read()` from a privileged-chain context with signature from a producer NOT in trusted-keys throws `PrivilegedSignatureError` with `reason === 'unknown_producer'`.
- [ ] Non-privileged chains tolerate the presence of `_chain_signature` (ignored, no error).
- [ ] Ed25519 verification overhead < 2ms per `read()` (measured via `performance.now()` in a perf test).

### Sanitization (Task 5)

- [ ] Field with schema `format: 'path'` and value `'../../../etc/passwd'` → `SanitizationError` with `rule === 'path-traversal'`.
- [ ] Field with schema `format: 'path'` and value `'/etc/passwd'` (outside worktree) → `SanitizationError` with `rule === 'absolute-path-outside-worktree'`.
- [ ] Field with schema `format: 'path'` and value `'./src/foo.ts'` (inside worktree) → passes.
- [ ] Field with schema `format: 'uri'` and value `'http://example.com'` → `SanitizationError` with `rule === 'non-https-uri'`.
- [ ] Field with schema `format: 'uri'` and value `'javascript:alert(1)'` → `SanitizationError` with `rule === 'non-https-uri'`.
- [ ] Field with schema `format: 'uri'` and value `'https://example.com/x'` → passes.
- [ ] Field with NO format and value `'rm -rf /'` (contains `;` not in this case but test all metachars: `;`, `|`, `&`, `` ` ``, `$(`, `${`, `>`, `<`) → `SanitizationError` with `rule === 'shell-metacharacter'`.
- [ ] Field with schema `format: 'shell-command'` and value containing `;` and `|` → passes (opt-in).
- [ ] Sanitizer recurses into nested objects: payload `{a: {b: '../foo'}}` with schema declaring `a.b` as `format: 'path'` → rejected with `fieldPath === 'a.b'`.
- [ ] Sanitizer recurses into arrays: payload `{paths: ['ok', '../bad']}` with schema declaring `paths.items` as `format: 'path'` → rejected with `fieldPath === 'paths[1]'`.
- [ ] First violation short-circuits (does not continue scanning).

### Combined Pipeline

- [ ] In a single `read()` call, errors surface in the order: capability → unsigned → tampered → privileged → schema → sanitization. Verified by 6 ordered tests.
- [ ] HMAC verify happens BEFORE schema validation (verified by spy: schema validator not called when HMAC fails).
- [ ] Sanitizer runs AFTER schema validation (verified by spy: sanitizer not called when schema fails).
- [ ] Coverage on `sanitizer.ts` ≥ 95%; on `canonical-json.ts` ≥ 95%; on extended `artifact-registry.ts` ≥ 95%.

## Dependencies

- **Blocked by**: PLAN-022-1 (`ArtifactRegistry`, `persist()`/`read()` skeleton), PLAN-022-2 (`extensions.privileged_chains[]` allowlist on chain definitions), SPEC-022-3-01 (composition surface in `read()`).
- **Reuses**: PLAN-019-3 (`signature-verifier.ts`, `~/.claude/trusted-keys/`), PLAN-019-4 (`AUDIT_HMAC_KEY` resolution pattern is the model for `CHAIN_HMAC_KEY`).
- **Library**: Node `crypto` module (HMAC, Ed25519, randomBytes, timingSafeEqual). No new deps; `safe-stable-stringify` is optional (hand-roll if not already in tree).
- **Filesystem**: writes `~/.autonomous-dev/chain-hmac.key` (mode 0600) on first run if env var unset.

## Notes

- **Why HMAC AND Ed25519?** HMAC catches in-transit/at-rest tampering using a shared secret known to all chain participants on this machine. Ed25519 additionally proves WHICH plugin signed the artifact, defeating a hostile plugin that knows the HMAC key but doesn't have another plugin's signing key. Both are cheap; we use both for privileged chains. For non-privileged chains, HMAC alone suffices since all participants are equally trusted by the operator.
- **`timingSafeEqual` is mandatory.** Naive `===` on HMAC strings leaks bytes via timing, allowing a malicious producer to brute-force a forged HMAC over many runs. The Node API is purpose-built for this.
- **Canonical JSON is the contract.** Any divergence in serialization (key order, whitespace, escape sequences) breaks HMAC verification across processes. Both producer and consumer MUST go through `canonical-json.ts`.
- **Sanitizer is default-deny.** A field with no schema-declared format is treated as "must not contain shell metacharacters" — the safe default. Producers that legitimately need to emit such content (a code-fixer's patch payload, for example) declare `format: shell-command` on the relevant fields in their artifact schema.
- **Worktree containment** for `format: path` fields uses `path.resolve()` + prefix check against `worktreePath`. Symlinks pointing outside are NOT followed at this layer; that is a filesystem concern handled by sandboxing in PLAN-022-2.
- The `CHAIN_HMAC_KEY` first-run generation is loud (CRITICAL log) precisely because losing the previous key means existing artifacts become unverifiable. Operators are expected to set `CHAIN_HMAC_KEY` env var in production for stability across processes.
- Test fixtures under `tests/chains/fixtures/keys/` should include 2 Ed25519 keypairs (producer + an unrelated key for negative tests). Generate via `openssl genpkey -algorithm ED25519` and check in only the public keys; private keys live in test files as base64 constants (NOT a real secret).
- Audit emission of signature failures is added in SPEC-022-3-03 (this spec just throws; the executor that catches the error logs it).
