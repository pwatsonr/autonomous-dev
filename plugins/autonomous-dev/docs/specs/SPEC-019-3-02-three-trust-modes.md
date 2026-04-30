# SPEC-019-3-02: Three Trust Modes — Allowlist, Permissive, Strict

## Metadata
- **Parent Plan**: PLAN-019-3
- **Tasks Covered**: Task 3 (allowlist mode), Task 4 (permissive mode), Task 5 (strict mode)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-3-02-three-trust-modes.md`

## Description
Implement the per-mode logic of `TrustValidator.stepTrustStatus()` (and, for strict mode, the privileged-reviewer arm of `stepCapabilityValidation()`) per TDD-019 §10.1. The seven-step skeleton from SPEC-019-3-01 invokes these step methods; this spec replaces the stubbed `stepTrustStatus` with a switch over `config.trust_mode` that dispatches to one of three private helpers (`checkAllowlistMode`, `checkPermissiveMode`, `checkStrictMode`) and updates `stepCapabilityValidation` to enforce the privileged-reviewer allowlist when in strict mode.

Signature verification itself is implemented in SPEC-019-3-03; this spec calls a stub `verifySignature()` method that returns true if signature verification is disabled or a fixture-injected stub returns true. The truth-table tests run against the stub; once 019-3-03 lands the real verifier replaces the stub without contract changes.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Modify | Implement `stepTrustStatus`, three mode helpers, strict-mode privileged-reviewer arm |
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Modify | Add `verifySignature()` stub method (replaced by 019-3-03) |

## Implementation Details

### `stepTrustStatus` Dispatch

```ts
private async stepTrustStatus(manifest: HookManifest, manifestPath: string): Promise<TrustVerdict> {
  switch (this.config.trust_mode) {
    case 'allowlist':  return this.checkAllowlistMode(manifest);
    case 'permissive': return this.checkPermissiveMode(manifest, manifestPath);
    case 'strict':     return this.checkStrictMode(manifest, manifestPath);
    default: {
      const exhaustive: never = this.config.trust_mode;
      return { trusted: false, reason: `unknown trust_mode: ${String(exhaustive)}`, requiresMetaReview: false };
    }
  }
}
```

### Allowlist Mode

```ts
private checkAllowlistMode(manifest: HookManifest): TrustVerdict {
  if (!this.config.allowlist.includes(manifest.id)) {
    return { trusted: false, reason: 'not in allowlist', requiresMetaReview: false };
  }
  return { trusted: true, requiresMetaReview: false };
}
```

Behavior:
- Plugin id present in `extensions.allowlist` → trusted.
- Plugin id absent → rejected with reason `"not in allowlist"`.
- Empty allowlist rejects everything.
- Signature is NOT consulted in pure allowlist mode (the operator's manual trust decision is sufficient).

### Permissive Mode

```ts
private async checkPermissiveMode(manifest: HookManifest, manifestPath: string): Promise<TrustVerdict> {
  if (!this.config.signature_verification) {
    return { trusted: true, requiresMetaReview: false };
  }
  const signed = await this.verifySignature(manifest, manifestPath);
  if (!signed) {
    return { trusted: false, reason: 'permissive mode requires valid signature; none found or invalid', requiresMetaReview: false };
  }
  return { trusted: true, requiresMetaReview: false };
}
```

Behavior:
- `signature_verification: false` → all plugins trusted regardless of signature or allowlist (advisory mode).
- `signature_verification: true` → signed plugins (any key in `~/.claude/trusted-keys/`) are trusted; unsigned/invalid-signature plugins are rejected.
- Allowlist is advisory: a signed plugin not on the allowlist is still trusted in permissive mode.

### Strict Mode

```ts
private async checkStrictMode(manifest: HookManifest, manifestPath: string): Promise<TrustVerdict> {
  if (!this.config.allowlist.includes(manifest.id)) {
    return { trusted: false, reason: 'strict mode: plugin not in allowlist', requiresMetaReview: false };
  }
  const signed = await this.verifySignature(manifest, manifestPath);
  if (!signed) {
    return { trusted: false, reason: 'strict mode: missing or invalid signature', requiresMetaReview: false };
  }
  // Privileged-reviewer check happens in stepCapabilityValidation; tracked via flag.
  return { trusted: true, requiresMetaReview: false };
}
```

Behavior:
- Plugin must be on `extensions.allowlist` AND have a valid signature.
- If the plugin registers a `code-review` or `security-review` reviewer slot (checked in `stepCapabilityValidation`), the id must additionally be on `extensions.privileged_reviewers`.
- Failure of any check rejects with a specific reason string.

### `stepCapabilityValidation` — Privileged Reviewer Arm

```ts
private async stepCapabilityValidation(manifest: HookManifest): Promise<TrustVerdict> {
  if (this.config.trust_mode === 'strict') {
    const reviewerSlots = (manifest.reviewer_slots ?? []);
    const declaresPrivilegedReview = reviewerSlots.some(s => s === 'code-review' || s === 'security-review');
    if (declaresPrivilegedReview && !this.config.privileged_reviewers.includes(manifest.id)) {
      return { trusted: false, reason: 'strict mode: privileged reviewer not in privileged_reviewers list', requiresMetaReview: false };
    }
  }
  return { trusted: true, requiresMetaReview: false };
}
```

Note: in `allowlist` and `permissive` modes, privileged-reviewer membership is not enforced at trust check; the meta-review trigger (SPEC-019-3-03) is the gate for those modes.

### `verifySignature` Stub

Until SPEC-019-3-03 lands the real verifier, this method is a stub that delegates to an injectable function for testability:

```ts
protected async verifySignature(manifest: HookManifest, manifestPath: string): Promise<boolean> {
  // Replaced by SPEC-019-3-03 with real Ed25519 verification.
  return false; // safe default: no signature trusted by default
}
```

Tests in this spec inject a subclass overriding `verifySignature` to simulate signed/unsigned/invalid scenarios.

## Acceptance Criteria

### Allowlist Mode
- [ ] With `trust_mode: 'allowlist'`, `allowlist: ['com.acme.foo']`: `com.acme.foo` returns `{ trusted: true }`; `com.acme.bar` returns `{ trusted: false, reason: 'not in allowlist' }`.
- [ ] With `allowlist: []`: any plugin returns `{ trusted: false, reason: 'not in allowlist' }`.
- [ ] Allowlist mode does NOT call `verifySignature` (verified via spy).

### Permissive Mode
- [ ] With `trust_mode: 'permissive'`, `signature_verification: false`: any plugin (signed or unsigned) returns `{ trusted: true }`.
- [ ] With `trust_mode: 'permissive'`, `signature_verification: true`: signed plugin not on allowlist returns `{ trusted: true }`.
- [ ] With `trust_mode: 'permissive'`, `signature_verification: true`: unsigned plugin returns `{ trusted: false, reason: 'permissive mode requires valid signature; none found or invalid' }`.

### Strict Mode
- [ ] With `trust_mode: 'strict'`, allowlisted + signed plugin returns `{ trusted: true }`.
- [ ] Allowlisted but unsigned: `{ trusted: false, reason: 'strict mode: missing or invalid signature' }`.
- [ ] Signed but not allowlisted: `{ trusted: false, reason: 'strict mode: plugin not in allowlist' }`.
- [ ] Plugin with `reviewer_slots: ['code-review']`, allowlisted, signed, but not in `privileged_reviewers`: returns `{ trusted: false, reason: 'strict mode: privileged reviewer not in privileged_reviewers list' }`.
- [ ] Same plugin with id added to `privileged_reviewers`: returns `{ trusted: true }`.

### Truth Table Coverage
- [ ] A unit test enumerates the full truth table: 3 modes × {allowlisted, not} × {signed, unsigned, no-verify} × {privileged-slot, not} = 36 cases minimum. Each row asserts the exact reason string.
- [ ] Unknown trust mode (programmatic injection) returns `{ trusted: false, reason: 'unknown trust_mode: <value>' }` with TypeScript exhaustiveness check intact.
- [ ] All tests run in <2s.

## Dependencies

- **SPEC-019-3-01** (blocking): provides `TrustValidator` skeleton, `ExtensionsConfig`, `TrustVerdict`, `TrustMode` types.
- `HookManifest.reviewer_slots` field (defined by PLAN-019-1 / 019-2): consumed by strict-mode privileged-reviewer check.
- No new npm dependencies.

## Notes

- The exact reason strings are part of the contract — the audit log (SPEC-019-3-04) and the operator-facing error messages parse them. Do NOT change them without coordination.
- `verifySignature` is intentionally left as a stub returning `false` so that any premature use in non-permissive paths fails closed. The stub does not break allowlist mode (which never calls it) or permissive-no-verify (which short-circuits before it).
- The truth-table test is the most important deliverable here; it locks in the cross-mode behavior that the rest of the system depends on. Treat any added trust mode as a schema-breaking change.
- Strict mode's two-arm check (allowlist+signature in `stepTrustStatus`, privileged-reviewers in `stepCapabilityValidation`) intentionally splits the rejection across steps so the audit log (in SPEC-019-3-04) can attribute each rejection to its proper validation step.
- A subclass-with-overridden-verifier pattern is used for testing today; once 019-3-03 lands, the real verifier replaces the stub and tests inject a fixture key directory instead of a method override.
