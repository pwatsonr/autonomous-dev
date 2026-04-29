# SPEC-012-2-03: Repository Layer — TypeScript CRUD on Source Metadata

## Metadata
- **Parent Plan**: PLAN-012-2
- **Tasks Covered**: Task 3 (extend RequestEntity + repository ops), Task 4 (RequestSource + AdapterMetadata types), Task 5 (state.json schema for source tracking), Task 7 (backward-compat validator)
- **Estimated effort**: 5 hours

## Description

Extend `intake/db/repository.ts` and define canonical `RequestSource` + `AdapterMetadata` types in `intake/types/request_source.ts`. The repository layer is the **only** place that translates between SQLite rows (`adapter_metadata` as TEXT) and TypeScript domain objects (`AdapterMetadata` as discriminated union). Callers above this layer always work in domain types; callers below this layer always work in raw SQL. JSON serialization happens at exactly one boundary: this file.

This spec also defines the v1.0 → v1.1 state.json validator with backward-compat handling: reading a v1.0 state.json (no `source` field) defaults `source='cli'` and `adapter_metadata={}`. Writing always emits v1.1 shape.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/types/request_source.ts` | Create | Canonical `RequestSource` + `AdapterMetadata` |
| `intake/db/repository.ts` | Modify | Extend `RequestEntity`; update insert/select queries |
| `intake/state/state_validator.ts` | Modify | Add v1.0 → v1.1 backward-compat |

## Implementation Details

### Task 4: `intake/types/request_source.ts`

```typescript
/**
 * Discriminator for which adapter/channel originated a request.
 * MUST stay in sync with the CHECK constraint in
 * `intake/db/migrations/002_add_source_metadata.sql`.
 *
 * Adding a new source requires:
 *   1. Add the literal here
 *   2. Add a new migration that ALTERs the CHECK constraint
 *   3. Extend AdapterMetadata with the new shape
 *   4. Implement the adapter
 */
export type RequestSource =
  | 'cli'
  | 'claude-app'
  | 'discord'
  | 'slack'
  | 'production-intelligence'
  | 'portal';

export const REQUEST_SOURCES: readonly RequestSource[] = [
  'cli',
  'claude-app',
  'discord',
  'slack',
  'production-intelligence',
  'portal',
] as const;

/** Type guard — narrows `unknown` to `RequestSource`. */
export function isRequestSource(value: unknown): value is RequestSource {
  return typeof value === 'string'
    && (REQUEST_SOURCES as readonly string[]).includes(value);
}

/**
 * Discriminated union of per-adapter metadata payloads.
 * The discriminator key is `source` (matches RequestEntity.source).
 *
 * All non-discriminator fields are optional — adapters MAY emit any
 * subset depending on what's available. Consumers MUST tolerate
 * missing fields.
 */
export type AdapterMetadata =
  | { source: 'cli'; pid?: number; cwd?: string; branch?: string }
  | { source: 'claude-app'; session_id?: string; user?: string; workspace?: string }
  | { source: 'discord'; guild_id?: string; channel_id?: string; user_id?: string; message_id?: string }
  | { source: 'slack'; team_id?: string; channel_id?: string; user_id?: string; message_ts?: string }
  | { source: 'production-intelligence'; alert_id?: string; severity?: string }
  | { source: 'portal'; session_id?: string; user_agent?: string }
  | {}; // Empty object = legacy v1.0 row pre-migration

/**
 * Validate a parsed JSON object as AdapterMetadata.
 * Returns the typed object on success; throws ValidationError on
 * unknown discriminator or schema violation.
 */
export function parseAdapterMetadata(json: unknown): AdapterMetadata;
```

`parseAdapterMetadata` rules:
- `null` or `undefined` → returns `{}` (treated as v1.0 legacy)
- Object with no `source` key → returns `{}`
- Object with `source` not in `REQUEST_SOURCES` → throws `ValidationError('unknown adapter source: ...')`
- Object with valid `source` and any subset of optional fields → returns the typed shape (excess fields are dropped, not included in return value)
- Anything else (string, number, array) → throws `ValidationError('adapter_metadata must be object')`

### Task 3: Extend `RequestEntity` and Repository Operations

Update `RequestEntity` in `intake/db/repository.ts`:

```typescript
export interface RequestEntity {
  // ... existing v1 fields ...
  request_id: string;
  title: string;
  description: string;
  // ... etc ...

  // v2 fields (added by 002_add_source_metadata.sql):
  /** Channel/adapter that originated this request. */
  source: RequestSource;
  /** Adapter-specific metadata. Always present; empty object for legacy. */
  adapter_metadata: AdapterMetadata;
}
```

**Critical**: `adapter_metadata` is typed as `AdapterMetadata` in the entity, NOT as raw `string`. The repository handles the JSON `parse`/`stringify` at the SQL boundary.

Update SQL queries — three operations need changes:

1. **`insertRequest(req: NewRequest): RequestEntity`**:
   ```typescript
   const stmt = db.prepare(`
     INSERT INTO requests (
       request_id, title, description, raw_input, priority,
       target_repo, status, current_phase, requester_id,
       source_channel, notification_config, source, adapter_metadata,
       /* ... other v1 columns ... */
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, /* ... */)
   `);
   stmt.run(
     /* ... v1 args ... */,
     req.source,
     JSON.stringify(req.adapter_metadata ?? {})
   );
   ```
   Defaults: if caller omits `source`, repository writes `'cli'`. If caller omits `adapter_metadata`, repository writes `'{}'`.

2. **`getRequest(id: string): RequestEntity | null`**:
   - SELECT includes `source` and `adapter_metadata` columns
   - Maps `row.adapter_metadata` (string) through `JSON.parse()` then `parseAdapterMetadata()`
   - On JSON parse failure: log error, return `adapter_metadata: {}` (do NOT fail the entire read — defensive against corrupt rows)

3. **`updateRequest(id: string, fields: Partial<RequestEntity>): RequestEntity`**:
   - If `fields.source` is provided, validate via `isRequestSource()` before SQL
   - If `fields.adapter_metadata` is provided, `JSON.stringify()` it before binding
   - Reject updates that would set `source` to an invalid value with `ValidationError`

**New helper**: `listRequestsBySource(source: RequestSource, status?: RequestStatus): RequestEntity[]` — uses `idx_requests_source_status` index. Used by reconciliation CLI (PLAN-012-3) and per-channel dashboards.

### Task 5 + Task 7: state.json Validator (v1.0 ↔ v1.1)

Update `intake/state/state_validator.ts`:

```typescript
/** v1.0 state.json shape (no source). Read-only legacy. */
interface StateJsonV10 { /* existing fields */ }

/** v1.1 state.json shape. Always-write target. */
interface StateJsonV11 extends StateJsonV10 {
  source: RequestSource;
  adapter_metadata: AdapterMetadata;
}

/**
 * Read + validate a state.json. Accepts v1.0 (defaults source) and v1.1.
 * Rejects malformed or unknown-source files.
 */
export function readStateJson(path: string): StateJsonV11;

/** Always emits v1.1 shape regardless of input source. */
export function writeStateJson(path: string, state: StateJsonV11): void;
```

Read behavior:
- Parse JSON; on parse failure throw `StateValidationError('malformed JSON')`
- If `source` field is **missing**: set `source = 'cli'`, `adapter_metadata = {}`, log `state.v10_compat` info entry with the file path
- If `source` field is **present but invalid**: throw `StateValidationError('unknown source: ...')`
- If `source` is valid but `adapter_metadata` is missing: set `adapter_metadata = {}`
- If both are present: validate `adapter_metadata` via `parseAdapterMetadata()` and pass through

Write behavior: always serialize all v1.1 fields. Never emit v1.0 shape. The on-disk file becomes self-upgrading on first write.

## Acceptance Criteria

- [ ] `intake/types/request_source.ts` exports `RequestSource`, `REQUEST_SOURCES`, `AdapterMetadata`, `isRequestSource`, `parseAdapterMetadata` with the documented signatures.
- [ ] `RequestEntity` includes `source: RequestSource` and `adapter_metadata: AdapterMetadata` (typed object, not string).
- [ ] `insertRequest({ source: 'discord', adapter_metadata: { source: 'discord', guild_id: 'g1' } })` succeeds; subsequent `getRequest()` returns the typed metadata back.
- [ ] `insertRequest({})` (no source provided) writes `source='cli'`, `adapter_metadata={}`.
- [ ] `insertRequest({ source: 'urgent' as any })` is rejected with `ValidationError` BEFORE SQL is issued.
- [ ] `getRequest()` on a row with corrupt JSON in `adapter_metadata` returns `{}` (with error log) — does not throw.
- [ ] `listRequestsBySource('discord')` returns only rows with `source='discord'` and uses `idx_requests_source_status` per `EXPLAIN QUERY PLAN`.
- [ ] `parseAdapterMetadata(null)` returns `{}`; `parseAdapterMetadata({ source: 'discord', guild_id: 'g1', extra: 'ignored' })` returns `{ source: 'discord', guild_id: 'g1' }` (extra dropped).
- [ ] `parseAdapterMetadata({ source: 'unknown' })` throws `ValidationError`.
- [ ] `readStateJson()` on a v1.0 file (no `source`) returns `{ ...v10, source: 'cli', adapter_metadata: {} }` and emits `state.v10_compat` log.
- [ ] `readStateJson()` on a v1.1 file with valid `source` + `adapter_metadata` round-trips unchanged.
- [ ] `readStateJson()` on a file with `source: 'banana'` throws `StateValidationError`.
- [ ] `writeStateJson()` always emits both `source` and `adapter_metadata` fields.
- [ ] `tsc --noEmit` passes with no errors.

## Test Requirements

Test execution lives in SPEC-012-2-04. This spec defines what the repository + types must satisfy:

| Surface | Verified Behavior |
|---------|------------------|
| Type compilation | All exported symbols compile; discriminated union narrows correctly |
| Insert with source | Round-trips to `getRequest()` |
| Insert without source | Defaults to `'cli'` |
| Insert with invalid source | `ValidationError` |
| Update source field | Validated; index used |
| Corrupt JSON in row | Defensive `{}` return + log |
| `listRequestsBySource` | Filters correctly; uses index |
| State v1.0 read | Defaults applied |
| State v1.1 round-trip | Bytewise equal after read+write |
| State v1.1 with invalid source | Rejected |

## Dependencies

- **Consumes**: SPEC-012-2-01 schema (specifically the `source` and `adapter_metadata` columns + CHECK constraints).
- **Consumes**: SPEC-012-2-02 migration runner (must run before repository code touches the DB).
- **Consumes**: Existing `RequestEntity`, `NewRequest`, `getRequest`, `insertRequest`, `updateRequest` from SPEC-008-1-01.
- **Consumes**: `ValidationError`, `StateValidationError` types from existing error module.
- **Exposes**: `RequestSource` + `AdapterMetadata` types — consumed by all channel adapters (PLAN-011-*) and handoff layer (PLAN-012-1).
- **Exposes**: `listRequestsBySource()` — consumed by reconciliation CLI (PLAN-012-3).

## Notes

- **JSON boundary discipline**: the repository is the ONE place that calls `JSON.parse`/`JSON.stringify` for `adapter_metadata`. Other modules MUST NOT touch the raw string. Enforced by typing `RequestEntity.adapter_metadata` as `AdapterMetadata` (not `string`).
- **Why drop excess fields in `parseAdapterMetadata`?** Forward-compat: an older daemon reading state.json from a newer adapter should not crash on unknown fields. This is a deliberate "tolerant reader" choice per Postel's law applied to internal interfaces.
- **Why log + return `{}` on corrupt JSON instead of throwing?** A single corrupt row should not block listing/reading other rows. Operators see the warning log and can fix or purge the bad row out-of-band. This matches the daemon's "stay-up under partial corruption" posture from TDD-012 §reliability.
- **`source` is immutable in practice**: while `updateRequest` accepts a `source` field, no real caller should ever change it after insert. The validator allows it only because surgical operator-driven repairs (e.g. recategorizing a misattributed Discord request as Slack) need an escape hatch.
- **State.json self-upgrade**: the first write after a daemon upgrade automatically converts v1.0 → v1.1 on disk. No batch migration script is needed for state files (unlike DB migrations which require explicit ordering).
