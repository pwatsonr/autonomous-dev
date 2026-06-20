# Reliability harness (#524)

A repeatable **"run-until-N-green"** harness that measures the autonomous-dev
pipeline's end-to-end **success rate** and **determinism**. It is the
acceptance metric for the *road to 100%* epic (#532).

It submits a version-controlled [task suite](./task-suite.json) of
representative requests against a **disposable scratch repo**, polls each to a
terminal state, reads the per-request `state.json` `phase_history`, and reports
success rate, per-phase failure attribution, per-task determinism, and
cost/retry stats — as a human table **and** machine-readable JSON.

> ## ⚠️ COST WARNING
> A **live** run is **~$3 and ~30 minutes per `(task × repeat)`**. The full
> suite (3 tasks) at `--repeats 3` is **9 runs ≈ $27 / a few hours**.
> Running a real batch is the **operator's deliberate choice** — start with
> `--dry-run` (mocked, **$0**), and scope live cost with `--tasks` / `--repeats`.

## Quick start

```bash
# From the plugin root: plugins/autonomous-dev

# 1) Free dry-run — exercises the full submit→poll→read→aggregate wiring
#    against a MOCK daemon (no cost, no real requests):
bun tools/reliability/cli.ts --repo /tmp/scratch-repo --dry-run

# 2) Live single trivial run (~$3) against a throwaway repo:
bun tools/reliability/cli.ts --repo ~/codebase/smoke-hello --tasks trivial-docs-readme

# 3) Determinism sweep: every task, 3 repeats, JSON report to disk:
bun tools/reliability/cli.ts --repo ~/codebase/scratch --tasks all --repeats 3 \
    --out reliability-report.json
```

The process **exits 0 only when every run was green** (`successRate == 1`),
`1` on any non-green / error, `2` on bad args, `3` when the repo guard refuses
the target — so it slots into a CI "gate" or a `run-until-N-green` loop.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <path>` | — | **REQUIRED.** Disposable scratch repo. Refuses the autonomous-dev repo (see Guard). |
| `--tasks <ids\|all>` | `all` | Comma-separated task ids from `task-suite.json`, or `all`. |
| `--repeats <N>` | `1` | Repeats per task. Two-or-more is what reveals **non-determinism (flakiness)**. |
| `--dry-run` | off | Mocked CLI + `state.json`; no daemon, **$0**. |
| `--out <file>` | — | Write the machine-readable JSON report. |
| `--timeout <ms>` | `1800000` | Per-run poll timeout (30 min). |
| `--interval <ms>` | `15000` | Poll interval (15 s). |
| `--suite <file>` | bundled | Override the task-suite path. |

## Task suite

[`task-suite.json`](./task-suite.json) is version-controlled and intentionally
small (keep it that way — each task costs real money/time). Entries span the
risk classes seen in production:

| id | sizeClass | shape |
| --- | --- | --- |
| `trivial-docs-readme` | `trivial-docs` | 1-line README append |
| `small-fn-with-test` | `small` | a function + a unit test |
| `standard-multifile-greet` | `standard` | a small multi-file refactor + tests |

Each entry is `{ id, description, sizeClass, expectedTerminalPhase: 'done' }`;
`sizeClass` is forwarded to the CLI `--size` flag. The shape is enforced by
[`task-suite.schema.json`](./task-suite.schema.json) and a load-time check.

## What it records

Per `(task × repeat)` the runner emits a `RunResult`:

```jsonc
{
  "taskId": "standard-multifile-greet", "repeat": 1,
  "requestId": "REQ-000123", "status": "done", "terminalPhase": "monitor",
  "perPhaseRetries": { "code": 1, "code_review": 0 }, "totalRetries": 1,
  "blocker": null, "costUsd": 2.7, "wallClockMs": 1683000
}
```

> A **healthy** completed request has `status: "done"` while `terminalPhase`
> (`request status .currentPhase`) is the **last** pipeline phase, `monitor` —
> not the literal `"done"`. Success is therefore keyed on `.status`.

The pure aggregation ([`aggregate.ts`](./aggregate.ts)) turns the
`RunResult[]` into a `Summary`:

- `successRate`, `successCount`, `totalRuns`
- `byTerminalStatus`, `byTerminalPhase`
- `perPhaseFailureHistogram` — which phase each failure is most attributable to
- `determinismByTask` — per-task success rate over repeats (`1.0` ==
  deterministic-green; `0 < x < 1` == flaky)
- `byTask` (incl. a `flaky` flag), `totalCostUsd`, `retryStats`, `costStats`

## The "never run against the daemon's own repo" guard

[`guard.ts`](./guard.ts) is the single choke point. `assertRepoAllowed(repo)`
is called by `runBatch` **before any submission** and throws
`ForbiddenRepoError` (→ exit `3`, `REFUSED:` message) when `--repo` resolves to
the autonomous-dev repo root **or any path nested inside it**.

- The protected root is derived from this file's own location
  (`tools/reliability/` → four levels up = the repo root), so it tracks the
  checkout with no hard-coded absolute path.
- Both sides are canonicalized (`~` expansion, `path.resolve`, and
  `realpathSync` symlink-follow), so `.`/`..`/symlink dodges don't slip past.
- An empty/missing `--repo` is also refused.

This protects against the daemon rewriting its **own source** mid-batch.

## Architecture (why it's testable without spending money)

| File | Role |
| --- | --- |
| `types.ts` | Shared data contracts (`Task`, `RunResult`, `Summary`). |
| `aggregate.ts` | **Pure** functions: `RunResult[]` → `Summary`. No I/O. |
| `guard.ts` | Repo-path safety guard. |
| `harness.ts` | `Harness` interface + `CliHarness` (real, shells to `autonomous-dev.sh` + reads `state.json`) + `MockHarness` (in-memory) + the `runBatch` orchestration. |
| `report.ts` | Pure text-table renderer. |
| `run-harness.ts` | Library: flags → guard → run → aggregate → render → exit code. **No side effects on import.** |
| `cli.ts` | Thin bun entrypoint (`#!/usr/bin/env bun` + `import.meta.main`). |
| `__tests__/` | `aggregate.test.ts` (pure-logic edge cases) + `run-harness.test.ts` (mock dry-run wiring + guard). |

`runBatch` talks to the pipeline **only** through the `Harness` interface and
takes an injectable clock/sleep, so `--dry-run` swaps in `MockHarness` and the
whole orchestration runs **deterministically and instantly** with no daemon.
That same mock path is what the runner test asserts.

## Tests & type-check

```bash
# Tests (repo standard runner — also runs under `bun test`):
npx jest tools/reliability          # 43 tests, 2 suites

# Type-check just these files (isolated; the repo-wide tsconfig excludes
# tools/ and carries unrelated pre-existing errors):
npx tsc -p tools/reliability/tsconfig.json --noEmit
```
