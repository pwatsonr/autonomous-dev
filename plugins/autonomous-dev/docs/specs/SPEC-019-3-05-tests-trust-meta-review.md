# SPEC-019-3-05: Unit & Integration Tests for Trust and Meta-Review

## Metadata
- **Parent Plan**: PLAN-019-3
- **Tasks Covered**: Task 11 (unit tests), Task 12 (integration test)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-3-05-tests-trust-meta-review.md`

## Description
Deliver the test suite that locks in the contracts established by SPEC-019-3-01 through SPEC-019-3-04. Five unit-test files cover the trust modes, signature verification, and meta-review trigger truth tables; one integration test exercises the full discovery → trust → meta-review → registration flow with three fixture plugins. The unit tests must achieve ≥95% coverage on `trust-validator.ts` and `signature-verifier.ts` and run in <10s total. The integration test runs the real daemon (with a mocked meta-reviewer agent) end-to-end against a fixture marketplace and asserts on registry state and audit log entries.

This spec creates no production code. All implementation is fixture and test code under `plugins/autonomous-dev/tests/`. The fixtures are committed (key pairs, signed manifests) so tests are deterministic and CI does not need to generate keys at runtime.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/hooks/test-trust-allowlist.test.ts` | Create | Allowlist-mode truth table |
| `plugins/autonomous-dev/tests/hooks/test-trust-permissive.test.ts` | Create | Permissive-mode truth table |
| `plugins/autonomous-dev/tests/hooks/test-trust-strict.test.ts` | Create | Strict-mode truth table (incl. privileged-reviewer arm) |
| `plugins/autonomous-dev/tests/hooks/test-signature.test.ts` | Create | Ed25519 + RSA-PSS verification, adversarial cases |
| `plugins/autonomous-dev/tests/hooks/test-meta-review-trigger.test.ts` | Create | Six trigger conditions, cache hit/miss |
| `plugins/autonomous-dev/tests/hooks/test-runtime-revocation.test.ts` | Create | Runtime trust enforcement |
| `plugins/autonomous-dev/tests/integration/test-plugin-trust-flow.test.ts` | Create | Full pipeline end-to-end |
| `plugins/autonomous-dev/tests/fixtures/keys/README.md` | Create | Key regeneration procedure |
| `plugins/autonomous-dev/tests/fixtures/plugins/benign/` | Create | Fixture: allowlisted, no triggers |
| `plugins/autonomous-dev/tests/fixtures/plugins/privileged/` | Create | Fixture: allowlisted, triggers meta-review |
| `plugins/autonomous-dev/tests/fixtures/plugins/untrusted/` | Create | Fixture: not allowlisted |
| `plugins/autonomous-dev/tests/helpers/config-mutator.ts` | Create | In-memory config mutation helper |
| `plugins/autonomous-dev/tests/helpers/agent-spawner-mock.ts` | Create | Mock `agentSpawner.invoke('agent-meta-reviewer', ...)` |

## Implementation Details

### Test Framework

Use the existing test runner (Vitest, per the autonomous-dev convention). All test files end in `.test.ts`. Each test file:
- Imports the system under test directly.
- Uses `beforeEach` to set up an isolated config object (no shared state across tests).
- Asserts on the verdict shape AND the exact reason string.

### `test-trust-allowlist.test.ts` (Sample Cases)

```ts
import { describe, it, expect } from 'vitest';
import { TrustValidator } from '../../src/hooks/trust-validator';
import { makeConfig, makeManifest, makeStubDeps } from '../helpers';

describe('TrustValidator: allowlist mode', () => {
  it('trusts a plugin on the allowlist', async () => {
    const v = new TrustValidator(makeConfig({ trust_mode: 'allowlist', allowlist: ['com.acme.foo'] }), ...makeStubDeps());
    const result = await v.validatePlugin(makeManifest({ id: 'com.acme.foo' }), '/fake/path');
    expect(result).toEqual({ trusted: true, requiresMetaReview: false });
  });

  it('rejects a plugin not on the allowlist', async () => {
    const v = new TrustValidator(makeConfig({ trust_mode: 'allowlist', allowlist: ['com.acme.foo'] }), ...makeStubDeps());
    const result = await v.validatePlugin(makeManifest({ id: 'com.acme.bar' }), '/fake/path');
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe('not in allowlist');
  });

  it('empty allowlist rejects everything', async () => {
    const v = new TrustValidator(makeConfig({ trust_mode: 'allowlist', allowlist: [] }), ...makeStubDeps());
    const result = await v.validatePlugin(makeManifest({ id: 'com.acme.foo' }), '/fake/path');
    expect(result.trusted).toBe(false);
  });

  it('does NOT call signature verifier in allowlist mode', async () => {
    const sigSpy = vi.fn();
    const v = new TrustValidator(makeConfig({ trust_mode: 'allowlist', allowlist: ['com.acme.foo'] }), { verify: sigSpy } as any, ...);
    await v.validatePlugin(makeManifest({ id: 'com.acme.foo' }), '/fake/path');
    expect(sigSpy).not.toHaveBeenCalled();
  });
});
```

### `test-trust-permissive.test.ts`

Cases covered:
- `signature_verification: false` → all plugins trusted.
- `signature_verification: true`, signed plugin not on allowlist → trusted.
- `signature_verification: true`, unsigned plugin → rejected with reason `'permissive mode requires valid signature; none found or invalid'`.
- Signed plugin: signature verifier called exactly once.

### `test-trust-strict.test.ts`

Cases covered (truth table — 16 rows minimum):
- {allowlisted, not} × {signed, unsigned} × {privileged-slot, not} × {in privileged_reviewers, not}
- Each row asserts the exact verdict and reason string.
- Verifies that the privileged-reviewer check fires only in strict mode (not in allowlist or permissive).

### `test-signature.test.ts`

Cases covered:
- Valid Ed25519 signature, key in trusted-keys → true.
- Valid RSA-PSS signature, key in trusted-keys → true.
- Wrong-key signature → false.
- Corrupted-byte signature → false.
- Missing `.sig` file → false (no exception).
- Empty trusted-keys directory → false.
- Trusted-keys dir with mode 0o777 → false (and verify logs an error).
- Performance: 1000 verifications complete in <5s (asserts ~5ms per Ed25519 verify).

Setup: tests load fixtures from `tests/fixtures/keys/` and `tests/fixtures/manifests/signed/`. Fixtures are committed; the README documents regeneration via `openssl genpkey -algorithm ed25519`.

### `test-meta-review-trigger.test.ts`

Cases covered (six triggers, plus negatives):
- Each of the six trigger conditions individually triggers `evaluateMetaReviewTriggers`.
- Plugin matching multiple triggers returns all reasons.
- Plugin matching none returns `{ triggered: false, reasons: [] }`.
- Cache hit: second `validatePlugin` for same id+version does NOT call `agentSpawner.invoke` (call-count assertion).
- Cache miss after version bump: `agentSpawner.invoke` called again.
- PASS verdict → trusted.
- FAIL verdict → rejected with reason `'meta-review FAIL: <findings>'`.

### `test-runtime-revocation.test.ts`

Cases covered:
- After `reloadTrustedSet()` with empty allowlist, `isTrusted('com.acme.foo')` returns false.
- Executor calls `isTrusted` before `invokeInSandbox`; if false, sandbox is NOT called.
- Executor emits `runtime-revoked` audit entry on revocation.
- Performance: `isTrusted` benchmark with 10,000 ids runs <2µs per call.

### Integration Test — `test-plugin-trust-flow.test.ts`

```ts
describe('Plugin trust flow: discovery → trust → meta-review → registration', () => {
  it('registers benign and privileged, rejects untrusted', async () => {
    const tmpDir = await setupFixtureMarketplace([
      'tests/fixtures/plugins/benign',     // allowlisted, no triggers
      'tests/fixtures/plugins/privileged', // allowlisted, triggers meta-review
      'tests/fixtures/plugins/untrusted',  // NOT allowlisted
    ]);
    const config = makeConfig({
      trust_mode: 'allowlist',
      allowlist: ['fixture.benign', 'fixture.privileged'],
      privileged_reviewers: ['fixture.privileged'], // n/a in allowlist mode but set for clarity
    });
    const agentSpawner = mockAgentSpawner({ verdict: { pass: true, findings: ['no issues'] } });
    const audit = new InMemoryAuditWriter();

    const daemon = await startDaemonWith({ config, marketplaceDir: tmpDir, agentSpawner, audit });

    expect(daemon.registry.has('fixture.benign')).toBe(true);
    expect(daemon.registry.has('fixture.privileged')).toBe(true);
    expect(daemon.registry.has('fixture.untrusted')).toBe(false);

    const entries = audit.entries('trust');
    expect(entries.find(e => e.pluginId === 'fixture.benign'      && e.decision === 'registered')).toBeDefined();
    expect(entries.find(e => e.pluginId === 'fixture.privileged'  && e.decision === 'registered')).toBeDefined();
    expect(entries.find(e => e.pluginId === 'fixture.privileged'  && e.decision === 'meta-review-verdict' && e.metaReviewVerdict?.pass)).toBeDefined();
    expect(entries.find(e => e.pluginId === 'fixture.untrusted'   && e.decision === 'rejected' && e.reason === 'not in allowlist')).toBeDefined();

    expect(agentSpawner.invokeCount).toBe(1); // only 'privileged' triggered meta-review
  });

  it('completes full pipeline in <100ms per plugin (excl meta-review network)', async () => {
    // Performance assertion as documented in PLAN-019-3 risks.
  });
});
```

### Fixture Plugin Manifests

`tests/fixtures/plugins/benign/hooks.json`:
```json
{
  "id": "fixture.benign",
  "version": "1.0.0",
  "hooks": [{ "hook_point": "post-tool-use", "command": "echo benign", "failure_mode": "warn" }],
  "capabilities": [],
  "reviewer_slots": []
}
```

`tests/fixtures/plugins/privileged/hooks.json`:
```json
{
  "id": "fixture.privileged",
  "version": "1.0.0",
  "hooks": [{ "hook_point": "pre-commit", "command": "echo review", "failure_mode": "block" }],
  "capabilities": ["network"],
  "reviewer_slots": ["code-review"]
}
```

`tests/fixtures/plugins/untrusted/hooks.json`:
```json
{
  "id": "fixture.untrusted",
  "version": "1.0.0",
  "hooks": [{ "hook_point": "post-tool-use", "command": "echo malice", "failure_mode": "warn" }],
  "capabilities": [],
  "reviewer_slots": []
}
```

## Acceptance Criteria

### Coverage and Performance
- [ ] All six unit test files pass; combined runtime <10s.
- [ ] `vitest --coverage` reports ≥95% line + branch coverage on `src/hooks/trust-validator.ts` and `src/hooks/signature-verifier.ts`.
- [ ] `meta-review-cache.ts` coverage ≥90%.
- [ ] Integration test passes deterministically across 10 consecutive runs.
- [ ] Integration test runtime <5s.

### Truth Table Completeness
- [ ] `test-trust-allowlist.test.ts`: minimum 4 cases (on, off, empty, signature-not-called).
- [ ] `test-trust-permissive.test.ts`: minimum 4 cases (verify-off, verify-on signed, verify-on unsigned, off-allowlist).
- [ ] `test-trust-strict.test.ts`: minimum 16 cases enumerating the 4-axis truth table.
- [ ] `test-signature.test.ts`: minimum 8 cases (Ed25519 valid, RSA valid, wrong key, corrupted, missing sig, empty keys dir, unsafe perms, perf).
- [ ] `test-meta-review-trigger.test.ts`: minimum 12 cases (6 triggers individually, multi-trigger, no-trigger, cache hit, cache miss, PASS, FAIL).
- [ ] `test-runtime-revocation.test.ts`: minimum 4 cases (revoked → skipped, audit emitted, sandbox not called, perf benchmark).

### Integration Test Assertions
- [ ] Three fixture plugins are processed; registry contains exactly `fixture.benign` and `fixture.privileged`.
- [ ] Audit log contains exactly four entries: `registered` for benign, `meta-review-verdict` (PASS) for privileged, `registered` for privileged, `rejected` for untrusted.
- [ ] Mocked `agentSpawner.invoke` called exactly once (for `fixture.privileged`); call args include the manifest and the trigger reasons array containing `'network capability'`, `'privileged reviewer slot'`, `'failure_mode=block on critical hook'`.
- [ ] Mocked agent verdict is captured verbatim in the audit `metaReviewVerdict` field.

### Fixtures
- [ ] Three fixture plugins exist under `tests/fixtures/plugins/{benign,privileged,untrusted}/`, each with a valid `hooks.json`.
- [ ] Fixture key pair exists at `tests/fixtures/keys/test-ed25519.{key,pub}` (private + public).
- [ ] Fixture signed manifest exists at `tests/fixtures/manifests/signed/hooks.json` and `hooks.json.sig`.
- [ ] `tests/fixtures/keys/README.md` documents the regeneration procedure with the exact `openssl` commands.

### Negative-Path Coverage (per PLAN-019-3 testing strategy)
- [ ] At least one test per validation step demonstrates rejection at that step (7 negative tests minimum across the unit files).
- [ ] Each rejection emits the documented audit entry shape (verified in `test-runtime-revocation.test.ts` and integration test).

## Dependencies

- **SPEC-019-3-01, 02, 03, 04** (blocking): provide all the implementation under test.
- Vitest test runner (already in project).
- Node ≥ 18 for built-in Ed25519.
- `openssl` CLI for one-time fixture key generation (NOT a runtime dependency).
- No new npm packages.

## Notes

- **Determinism**: the integration test uses a mocked agent spawner so the meta-review verdict is fixed. Real meta-reviewer behavior is exercised only in manual smoke tests (PLAN-019-3 testing strategy section).
- **Fixture stability**: key pairs and signed manifests are committed binaries. Do not regenerate them in CI — that would invalidate the corrupted-signature fixture (which is generated by flipping a known byte).
- **Coverage tool**: enforce the 95% threshold via `vitest --coverage --reporter=text --threshold 95` in the CI test script. Below-threshold runs fail the build.
- **Performance assertions**: `test-signature.test.ts` and `test-runtime-revocation.test.ts` include explicit timing assertions. These may be flaky on contended CI; if they fail intermittently the threshold is loosened by 2× (not removed).
- **Audit assertions**: the integration test uses an `InMemoryAuditWriter` that buffers entries instead of writing to disk. This isolates the test from PLAN-019-4's eventual on-disk schema. Replace with the real writer once PLAN-019-4 ships.
- **Fixture id namespacing**: `fixture.*` namespace is reserved for test plugins to avoid collision with real plugin ids in operator audit logs (the inverse-domain convention `com.*` is for real plugins).
- **Test run ordering**: each test file is independent; no `beforeAll` shared state. This makes `vitest -t <single test>` work for any individual case.
