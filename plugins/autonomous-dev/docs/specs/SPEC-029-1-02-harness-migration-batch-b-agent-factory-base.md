# SPEC-029-1-02: Harness Migration Batch B — agent-factory base (7 files)

## Metadata
- **Parent Plan**: PLAN-029-1 (Custom-Harness Migration to Idiomatic Jest)
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-1 Task 2 (Batch B base — 7 files in `tests/agent-factory/` excluding `runtime.test.ts`)
- **Estimated effort**: 1.5 days (~7 × 30 min mechanical conversion + ~30 min review/verify per file)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-029-1-02-harness-migration-batch-b-agent-factory-base.md`
- **Depends on**: SPEC-029-1-01 (preceding batch establishes the conversion pattern; non-blocking but conceptually sequential)

## Description
Convert the seven base agent-factory `.test.ts` files (everything in `plugins/autonomous-dev/tests/agent-factory/` *except* `runtime.test.ts`) from custom-harness `runTests()` IIFE to idiomatic jest `describe`/`it`/`expect`. Same Strategy-A mechanical recipe as SPEC-029-1-01: leave each `test_*` function body intact, replace only the bottom-of-file harness scaffold, preserve assertion count 1:1.

`runtime.test.ts` is **explicitly excluded** from this batch because its multi-step daemon lifecycle requires `beforeAll`/`afterAll` hoisting (handled in SPEC-029-1-05). The seven files in this batch all follow the same simple flat-`tests`-array shape as SPEC-029-1-01.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/agent-factory/agents.test.ts` | Modify | Replace `runTests()` IIFE with `describe`/`it` block |
| `plugins/autonomous-dev/tests/agent-factory/audit.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/agent-factory/cli.test.ts` | Modify | Same; check for any `process.argv` mutations that need `beforeEach`/`afterEach` reset |
| `plugins/autonomous-dev/tests/agent-factory/config.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/agent-factory/discovery.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/agent-factory/parser.test.ts` | Modify | Same |
| `plugins/autonomous-dev/tests/agent-factory/validator.test.ts` | Modify | Same |

`tests/agent-factory/runtime.test.ts` is OUT OF SCOPE for this spec — owned by SPEC-029-1-05.

Seven file modifications, one commit per file (no squash).

## Implementation Details

### Per-file procedure

The procedure is identical to SPEC-029-1-01 §Implementation Details `Per-file procedure` steps 1–8. Summary:

1. Read file; identify `tests` array, `runTests()` IIFE, trailing `process.exit`, side-effect imports.
2. Compute `pre` count: sum of `assert(`, `if (...failed...)`, `throw new Error(` sites reachable from the original `runTests` body.
3. Replace the `tests = [...]` array and `runTests()` IIFE with one `describe(...) { it(...); ... }` block. Preserve `it()` order to match the `tests` array order. Each `it` body delegates: `async () => { await test_*(); }`. Do NOT inline `test_*` bodies.
4. Side-effect import audit per FR-1606: hoist any unreferenced relative imports into `beforeAll(() => register())` if they expose a callable register entry point; otherwise add a `// side-effect-only import: <reason>` comment.
5. Run `npx jest <path> --runInBand`; require a jest pass/fail summary (no worker crash).
6. Compute `post` count: `it(` + `expect(` + surviving `assert(` sites.
7. Verify `pre === post`. Mismatch ⇒ revert and recount.
8. Commit. Format:

   ```
   refactor(test-harness): convert tests/agent-factory/<file>.test.ts to idiomatic jest

   Replace top-level runTests() IIFE with describe/it blocks. Each former
   tests-array entry becomes an it() that delegates to its test_* function.
   Removes process.exit(1) so the suite no longer crashes the jest worker.

   preserved-assertions: <pre> -> <post>
   side-effect-imports: <list-or-none>

   Refs PRD-016 FR-1601, FR-1602, FR-1603; TDD-029 §5; PLAN-029-1 Task 2.
   ```

### File-by-file specifics

| File | Notes |
|------|-------|
| `tests/agent-factory/agents.test.ts` | Suite name: `AgentFactoryAgents` (or what the existing top-of-file comment specifies). Inspect for `agentRegistry.register(...)` side-effects at module load. |
| `tests/agent-factory/audit.test.ts` | Suite name: `AgentFactoryAudit`. Likely no shared state. |
| `tests/agent-factory/cli.test.ts` | Suite name: `AgentFactoryCli`. **Special:** if any `test_*` mutates `process.argv` or `process.env`, capture the original in a `beforeEach` and restore in `afterEach`. This is a TODO **only if observed**; do not preemptively wrap state that the original tests handled internally. |
| `tests/agent-factory/config.test.ts` | Suite name: `AgentFactoryConfig`. Inspect for env-var or working-directory side-effects. |
| `tests/agent-factory/discovery.test.ts` | Suite name: `AgentFactoryDiscovery`. Inspect for plugin-registry mutations. |
| `tests/agent-factory/parser.test.ts` | Suite name: `AgentFactoryParser`. Pure-function suite; safest of the batch. |
| `tests/agent-factory/validator.test.ts` | Suite name: `AgentFactoryValidator`. Pure-function suite; second safest. |

### `process.argv` / `process.env` guard (cli.test.ts only)

If, and only if, `cli.test.ts` shows any `test_*` function that writes to `process.argv` or `process.env` without restoring it, add the following at the top of the new `describe` block:

```ts
describe('AgentFactoryCli', () => {
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalArgv = process.argv;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  it('...', async () => { await test_*(); });
  // ...
});
```

Document the guard in the commit body's `setup-reshape:` line. If no mutation is observed, do NOT add the guard — the spirit of Strategy A is mechanical 1:1 conversion, not preemptive hardening.

### What NOT to do

- Do NOT migrate `tests/agent-factory/runtime.test.ts` in this spec (owned by SPEC-029-1-05).
- Do NOT rewrite `assert(...)` to `expect(...)`.
- Do NOT inline `test_*` function bodies.
- Do NOT delete the file-local `function assert(...)` helper.
- Do NOT squash the seven commits.
- Do NOT modify production code in `src/agent-factory/`.

## Acceptance Criteria

- [ ] All seven files (`agents`, `audit`, `cli`, `config`, `discovery`, `parser`, `validator`) have their `runTests()` IIFE replaced by a single `describe(...)` block.
- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests/agent-factory/agents.test.ts plugins/autonomous-dev/tests/agent-factory/audit.test.ts plugins/autonomous-dev/tests/agent-factory/cli.test.ts plugins/autonomous-dev/tests/agent-factory/config.test.ts plugins/autonomous-dev/tests/agent-factory/discovery.test.ts plugins/autonomous-dev/tests/agent-factory/parser.test.ts plugins/autonomous-dev/tests/agent-factory/validator.test.ts` returns zero hits.
- [ ] `git grep -n "process\.exit" plugins/autonomous-dev/tests/agent-factory/runtime.test.ts` STILL returns hits — this is correct (handled by SPEC-029-1-05).
- [ ] `git grep -n "runTests()" <same seven files>` returns zero hits.
- [ ] Seven commits exist on the branch, one per file, in alphabetical-by-path order.
- [ ] Each commit body contains a line matching `^preserved-assertions: \d+ -> \d+$` and the two numbers are equal.
- [ ] Each commit body contains a `side-effect-imports:` line.
- [ ] If `cli.test.ts` was given a `process.argv`/`process.env` `beforeEach`/`afterEach` guard, its commit body contains a `setup-reshape:` line documenting the change.
- [ ] Each commit body contains the reference suffix `Refs PRD-016 FR-1601, FR-1602, FR-1603; TDD-029 §5; PLAN-029-1 Task 2.`
- [ ] `npx jest plugins/autonomous-dev/tests/agent-factory/agents.test.ts --runInBand` produces a jest pass/fail summary (no worker crash). Same for the other six files individually.
- [ ] `npx jest plugins/autonomous-dev/tests/agent-factory --runInBand` runs to a summary; the only file that may still crash the worker is `runtime.test.ts` (out-of-scope for this spec).
- [ ] No `test_*` function body is modified.
- [ ] No new test files; no deleted test files.
- [ ] No production-code files modified.

## Dependencies

- **Blocked by**: SPEC-029-1-01 only loosely (the conversion pattern is established there; this spec is mechanically independent and could land in parallel).
- **Blocks**: SPEC-029-1-05 (Batch D complex + verification) — needs the seven base files migrated so that the cumulative `npx jest tests/agent-factory --runInBand` smoke check at the start of `runtime.test.ts` work shows only one remaining crash source.
- **Blocks**: SPEC-029-2-* (triage matrix), SPEC-029-3-* (CI gate) — same downstream chain as the parent plan.

## Notes

- All seven files in this batch were grouped because they share the same harness shape AND the same module boundary (`agent-factory/`). Reviewing them as a batch lets the reviewer skim seven adjacent commits with identical diff shape.
- The `cli.test.ts` `process.argv`/`process.env` guard is the only deviation permitted from a pure mechanical conversion in this spec. The reason: the original `runTests()` IIFE ran the seven `test_*` functions in sequence inside one process; per-test argv mutation was self-correcting because each test set what it needed before reading. Under jest, each `it` runs in the same worker process but jest does NOT reset argv/env between cases — so a leak in `test_a` corrupts `test_b`. The guard preserves the original implicit isolation.
- If a `test_*` function in `discovery.test.ts` or `agents.test.ts` mutates a module-level registry, leave the mutation in place but inspect for a corresponding cleanup. If cleanup is missing, raise it as a triage row in SPEC-029-2-02 — do NOT fix it in this spec (out of scope per FR-1603 1:1 discipline).
- Commit ordering is alphabetical-by-path: `agents`, `audit`, `cli`, `config`, `discovery`, `parser`, `validator`.
- After this spec lands, the agent-factory directory has one remaining harness file (`runtime.test.ts`); `git grep -c "process\.exit" plugins/autonomous-dev/tests/agent-factory/` should equal exactly the number of `process.exit` references in `runtime.test.ts` (typically 1). This number is the exit criterion for SPEC-029-1-05.
