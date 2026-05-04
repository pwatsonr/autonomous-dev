# SPEC-030-2-03: `cost-pipeline.ts` (rewritable JSON; URL API-key redaction)

## Metadata
- **Parent Plan**: PLAN-030-2 (TDD-015 portal pipeline closeout)
- **Parent TDD**: TDD-030 §6.2, §6.3, §8.1
- **Tasks Covered**: TASK-003 (cost-pipeline.ts + tests + fixtures + SSE wire)
- **Estimated effort**: 1 day
- **Depends on**: SPEC-030-2-01 (interface) merged, SPEC-030-2-02 (heartbeat pattern lock) merged
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-2-03-cost-pipeline.md`

## Description

Implement the `cost-pipeline.ts` portal live-data pipeline. Source artifact is a **rewritable JSON document** at `<request>/.autonomous-dev/cost.json` (NOT append-only JSONL — this is the key semantic difference from heartbeat and log). On each watcher event, the pipeline re-reads the entire document, schema-validates it, redacts any embedded API keys from URL strings, and emits exactly one `data` event per change.

The pipeline copies the `HeartbeatPipeline` structure from SPEC-030-2-02 and `implements Pipeline<CostPayload>` from SPEC-030-2-01. It reuses the existing `server/readers/schemas/cost.ts` schema and (if present) `server/readers/CostReader.ts`. The pipeline does NOT modify `state-pipeline.ts`, `redaction.ts`, or any reader.

Per TDD-030 §8.1, the redaction strips `?api_key=…` (and similar) parameters from URL strings within the cost record. The implementation calls the existing `redaction.ts` helper if it handles URL params; otherwise it adds a small file-local URL-cleaning util (NEVER modifies `redaction.ts` itself — TDD-030 OQ-30-07).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/server/integration/cost-pipeline.ts` | Create | Implements `Pipeline<CostPayload>` |
| `plugins/autonomous-dev-portal/server/integration/__tests__/cost-pipeline.test.ts` | Create | Happy / malformed / redact / recovery |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/cost-valid.json` | Create | Schema-valid, no secrets |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/cost-with-api-key.json` | Create | Schema-valid; contains a URL with `?api_key=SECRET` |
| `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/cost-malformed.json` | Create | Bad JSON / wrong shape |
| `plugins/autonomous-dev-portal/server/sse/index.ts` | Modify (only if needed) | Register `cost-update` topic if not auto-registered |
| `plugins/autonomous-dev-portal/server/integration/redact-url.ts` | Create (conditional) | Tiny local URL-cleaning util IF `redaction.ts` does not already handle URL params |

The `redact-url.ts` file is **conditional**: read `server/readers/redaction.ts` first. If it exports a function that strips URL query params, reuse it and skip creating `redact-url.ts`. If it only redacts object fields, create the small local util and document the choice in the pipeline header comment.

## Implementation Details

### `cost-pipeline.ts` — public surface

```ts
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Pipeline, PipelineErrorPayload } from './pipeline-types';
import { FileWatcher } from '../watchers/FileWatcher';
import type { CostPayload } from '../readers/schemas/cost';
import { costSchema } from '../readers/schemas/cost'; // verify exact export name
// EITHER:
import { redactCostUrls } from '../readers/redaction';
// OR (if the existing helper does not cover URL params):
import { stripApiKeyParams } from './redact-url';

export interface CostPipelineConfig {
  /** Absolute path to the watched cost.json file. */
  filePath: string;
}

export class CostPipeline implements Pipeline<CostPayload> {
  private readonly emitter = new EventEmitter();
  private watcher?: FileWatcher;

  constructor(private readonly cfg: CostPipelineConfig) {}

  async start(): Promise<void> { /* ... */ }
  async stop(): Promise<void>  { /* ... */ }

  on(event: 'data', listener: (p: CostPayload) => void): void;
  on(event: 'error', listener: (e: PipelineErrorPayload) => void): void;
  on(event: 'recovered', listener: () => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener);
  }
}
```

### Behavior

1. `start()` attaches a `FileWatcher` to `cfg.filePath`. On each watcher event:
   - Read the **entire** file via `readFile(path, 'utf-8')`. Rewritable-JSON semantics — there is no offset tracking.
   - `JSON.parse` the contents. JSON parse failure → emit `'error'` with `code: 'JSON_PARSE'`. Pipeline keeps running.
   - Validate against `costSchema`. Validation failure → emit `'error'` with `code: 'SCHEMA_VALIDATION'` and `cause: <zod or schema error>`. Pipeline keeps running.
   - Redact API-key URL params on every URL string in the payload (depth-first walk, or via the existing helper if it does this).
   - Emit `'data'` with the redacted payload.
2. **Coalescing**: If two watcher events arrive within the same tick, only one read is performed (use a `Promise` flag — if a read is already in flight, set a "rerun" flag; on completion, run again exactly once). This avoids an N-event storm on rapid writes.
3. **Recovery**: file unlinked → emit `'error'` with `code: 'WATCHER_ENOENT'`. When the file is recreated, emit `'recovered'`. The next read happens on the watcher's next event after recreate.
4. `start()` and `stop()` are idempotent (per the SPEC-030-2-02 pattern).
5. Empty file (zero bytes) → emit `'error'` with `code: 'EMPTY_FILE'`. Pipeline keeps running.

### URL-redaction contract

The redacted form replaces the value of any `api_key` (case-insensitive) URL query parameter with `REDACTED`. Examples:

| Input | Output |
|-------|--------|
| `https://api.example.com/v1?api_key=SECRET` | `https://api.example.com/v1?api_key=REDACTED` |
| `https://api.example.com/v1?api_key=SECRET&q=foo` | `https://api.example.com/v1?api_key=REDACTED&q=foo` |
| `https://api.example.com/v1?Api-Key=SECRET` | `https://api.example.com/v1?Api-Key=REDACTED` |
| `https://api.example.com/v1` | _(unchanged)_ |
| `not-a-url` | _(unchanged)_ — never throws on non-URL strings |

If `redaction.ts` already provides a helper with **different** semantics (e.g., strips the param entirely instead of replacing with `REDACTED`), use whatever that helper does and assert that contract in tests. Document the chosen behavior in the pipeline file's header comment.

### Walking the payload

URL strings may live anywhere in the cost record. The pipeline walks the JSON depth-first; for each string value, attempts `new URL(value)` (catches `TypeError` for non-URLs); rewrites query params if the URL parses. **Never throws on non-URL strings** — they pass through unchanged.

### `cost-pipeline.test.ts` — test cases

```ts
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

let dir: string;
let filePath: string;
let pipeline: CostPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cost-pipeline-'));
  filePath = join(dir, 'cost.json');
});

afterEach(async () => {
  await pipeline?.stop();
  rmSync(dir, { recursive: true, force: true });
});
```

| Case | Setup | Assertion |
|------|-------|-----------|
| Happy path | Write `cost-valid.json` to filePath; start() | Within 500 ms, exactly one `'data'` event with parsed payload |
| Re-write | Write valid; start(); write same file with different valid content | Two `'data'` events total |
| API-key redaction | Write `cost-with-api-key.json`; start() | The emitted payload's URL contains `api_key=REDACTED`, never `SECRET` |
| Malformed JSON | Write `cost-malformed.json`; start() | One `'error'` event with `code: 'JSON_PARSE'`; pipeline still running |
| Schema-invalid | Write `{}` (parses but fails schema); start() | One `'error'` event with `code: 'SCHEMA_VALIDATION'` |
| Empty file | Write `''`; start() | One `'error'` event with `code: 'EMPTY_FILE'` |
| Recovery | Start; valid; unlink; recreate with valid | `'data'` → `'error'` (WATCHER_ENOENT) → `'recovered'` → `'data'` |
| Coalescing | Start; rapid `writeFileSync` x 5 in same tick | At most 2 `'data'` events (1 in-flight + 1 rerun) — proves no N-event storm |
| Idempotent start/stop | start(); start(); stop(); stop() | Both second calls resolve; no duplicate watchers |

Test runtime budget: ≤500 ms per `it`. Use the explicit "wait for event with timeout" helper from SPEC-030-2-02 — DO NOT add bare `setTimeout` to mask flake.

### Fixtures

`cost-valid.json` (shape MUST be re-confirmed against `schemas/cost.ts`):
```json
{
  "ts": "2026-05-02T00:00:00.000Z",
  "totalUsd": 1.2345,
  "byProvider": {
    "anthropic": { "usd": 1.0, "tokens": 12345 },
    "openai":    { "usd": 0.2345, "tokens": 999 }
  }
}
```

`cost-with-api-key.json`:
```json
{
  "ts": "2026-05-02T00:00:00.000Z",
  "totalUsd": 0.10,
  "byProvider": {
    "anthropic": {
      "usd": 0.10,
      "tokens": 100,
      "endpoint": "https://api.anthropic.com/v1?api_key=SECRETXYZ&workspace=team-1"
    }
  }
}
```

`cost-malformed.json`:
```
{ this is not valid json
```

(literal corrupt JSON — opening brace, no quotes, no closing brace.)

### `redact-url.ts` (conditional)

If `redaction.ts` does not handle URL params, create:

```ts
// plugins/autonomous-dev-portal/server/integration/redact-url.ts
const KEY_PARAM_NAMES = new Set(['api_key', 'apikey']);

/** Returns the input with api_key-style query params replaced by REDACTED. */
export function stripApiKeyParams(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value; // not a URL; pass through
  }
  let mutated = false;
  for (const key of [...url.searchParams.keys()]) {
    if (KEY_PARAM_NAMES.has(key.toLowerCase())) {
      url.searchParams.set(key, 'REDACTED');
      mutated = true;
    }
  }
  return mutated ? url.toString() : value;
}

/** Walks a payload depth-first; returns a copy with URL strings sanitized. */
export function redactPayloadUrls<T>(payload: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return stripApiKeyParams(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(payload) as T;
}
```

This util is internal to the integration module; no import from outside `integration/` is allowed (enforce via a one-line comment in the file header).

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev-portal/server/integration/cost-pipeline.ts` exists and exports a `CostPipeline` class that `implements Pipeline<CostPayload>`.
- AC-2: The pipeline reads the **entire** file on each watcher event (rewritable-JSON semantics; no offset tracking).
- AC-3: API-key URL parameters are replaced with `REDACTED` (or the existing `redaction.ts` convention) in every emitted payload. The literal string `SECRETXYZ` from the fixture never appears in any emitted `data` event.
- AC-4: Malformed JSON, schema failure, and empty-file inputs each emit a typed `'error'` event with a distinct `code` field (`JSON_PARSE`, `SCHEMA_VALIDATION`, `EMPTY_FILE`); the pipeline does NOT stop.
- AC-5: Recovery path (unlink → recreate) emits `'error'` with `code: 'WATCHER_ENOENT'` followed by `'recovered'`.
- AC-6: Coalescing test (5 rapid writes) produces at most 2 `'data'` events.
- AC-7: `npx jest plugins/autonomous-dev-portal/server/integration/__tests__/cost-pipeline.test.ts` from the autonomous-dev plugin root exits 0; each `it()` ≤ 500 ms.
- AC-8: Line coverage of `cost-pipeline.ts` ≥ 80%.
- AC-9: `redaction.ts`, `state-pipeline.ts`, `schemas/cost.ts`, readers under `server/readers/`, and `FileWatcher.ts` are all unmodified by this spec.
- AC-10: `tsc --noEmit` from the portal passes; portal's `bun test` continues to pass.
- AC-11: Manual smoke (TDD-030 §10.4): touching the watched cost.json file results in a `cost-update` SSE message to a connected client. PR description captures the exact `wscat` / `curl` command and observed payload.
- AC-12: All `'error'` payloads have a typed `code`; `grep "error.message ===" cost-pipeline.test.ts` returns zero hits.

### Given/When/Then

```
Given a CostPipeline started on a non-existent cost.json
When the file is created with valid JSON matching the cost schema
Then within 500 ms the pipeline emits one 'data' event with the parsed payload

Given a CostPipeline running on a valid cost.json
When the file is rewritten to contain a URL with ?api_key=SECRETXYZ
Then within 500 ms the pipeline emits one 'data' event
And the emitted payload's URL contains api_key=REDACTED
And the literal string "SECRETXYZ" does not appear anywhere in the payload

Given a CostPipeline running on a valid cost.json
When 5 distinct rewrites occur within the same event-loop tick
Then the pipeline emits at most 2 'data' events (in-flight + 1 coalesced rerun)

Given a CostPipeline running on a valid cost.json
When the file is unlinked and then recreated with valid content
Then the pipeline emits 'error' (code: WATCHER_ENOENT) followed by 'recovered'
And the next file change emits 'data' as expected

Given a CostPipeline running on a valid cost.json
When the file is rewritten with corrupt JSON ("{ not json")
Then the pipeline emits one 'error' event with code: 'JSON_PARSE'
And the pipeline keeps running (subsequent valid rewrites still emit 'data')
```

## Test Requirements

The test file must:
1. Pass under `npx jest --runInBand`.
2. Pass in isolation: `npx jest <path>`.
3. Achieve ≥ 80% line coverage on `cost-pipeline.ts` (and on `redact-url.ts` if created).
4. Use the explicit "wait for event with 500 ms timeout" pattern; no bare `setTimeout`.
5. Clean up `mkdtempSync` directories in `afterEach`.
6. Assert on the **redacted** form of secrets — never `expect(payload).toContain('SECRETXYZ')` as a positive assertion.

## Implementation Notes

- **Coalescing pattern**: a single `private inflight: Promise<void> | null` plus `private rerunPending = false`. On each watcher event: if `inflight` is null, start a read and store the promise; if not, set `rerunPending = true`. On promise completion: if `rerunPending`, clear it and start one more read. This is the minimum viable coalescing — do NOT introduce a debounce timer (that adds latency for the common case).
- **Header comment**: the pipeline file's first 5–10 lines must declare the redaction provenance: either "uses `redaction.ts#redactCostUrls`" or "uses local `redact-url.ts` because `redaction.ts` does not cover URL query params (TDD-030 OQ-30-07)".
- **Schema name verification**: `schemas/cost.ts` may export the schema as `costSchema`, `Cost`, `CostSchema`, or similar. Read the file before authoring to avoid an import-name guess.
- **CostReader**: if `server/readers/CostReader.ts` exists and already exposes a "validate cost JSON" function, use it via composition. If not, the pipeline owns parse + validate inline.
- The `cost-with-api-key.json` fixture's `endpoint` field is illustrative — the real `cost.ts` schema may not have an `endpoint` field. If not, place the URL string in whatever field the schema permits (e.g., `meta.source`). The redaction contract applies to **any** URL string in the payload; the test asserts on the redacted form regardless of which field carries it.

## Rollout Considerations

The pipeline is gated off-by-default at the config level (TDD-030 §10.3). Merging this spec does not enable cost emission until an operator turns it on. Revert by deleting the created files and the SSE wiring delta (if any).

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `redaction.ts` does not handle URL params (need local util) | Medium | Low | Local `redact-url.ts` permitted; do not modify `redaction.ts` (TDD-030 OQ-30-07) |
| FileWatcher event timing flakes on CI | Medium | Medium | Explicit 500 ms wait pattern; 3-green CI flake check before merge (TDD-030 §8.4) |
| Coalescing test asserts wrong upper bound | Medium | Low | "At most 2" is the contract; tests should not assert "exactly 1" — file-watcher coalescing is a best-effort optimization, not a guarantee |
| Schema export name mismatch | Low | Low | Read `schemas/cost.ts` before authoring |
| Secret leaks into a test failure message | Low | High (security) | All fixtures use `SECRETXYZ` (obvious test sentinel); CI logs are scrubbed; no real provider keys in fixtures |
| `cost.json` rewrite races test assertion | Medium | Low | `writeFileSync` (not async); explicit wait-for-event |
| The `cost-update` SSE topic is unknown to the existing bus | Low | Low | Verify `server/sse/index.ts` first; register if needed; manual smoke confirms wiring |
