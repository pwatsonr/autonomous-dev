# SPEC-030-2-02: `heartbeat-pipeline.ts` (no redaction; pattern lock-in)

## Metadata
- **Parent Plan**: PLAN-030-2 (TDD-015 portal pipeline closeout)
- **Parent TDD**: TDD-030 §6.2, §6.3
- **Tasks Covered**: TASK-002 (heartbeat-pipeline.ts + test + fixtures + SSE wire)
- **Estimated effort**: 0.75 day
- **Depends on**: SPEC-030-2-01 merged
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-2-02-heartbeat-pipeline.md`

## Description

Implement the simplest of the three new portal pipelines: heartbeat. No redaction (TDD-030 §6.2 confirms no PII in heartbeat); just `FileWatcher` → schema-validate → emit. This pipeline establishes the pattern that SPEC-030-2-03 (cost) and SPEC-030-2-04 (log) copy.

The pipeline `implements Pipeline<HeartbeatPayload>` from SPEC-030-2-01. It reuses the existing `HeartbeatReader` schema at `plugins/autonomous-dev-portal/server/readers/schemas/heartbeat.ts` and the `FileWatcher` at `plugins/autonomous-dev-portal/server/watchers/`. No reader, schema, or redaction code is modified.

The pipeline emits to the `heartbeat` SSE topic. SSE wiring is verified — and only modified if the topic is not already known to the bus (verify before modifying per TDD-030 §6.4).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/server/integration/heartbeat-pipeline.ts` | Create | Implements `Pipeline<HeartbeatPayload>` from SPEC-030-2-01 |
| `plugins/autonomous-dev-portal/server/integration/__tests__/heartbeat-pipeline.test.ts` | Create | Happy / error / recovery |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/heartbeat-valid.jsonl` | Create | At least 3 valid lines |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/heartbeat-malformed.jsonl` | Create | Mix of valid + malformed |
| `plugins/autonomous-dev-portal/server/sse/index.ts` | Modify (only if needed) | Register `heartbeat` topic if not already known |

If the SSE bus already accepts the `heartbeat` topic name (TDD-015's existing wiring), do NOT modify `server/sse/index.ts`. Verify by reading the file before modifying.

## Implementation Details

### `heartbeat-pipeline.ts`

Public surface:

```ts
import type { Pipeline, PipelineErrorPayload } from './pipeline-types';
import { EventEmitter } from 'node:events';
// Read existing FileWatcher and HeartbeatReader exports before authoring;
// the import paths below are illustrative and MUST be verified.
import { FileWatcher } from '../watchers/FileWatcher';
import { HeartbeatReader } from '../readers/HeartbeatReader';
import type { HeartbeatPayload } from '../readers/schemas/heartbeat';

export interface HeartbeatPipelineConfig {
  /** Absolute path to the watched heartbeat.jsonl file. */
  filePath: string;
}

export class HeartbeatPipeline implements Pipeline<HeartbeatPayload> {
  private readonly emitter = new EventEmitter();
  private watcher?: FileWatcher;
  private reader?: HeartbeatReader;

  constructor(private readonly cfg: HeartbeatPipelineConfig) {}

  async start(): Promise<void> { /* ... */ }
  async stop(): Promise<void>  { /* ... */ }

  on(event: 'data', listener: (p: HeartbeatPayload) => void): void;
  on(event: 'error', listener: (e: PipelineErrorPayload) => void): void;
  on(event: 'recovered', listener: () => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener);
  }
}
```

Behavior:

1. `start()` instantiates a `FileWatcher` on `cfg.filePath`. On each watcher event, the pipeline reads new lines via `HeartbeatReader` (or the equivalent `readLines`-style helper exposed by the existing reader; verify by reading `HeartbeatReader.ts` before authoring), validates each against the heartbeat schema, and emits `'data'` per valid line.
2. Malformed lines emit `'error'` with `code: 'SCHEMA_VALIDATION'` and `cause: <zod or schema error>`. The pipeline does NOT stop; the next valid line still emits `'data'`.
3. A simulated transient watcher error (file unlinked then recreated) emits `'error'` (`code: 'WATCHER_ENOENT'`) followed by `'recovered'` once the watcher reattaches.
4. `start()` is idempotent (second call resolves without re-attaching).
5. `stop()` removes all listeners on the watcher and the internal emitter; resolves after the watcher is fully detached.

The pipeline does **not** call `redaction.redactLog` or any redaction helper. The heartbeat schema's payload is treated as PII-free per TDD-030 §6.2.

SSE bridge: a one-line subscriber in the SSE module forwards every `'data'` event to the `heartbeat` topic. If the SSE bus auto-registers topics on first publish, the bridge is just `pipeline.on('data', (p) => sseBus.publish('heartbeat', p))`. If registration is required, register `heartbeat` first. Verify by reading `server/sse/index.ts` before modifying.

### `heartbeat-pipeline.test.ts`

Setup pattern:

```ts
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let filePath: string;
let pipeline: HeartbeatPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heartbeat-pipeline-'));
  filePath = join(dir, 'heartbeat.jsonl');
  writeFileSync(filePath, '');  // pre-create empty file so watcher attaches
});

afterEach(async () => {
  await pipeline?.stop();
  rmSync(dir, { recursive: true, force: true });
});
```

Test cases:

| Case | Setup | Assertion |
|------|-------|-----------|
| Happy path | start(); append a valid heartbeat line | Within 500 ms, exactly one `'data'` event with parsed payload |
| Malformed line | start(); append malformed line then valid line | One `'error'` then one `'data'`; pipeline still running |
| Recovery | start(); unlink + recreate file; append valid line | One `'error'` (code: WATCHER_ENOENT) then one `'recovered'`; subsequent `'data'` works |
| Idempotent start | start(); start() | Second call resolves; only one watcher attached |
| Idempotent stop | start(); stop(); stop() | Second stop resolves; no error |

Constraints:
- Each "wait for event" uses an explicit `Promise<T>` with a 500 ms `setTimeout` that rejects with a typed error. NO arbitrary `setTimeout` to mask flake.
- `appendFileSync` (synchronous fs writes) is used instead of `appendFile` to make the watcher's event timing more predictable.
- Test runtime budget: ≤500 ms per `it`.

### Fixtures

`heartbeat-valid.jsonl` (3 lines):
```
{"ts":"2026-05-02T00:00:00.000Z","status":"ok"}
{"ts":"2026-05-02T00:00:01.000Z","status":"ok"}
{"ts":"2026-05-02T00:00:02.000Z","status":"degraded","reason":"high-latency"}
```

(Adjust shape to match the real `heartbeat.ts` schema — read it first.)

`heartbeat-malformed.jsonl` (3 lines):
```
{"ts":"2026-05-02T00:00:00.000Z","status":"ok"}
not-json
{"ts":"oops","status":42}
```

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev-portal/server/integration/heartbeat-pipeline.ts` exists and exports a `HeartbeatPipeline` class that `implements Pipeline<HeartbeatPayload>`.
- AC-2: The class has `start()`, `stop()`, and three overloaded `on(...)` signatures matching SPEC-030-2-01.
- AC-3: `npx jest plugins/autonomous-dev-portal/server/integration/__tests__/heartbeat-pipeline.test.ts` from the autonomous-dev plugin root exits 0.
- AC-4: All five test cases (happy, malformed, recovery, idempotent start, idempotent stop) pass.
- AC-5: Each `it()` completes in ≤500 ms (TDD-030 §8.4 budget).
- AC-6: Line coverage of `heartbeat-pipeline.ts` ≥ 80 %.
- AC-7: `tsc --noEmit` from the portal passes.
- AC-8: The portal's existing `bun test` continues to pass.
- AC-9: `state-pipeline.ts`, `redaction.ts`, `HeartbeatReader.ts`, `schemas/heartbeat.ts`, and `FileWatcher.ts` are unmodified by this spec. `git diff main` against those files returns empty.
- AC-10: SSE wiring: touching the watched file results in a `heartbeat` SSE message to a connected client during the manual smoke (TDD-030 §10.4). Captured in PR description.
- AC-11: All `'error'` payloads have a typed `code` property (`SCHEMA_VALIDATION` or `WATCHER_ENOENT`); a grep for `error.message ===` against the test file returns zero hits.
- AC-12: The pipeline does NOT import `redaction` or any redaction helper. `grep "redaction" heartbeat-pipeline.ts` returns zero hits.

### Given/When/Then

```
Given a HeartbeatPipeline started on an empty heartbeat.jsonl file
When a valid heartbeat JSON line is appended to the file
Then within 500 ms the pipeline emits exactly one 'data' event
And the payload matches the heartbeat schema's inferred type

Given a running HeartbeatPipeline
When a malformed line is appended followed by a valid line
Then the pipeline emits one 'error' event (code: SCHEMA_VALIDATION) and one 'data' event
And the pipeline remains running (subsequent valid lines still emit)

Given a running HeartbeatPipeline
When the watched file is unlinked and recreated
Then the pipeline emits one 'error' event (code: WATCHER_ENOENT) followed by one 'recovered' event
And subsequent appends emit 'data' as expected
```

## Test Requirements

The test file must:
1. Pass under `npx jest --runInBand`.
2. Pass in isolation: `npx jest <path>`.
3. Achieve ≥ 80 % line coverage on `heartbeat-pipeline.ts` when run with `--coverage`.
4. Use the explicit "wait for event with 500 ms timeout" pattern; no bare `setTimeout`.
5. Clean up `mkdtempSync` directories in `afterEach`.

## Implementation Notes

- The `FileWatcher` API is the existing portal class; do NOT reimplement file watching with `chokidar` or `fs.watch` directly. Read `server/watchers/FileWatcher.ts` first to confirm the subscribe / event API.
- The `HeartbeatReader` may already encapsulate line-by-line parsing; if so, reuse it via composition (do not subclass). If only a schema (`schemas/heartbeat.ts`) exists and no `HeartbeatReader.ts`, the pipeline takes ownership of newline splitting (split on `\\n`, ignore trailing empty line).
- The "recovery path" test is inherently file-watcher-flake-prone. The 500 ms timeout per "wait for event" is the explicit mitigation; CI 3-green flake check before merge is the second.
- This spec is the **pattern lock**. Once merged, SPEC-030-2-03 and SPEC-030-2-04 copy this structure verbatim, only changing the redaction and schema details.

## Rollout Considerations

The pipeline is gated off-by-default at the config level (TDD-030 §10.3). Merging this spec does not enable heartbeat emission until an operator turns it on via the live-data settings UI. Revert by deleting the four created files and the SSE wiring delta (if any).

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| FileWatcher event timing flakes on CI | Medium | Medium | Explicit 500 ms wait pattern; 3-green CI check before merge |
| HeartbeatReader API differs from assumption | Medium | Low | Read the file first; adjust import shape |
| SSE topic registration is non-trivial | Low | Low | Verify before modifying `server/sse/index.ts`; many SSE buses auto-register on first publish |
| `heartbeat` topic already wired by TDD-015 (silent collision) | Low | Low | Verify by reading SSE module first; no-op the wiring if already present |
| Test temp dir leaks between cases | Low | Low | `rmSync(..., {recursive: true, force: true})` in `afterEach` |
