# PLAN-030-2: TDD-015 Portal Pipeline Closeout (Cost / Heartbeat / Log)

## Metadata
- **Parent TDD**: TDD-030-closeout-backfill-014-015-019 (§6)
- **Parent PRD**: PRD-016 Test-Suite Stabilization & Jest Harness Migration
- **Sibling plans**: PLAN-030-1 (auth security tests, merged), PLAN-030-3 (plugin-reload CLI)
- **Estimated effort**: 3-4 days (≈8 engineer-hours of pipeline code + ~16 hours of test scaffolding/fixtures, per TDD-030 §8.6)
- **Dependencies**: ["TDD-029 merged"] — clean jest gate must exist before the new pipeline tests can land
- **Blocked by**: []
- **Priority**: P1 (production code; gated off-by-default per TDD-030 §10.3)

## Objective

Ship the three missing portal live-data production pipelines named by TDD-015 but
absent from the tree at `main@2937725`:

| File (NEW) | Source artifact | SSE topic | Redaction |
|------------|-----------------|-----------|-----------|
| `plugins/autonomous-dev-portal/server/integration/cost-pipeline.ts` | `<request>/.autonomous-dev/cost.json` | `cost-update` | strip API keys from embedded URLs |
| `plugins/autonomous-dev-portal/server/integration/heartbeat-pipeline.ts` | `<request>/.autonomous-dev/heartbeat.jsonl` | `heartbeat` | none (no PII in heartbeat) |
| `plugins/autonomous-dev-portal/server/integration/log-pipeline.ts` | `<request>/log.jsonl` | `log-line` | `redaction.redactLog(entry)` |

Each pipeline follows the exact shape of the existing
`server/integration/state-pipeline.ts` reference implementation (TDD-030 §6.1 — no
extracted base class per NG-3004) and exports the same three-method interface
(TDD-030 §6.3):

```ts
export interface Pipeline<E> {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'data' | 'error' | 'recovered', listener: (e: E) => void): void;
}
```

This plan ships **production code plus the minimum test scaffolding required to
prove the contract** (TDD-030 §6.4 disposition rule: ship fixtures only for tests
we ship). The audit's "84 missing scaffolding files" is *not* the target — TDD-031
amends the SPEC for files that won't ship.

## Scope

### In Scope

- Three new pipeline files under
  `plugins/autonomous-dev-portal/server/integration/` matching the public surface of
  `state-pipeline.ts`.
- Three new unit-test files under
  `plugins/autonomous-dev-portal/server/integration/__tests__/` covering the
  happy / error / recovery paths from TDD-030 §6.3.
- Schema reuse from `server/readers/schemas/{cost,heartbeat,log}.ts` (these already
  exist — confirmed against `main@2937725`).
- Reader reuse from `server/readers/{CostReader,HeartbeatReader,LogReader}.ts`
  (these already exist — confirmed against `main@2937725`).
- Redaction reuse from `server/readers/redaction.ts` for `log-pipeline.ts` (TDD-030
  §6.2, §8.1).
- SSE-bus wiring under `server/sse/` so each new topic is published when its
  pipeline emits a `data` event.
- A small set of fixture artifacts under
  `server/integration/__tests__/fixtures/` (one per pipeline) to drive the unit
  tests deterministically.
- A `coverageThreshold` line entry (or extension of PLAN-030-1's portal-local
  config) for `server/integration/{cost,heartbeat,log}-pipeline.ts` at ≥ 80 %
  (TDD-030 §11.1 target).

### Out of Scope

- Refactoring `state-pipeline.ts` to extract a shared base class (TDD-030 NG-3004).
- New event types beyond cost / heartbeat / log (TDD-030 NG-3003).
- End-to-end SSE → UI tests (TDD-015 already covers this; PRD-016 does not require
  it of the closeout).
- Hot-path performance work; pipelines are gated off by default and will ship
  unbudgeted (TDD-030 §10.3).
- Auth-surface tests (PLAN-030-1, merged) and CLI work (PLAN-030-3).
- Any redaction logic changes inside `redaction.ts` itself — pipelines call the
  existing function. If a redaction bug is discovered, it ships as a separate PR
  per TDD-030 OQ-30-07.

## Tasks

### TASK-001: Confirm reference shape and lock pipeline interface

**Description:** Read `server/integration/state-pipeline.ts` end-to-end and write a
≤25-line interface contract module (`pipeline-types.ts`) that captures the shared
shape (per TDD-030 §6.3). This is **not** a base class — it is a TypeScript
`interface Pipeline<E>` plus the discriminated `event` union. Each new pipeline
file imports and `implements` this interface.

**Files to create:**
- `plugins/autonomous-dev-portal/server/integration/pipeline-types.ts`

**Files to modify:** none

**Dependencies:** []

**Acceptance Criteria:**
- The interface declares `start()`, `stop()`, `on(event, listener)` with the exact
  signature in TDD-030 §6.3.
- The event-name union is `'data' | 'error' | 'recovered'` — no other events.
- `state-pipeline.ts` continues to compile unmodified (the interface is additive;
  the existing pipeline does **not** retroactively `implements` it in this task —
  that is explicitly out of scope per NG-3004).
- TypeScript build of the portal passes (`tsc --noEmit`).

**Estimated Effort:** 0.25 day

**Track:** Foundation

**Risks:**
- **Low:** None — pure type contract; no runtime change.

---

### TASK-002: `heartbeat-pipeline.ts` (simplest — no redaction)

**Description:** Implement `heartbeat-pipeline.ts` first because it is the
simplest of the three (no PII, no redaction; just schema-validate and forward).
Establishes the pattern the next two pipelines copy.

**Files to create:**
- `plugins/autonomous-dev-portal/server/integration/heartbeat-pipeline.ts`
- `plugins/autonomous-dev-portal/server/integration/__tests__/heartbeat-pipeline.test.ts`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/heartbeat-valid.jsonl`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/heartbeat-malformed.jsonl`

**Files to modify:**
- `plugins/autonomous-dev-portal/server/sse/index.ts` (register the `heartbeat`
  topic if not already wired by TDD-015's existing SSE plumbing — verify before
  modifying)

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §6.2, §6.3):
- The pipeline subscribes to `<request>/.autonomous-dev/heartbeat.jsonl` via the
  existing `FileWatcher` (`server/watchers/FileWatcher.ts`).
- Each new line is validated against `server/readers/schemas/heartbeat.ts`; valid
  payloads emit `data`, malformed lines emit `error` and the pipeline keeps
  running.
- A simulated transient watcher error (unlink → recreate the watched file) emits
  `error` followed by `recovered`.
- The unit test runs under `npx jest --runInBand` from the autonomous-dev plugin
  root and completes in ≤500 ms.
- The `data` event payload type matches the heartbeat schema's inferred type.
- Line coverage of `heartbeat-pipeline.ts` ≥ 80 %.

**Estimated Effort:** 0.75 day

**Track:** Pipeline implementation

**Risks:**
- **Medium:** File-watcher event timing on CI hosts.
  - **Mitigation:** Tests use an explicit "wait for event" promise with a 500 ms
    timeout (TDD-030 §8.4); no arbitrary `setTimeout`.

---

### TASK-003: `cost-pipeline.ts` (rewritable JSON, redact embedded URL keys)

**Description:** Implement `cost-pipeline.ts`. Source artifact is a rewritable
JSON file (not append-only), so the pipeline reads the whole document on each
change and emits one `data` event per change. Redaction strips `?api_key=…` (and
similar) parameters from any URL strings the cost record may carry.

**Files to create:**
- `plugins/autonomous-dev-portal/server/integration/cost-pipeline.ts`
- `plugins/autonomous-dev-portal/server/integration/__tests__/cost-pipeline.test.ts`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/cost-valid.json`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/cost-with-api-key.json`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/cost-malformed.json`

**Files to modify:**
- `plugins/autonomous-dev-portal/server/sse/index.ts` (register the `cost-update`
  topic — verify before modifying)

**Dependencies:** [TASK-001, TASK-002 (pattern lock-in)]

**Acceptance Criteria** (per TDD-030 §6.2, §8.1):
- The pipeline subscribes to `<request>/.autonomous-dev/cost.json` via
  `FileWatcher`.
- The whole document is re-read on each change (rewritable-json semantics, not
  append-only).
- Schema validation against `server/readers/schemas/cost.ts`; malformed → `error`,
  pipeline keeps running.
- API-key redaction: a fixture URL `https://api.example.com/v1?api_key=SECRET` is
  observed in the emitted payload as `https://api.example.com/v1` (or
  `?api_key=REDACTED`, matching whatever convention `redaction.ts` uses for URL
  params; verify against existing utility).
- Recovery path: unlink → recreate emits `error` then `recovered`.
- Line coverage of `cost-pipeline.ts` ≥ 80 %.

**Estimated Effort:** 1 day

**Track:** Pipeline implementation

**Risks:**
- **Medium:** `redaction.ts` may not currently handle URL query params. If the
  helper is missing this case, the redaction is performed inline by the pipeline
  using the existing helper for object fields plus a small URL-cleaning util
  scoped to this file (do **not** modify `redaction.ts` itself per TDD-030
  OQ-30-07).
  - **Mitigation:** Inspect `redaction.ts` exports during TASK-001; document the
    chosen approach in the pipeline file's header comment.

---

### TASK-004: `log-pipeline.ts` (append-only JSONL, full PII redaction)

**Description:** Implement `log-pipeline.ts`. Source is append-only JSONL; the
pipeline tracks last-read offset and only processes new lines on each change. Each
new entry is passed through `redaction.redactLog(entry)` before emission.

**Files to create:**
- `plugins/autonomous-dev-portal/server/integration/log-pipeline.ts`
- `plugins/autonomous-dev-portal/server/integration/__tests__/log-pipeline.test.ts`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/log-valid.jsonl`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/log-with-pii.jsonl`
- `plugins/autonomous-dev-portal/server/integration/__tests__/fixtures/log-malformed.jsonl`

**Files to modify:**
- `plugins/autonomous-dev-portal/server/sse/index.ts` (register the `log-line`
  topic — verify before modifying)

**Dependencies:** [TASK-001, TASK-002, TASK-003]

**Acceptance Criteria** (per TDD-030 §6.2, §8.1, §8.2):
- The pipeline subscribes to `<request>/log.jsonl` via `FileWatcher`.
- Append-only semantics: only new lines are emitted; rotating the file (truncate
  to 0 then write again) is tracked correctly (offset reset detection).
- Schema validation against `server/readers/schemas/log.ts`; malformed → `error`.
- Redaction: a fixture log entry containing a synthetic email
  (`alice@example.test`) emerges from the `data` event with the email replaced
  per `redaction.redactLog`'s behavior (test asserts on the redacted form).
- Recovery path: unlink → recreate emits `error` then `recovered`; the offset is
  reset to 0 on recreate.
- Line coverage of `log-pipeline.ts` ≥ 80 %.

**Estimated Effort:** 1 day

**Track:** Pipeline implementation

**Risks:**
- **Medium:** Offset tracking across truncations is the trickiest semantics in
  this plan; tests must cover the rotate case explicitly.
  - **Mitigation:** Dedicated test "rotates the file and expects offset reset"
    plus a "writes 100 lines in 10 batches and expects exactly 100 emissions"
    test.
- **Low:** `redaction.redactLog` may have a slightly different signature than
  expected.
  - **Mitigation:** TASK-001 inspects the export; the pipeline calls it as-is.

---

### TASK-005: SSE wiring + smoke verification + coverage threshold

**Description:** Wire the three new topics into the SSE bus (verify each is
already a known topic from TDD-015 or add registrations as needed), run a manual
smoke test confirming each pipeline emits to its topic when its watched file is
touched (TDD-030 §10.4), and add the per-file `coverageThreshold` entries.

**Files to modify:**
- `plugins/autonomous-dev-portal/server/sse/index.ts` (final verification — only
  changes if not already done by TASKs 002–004)
- `plugins/autonomous-dev-portal/jest.config.cjs` (extend the
  `coverageThreshold` block PLAN-030-1 introduced; add the three new pipeline
  files at ≥ 80 %)

**Files to create:**
- `plugins/autonomous-dev-portal/server/integration/__tests__/README.md` (≤25
  lines; links to TDD-030 §6 and notes the bun-vs-jest split)

**Dependencies:** [TASK-002, TASK-003, TASK-004]

**Acceptance Criteria:**
- `npx jest --runInBand --coverage` from the autonomous-dev plugin root exits 0
  with the new threshold active.
- Manual smoke (per TDD-030 §10.4): on a developer laptop, touching each watched
  file results in an SSE message on the corresponding topic to a connected
  client. Document the exact `curl` / `wscat` commands used in the PR
  description.
- `coverageThreshold` is scoped to `server/integration/{cost,heartbeat,log}-pipeline.ts`
  specifically — not globally — at ≥ 80 %.
- The portal's existing `bun test` continues to pass (no regression).

**Estimated Effort:** 0.5 day

**Track:** Closeout

**Risks:**
- **Low:** The SSE bus may already accept arbitrary topic names (no registration
  required); in that case the wiring step is a no-op and the manual smoke is the
  only verification.
- **Medium:** Manual-smoke step requires a running portal; if the portal is hard
  to bring up locally during the work window, document the gap and defer the
  smoke evidence to the canary checklist on the PR.

---

## Dependency Graph

```
TASK-001 (pipeline-types.ts)
└── TASK-002 (heartbeat-pipeline.ts)         ← simplest; locks the pattern
    └── TASK-003 (cost-pipeline.ts)          ← rewritable-json semantics
        └── TASK-004 (log-pipeline.ts)       ← append-only + redaction
            └── TASK-005 (SSE wiring + threshold + smoke)
```

**Critical path:** TASK-001 → TASK-002 → TASK-003 → TASK-004 → TASK-005
(≈ 3.5 days, single engineer).

**Parallelism:** Limited. TASK-002 must land first to lock the pattern; once it
is merged, TASK-003 and TASK-004 can theoretically run in parallel branches
because they touch disjoint files, but the cost of merge conflicts in
`server/sse/index.ts` is non-trivial. Recommended: serialize.

## Testing Strategy

This plan ships both production code and tests. Verification:

1. `npx jest --runInBand --coverage` exits 0 with the new threshold; each new
   pipeline reports ≥ 80 % line coverage.
2. Each pipeline test file passes in isolation: `npx jest <path>`.
3. The portal's existing `bun test` continues to pass.
4. Manual smoke per TASK-005 confirms end-to-end emission to the SSE bus.
5. CI runs three times in a row green before merging (flake check; pipeline
   tests are file-watcher-bound and inherently flake-prone per TDD-030 §8.4).

## Risks

| Risk | Probability | Impact | Affected tasks | Mitigation |
|------|-------------|--------|----------------|------------|
| File-watcher events flake on CI hosts | Medium | Medium (CI) | TASK-002, 003, 004 | Explicit "wait for event" promise with 500 ms timeout; no arbitrary `setTimeout`; CI 3-green flake check before merge (TDD-030 §8.4) |
| `redaction.ts` does not handle URL query params | Medium | Low (scope) | TASK-003 | Use existing helper for object-field redaction plus a tiny URL-cleaning util scoped to `cost-pipeline.ts`; do not modify `redaction.ts` (TDD-030 OQ-30-07) |
| Offset tracking on `log.jsonl` rotates incorrectly | Medium | Medium (data) | TASK-004 | Dedicated rotate-test; explicit reset logic on truncate detection |
| SSE topic registration is non-trivial | Low | Low | TASK-005 | Inspect `server/sse/index.ts` during TASK-001; if registration is required, fold it into TASKs 002–004 |
| Pipeline reveals a bug in `state-pipeline.ts` (shared semantic) | Low | Low | any | Per TDD-030 OQ-30-07: document the finding, ship the fix as a separate PR; do not block this plan |
| Bun-vs-jest module resolution differs for `server/integration` files | Low | Medium (schedule) | TASK-002 | PLAN-030-1 already established the `projects` config; reuse it as-is |

## Definition of Done

- [ ] `cost-pipeline.ts`, `heartbeat-pipeline.ts`, `log-pipeline.ts` exist under
      `server/integration/` and `implements` the interface in `pipeline-types.ts`.
- [ ] Each pipeline has a corresponding test file under
      `server/integration/__tests__/` covering happy / error / recovery paths
      (TDD-030 §6.3).
- [ ] Each pipeline reaches ≥ 80 % line coverage; `coverageThreshold` enforces it.
- [ ] Each pipeline emits to the correct SSE topic (`cost-update`,
      `heartbeat`, `log-line`) verified by manual smoke per TDD-030 §10.4.
- [ ] `log-pipeline.ts` calls `redaction.redactLog` on every emitted entry; the
      test asserts redaction on a synthetic-PII fixture.
- [ ] `cost-pipeline.ts` strips API-key URL parameters before emission; the test
      asserts on a `?api_key=SECRET` fixture.
- [ ] `state-pipeline.ts` is unmodified (NG-3004).
- [ ] `redaction.ts`, `server/readers/schemas/*`, and the readers under
      `server/readers/` are unmodified by this plan.
- [ ] Portal's existing `bun test` continues to pass (no regression).
- [ ] CI runs 3 consecutive green builds on the PR branch (flake check).
- [ ] PR description notes "depends on TDD-029 merged" and links the merge SHA;
      describes the manual smoke evidence (per TDD-030 §10.4).
- [ ] Pipelines remain off-by-default at the config level (TDD-030 §10.3) — no
      auto-enable in this plan.
