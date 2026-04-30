# SPEC-022-3-04: Adversarial Tests, Unit-Test Coverage Closeout, and Full Secured-Chain Integration Test

## Metadata
- **Parent Plan**: PLAN-022-3
- **Tasks Covered**: Task 9 (adversarial tests for data-flow security), Task 10 (unit tests for sanitizer/signing/audit), Task 11 (integration test: full secured chain)
- **Estimated effort**: 9 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-3-04-adversarial-and-integration-tests.md`

## Description
Final test layer for PLAN-022-3. Captures the security boundary in three test surfaces: (1) targeted adversarial tests, one per attack vector enumerated in the TDD; (2) closeout unit tests filling coverage gaps left by the implementation specs; (3) a single end-to-end integration test running a real privileged chain (rule-set-enforcement → code-fixer with approval) with all security layers active, plus a malicious-producer fixture that systematically attempts each attack vector and verifies all are blocked at the documented layer with the documented error class.

The goal is regression protection: any future change that weakens the consumer boundary, removes a sanitization rule, breaks HMAC chaining, or degrades the privileged-chain signature path will fail one of these tests with a clear assertion. Coverage targets are set at ≥95% on new modules so untested paths are visible.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/chains/test-security-attacks.test.ts` | Create | 5 adversarial tests, one per attack vector |
| `plugins/autonomous-dev/tests/chains/test-sanitizer.test.ts` | Modify (extend) | Closeout coverage from SPEC-022-3-02 |
| `plugins/autonomous-dev/tests/chains/test-artifact-signing.test.ts` | Modify (extend) | Closeout coverage from SPEC-022-3-02 |
| `plugins/autonomous-dev/tests/chains/test-chain-audit.test.ts` | Modify (extend) | Closeout coverage from SPEC-022-3-03 |
| `plugins/autonomous-dev/tests/integration/test-chain-security.test.ts` | Create | Full secured chain + malicious-producer fixture |
| `plugins/autonomous-dev/tests/chains/fixtures/malicious-producer.ts` | Create | Test plugin that attempts each attack vector on demand |
| `plugins/autonomous-dev/tests/chains/fixtures/privileged-chain-config.json` | Create | Chain definition with both producer and consumer in `privileged_chains[]` |
| `plugins/autonomous-dev/tests/chains/fixtures/coverage-targets.json` | Create | Per-module coverage thresholds for CI gate |

## Implementation Details

### Adversarial Test Suite (`test-security-attacks.test.ts`)

Five test cases, each named after the attack vector. Each MUST assert the SPECIFIC error class — string matching is forbidden (regressions in error type are silent failures otherwise).

#### Vector 1: Producer Emits Extra Field (Schema Strictness)

```
GIVEN a chain where the consumer declares consumes.schema_version = '1.0' for security-findings
AND the producer emits a security-findings artifact containing extra_data: 'leaked secret'
WHEN the consumer reads the artifact
THEN the read returns successfully
AND the returned payload does NOT contain 'extra_data'
AND the audit log contains an artifact_emitted entry but no schema-violation entry (since stripping is silent by design)
```

#### Vector 2: Producer Emits Path Traversal (Sanitization)

```
GIVEN a chain where the producer emits a code-patches artifact with patches[0].file = '../../../etc/passwd'
AND the artifact schema declares 'file' as format: path
WHEN the consumer reads the artifact
THEN read() throws SanitizationError
AND error.rule === 'path-traversal'
AND error.fieldPath === 'patches[0].file'
AND the chain executor catches the error and emits a plugin_failed audit entry
```

#### Vector 3: Producer Mutates Artifact Post-Write (HMAC Tampering)

```
GIVEN a producer persists an artifact (HMAC signed)
WHEN an external process mutates a single byte in the on-disk file's payload
AND the consumer attempts to read the artifact
THEN read() throws ArtifactTamperedError
AND the audit log records a plugin_failed entry with error_code 'ARTIFACT_TAMPERED'
```

The test MUST mutate the file via `fs.writeFile` (not via the registry API) to simulate an external attacker.

#### Vector 4: Consumer Reads Artifact Outside Declared Consumes (Capability Scope)

```
GIVEN a consumer A with consumes: [{artifact_type: 'security-findings', schema_version: '1.0'}]
AND a code-patches artifact exists in the request's registry (produced by another plugin)
WHEN A calls read('code-patches', ...)
THEN read() throws CapabilityError
AND error.code === 'CAPABILITY_DENIED'
AND no schema-load or HMAC-verify is attempted (verified by spy on lower layers)
```

#### Vector 5: Privileged Chain With Missing Ed25519 Signature

```
GIVEN a chain definition with both producer and consumer in extensions.privileged_chains[]
AND a producer artifact persisted WITHOUT _chain_signature (simulated by deleting the field post-write)
WHEN the consumer reads the artifact
THEN read() throws PrivilegedSignatureError
AND error.reason === 'missing'
AND the audit log records a plugin_failed entry
```

All five tests MUST run in <5 seconds total (no real Ed25519 keygen per test; reuse keypairs from `tests/chains/fixtures/keys/`).

### Coverage Closeout Tests

Extend the three unit-test files from SPEC-022-3-02/03 to fill remaining coverage gaps:

**`test-sanitizer.test.ts` additions:**
- Edge case: empty string in `format: path` field → reject.
- Edge case: path containing `%2e%2e` (URL-encoded `..`) → reject (treat as literal `..` after decode? **Per security policy: reject without decoding** — defense in depth).
- Edge case: deeply nested object (5 levels) with violation at the deepest level → fieldPath reports the full dotted path.
- Edge case: array of arrays with violation in inner array → fieldPath reports `[i][j]`.
- Edge case: schema declares format on object property but payload sends an array → schema-validation catches first; sanitizer never sees it.

**`test-artifact-signing.test.ts` additions:**
- Canonical JSON: `{"a":1,"b":2}` and `{"b":2,"a":1}` produce IDENTICAL HMAC.
- Canonical JSON: a payload containing `undefined` values throws `TypeError`.
- HMAC: producer and consumer with DIFFERENT keys → tampered error (defense against operator running two daemons with mismatched keys).
- Ed25519: signing artifact size 1 KB takes <2ms; size 1 MB takes <10ms (perf assertion).
- Privileged chain: producer in privileged list, consumer NOT → verification skipped (signature ignored even if present).

**`test-chain-audit.test.ts` additions:**
- HMAC chain across rotation: write 50 entries, force rotate, write 50 more → both files independently verify.
- `init()` on a file with a single line resumes correctly.
- `init()` on a file with a corrupted last line (truncated mid-write) → recovery: detect corruption, log WARNING, treat as if the previous valid line was the tail.
- Concurrent writes during rotation: 10 concurrent appends span the rotation boundary → all 10 land in either old or new file, none lost, both chains intact.

### Coverage Thresholds (`coverage-targets.json`)

```json
{
  "plugins/autonomous-dev/src/chains/artifact-registry.ts": { "lines": 95, "branches": 90 },
  "plugins/autonomous-dev/src/chains/sanitizer.ts": { "lines": 95, "branches": 90 },
  "plugins/autonomous-dev/src/chains/canonical-json.ts": { "lines": 95, "branches": 90 },
  "plugins/autonomous-dev/src/chains/audit-writer.ts": { "lines": 95, "branches": 90 },
  "plugins/autonomous-dev/src/chains/schema-cache.ts": { "lines": 95, "branches": 90 },
  "plugins/autonomous-dev/src/cli/commands/chains-audit.ts": { "lines": 90, "branches": 85 }
}
```

The CI test gate enforces these thresholds; PRs that drop coverage below threshold fail.

### Integration Test (`test-chain-security.test.ts`)

Single test file with two top-level describe blocks:

#### Block A: Happy-Path Privileged Chain

Use the chain definition from `privileged-chain-config.json`:

```
chain: secure-fix-flow
plugins:
  - rule-set-enforcement (producer: security-findings)
  - code-fixer (consumer: security-findings; producer: code-patches; gated by approval)
extensions:
  privileged_chains: ["secure-fix-flow"]
```

Test flow:
1. Bootstrap: ensure trusted-keys for both plugins, set `CHAIN_HMAC_KEY` and `CHAINS_AUDIT_HMAC_KEY` to fixed test values, fresh `chains-audit.log`.
2. Trigger the chain via the executor with a fixture input.
3. Mock the approval gate to auto-grant.
4. Wait for `chain_completed` audit entry.

Assertions:
- Chain executes both plugins to completion.
- security-findings artifact has both `_chain_hmac` AND `_chain_signature`.
- code-patches artifact has both signatures.
- Audit log contains exactly one of each: `chain_started`, `chain_completed`. At least 2 of: `plugin_invoked`, `plugin_completed`, `artifact_emitted`. Exactly one of each: `approval_requested`, `approval_granted`.
- `chains audit verify` over the resulting log exits 0.

#### Block B: Malicious-Producer Suite

Replace the producer (rule-set-enforcement) with `malicious-producer.ts` which exposes 5 modes via a `MALICIOUS_MODE` env var:

| Mode | Behavior | Expected outcome |
|------|----------|------------------|
| `extra_field` | Emit valid security-findings + extra_data: 'leak' | Chain succeeds; consumer payload has no extra_data; audit log shows artifact_emitted |
| `path_traversal` | Emit security-findings with file: '../../../etc/passwd' | Consumer's read throws SanitizationError; chain fails with plugin_failed |
| `tamper` | Emit valid artifact, then mutate the file post-write | Consumer's read throws ArtifactTamperedError; chain fails |
| `cross_capability` | Producer attempts to read code-patches (which it doesn't declare) | Producer's own call throws CapabilityError; chain fails before consumer runs |
| `missing_signature` | Strip _chain_signature from the artifact post-write | Consumer's read throws PrivilegedSignatureError with reason 'missing'; chain fails |

For each mode, run the chain and assert:
- Specific error class surfaces.
- Audit log shows the failure.
- No code-patches artifact is produced (chain stops at the failure).
- `chains audit verify` over the resulting log exits 0 (audit chain itself remains intact even when plugins fail).

Each malicious-mode subtest runs in <3 seconds. Total integration suite <30 seconds.

### Malicious Producer Fixture (`malicious-producer.ts`)

```typescript
export const maliciousProducer = {
  pluginId: 'malicious-producer-fixture',
  consumes: [],
  produces: [{ artifact_type: 'security-findings', schema_version: '1.0' }],
  async run(ctx: PluginContext): Promise<void> {
    const mode = process.env.MALICIOUS_MODE ?? 'extra_field';
    switch (mode) {
      case 'extra_field': {
        const a = { findings: [{ file: 'src/x.ts', line: 1, rule_id: 'R1' }], extra_data: 'leak' } as any;
        await ctx.artifactRegistry.persist({ artifact_type: 'security-findings', schema_version: '1.0', payload: a }, ctx.producerCtx);
        return;
      }
      case 'path_traversal': { /* findings[0].file = '../../../etc/passwd' */ }
      case 'tamper': { /* persist, then directly fs.writeFile to corrupt the on-disk artifact */ }
      case 'cross_capability': { /* await ctx.artifactRegistry.read('code-patches', '...', { pluginId: 'malicious-producer-fixture', consumes: [] }); */ }
      case 'missing_signature': { /* persist, then read JSON, delete _chain_signature, write back */ }
    }
  },
};
```

Strip the implementation in this spec; the executor sees a normal plugin and runs it. The destructive behaviors are intentional and isolated to the fixture's worktree.

## Acceptance Criteria

### Adversarial Tests (Task 9)

- [ ] `test-security-attacks.test.ts` exists with exactly 5 named test cases, one per attack vector.
- [ ] Each test asserts the specific error class (CapabilityError, SchemaValidationError-or-equivalent, ArtifactTamperedError, SanitizationError, PrivilegedSignatureError) — NOT a string match.
- [ ] All 5 tests pass.
- [ ] Total suite runtime <5 seconds (measured locally on dev machine; CI may add overhead).
- [ ] Each test asserts the corresponding audit log entry was written (or correctly absent).
- [ ] Vector 4 (capability) verifies via spy that the schema loader was NOT called (capability check short-circuits).

### Coverage Closeout (Task 10)

- [ ] `test-sanitizer.test.ts` adds the 5 listed edge cases; all pass.
- [ ] `test-artifact-signing.test.ts` adds the 5 listed edge cases; all pass.
- [ ] `test-chain-audit.test.ts` adds the 4 listed edge cases; all pass.
- [ ] CI coverage gate is configured with thresholds from `coverage-targets.json`.
- [ ] Running the full chains test suite reports actual coverage at or above thresholds for all 6 listed modules.
- [ ] All tests are deterministic: 10 consecutive runs produce identical pass/fail results.
- [ ] No tests use `setTimeout` for synchronization (use deterministic awaits or mock clocks).

### Integration Test (Task 11)

- [ ] `test-chain-security.test.ts` Block A (happy path) passes: privileged chain runs end-to-end, both artifacts have both signatures, audit log is intact.
- [ ] `test-chain-security.test.ts` Block B runs all 5 malicious modes; each blocks at the expected layer with the expected error class.
- [ ] After each malicious mode, `chains audit verify` exits 0 (audit chain integrity preserved through failures).
- [ ] `MALICIOUS_MODE` env var switches the producer's behavior between subtests; no shared state across modes.
- [ ] Total integration suite (Block A + 5 modes) runs in <30 seconds.
- [ ] Test uses fixed `CHAIN_HMAC_KEY` and `CHAINS_AUDIT_HMAC_KEY` constants so it is reproducible across machines.
- [ ] Test cleans up artifacts and audit log between subtests (fresh state per scenario).
- [ ] All paths use the public APIs exposed by SPEC-022-3-01/02/03; no internal-state pokes (this is a true integration test).

## Dependencies

- **Blocked by**: SPEC-022-3-01 (capability + schema layer), SPEC-022-3-02 (signing + sanitization), SPEC-022-3-03 (audit log + executor wiring + CLI). All three must be merged before this spec can pass.
- **Reuses**: existing test harness, AJV, Node `crypto`, the test plugin loader from PLAN-022-1's test infrastructure.
- **Fixtures**: depends on `tests/chains/fixtures/keys/` from SPEC-022-3-02 and the chain configuration plumbing from PLAN-022-2.

## Notes

- **Why so many error-class assertions?** A regression that converts `CapabilityError` to a generic `Error` would still pass a string-match test ("denied" appears in many error messages). Class-instance checks lock the API contract.
- **Vector 4 (capability) is the most subtle.** A malicious producer that manages to craft a `ConsumerPluginRef` with widened capabilities is a separate attack surface — covered by ensuring `ConsumerPluginRef` is constructed by the executor from the trusted manifest, not supplied by the plugin. The integration test exercises this path.
- **The malicious-producer fixture is a known security risk in the test tree.** It contains code that intentionally writes path-traversal strings and corrupts files. It runs ONLY inside the test runner's tmp worktree; the helper MUST refuse to run if `process.env.NODE_ENV !== 'test'` (assert in module-load, throw if violated).
- **Coverage thresholds are floors, not targets.** New modules SHOULD achieve >98% on lines; the 95% number is the failure threshold.
- **Determinism in audit-log tests:** inject a fixed-value clock so timestamps are predictable; HMACs over the canonical entries are then byte-identical across runs and can be hardcoded as expected values where useful.
- **Performance assertions in the closeout tests** (Ed25519 <2ms / 1KB; HMAC <1ms / artifact) are deliberately loose; flaky CI machines must not fail the suite. If a future regression makes them ≥10× slower, the assertion catches it.
- **Block A and Block B share the same chain definition** but Block B swaps the producer. The chain definition itself is unchanged so `extensions.privileged_chains[]` evaluation is identical.
- This spec is the LAST implementation task of PLAN-022-3. All Definition-of-Done items are exercised by the tests defined here. After this spec lands, PLAN-022-3 is complete.
