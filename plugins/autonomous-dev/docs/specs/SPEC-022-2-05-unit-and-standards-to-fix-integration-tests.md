# SPEC-022-2-05: Unit Test Suites + Standards-to-Fix Integration Test

## Metadata
- **Parent Plan**: PLAN-022-2
- **Tasks Covered**: Task 11 (consolidated unit test suites for resource limits, failure modes, trust integration), Task 12 (standards-to-fix end-to-end integration test including approval gate)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-2-05-unit-and-standards-to-fix-integration-tests.md`

## Description
Consolidate the unit test surfaces written against the executor extensions (timeout from SPEC-022-2-01, limits and failure modes from SPEC-022-2-02, trust + privileged-chain from SPEC-022-2-04) into the three test files called out by PLAN-022-2 task 11, and ship the canonical end-to-end integration test for the standards-to-fix flow (task 12) that exercises every component shipped by PLAN-022-2 in concert: `rule-set-enforcement-reviewer` (existing) → `code-fixer` (SPEC-022-2-03 fixture) with `requires_approval: true` patches → escalation fires → operator runs `chains approve` (SPEC-022-2-04 CLI) → executor resumes and the chain completes.

The unit-test files in this spec may overlap with the per-spec test files added by SPEC-022-2-01 / 02 / 03 / 04; those per-spec files are scoped to single-feature smoke; the consolidated files in this spec exercise cross-feature interactions (e.g., timeout + failure-mode = does a `block`-mode timeout halt the chain? trust failure + privileged chain = does the privilege check fire even if trust skips a plugin?). The integration test in this spec is THE end-to-end demo of TDD §10 and is run by CI on every PR touching `chains/**`.

All tests are deterministic: agent responses are mocked, timers are faked, file I/O is in tempdirs. No real waiting, no network.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/chains/test-resource-limits.test.ts` | Create | Cross-feature: timeout × length × size × concurrent-cap |
| `plugins/autonomous-dev/tests/chains/test-failure-modes.test.ts` | Create | Cross-feature: each `on_failure` mode × upstream error source (timeout, throw, size cap, trust) |
| `plugins/autonomous-dev/tests/chains/test-trust-integration.test.ts` | Create | Cross-feature: trust × privileged-chain × failure-mode interactions |
| `plugins/autonomous-dev/tests/integration/test-standards-to-fix.test.ts` | Create | End-to-end: rule-set-enforcement-reviewer → code-fixer → approval gate → resume |
| `plugins/autonomous-dev/tests/fixtures/diffs/sql-injection.diff` | Create | Fixture diff with planted SQL injection for the integration test |
| `plugins/autonomous-dev/tests/fixtures/agents/mock-rule-set-enforcement-reviewer.ts` | Create | Mock that returns a deterministic `security-findings` artifact for the planted SQL injection |
| `plugins/autonomous-dev/vitest.config.ts` | Modify | Ensure `tests/chains/**` and `tests/integration/**` are included; coverage thresholds raised to 95% on `src/chains/**` |

## Implementation Details

### `test-resource-limits.test.ts` — Cross-Feature Scenarios

| Scenario | Setup | Expected |
|----------|-------|----------|
| Timeout while chain at length boundary | Chain length 10 (== max), middle plugin sleeps 130s with 120s timeout | `PluginTimeoutError`, downstream skipped per default `warn` |
| Size cap during paused chain | Producer emits `requires_approval` artifact whose serialized size is 11MB, cap 10MB | `ArtifactTooLargeError` raised before pause; chain marked `failed`, NO state file written |
| Concurrent-chain cap with timeout in flight | 3 chains running, one at timeout boundary; 4th attempt blocked; after timeout fires and chain unwinds, 4th succeeds | `ConcurrentChainLimitError` for the 4th attempt; counter correctly decremented |
| Length limit overrides everything | Chain length 12, max 10, even with `on_failure: 'ignore'` | `ChainTooLongError` raised before any plugin invoked |

### `test-failure-modes.test.ts` — Cross-Feature Matrix

For each error source ∈ {timeout, throw, size-cap, trust-failure} × each `on_failure` mode ∈ {block, warn, ignore}, verify chain outcome and downstream invocation count. Trust-failure × any mode always behaves as `warn` per SPEC-022-2-04 design note.

### `test-trust-integration.test.ts` — Trust + Privileged + Failure-Mode

| Scenario | Expected |
|----------|----------|
| Untrusted producer in privileged chain (allowlist matches) | Skipped per `warn`; consumer's privileged-check still passed pre-flight; consumer skipped because producer's artifact missing |
| Untrusted producer in privileged chain (allowlist does NOT match) | `PrivilegedChainNotAllowedError` raised pre-flight; trust check never runs |
| Trusted producer, untrusted consumer in privileged chain | Producer runs; consumer skipped with `TrustValidationError`; chain outcome `failed` |
| Allowlist glob `*` matches all versions | Chain proceeds for both v1.0.0 and v9.9.9 consumer |
| Allowlist glob `1.x` rejects v2.0.0 consumer | `PrivilegedChainNotAllowedError` |

### `test-standards-to-fix.test.ts` — Integration Test

```ts
describe('standards-to-fix end-to-end', () => {
  let executor: ChainExecutor;
  let escalations: EscalationEvent[] = [];
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp();
    escalations = [];
    executor = await buildTestExecutor({
      requestRoot: tempRoot,
      plugins: [
        loadFixturePlugin('mock-rule-set-enforcement-reviewer'),
        loadFixturePlugin('code-fixer'),
      ],
      escalationRouter: { notify: e => { escalations.push(e); } },
      config: {
        chains: { max_length: 10, per_plugin_timeout_seconds: 30, per_chain_timeout_seconds: 120, max_artifact_size_mb: 10, max_concurrent_chains: 3 },
        extensions: { privileged_chains: ['rule-set-enforcement-reviewer:code-fixer@*'] },
      },
    });
  });

  it('runs the full flow: review -> findings -> fixer -> approval -> resume', async () => {
    const diff = await readFixture('diffs/sql-injection.diff');

    // Step 1: trigger the chain
    const initial = await executor.executeForReview({ diff, request_id: 'REQ-1' });
    expect(initial.outcome).toBe('paused');

    // Step 2: verify the rule-set-enforcement-reviewer ran and produced findings
    const findingsArtifact = await readArtifact(tempRoot, 'security-findings', 'REQ-1');
    expect(findingsArtifact.findings).toHaveLength(1);
    expect(findingsArtifact.findings[0].rule_id).toBe('SQL_INJECTION');

    // Step 3: verify the code-fixer ran and produced patches with requires_approval
    const patchesArtifact = await readArtifact(tempRoot, 'code-patches', 'REQ-1');
    expect(patchesArtifact.patches).toHaveLength(1);
    expect(patchesArtifact.patches[0].requires_approval).toBe(true);

    // Step 4: verify state file persisted and escalation fired
    const stateFile = await readStateFile(tempRoot, initial.state.chain_id);
    expect(stateFile.paused_at_plugin).toBe('code-fixer');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].kind).toBe('chain-approval-pending');

    // Step 5: simulate operator running `chains approve`
    await chainsApprove({ artifactId: patchesArtifact.id });

    // Step 6: verify approved.json marker and state-file cleanup
    const approvedMarker = await readApprovedMarker(tempRoot, patchesArtifact.id);
    expect(approvedMarker.approved_by).toBeDefined();
    expect(await stateFileExists(tempRoot, initial.state.chain_id)).toBe(false);

    // Step 7: verify telemetry emitted exactly once
    expect(capturedTelemetry).toHaveLength(1);
    expect(capturedTelemetry[0].outcome).toBe('success');
    expect(capturedTelemetry[0].plugins).toEqual(['rule-set-enforcement-reviewer', 'code-fixer']);
  });

  it('survives daemon restart while paused', async () => {
    const diff = await readFixture('diffs/sql-injection.diff');
    const initial = await executor.executeForReview({ diff, request_id: 'REQ-2' });
    expect(initial.outcome).toBe('paused');

    // Simulate daemon restart: tear down executor, build a new one over the same tempRoot.
    executor = await buildTestExecutor({ requestRoot: tempRoot, /* same plugins, config */ });

    // Recovery: pending escalations re-emitted.
    const recovered = await recoverPending(tempRoot, { notify: e => escalations.push(e) });
    expect(recovered).toBe(1);

    // Approve and verify chain completes.
    const patchesArtifact = await readArtifact(tempRoot, 'code-patches', 'REQ-2');
    await chainsApprove({ artifactId: patchesArtifact.id });
    expect(await stateFileExists(tempRoot, initial.state.chain_id)).toBe(false);
  });

  it('rejection cancels the chain', async () => {
    const diff = await readFixture('diffs/sql-injection.diff');
    const initial = await executor.executeForReview({ diff, request_id: 'REQ-3' });
    const patchesArtifact = await readArtifact(tempRoot, 'code-patches', 'REQ-3');

    await chainsReject({ artifactId: patchesArtifact.id, reason: 'patches too risky' });

    const rejectedMarker = await readRejectedMarker(tempRoot, patchesArtifact.id);
    expect(rejectedMarker.reason).toBe('patches too risky');
    expect(await stateFileExists(tempRoot, initial.state.chain_id)).toBe(false);
  });
});
```

### Mock Reviewer

```ts
// tests/fixtures/agents/mock-rule-set-enforcement-reviewer.ts
export default async function mockReviewer({ diff }: { diff: string }) {
  // Deterministic: detect the planted "SELECT * FROM users WHERE id = '" string in the diff.
  const findings = diff.includes(`SELECT * FROM users WHERE id = '`) ? [{
    finding_id: 'SQLI-001',
    rule_id: 'SQL_INJECTION',
    severity: 'critical',
    location: { file: 'src/db.js', line: 42 },
    message: 'String concatenation in SQL query',
  }] : [];
  return { artifact_type: 'security-findings', findings };
}
```

### Fixture Diff (`tests/fixtures/diffs/sql-injection.diff`)

A minimal unified diff adding a vulnerable line — content is exactly:

```diff
--- a/src/db.js
+++ b/src/db.js
@@ -40,3 +40,4 @@
 function getUser(id) {
-  return db.query('SELECT * FROM users WHERE id = ?', [id]);
+  return db.query("SELECT * FROM users WHERE id = '" + id + "'");
 }
```

### Coverage Threshold (`vitest.config.ts`)

```ts
coverage: {
  thresholds: {
    'src/chains/**': { lines: 95, branches: 95, functions: 95 },
  },
},
```

## Acceptance Criteria

- [ ] `tests/chains/test-resource-limits.test.ts` contains all four cross-feature scenarios from the table; all pass.
- [ ] `tests/chains/test-failure-modes.test.ts` covers the full 4×3 matrix (4 error sources × 3 modes), with the trust-failure row asserting `warn` behavior regardless of declared mode; all pass.
- [ ] `tests/chains/test-trust-integration.test.ts` covers all five scenarios from the table; all pass.
- [ ] `tests/integration/test-standards-to-fix.test.ts` contains exactly three `it()` cases: full happy path, daemon-restart recovery, rejection-cancels-chain.
- [ ] Happy-path integration test passes deterministically: each step in the documented flow occurs in order, verified by reading on-disk artifacts and capturing escalations.
- [ ] Daemon-restart recovery test passes: state file survives executor teardown; `recoverPending` re-emits one escalation; subsequent approval resumes the chain to completion.
- [ ] Rejection test passes: `.rejected.json` marker is written with the operator's reason; state file is removed; chain does not resume.
- [ ] Telemetry capture in the happy-path test asserts exactly one `chain.completed` event with `outcome: 'success'`, `plugins: ['rule-set-enforcement-reviewer', 'code-fixer']`, and a positive `duration_ms`.
- [ ] All unit and integration tests run in under 10 seconds total wall-clock (mocked timers, mocked agent responses, no real network).
- [ ] Coverage on `src/chains/**` is ≥95% (lines, branches, functions) per the new vitest threshold; CI fails if coverage drops below.
- [ ] Running `vitest tests/chains tests/integration` from a clean checkout passes on macOS and Linux (CI matrix).
- [ ] No test modifies global state (e.g., the static `ChainExecutor.activeChains` counter) without resetting in `afterEach`; verified by running the full suite twice in sequence with no test pollution.

## Dependencies

- **Blocked by**: SPEC-022-2-01, SPEC-022-2-02, SPEC-022-2-03, SPEC-022-2-04 (this spec consolidates and integration-tests their behavior).
- Consumes: PLAN-020-1's `rule-set-enforcement-reviewer` agent (mocked in tests; the real agent is exercised in manual smoke per the plan's testing strategy).
- No new npm packages introduced (vitest, mocked timers, tempdir helpers already available).

## Notes

- The integration test deliberately uses a mock for `rule-set-enforcement-reviewer` rather than invoking the real agent. The real agent is non-deterministic (LLM-backed) and exercising it would require live API calls. The plan's testing strategy explicitly calls out a manual smoke test on a real PR; that is the path for end-to-end agent validation.
- The `code-fixer` fixture from SPEC-022-2-03 is loaded as-is; no further mocking. Its placeholder-patch output is sufficient for the integration test's purposes (the test verifies wiring, not patch quality).
- The 95% coverage threshold on `src/chains/**` is enforced by vitest config so future PRs that drop coverage fail CI; this codifies the plan's task-11 acceptance criterion as a structural guard.
- Daemon-restart simulation is in-process: tear down the `ChainExecutor` instance and build a new one over the same tempdir. This is sufficient because state persistence is on-disk; full process restart is verified by manual smoke per the plan.
- Cross-feature scenarios (e.g., size-cap during paused chain, untrusted producer in privileged chain) are deliberately exercised here because the per-spec smoke tests only cover single-feature behavior. The risk these tests guard against is feature interactions silently breaking when individual features pass their own tests.
- All three `it()` cases in the integration test use distinct `request_id`s (`REQ-1`, `REQ-2`, `REQ-3`) so artifact files do not collide if tests run in parallel; tempRoot is per-test as well.
