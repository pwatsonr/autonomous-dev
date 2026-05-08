# Portal Integration Pipeline Tests

These tests use **Jest** (not the portal's default `bun test`) per
[TDD-030](../../../../autonomous-dev/docs/tdd/TDD-030-closeout-backfill-014-015-019.md) §5.4 and §6.
They live under `server/integration/__tests__/` and are discovered by the
portal-local `jest.config.cjs` (a sibling of this README's package.json).

The portal's `bun test` continues to own the rest of the portal's tests; this
directory is the carve-out for the new live-data pipelines (cost, heartbeat,
log) shipped with TDD-030.

## Layout

| File                         | Pipeline                | Source artifact                                            |
|------------------------------|-------------------------|------------------------------------------------------------|
| `cost-pipeline.test.ts`      | `cost-pipeline.ts`      | `<request>/.autonomous-dev/cost.json` (rewritable JSON)    |
| `heartbeat-pipeline.test.ts` | `heartbeat-pipeline.ts` | `<request>/.autonomous-dev/heartbeat.jsonl` (append-only)  |
| `log-pipeline.test.ts`       | `log-pipeline.ts`       | `<request>/log.jsonl` (append-only + PII redaction)        |

## Mocking strategy

Per TDD-030 §6.4: tests use real `fs` operations against `mkdtempSync` temp
directories (no `fs` mocks). Watcher events are observed via the existing
`FileWatcher` class — the watcher is real, not stubbed. The pipelines
themselves are exercised end-to-end at the public-API surface (`start`,
`stop`, `on`).

## Coverage gate

`jest.config.cjs` enforces per-file `lines >= 80%` for each pipeline file
(SPEC-030-2-05). Adding a new file under `server/integration/` is an
explicit addition to `collectCoverageFrom` and `coverageThreshold` — not a
silent dilution.
