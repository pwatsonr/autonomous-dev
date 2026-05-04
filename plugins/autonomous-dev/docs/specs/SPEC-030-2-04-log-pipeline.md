# SPEC-030-2-04: `log-pipeline.ts` (append-only JSONL; full PII redaction)

## Metadata
- **Parent Plan**: PLAN-030-2 (TDD-015 portal pipeline closeout)
- **Parent TDD**: TDD-030 §6.2, §6.3, §8.1, §8.2
- **Tasks Covered**: TASK-004 (log-pipeline.ts + tests + fixtures + SSE wire)
- **Estimated effort**: 1 day
- **Depends on**: SPEC-030-2-01 (interface), SPEC-030-2-02 (heartbeat pattern), SPEC-030-2-03 (cost) merged
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-2-04-log-pipeline.md`

## Description

Implement the `log-pipeline.ts` portal live-data pipeline. Source artifact is `<request>/log.jsonl` — an **append-only JSONL** stream (NOT a rewritable JSON document; this is the key semantic difference from cost-pipeline). The pipeline tracks the last-read byte offset, only processes new lines on each watcher event, runs every entry through `redaction.redactLog(...)` before emission, and emits one `data` event per redacted entry.

Two behaviors set log-pipeline apart from heartbeat:
1. **Offset tracking** — only new bytes since the last read are processed.
2. **Truncation / rotation detection** — if file size shrinks or the inode changes, reset offset to 0 and reprocess from the start (after emitting an `error` + `recovered` pair).

The pipeline copies the SPEC-030-2-02 / 2-03 structure and `implements Pipeline<LogPayload>` from SPEC-030-2-01. It reuses `server/readers/schemas/log.ts`, `server/readers/redaction.ts` (for `redactLog`), and `FileWatcher`. None of those modules is modified by this spec.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/server/integration/log-pipeline.ts` | Create | Implements `Pipeline<LogPayload>` |
| `plugins/autonomous-dev-portal/server/integration/__tests__/log-pipeline.test.ts` | Create | Happy / malformed / redact / rotate / recovery |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/log-valid.jsonl` | Create | 3+ valid log lines |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/log-with-pii.jsonl` | Create | 1+ line containing `alice@example.test` |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/log-malformed.jsonl` | Create | Mix of valid + corrupt lines |
| `plugins/autonomous-dev-portal/server/sse/index.ts` | Modify (only if needed) | Register `log-line` topic if not auto-registered |

## Implementation Details

### `log-pipeline.ts` — public surface

```ts
import { EventEmitter } from 'node:events';
import { open, stat } from 'node:fs/promises';
import type { Pipeline, PipelineErrorPayload } from './pipeline-types';
import { FileWatcher } from '../watchers/FileWatcher';
import { logSchema } from '../readers/schemas/log'; // verify export name
import type { LogPayload } from '../readers/schemas/log';
import { redactLog } from '../readers/redaction'; // verify export name

export interface LogPipelineConfig {
  /** Absolute path to the watched log.jsonl file. */
  filePath: string;
  /** Optional starting offset (default: file end at start, so historical lines are NOT re-emitted). */
  startAt?: 'beginning' | 'end';
}

export class LogPipeline implements Pipeline<LogPayload> {
  private readonly emitter = new EventEmitter();
  private watcher?: FileWatcher;
  private offset = 0;
  private inode?: number;
  private buffer = ''; // partial-line buffer across reads

  constructor(private readonly cfg: LogPipelineConfig) {}

  async start(): Promise<void> { /* ... */ }
  async stop(): Promise<void>  { /* ... */ }

  on(event: 'data', listener: (p: LogPayload) => void): void;
  on(event: 'error', listener: (e: PipelineErrorPayload) => void): void;
  on(event: 'recovered', listener: () => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener);
  }
}
```

### Behavior

1. **`start()`**:
   - `stat(filePath)`: capture initial `size` and `ino`. The `ino` is the rotation sentinel.
   - Set `offset = (cfg.startAt === 'beginning') ? 0 : size`. Default is `'end'` so the pipeline does not flood the SSE bus with historical lines on startup.
   - Attach `FileWatcher`. On each event, run the read loop below.
2. **Read loop** (each watcher event):
   - `stat` the file. Catch ENOENT → emit `'error'` with `code: 'WATCHER_ENOENT'`. Wait for the next event.
   - If `stat.ino !== this.inode` → file rotated. Emit `'error'` (`code: 'ROTATION_DETECTED'`), reset `offset = 0`, `inode = stat.ino`, clear `buffer`. Emit `'recovered'`. Continue to read.
   - If `stat.size < this.offset` → in-place truncation. Same handling as rotation: emit `'error'` (`code: 'TRUNCATION_DETECTED'`), reset `offset = 0`, clear `buffer`, emit `'recovered'`. Continue to read.
   - Open the file, `read(buf, 0, size - offset, offset)` to fetch only new bytes; close.
   - Append the read chunk to `this.buffer`; split on `\n`; the **last** element of the split is held back as the next-read prefix (handles partial lines mid-write); the rest are complete lines.
   - For each complete line:
     - If empty (`''`) — skip.
     - `JSON.parse`. Failure → `'error'` (`code: 'JSON_PARSE'`); continue with next line.
     - Validate via `logSchema`. Failure → `'error'` (`code: 'SCHEMA_VALIDATION'`); continue with next line.
     - `const redacted = redactLog(parsed)` — apply redaction.
     - Emit `'data'` with the **redacted** payload.
   - Update `offset = stat.size - buffer.length`.
3. **`stop()`**: detach watcher, remove all listeners on the emitter, resolve when the watcher is fully detached. Idempotent.
4. **`start()`** is idempotent (second call resolves without re-attaching).
5. The pipeline NEVER calls `redactLog` more than once per entry, and the **only** thing emitted on `'data'` is the redacted form. `grep "emitter.emit('data'" log-pipeline.ts` returns at most one call site, and that call site's argument is `redacted` (not `parsed`).

### `log-pipeline.test.ts` — test cases

```ts
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let filePath: string;
let pipeline: LogPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-pipeline-'));
  filePath = join(dir, 'log.jsonl');
  writeFileSync(filePath, '');
});

afterEach(async () => {
  await pipeline?.stop();
  rmSync(dir, { recursive: true, force: true });
});
```

| Case | Setup | Assertion |
|------|-------|-----------|
| Happy path (start at end) | Pre-write 3 valid lines; start({startAt:'end'}); append 1 new line | Exactly 1 `'data'` event; the historical 3 are NOT emitted |
| Happy path (start at beginning) | Pre-write 3 valid lines; start({startAt:'beginning'}) | Exactly 3 `'data'` events |
| Append batch | start(); append 100 valid lines in 10 batches of 10 | Exactly 100 `'data'` events; no duplicates |
| Malformed line | start(); append valid, corrupt, valid | One `'data'`, one `'error'` (JSON_PARSE), one `'data'`; pipeline still running |
| Schema-invalid line | start(); append `{}` (parses but fails schema) | One `'error'` (SCHEMA_VALIDATION); pipeline still running |
| PII redaction | start(); append a line with `alice@example.test` in the message | The emitted payload's message field contains the redacted form (per `redactLog`'s contract — likely `***@example.test` or similar; assert against the actual helper's behavior, not a guessed string) |
| In-place truncation | start(); append 5 valid lines; `truncateSync(filePath, 0)`; append 2 new valid lines | One `'error'` (TRUNCATION_DETECTED), one `'recovered'`, then 2 `'data'` events. The original 5 do NOT re-emit. |
| Rotation (rename + recreate) | start(); append 3 lines; rename to `.1`; recreate empty; append 1 line | One `'error'` (ROTATION_DETECTED), one `'recovered'`, then 1 `'data'` |
| Partial-line write | start(); write `'{"ts":"2026-05-02T00:00:00.000Z","level":"info","msg":"hel'` then later `'lo"}\n'` | Exactly 1 `'data'` event after the line is completed |
| Recovery (unlink + recreate) | start(); unlink filePath; recreate with 1 valid line | One `'error'` (WATCHER_ENOENT), one `'recovered'`, one `'data'` |
| Idempotent start/stop | start(); start(); stop(); stop() | Both second calls resolve; no duplicate watchers |

Test runtime budget: ≤500 ms per `it`. The 100-line batch test gets a 1500 ms exception (write loop dominates).

### Fixtures

`log-valid.jsonl` (3 lines; shape MUST be confirmed against `schemas/log.ts`):
```jsonl
{"ts":"2026-05-02T00:00:00.000Z","level":"info","msg":"server started"}
{"ts":"2026-05-02T00:00:01.000Z","level":"warn","msg":"deprecated config flag used"}
{"ts":"2026-05-02T00:00:02.000Z","level":"error","msg":"transient downstream error","retryIn":1000}
```

`log-with-pii.jsonl`:
```jsonl
{"ts":"2026-05-02T00:00:00.000Z","level":"info","msg":"login from alice@example.test"}
```

(Use `alice@example.test` — `.test` is RFC-2606-reserved and guaranteed non-routable; no risk of accidental real-mailbox lookup. NEVER use real email-shaped strings in fixtures.)

`log-malformed.jsonl`:
```
{"ts":"2026-05-02T00:00:00.000Z","level":"info","msg":"valid"}
{ this is not json
{"ts":"oops","level":99}
```

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev-portal/server/integration/log-pipeline.ts` exists and exports a `LogPipeline` class that `implements Pipeline<LogPayload>`.
- AC-2: With `{ startAt: 'end' }` (default), historical lines present at `start()` time are NOT emitted.
- AC-3: With `{ startAt: 'beginning' }`, all historical lines are emitted in file order.
- AC-4: 100-line append-batch test produces exactly 100 `'data'` events (no duplicates, no drops).
- AC-5: `redactLog(...)` is called for every entry before emission. `grep -E "emitter\\.emit\\('data'" log-pipeline.ts` shows the emitted argument is the **redacted** form, not the raw parsed line.
- AC-6: PII test: the synthetic email `alice@example.test` is observed in the emitted payload only in its redacted form (whatever `redactLog` produces). The literal string `alice@example.test` does NOT appear in the emitted payload.
- AC-7: In-place truncation (`truncateSync(path, 0)`) emits `'error'` (code: `TRUNCATION_DETECTED`) followed by `'recovered'`; the offset resets to 0; subsequent appends emit `'data'`.
- AC-8: Rotation (rename + recreate) emits `'error'` (code: `ROTATION_DETECTED`) followed by `'recovered'`; subsequent appends emit `'data'`. The pre-rotation lines are NOT re-emitted from the renamed file.
- AC-9: Partial-line write (line split across two watcher events) emits exactly one `'data'` event when the line is complete; the partial bytes do NOT cause a `JSON_PARSE` error.
- AC-10: Malformed lines emit `'error'` with `code: 'JSON_PARSE'` (corrupt JSON) or `'SCHEMA_VALIDATION'` (parses but invalid shape); the pipeline keeps running after each.
- AC-11: `npx jest plugins/autonomous-dev-portal/server/integration/__tests__/log-pipeline.test.ts` from the autonomous-dev plugin root exits 0; each `it()` ≤ 500 ms (1500 ms for the 100-line batch).
- AC-12: Line coverage of `log-pipeline.ts` ≥ 80%.
- AC-13: `redaction.ts`, `state-pipeline.ts`, `schemas/log.ts`, readers under `server/readers/`, and `FileWatcher.ts` are all unmodified.
- AC-14: `tsc --noEmit` from the portal passes; portal's `bun test` continues to pass.
- AC-15: Manual smoke (TDD-030 §10.4): touching the watched log.jsonl file results in a `log-line` SSE message to a connected client. PR description captures the exact `wscat` / `curl` command.

### Given/When/Then

```
Given a LogPipeline started with { startAt: 'end' } on a file containing 3 lines
When 1 new line is appended
Then within 500 ms exactly one 'data' event is emitted
And the 3 historical lines are not emitted

Given a LogPipeline running on log.jsonl
When 100 valid lines are appended in 10 batches of 10
Then exactly 100 'data' events are emitted in file order
And each emitted payload has been processed through redactLog()

Given a LogPipeline running on log.jsonl with 5 lines previously emitted
When the file is truncated to size 0 and 2 new lines are appended
Then the pipeline emits 'error' (code: TRUNCATION_DETECTED) followed by 'recovered'
And then 2 'data' events
And the original 5 lines are not re-emitted

Given a LogPipeline running on log.jsonl
When a partial line ('{"ts":"...","msg":"hel') is written, then completed with 'lo"}\n'
Then no 'error' event fires for the partial bytes
And exactly one 'data' event fires when the line is complete

Given a LogPipeline running on log.jsonl
When a line containing the synthetic email "alice@example.test" is appended
Then the emitted payload's message field is the redactLog-redacted form
And the literal string "alice@example.test" does not appear in the emitted payload
```

## Test Requirements

The test file must:
1. Pass under `npx jest --runInBand`.
2. Pass in isolation: `npx jest <path>`.
3. Achieve ≥ 80% line coverage on `log-pipeline.ts`.
4. Use the explicit "wait for event with timeout" pattern; no bare `setTimeout`.
5. Clean up `mkdtempSync` directories in `afterEach`.
6. Use `appendFileSync` and `truncateSync` (synchronous fs APIs) for predictable watcher timing.
7. Assert on the **redacted** form for any PII fixture; never assert positive presence of an unredacted secret.

## Implementation Notes

- **Buffer / partial-line handling**: the `this.buffer` field holds the trailing fragment between reads. After splitting on `\n`, `lines.pop()` is the new buffer. If the file ended in `\n`, `pop()` yields `''` (the empty trailing element) — that is expected and correct, and the buffer is reset to empty for the next read.
- **Offset arithmetic**: `offset = stat.size - buffer.length`. On the next read, `read(buf, 0, newSize - offset, offset)` fetches just the new bytes, including any that complete the previous partial line. The buffer is **prefixed** to the new chunk before splitting.
- **Rotation detection** uses `stat.ino` (inode number). Linux/macOS guarantee unique inode per file; on Windows, `stat.ino` may be 0 — in that case fall back to `stat.size < offset` as the only sentinel. Documented in a code comment.
- **`redactLog` signature**: read `redaction.ts` first. The expected shape is `(entry: LogPayload) => LogPayload`, but it might be `(entry: unknown) => unknown` — adjust types accordingly.
- **`startAt` default is `'end'`** — historical lines are not re-emitted on every restart. This matters: a portal restart should not flood the SSE bus with the past hour's logs.
- **Schema export name verification**: `schemas/log.ts` may export `logSchema`, `Log`, `LogSchema`, etc. Read first.
- **PII fixture rule**: only use RFC-2606-reserved `.test` / `.example` / `.invalid` TLDs. Real-looking email addresses in fixtures are a defect (CI logs are search-indexed).

## Rollout Considerations

The pipeline is gated off-by-default at the config level (TDD-030 §10.3). Merging this spec does not enable log emission until an operator turns it on. Revert by deleting the created files and the SSE wiring delta (if any).

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Offset arithmetic regression on partial-line writes | Medium | High (data loss / dup) | Dedicated partial-line test; explicit buffer accounting in code review |
| Rotation detection misfires on benign `mtime` change | Low | Medium (spurious error/recovered pair) | Use `ino` + `size`, not `mtime`; documented in code comment |
| `stat.ino === 0` on Windows breaks rotation detection | Low | Low | Fall back to `size < offset` sentinel; documented |
| `redactLog` signature differs from assumption | Medium | Low | Read `redaction.ts` before authoring; adjust the call site |
| FileWatcher event timing flakes on CI | Medium | Medium | Explicit 500 ms wait pattern; 3-green CI flake check before merge |
| 100-line batch test exceeds 500 ms budget | Medium | Low | Allow 1500 ms exception for that one test; document in test file |
| PII appears unredacted in test failure message | Low | High (security) | Use only `.test` / `.example` synthetic emails; CI logs scrubbed regardless |
| `log-line` SSE topic conflicts with existing wiring | Low | Low | Verify `server/sse/index.ts` first; manual smoke confirms |
