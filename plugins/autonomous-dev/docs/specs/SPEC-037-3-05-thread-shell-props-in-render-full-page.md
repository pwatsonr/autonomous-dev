# SPEC-037-3-05: renderFullPage — derive and thread shell props

## Metadata
- **Parent Plan**: PLAN-037-3-rail-and-nav-completeness
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-3 Scope item 7
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-037-3-01, SPEC-037-3-02, SPEC-037-3-04, SPEC-013-3-03 (daemon-status reader)
- **Priority**: P0
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Thread the new rail-ops + rail-nav props through `renderFullPage` in `server/templates/index.tsx`. Derive `daemonStatus`, `daemonAgeSeconds`, `breakerState`/`breakerCount`/`breakerThreshold`, `mtdSpend`/`mtdPctOfCap`, `killSwitchEngaged`, `approvalsCount`, `requestsCount`, `homelabFailingCount`, `agentsAlertCount` server-side once per render and pass them to `<ShellLayout>`. Uses a 5-second in-memory cache on heartbeat reads to avoid per-render disk hits.

## Acceptance Criteria

- **AC-01**: `renderFullPage` gains a new optional `shellState?: ShellRailState` parameter. When omitted, the function derives state via a new `deriveShellRailState()` helper that reads heartbeat.json + cost tracker + approvals queue + platforms state.
- **AC-02**: `deriveShellRailState()` returns `{ daemonStatus, daemonAgeSeconds, breakerState, breakerCount, breakerThreshold, mtdSpend, mtdPctOfCap, killSwitchEngaged, approvalsCount, requestsCount, homelabFailingCount, agentsAlertCount }`. Each field is independent — a failure in one source yields `undefined`/`"unknown"` for that field only, never throwing.
- **AC-03**: Heartbeat read is cached in a module-level Map keyed by `state-dir`, TTL 5_000 ms. Subsequent calls within the TTL reuse the cached value (verified via spy in tests).
- **AC-04**: Daemon mapping — `daemon-status.ts` `"fresh"` → `daemonStatus="running"`; `"stale"` → `"stale"`; `"dead"` → `"down"`. `daemonAgeSeconds` = `Math.floor((now - last_seen)/1000)` when `last_seen` is present, else `undefined`.
- **AC-05**: `<ShellLayout>` invocation inside `renderFullPage` spreads the resolved `shellState` plus `activePath`, `cspNonce`, `theme`. Existing callers of `renderFullPage` are unchanged (no signature break — new param is optional and trailing).
- **AC-06**: `renderViewToContext` passes through `shellState` from `c.get("shellState")` if present, otherwise lets `renderFullPage` derive it. This enables future request-scoped overrides without breaking the default path.

## Implementation

Files modified/created:
1. `plugins/autonomous-dev-portal/server/templates/index.tsx` — update `renderFullPage` signature, derive state, spread onto `<ShellLayout>`.
2. `plugins/autonomous-dev-portal/server/lib/shell-rail-state.ts` (NEW) — `deriveShellRailState()` helper + 5s cache.
3. `plugins/autonomous-dev-portal/server/lib/shell-rail-state.test.ts` (NEW) — unit tests for derivation + cache.

Steps:
1. Define a `ShellRailState` interface with all 12 fields (all optional).
2. Implement `deriveShellRailState()` as the union of independent try/catch blocks — one per source. Sources: `daemon-status.ts` (daemon + kill-switch), cost-tracker JSON (mtd), approvals queue file (approvals/requests counts), platforms registry (homelab failing). Where a source is absent, omit the field.
3. Implement a `getCachedHeartbeat()` wrapper around `readDaemonStatus()` with 5_000 ms TTL.
4. Thread `shellState` through `renderFullPage` and the optional `renderViewToContext` overload.
5. Update `templates/index.test.tsx` to assert that calling `renderFullPage` with a mocked state surfaces the right props on `<ShellLayout>` (via render snapshot inspection).

## Tests

`plugins/autonomous-dev-portal/server/lib/shell-rail-state.test.ts`:

| ID | Assertion |
|----|-----------|
| SR-01 | With fresh heartbeat → `daemonStatus="running"`, `daemonAgeSeconds < 60` |
| SR-02 | With missing heartbeat file → `daemonStatus="down"`, other daemon-fields undefined, no throw |
| SR-03 | Two calls within 5s perform only one heartbeat read (spy on `readFile` count) |
| SR-04 | A failure reading approvals queue does not affect daemon fields |
| SR-05 | `mtdPctOfCap` computed correctly from `mtdSpend / cap * 100` rounded to integer |

`templates/index.test.tsx`:

| ID | Assertion |
|----|-----------|
| IDX-10 | `renderFullPage` with explicit `shellState` renders `data-active-path` + the supplied daemon dot tone |
| IDX-11 | `renderFullPage` without `shellState` still returns valid HTML (derivation path) |

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/unit/lib/shell-rail-state.test.ts tests/unit/templates/index.test.tsx
curl -s http://127.0.0.1:19280/ | grep -oE 'data-active-path="[^"]+"'
curl -s http://127.0.0.1:19280/ | grep -oE 'class="dot (live|warn|err|muted|ok)"'
```
