# SPEC-029-1-05: Harness Migration Batch D — runtime.test.ts + end-of-plan verification

## Metadata
- **Parent Plan**: PLAN-029-1
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-1 Task 5 (Batch D — `tests/agent-factory/runtime.test.ts`) + PLAN-029-1 Task 6 (end-of-plan verification & FAIL-list capture)
- **Estimated effort**: 0.5 day for the conversion + 2 hours for verification = ~6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-029-1-05-harness-migration-batch-d-runtime-and-end-of-plan-verification.md`
- **Depends on**: SPEC-029-1-01, SPEC-029-1-02, SPEC-029-1-03, SPEC-029-1-04 (must all be merged before this spec runs end-of-plan verification)

## Description
Convert `plugins/autonomous-dev/tests/agent-factory/runtime.test.ts` — the highest-risk harness file in PLAN-029-1 — from custom-harness `runTests()` IIFE to idiomatic jest. Then run the end-of-plan verification protocol from PLAN-029-1 Task 6 to (a) prove the entire `tests/` tree is harness-free, (b) run a full `npx jest --runInBand` to a complete pass/fail summary, and (c) capture that summary as the FAIL-list input for SPEC-029-2-* (triage matrix).

`runtime.test.ts` is called out as **complex** in TDD-029 §5.3 because its body wires up a multi-step daemon lifecycle: spawn a daemon process, run lifecycle phases against it, tear it down. The harness pattern's outer-scope `runTests` body did the spawn-once-tear-down-once dance implicitly. Under jest, that becomes explicit `beforeAll(spawn)` / `afterAll(teardown)` — the highest-stakes lift in the whole migration because a `beforeAll` failure or an unawaited teardown can produce zombie processes that corrupt unrelated CI runs.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/agent-factory/runtime.test.ts` | Modify | Replace `runTests()` IIFE with `describe`/`it` + `beforeAll`/`afterAll`; line ~616 contains the `process.exit(1)` |

Plus an end-of-plan verification artifact (not a source file modification):

| Artifact | Action | Notes |
|----------|--------|-------|
| `npx jest --runInBand` log capture | Produce | Saved to PR description (or attached as a workflow artifact) — handed off to SPEC-029-2-02 |

One commit for the conversion. The verification produces an artifact, not a commit.

## Implementation Details

### Per-file procedure (runtime.test.ts)

This file deviates from the SPEC-029-1-01 / SPEC-029-1-04 procedures because daemon lifecycle is involved. Procedure:

1. **Read the file end-to-end** with extra attention to:
   - The daemon spawn site (typically `child_process.spawn` or a project-internal helper like `spawnDaemon()`).
   - The teardown site (`daemon.kill()` or `await teardownDaemon()`).
   - Any `await` on daemon-process death (e.g., `await new Promise((r) => daemon.on('exit', r))`).
   - Cross-`test_*` ordering: which `test_*` functions assume the daemon is running, which assume a fresh spawn, which assume specific prior state.

2. **Compute `pre` count.** Same definition as SPEC-029-1-01 step 2.

3. **Map test ordering.** Write a short table (in the commit body's reviewer note) listing each `test_*` function and the lifecycle phase it depends on:

   | Test function | Daemon state required | Order-dependent? |
   |---------------|----------------------|------------------|
   | test_initial_handshake | freshly spawned | yes (must be first) |
   | test_register_agent | post-handshake | yes |
   | test_dispatch_request | running with registered agent | yes |
   | test_graceful_shutdown | running | yes (must be last before teardown) |
   | test_pure_serialization | n/a | no |

   This table determines whether the lift uses `beforeAll`/`afterAll` (one daemon for the whole suite) or `beforeEach`/`afterEach` (one daemon per case). For `runtime.test.ts`, `beforeAll`/`afterAll` is the expected choice — spawning a daemon per `it()` would multiply test time.

4. **Rewrite the bottom-of-file harness.** Target shape:

   ```ts
   describe('AgentFactoryRuntime', () => {
     let daemon: ChildProcess;

     beforeAll(async () => {
       daemon = await spawnDaemon(/* args */);
       // Wait for ready signal (existing helper, copied from runTests body)
       await waitForReady(daemon);
     });

     afterAll(async () => {
       if (daemon && !daemon.killed) {
         daemon.kill('SIGTERM');
         await new Promise<void>((resolve) => {
           daemon.once('exit', () => resolve());
         });
       }
     });

     // Order matters here. jest preserves declaration order within a describe.
     it('completes initial handshake', async () => { await test_initial_handshake(daemon); });
     it('registers an agent', async () => { await test_register_agent(daemon); });
     it('dispatches a request', async () => { await test_dispatch_request(daemon); });
     it('shuts down gracefully', async () => { await test_graceful_shutdown(daemon); });
     it('serializes pure helper input', async () => { await test_pure_serialization(); });
   });
   ```

   Conversion rules:
   - The `daemon` reference moves from `runTests`-local to `describe`-local. The `beforeAll` populates it; the `afterAll` cleans it; each `it` reads it.
   - If the original `test_*` functions took the daemon handle as a parameter, thread the closure variable in. If they read it from a module-level mutable — keep the module-level mutable, just have `beforeAll` write to it.
   - The `await new Promise<void>((resolve) => daemon.once('exit', () => resolve()))` block in `afterAll` is **non-negotiable**. A bare `daemon.kill()` is fire-and-forget and leaks a zombie process. The `await` ensures jest only finalises the worker after the daemon is dead.
   - If the original `runTests` had a `try { ... } finally { teardown(); }` shape, mirror the safety in `afterAll` by using `if (daemon && !daemon.killed)`-style guards.

5. **Side-effect import audit (FR-1606).** Same as SPEC-029-1-01 step 4.

6. **Per-file isolation check.** Run `npx jest plugins/autonomous-dev/tests/agent-factory/runtime.test.ts --runInBand`. Expected: a jest pass/fail summary. The total runtime should be within 2× of the original `runTests` wall-clock (daemon spawn dominates; no extra cost is incurred by jest's `it` decomposition).

7. **Process leak check (mandatory for this file only).** After the per-file isolation run completes, run:

   ```
   $ ps -ef | grep -i daemon | grep -v grep
   ```

   Expected: zero matches for any daemon process spawned by `runtime.test.ts`. Document the check (and its empty result) in the commit body. If matches appear, the `afterAll` teardown is broken — fix before commit.

8. **Compute `post` count** and **verify `pre === post`.** Same as SPEC-029-1-01 steps 6–7.

9. **Commit.** Format (longer body than other batches; reviewer note required):

   ```
   refactor(test-harness): convert tests/agent-factory/runtime.test.ts to idiomatic jest

   This is the highest-risk file in PLAN-029-1: a multi-step daemon lifecycle
   that the harness pattern absorbed implicitly. Under jest, daemon spawn lives
   in beforeAll, teardown lives in afterAll. The afterAll explicitly awaits
   daemon process death so jest does not leak zombie processes between workers.

   Test ordering preserved (it() blocks declare in the same sequence as the
   original tests array). Order-dependent cases:
     - test_initial_handshake (must be first)
     - test_register_agent (depends on handshake)
     - test_dispatch_request (depends on registration)
     - test_graceful_shutdown (must precede teardown)
     - test_pure_serialization (order-independent; placed last)

   Manual leak check: `ps -ef | grep -i daemon` after a full per-file run
   produced zero matches.

   preserved-assertions: <pre> -> <post>
   side-effect-imports: <list-or-none>
   setup-reshape: lifted spawnDaemon() into beforeAll, teardown into afterAll
                  (afterAll explicitly awaits daemon 'exit' event).

   Refs PRD-016 FR-1601, FR-1602, FR-1603, FR-1606; TDD-029 §5, §5.3 (complex);
   PLAN-029-1 Task 5.
   ```

### End-of-plan verification (PLAN-029-1 Task 6)

Run AFTER the conversion commit lands and AFTER all four upstream specs (SPEC-029-1-01..04) are merged. The verification produces an artifact for downstream specs; it does NOT modify code.

1. **Tree-level grep checks.** From repo root:

   ```
   $ git grep -n "process\.exit" plugins/autonomous-dev/tests/
   $ git grep -n "runTests()" plugins/autonomous-dev/tests/
   ```

   Both must return zero hits. Any hit is a regression and blocks the PR.

2. **Full jest run.** From `plugins/autonomous-dev/`:

   ```
   $ npx jest --runInBand 2>&1 | tee /tmp/jest-postmigration-$(date +%Y%m%d-%H%M%S).log
   ```

   Expected outcome: jest exits with a summary (zero-or-more PASS, zero-or-more FAIL) — **not** a worker crash. The exit code MAY be non-zero (failures are dispositioned by SPEC-029-2-*); a worker crash exit is a failure of THIS spec.

3. **FAIL-list extraction.** From the captured log:

   ```
   $ grep -E "^FAIL " /tmp/jest-postmigration-*.log | sort -u
   ```

   This produces the canonical list of FAIL suite paths that SPEC-029-2-02 ingests. The list MUST be attached to:
   - The PR description (verbatim copy in a fenced block), OR
   - A workflow artifact named `jest-postmigration-faillist.txt`.

4. **Per-file `preserved-assertions` audit.** For each of the 23 commits in PLAN-029-1 (7 from SPEC-029-1-01, 7 from SPEC-029-1-02, 6 from SPEC-029-1-03, 3 from SPEC-029-1-04, 1 from this spec):

   ```
   $ git log --grep "preserved-assertions:" --pretty=format:"%h %s%n%b" docs/specs-from-tdd-029
   ```

   Cross-check that every conversion commit has a `preserved-assertions: <a> -> <b>` line where `a == b`. Any mismatch is a FR-1603 violation; document and either fix in a follow-up commit or escalate.

5. **Hand-off to SPEC-029-2-02.** Confirm the FAIL list (step 3) is recorded and visible to the engineer implementing SPEC-029-2-02. The triage matrix populates from this exact list.

The verification produces no commit. Its artifact is the captured log + FAIL list.

### What NOT to do

- Do NOT re-spawn the daemon per `it()` (no `beforeEach(spawn)`). The daemon is expensive; one spawn per suite is the design.
- Do NOT use `daemon.kill()` without an `await` on the `'exit'` event. Fire-and-forget kill leaks zombies.
- Do NOT reorder `it()` blocks relative to the original `tests` array. The order encodes lifecycle dependencies.
- Do NOT inline `test_*` function bodies into `it` blocks.
- Do NOT widen coverage. No new test cases.
- Do NOT skip the `ps -ef | grep` leak check. Document its result in the commit body.
- Do NOT begin end-of-plan verification before all four upstream specs are merged. Partial verification is misleading.

## Acceptance Criteria

- [ ] `tests/agent-factory/runtime.test.ts` has its `runTests()` IIFE replaced by a single `describe('AgentFactoryRuntime', ...)` block with `beforeAll`/`afterAll` hooks containing daemon spawn and teardown.
- [ ] The `afterAll` hook awaits the daemon `'exit'` event before resolving.
- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests/agent-factory/runtime.test.ts` returns zero hits.
- [ ] `git grep -n "runTests()" plugins/autonomous-dev/tests/agent-factory/runtime.test.ts` returns zero hits.
- [ ] One conversion commit exists on the branch with body matching the §Implementation Details step-9 template (including `preserved-assertions:`, `side-effect-imports:`, `setup-reshape:`, and the test-ordering table).
- [ ] `preserved-assertions: <pre> -> <post>` numbers are equal in the commit body.
- [ ] Commit body documents the manual leak check result (`ps -ef | grep -i daemon` returned zero matches after a full per-file run).
- [ ] Commit body references `Refs PRD-016 FR-1601, FR-1602, FR-1603, FR-1606; TDD-029 §5, §5.3 (complex); PLAN-029-1 Task 5.`
- [ ] `npx jest plugins/autonomous-dev/tests/agent-factory/runtime.test.ts --runInBand` produces a jest pass/fail summary (no worker crash).
- [ ] No `test_*` function body is modified.
- [ ] No production-code files (`src/agent-factory/runtime/**` etc.) modified.

End-of-plan verification (separate gates; produced after merge of upstream specs):

- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests/` returns zero hits across the entire `tests/` tree.
- [ ] `git grep -n "runTests()" plugins/autonomous-dev/tests/` returns zero hits.
- [ ] `npx jest --runInBand` from `plugins/autonomous-dev/` runs to a full pass/fail summary; exit code may be non-zero but the run does NOT abort with a worker crash.
- [ ] The captured `npx jest --runInBand` log is attached to the PR description or as a workflow artifact and is visible to the SPEC-029-2-02 implementer.
- [ ] The extracted FAIL-list is recorded as the input for SPEC-029-2-02.
- [ ] `git log --grep "preserved-assertions:"` shows ≥24 commits (one per migrated file across SPEC-029-1-01..05); each has matching pre/post numbers.

## Dependencies

- **Blocked by**: SPEC-029-1-01, SPEC-029-1-02, SPEC-029-1-03, SPEC-029-1-04 — end-of-plan verification requires the entire migration to be complete before the full jest run is meaningful.
- **Blocks**: SPEC-029-2-01 (triage matrix scaffold) and SPEC-029-2-02 (FAIL-list ingest) — both consume the captured log produced by the verification.
- **Blocks**: SPEC-029-3-* (CI gate) — the gate's `--ci` flag turns the build red on any non-skipped failure. Until SPEC-029-2-* lands skip annotations for the FAIL list captured here, SPEC-029-3 cannot ship green.

## Notes

- `runtime.test.ts` is the file the original PLAN-029-1 budgets a half-day for despite its modest LOC. The reason is daemon-spawn risk, not code complexity. Treat the half-day as a careful-review budget, not as license to add scope.
- The `'exit'` event await pattern is the single most important safeguard in this spec. A naive `daemon.kill()` without await produces flaky CI behavior that takes hours to diagnose later. The reviewer should grep for `daemon.kill` and verify each instance is followed (in the same `afterAll`) by a Promise that resolves on `'exit'`.
- The `ps -ef | grep` leak check is documented in the commit body specifically so a future reader can verify the safeguard was exercised. If the test is later modified and the leak check is omitted, the commit body's text shows the original protocol.
- End-of-plan verification produces the artifact that gates SPEC-029-2-02. Without a captured log, SPEC-029-2-02 cannot start. The implementer of SPEC-029-2-02 should refuse to start work until the artifact is provided.
- If the post-migration FAIL count (extracted in step 3 of verification) exceeds 50, escalate to PRD-016 OQ-07 / TDD-029 OQ-29-06: split into PRD-016A (harness migration only) + PRD-016B (triage). PLAN-029-1 still merges; PLAN-029-2 re-scopes. This spec's deliverable is unaffected — it produced the count that triggered the split.
- The `test_pure_serialization` example in §Implementation Details is illustrative; the actual `runtime.test.ts` may not have a pure-helper test. Order-independent tests (if any exist) are placed last so they do not interfere with daemon-state ordering.
- A worst-case outcome for this spec is that the `beforeAll`/`afterAll` lift introduces a flake the original harness masked. Detection is the per-file isolation check (step 6 above); mitigation is documented in TDD-029 §10.4 (canary criteria) and §11 (test strategy).
