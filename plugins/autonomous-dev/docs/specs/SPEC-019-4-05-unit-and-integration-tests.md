# SPEC-019-4-05: Unit + Integration Tests for Reviewer Slots, Sequential Execution, and Audit

## Metadata
- **Parent Plan**: PLAN-019-4
- **Tasks Covered**: Task 11 (unit tests), Task 12 (integration test)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-4-05-unit-and-integration-tests.md`

## Description
Author the full test suite that proves SPEC-019-4-01 through SPEC-019-4-04 work as specified, individually and together. Five unit-test files exercise sequential execution, failure modes, fingerprint determinism, audit-writer integrity, and audit-verify detection. One integration test stitches the entire flow: register two reviewer plugins → run a code-review gate → assert both verdicts captured with fingerprints → tamper with the audit log → assert `audit verify` detects the tampering at the right line. Coverage targets: ≥95% on `executor.ts` (the extended pieces), `fingerprint.ts`, `audit-writer.ts`. Total runtime under 10 seconds for unit suites; integration test under 5 seconds.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/hooks/test-executor-sequential.test.ts` | Create | Priority order, chained context, empty-point edge cases |
| `plugins/autonomous-dev/tests/hooks/test-failure-modes.test.ts` | Create | block / warn / ignore behavior, mixed-mode scenarios |
| `plugins/autonomous-dev/tests/hooks/test-fingerprint.test.ts` | Create | Determinism (100 runs), collision smoke, canonicalization edge cases |
| `plugins/autonomous-dev/tests/audit/test-audit-writer.test.ts` | Create | Chain integrity, concurrent writes, key bootstrap, rotation, truncation |
| `plugins/autonomous-dev/tests/audit/test-audit-verify.test.ts` | Create | Clean / tampered / broken-chain / key-rotation fixtures |
| `plugins/autonomous-dev/tests/integration/test-reviewer-slot-flow.test.ts` | Create | End-to-end: 2 reviewers + audit + tamper |
| `plugins/autonomous-dev/tests/fixtures/audit-logs/clean.log.json` | Create | 50-entry clean fixture |
| `plugins/autonomous-dev/tests/fixtures/audit-logs/tampered-mid.log.json` | Create | Same as clean with byte 250 mutated |
| `plugins/autonomous-dev/tests/fixtures/audit-logs/key-rotation.log.json` | Create | 10 entries + key rotation + 10 more |
| `plugins/autonomous-dev/tests/fixtures/reviewers/echo-reviewer.ts` | Create | Test-only fixture plugin: returns deterministic verdict from input |

## Implementation Details

### `tests/hooks/test-executor-sequential.test.ts`

Required cases:
1. **Empty hook point** — `executeHooks('foo', {})` returns `{results: [], failures: [], aborted: false}`; no spy invocations.
2. **Single hook** — One hook at priority 50; `previousResults` it observes is `[]`; result appears in `results`.
3. **Three hooks descending priority** — Register hooks at 100, 75, 50 (in random registration order). Each hook's `invoke` records `{seenPriorities: previousResults.map(r => r.priority)}`. Assert:
   - 100-hook saw `[]`.
   - 75-hook saw `[100]`.
   - 50-hook saw `[100, 75]`.
4. **Equal priorities, stable order** — Register hooks A, B, C all at priority 50 (in that registration order). Assert results are in order A, B, C.
5. **Cumulative chaining (5 hooks)** — Register 5 hooks at descending priorities. Assert the last hook's `previousResults.length === 4` and each entry's `output` matches what the corresponding earlier hook returned.
6. **Read-only context** — A hook attempts `(context.previousResults as any[]).push('hax')`; the executor's next iteration sees an unaffected `previousResults` (defensive copy on each iteration).
7. **`originalContext` referential stability** — Each hook observes the same object reference for `context.originalContext` across all 5 invocations.
8. **`duration_ms` populated and non-negative** — Every result has `duration_ms >= 0`.

Use `vitest`'s `vi.fn()` for spies. Mock the registry minimally; do not pull in the full plugin loader.

### `tests/hooks/test-failure-modes.test.ts`

Required cases:
1. **`block`-mode throw aborts execution** — Three hooks: H1 success, H2 `block`-mode throws, H3 success. Assert:
   - `executeHooks` throws `HookBlockedError` whose `hookResult.hook_id === 'H2'`.
   - H3's `invoke` was NOT called (spy assertion).
   - The thrown error's `hookResult.error.failure_mode === 'block'`.
2. **`warn`-mode throw continues, logs WARN** — Three hooks: H1 success, H2 `warn`-mode throws, H3 success. Assert:
   - No throw from `executeHooks`.
   - `result.results.length === 3`.
   - `result.failures.length === 1`, `result.failures[0].hook_id === 'H2'`.
   - Logger spy received one WARN call with `{plugin_id, hook_id: 'H2', error}` metadata.
3. **`ignore`-mode throw continues silently** — Same as case 2 with `ignore`. Assert logger NOT called.
4. **Mixed `[warn(throw), ignore(throw), success]`** — All three appear in `results` (in priority order); `failures` has the warn and ignore entries; `aborted: false`.
5. **`block` after prior `warn`** — H1 `warn`-mode throws, H2 `block`-mode throws. Assert:
   - `executeHooks` throws `HookBlockedError` with `hookResult.hook_id === 'H2'`.
   - The warn failure was logged before the block fired (spy ordering).
6. **`block`-mode hook can see prior `previousResults`** — H1 success returns `{value: 42}`; H2 `block`-mode reads `context.previousResults[0].output.value`, throws if not 42. Assert no throw (i.e. context propagation works even on the doomed hook).

### `tests/hooks/test-fingerprint.test.ts`

Required cases:
1. **`canonicalize` key-order independence** — `canonicalize({a:1, b:2}) === canonicalize({b:2, a:1})`.
2. **`canonicalize` rejects NaN/Infinity** — `expect(() => canonicalize({n: NaN})).toThrow()`; same for Infinity.
3. **`canonicalize` rejects circular references** — `const o: any = {}; o.self = o;` throws.
4. **Determinism (100 runs)** — Loop 100 times invoking `inputFingerprint(complexInput)`; assert all 100 strings identical.
5. **Different inputs → different hashes** — `inputFingerprint({a:1}) !== inputFingerprint({a:2})`.
6. **`verdictFingerprint` determinism** — Same `(plugin_id, plugin_version, agent_name, input, verdict)` across 100 calls produces 100 identical hashes.
7. **`verdictFingerprint` plugin sensitivity** — Same input, same verdict, different `plugin_id` produces different hash.
8. **`verdictFingerprint` excludes timestamp** — Two verdict objects identical except for an injected `_ts` field that is NOT in the canonicalized scope produce identical fingerprints (proves we're hashing only the documented fields).
9. **Findings order matters** — `verdict.findings = [a, b]` vs `[b, a]` produce different fingerprints (callers must sort; we don't sort defensively).

### `tests/audit/test-audit-writer.test.ts`

Required cases:
1. **Open fresh log** — Path does not exist; `AuditWriter.open` creates it with mode 0600; first append's `prev_hmac === 'GENESIS'`.
2. **Reopen non-empty log** — Pre-populate log with 3 entries; reopen; new append's `prev_hmac` matches existing line 3's `hmac`.
3. **HMAC chain over 100 sequential appends** — All 100 entries chain correctly (entry[i].prev_hmac === entry[i-1].hmac for i>0; entry[0].prev_hmac === 'GENESIS').
4. **Concurrent appends serialize** — `Promise.all` of 100 `append()` calls; assert exactly 100 lines, all chained, no duplicates, no interleaving (each line parses cleanly as JSON).
5. **HMAC determinism** — Two identical entry inputs (same payload, ts, type) with the same `prev_hmac` produce the same `hmac` (sanity).
6. **Tamper detection setup** — Append 5 entries; modify byte at position 50 in line 3; verify reads file directly (not via writer); assert HMAC check on line 3 fails.
7. **Truncation on oversized payload** — Construct payload that serializes to >4000 bytes; append; assert resulting line has `payload._truncated: true`, `payload._original_size > 4000`, total line length ≤ 4096.
8. **Key bootstrap (env)** — Set `AUDIT_HMAC_KEY=deadbeef...` (64-hex chars); call `resolveAuditKey`; assert returned key matches; `rotated: false`.
9. **Key bootstrap (file)** — Write `~/.autonomous-dev/audit-key` (in a tempdir); unset env; call `resolveAuditKey`; assert key matches file content; `rotated: false`.
10. **Key bootstrap (missing)** — No env, no file; call `resolveAuditKey`; assert key is 32 random bytes, file is created with mode 0600, `rotated: true`.
11. **Rotation at size cap** — Set `max_size_mb: 0.001` (1 KB); append entries until size exceeded; assert `audit.log` is now smaller (just-rotated) and `audit.log.1` exists with the prior content.

Use `os.tmpdir() + '/audit-test-' + randomBytes(8).toString('hex')` for isolated dirs; clean up with `afterEach`.

### `tests/audit/test-audit-verify.test.ts`

Required cases:
1. **Clean log → `intact: true`** — Use `clean.log.json` fixture (50 entries); `verifyAuditLog` returns `{intact: true, total: 50, tamperedAt: [], brokenChainAt: []}`.
2. **Tampered byte detected** — Use `tampered-mid.log.json`; `verifyAuditLog` returns `tamperedAt` containing the affected line and `brokenChainAt` containing all subsequent lines (because their `prev_hmac` no longer matches the tampered entry's recomputed `hmac`).
3. **Specific line reported** — Construct a fixture where only line 7 is tampered; assert `tamperedAt[0] === 7`.
4. **Key rotation mid-log not flagged** — Use `key-rotation.log.json`; `verifyAuditLog` returns `intact: true` despite the `audit_key_rotated` entry having `prev_hmac: GENESIS` mid-log.
5. **Wrong key produces all-tampered** — Verify `clean.log.json` with a different random key; assert `tamperedAt.length === 50` (every line fails HMAC check).
6. **Empty log** — Verify a zero-byte file; returns `{intact: true, total: 0, tamperedAt: [], brokenChainAt: []}`.
7. **Malformed JSON line** — Inject a non-JSON line at position 5; assert line 5 in `tamperedAt`.

Fixtures are JSON files with arrays of pre-computed entries; the test harness writes them out as JSONL before invoking `verifyAuditLog`.

### `tests/integration/test-reviewer-slot-flow.test.ts`

Single test case (the integration flow), broken into clear phases:

```ts
it('register 2 reviewers, run code-review, capture audit, detect tampering', async () => {
  // Phase 1: setup
  const tmpDir = await mkdtemp(...);
  process.env.AUDIT_HMAC_KEY = randomBytes(32).toString('hex');
  const writer = await AuditWriter.open({logPath: `${tmpDir}/audit.log`, key: ...});
  const registry = new HookRegistry();
  registry.register(echoReviewerEntry({plugin_id: 'reviewer.alpha', verdict: 'APPROVE', score: 90}));
  registry.register(echoReviewerEntry({plugin_id: 'reviewer.beta',  verdict: 'CONCERNS', score: 70}));

  // Phase 2: run gate
  const input = {diff: 'fixture diff', files: ['src/app.ts']};
  const result = await runReviewersForGate('code-review', input, {
    registry, minReviewers: 2,
    invokeReviewer: async (slot, inp) => /* invoke fixture */,
    invokeBuiltIn: async () => { throw new Error('built-in should not be called'); },
    logger: silentLogger,
  });
  // Emit audit entries (the integration test wires this manually since
  // SPEC-019-4-04 wires it inside the production callsites).
  for (const v of result.verdicts) {
    await writer.append({ts: ..., type: 'reviewer_verdict', plugin_id: v.plugin_id,
                          plugin_version: v.plugin_version, payload: {verdict: v}});
  }
  await writer.close();

  // Phase 3: assertions on verdicts
  expect(result.usedFallback).toBe(false);
  expect(result.verdicts).toHaveLength(2);
  expect(result.verdicts[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(result.verdicts[1].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(result.verdicts[0].fingerprint).not.toEqual(result.verdicts[1].fingerprint);

  // Phase 4: assertions on audit log
  const verifyResult1 = await verifyAuditLog(`${tmpDir}/audit.log`, key);
  expect(verifyResult1.intact).toBe(true);
  expect(verifyResult1.total).toBeGreaterThanOrEqual(2);  // ≥2 reviewer_verdict entries

  // Phase 5: tamper and re-verify
  const fileContents = await readFile(`${tmpDir}/audit.log`, 'utf8');
  const lines = fileContents.split('\n').filter(Boolean);
  const tamperedLineIndex = 0;  // tamper line 1
  const original = lines[tamperedLineIndex];
  const mutated = original.slice(0, 100) + 'X' + original.slice(101);
  lines[tamperedLineIndex] = mutated;
  await writeFile(`${tmpDir}/audit.log`, lines.join('\n') + '\n');

  const verifyResult2 = await verifyAuditLog(`${tmpDir}/audit.log`, key);
  expect(verifyResult2.intact).toBe(false);
  expect(verifyResult2.tamperedAt).toContain(tamperedLineIndex + 1);  // 1-based
});
```

### `tests/fixtures/reviewers/echo-reviewer.ts`

Fixture factory: returns a `HookEntry` whose `invoke` returns a deterministic verdict derived from input + the configured `verdict`/`score`. No external IO; safe to invoke in tests.

```ts
export function echoReviewerEntry(opts: {
  plugin_id: string;
  verdict: VerdictKind;
  score: number;
}): HookEntry {
  return {
    plugin_id: opts.plugin_id,
    plugin_version: '0.0.0-test',
    hook_id: `${opts.plugin_id}#review`,
    priority: 50,
    failure_mode: 'warn',
    reviewer_slot: {
      agent_name: `agent.${opts.plugin_id}`,
      review_gates: ['code-review'],
      expertise_domains: ['general'],
      minimum_threshold: 60,
    },
    invoke: async () => ({
      verdict: opts.verdict,
      score: opts.score,
      findings: [],
      agent_name: `agent.${opts.plugin_id}`,
      plugin_id: opts.plugin_id,
      plugin_version: '0.0.0-test',
    }),
  };
}
```

## Acceptance Criteria

- [ ] All five unit-test files (`test-executor-sequential`, `test-failure-modes`, `test-fingerprint`, `test-audit-writer`, `test-audit-verify`) pass deterministically across 10 consecutive runs.
- [ ] Integration test `test-reviewer-slot-flow` passes deterministically across 10 consecutive runs.
- [ ] Total unit-test runtime ≤ 10 seconds (`vitest run tests/hooks tests/audit`).
- [ ] Integration-test runtime ≤ 5 seconds.
- [ ] Coverage report shows ≥ 95% line coverage on `src/hooks/executor.ts`, `src/hooks/fingerprint.ts`, `src/audit/audit-writer.ts`, `src/audit/verify.ts`, `src/audit/key-store.ts`.
- [ ] Coverage report shows ≥ 90% on `src/reviewers/aggregate.ts` (the rest is bash glue exercised by the integration test).
- [ ] Sequential test #6 (read-only context) confirms defensive-copy behavior — mutating returned `previousResults` does not affect the next iteration.
- [ ] Failure-mode test #1 (`block` aborts) confirms via spy that downstream hooks are not invoked.
- [ ] Fingerprint test #4 (100-run determinism) loops 100 iterations and asserts identical hashes.
- [ ] Audit-writer test #4 (concurrent appends) uses `Promise.all([...100])` and asserts exactly 100 chained lines.
- [ ] Audit-writer test #11 (rotation) confirms file is renamed to `.1` and a new empty `audit.log` is created.
- [ ] Audit-verify test #2 (tampered byte) confirms downstream `brokenChainAt` propagation.
- [ ] Audit-verify test #4 (key rotation) confirms `intact: true` when only the `audit_key_rotated` entry breaks the chain.
- [ ] Integration test asserts both reviewer fingerprints are non-empty 64-character hex strings AND distinct from each other.
- [ ] Integration test's tamper phase mutates exactly one byte and confirms `audit verify` reports the mutated line.
- [ ] All test fixtures are checked into `tests/fixtures/`; no test depends on network or live filesystem state outside its tempdir.
- [ ] Tempdirs are cleaned up in `afterEach` regardless of test outcome.
- [ ] No test relies on real `~/.autonomous-dev/` or real env vars persisted across tests; all isolation via tempdir + scoped env restoration.

## Dependencies

- **Blocked by**: SPEC-019-4-01, SPEC-019-4-02, SPEC-019-4-03, SPEC-019-4-04 (all production code under test).
- **Test framework**: `vitest` (existing project standard); no new test deps introduced.
- **External**: Node `fs/promises`, `os`, `crypto` standard libs only.

## Notes

- The integration test wires audit emission manually rather than going through the full daemon stack. This is deliberate: it isolates the contract assertions (fingerprints + audit chain integrity) from daemon plumbing, which is exercised separately by daemon-level tests outside PLAN-019-4.
- Fixtures `clean.log.json`, `tampered-mid.log.json`, and `key-rotation.log.json` are pre-computed JSON arrays. A small helper script (or a `beforeAll` in the test file) writes them out as JSONL into a tempdir before tests run; this avoids checking byte-exact JSONL files into git (which would diff noisily on JSON canonicalization changes).
- Coverage threshold (95%) is enforced via `vitest --coverage --coverage.statements 95`; CI fails if dropped. The 90% threshold for `aggregate.ts` accounts for the bash-bridge code path which is integration-tested rather than unit-tested.
- Determinism tests (#4 fingerprint, #6 verdict) loop 100x to make any non-determinism (Date.now, random keys, iteration order) glaringly visible. Lower iteration counts have historically masked bugs.
- The integration test's tamper at byte position 100 of line 1 is chosen because line 1's `payload` field starts well after byte 100 (timestamps and type push the structural prefix past byte 50). For very short payloads, this position may need adjustment; the test should compute the position dynamically (`line.indexOf('"payload"') + 20`) for robustness.
- We do not test `audit query` exhaustively here; basic happy-path coverage is acceptable since query is read-only and side-effect-free. The CLI-spec acceptance criteria from SPEC-019-4-04 cover its semantics.
- Concurrent-write test (#4) is the most likely flaky candidate. If V8 scheduler quirks cause occasional ordering issues, the test should retry up to 3 times; persistent failure indicates a real mutex bug.
