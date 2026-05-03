# PLAN-030-3: TDD-019 Plugin-Reload CLI Closeout

## Metadata
- **Parent TDD**: TDD-030-closeout-backfill-014-015-019 (§7)
- **Parent PRD**: PRD-016 Test-Suite Stabilization & Jest Harness Migration
- **Sibling plans**: PLAN-030-1 (auth security tests, merged), PLAN-030-2 (portal pipelines)
- **Estimated effort**: 2-3 days (≈6 engineer-hours per TDD-030 §8.6)
- **Dependencies**: ["TDD-029 merged"] — clean jest gate must exist before the new integration test can land
- **Blocked by**: []
- **Priority**: P1 (operator-facing CLI; no existing operators depend on it per TDD-030 §10.2)

## Objective

Ship the plugin-reload CLI surface named by TDD-019 but never landed in the tree
at `main@2937725`:

| File (NEW) | Type | Purpose |
|------------|------|---------|
| `plugins/autonomous-dev/bin/reload-plugins.js` | executable shebang script | Operator entry point; thin wrapper around the dispatcher |
| `plugins/autonomous-dev/intake/cli/dispatcher.ts` | new module | Shared CLI dispatcher; routes `plugin reload` to the command module |
| `plugins/autonomous-dev/intake/cli/commands/plugin.ts` | new module | Implements `plugin reload`; returns structured exit codes 0 / 1 / 2 |
| `plugins/autonomous-dev/tests/integration/plugin-reload.test.ts` | new jest integration test | End-to-end happy-path test booting a real daemon and CLI subprocess |

Per TDD-030 §7 / OQ-30-04, the as-built path is `intake/cli/...` (PRD-016 cited
`src/cli/...`; TDD-031 amends the SPEC). This plan uses the as-built path
exclusively.

The CLI uses **deterministic invalidation** (an explicit reload message to the
daemon), not file-watcher-driven reload, per TDD-030 §7.4 / PRD-016 R-06. The
file-watcher path is a documented P2 follow-up and explicitly **out of scope**
(NG-3006).

## Scope

### In Scope

- The four files above.
- `process.exit(...)` in `bin/reload-plugins.js` is permitted (PRD-016 FR-1660
  forbids it only under `**/tests/**`).
- A `bin` field entry in `plugins/autonomous-dev/package.json` for
  `"reload-plugins": "./bin/reload-plugins.js"` per TDD-030 OQ-30-05 → Yes.
- `chmod +x` on `bin/reload-plugins.js` (via `.gitattributes` line or a
  one-line `npm prepare` script — pick the lower-friction option).
- Exit-code contract per TDD-030 §7.3 (0 success, 1 transient, 2 config error).
- One integration test per TDD-030 §7.4: boots a daemon in a temp dir, installs a
  plugin at v1.0.0, modifies the manifest to v1.1.0, invokes the CLI, asserts
  exit 0, asserts the daemon RPC reports v1.1.0, asserts the daemon PID is
  unchanged. Runtime budget ≤ 10 s.

### Out of Scope

- Hot-reload semantics for non-plugin daemon state (config, standards, hooks)
  — TDD-030 NG-3006.
- File-watcher-driven auto-reload — TDD-030 §9.3 / NG-3006.
- New CLI commands beyond `plugin reload` — TDD-030 NG-3005.
- Mock-only unit tests of `commands/plugin.ts` — TDD-030 §9.4 explicitly rejects
  this in favor of one real integration test.
- SPEC text amendments referencing the old `src/cli/...` paths — owned by
  TDD-031.
- Auth and pipeline work (PLAN-030-1, PLAN-030-2).

## Tasks

### TASK-001: Add the dispatcher skeleton + CLI command module

**Description:** Create `intake/cli/dispatcher.ts` and
`intake/cli/commands/plugin.ts`. The dispatcher exposes `dispatch(argv: string[]):
Promise<number>` and routes `plugin reload` to the command module. The command
module implements the daemon RPC (using whatever transport the daemon already
exposes — verify against TDD-019's existing hot-reload hook before authoring) and
returns the exit code per the §7.3 contract.

**Files to create:**
- `plugins/autonomous-dev/intake/cli/dispatcher.ts`
- `plugins/autonomous-dev/intake/cli/commands/plugin.ts`

**Files to modify:** none

**Dependencies:** []

**Acceptance Criteria** (per TDD-030 §7):
- `dispatch(['plugin', 'reload', '<plugin-name>'])` resolves with `0` on success,
  `1` on a transient daemon-unreachable error, `2` on a configuration error
  (invalid plugin path, unparseable manifest).
- Unknown commands resolve with `2` (configuration error) and write a usage
  string to `stderr`.
- The command module imports the daemon's existing reload hook (from TDD-019)
  rather than re-implementing the reload semantics. If the hook does not exist
  in a callable form, the task is **paused** and the gap is escalated — this
  plan does not invent new daemon mechanics.
- TypeScript build passes (`tsc --noEmit`).
- No `process.exit` calls in either module (per PRD-016 FR-1660; the wrapper in
  `bin/` owns process termination).
- The dispatcher is pure: it accepts an argv array and returns a number; it does
  not read `process.argv`, does not call `process.exit`, and writes to a passed-in
  logger (default `console`) so the integration test can swap in a buffer.

**Estimated Effort:** 1 day

**Track:** CLI plumbing

**Risks:**
- **Medium:** TDD-019's "existing daemon hot-reload hook" referenced in TDD-030
  §7 may not actually exist as an importable function.
  - **Mitigation:** Inspect the daemon source first (before writing the command
    module). If absent, file an explicit gap, set this plan's status to
    blocked-on-discovery, and surface in the PR description.

---

### TASK-002: `bin/reload-plugins.js` operator entry point

**Description:** A single-file shebang wrapper that imports the dispatcher and
maps its return value to `process.exit`. Unhandled errors map to exit 2.

**Files to create:**
- `plugins/autonomous-dev/bin/reload-plugins.js`

**Files to modify:**
- `plugins/autonomous-dev/package.json` — add a `"bin"` map entry
  `"reload-plugins": "./bin/reload-plugins.js"` per TDD-030 OQ-30-05.
- `plugins/autonomous-dev/.gitattributes` (create or extend) so
  `bin/reload-plugins.js` is checked in with the executable bit, **or** add a
  one-line `npm prepare` script that runs `chmod +x ./bin/reload-plugins.js`
  (lower-friction option wins; document which in the PR).

**Dependencies:** [TASK-001]

**Acceptance Criteria** (per TDD-030 §7.2):
- File begins with `#!/usr/bin/env node`.
- Imports `dispatch` from `../intake/cli/dispatcher.js` (note: `.js` extension
  for ESM; the build step compiles `.ts` to `.js` before publish).
- Calls `dispatch(['plugin', 'reload', ...process.argv.slice(2)])`,
  `.then((code) => process.exit(code))`, `.catch((err) => { console.error(err);
  process.exit(2); })`.
- File mode is executable on disk (verified by `git ls-files --stage`
  reporting `100755`, **or** by the `npm prepare` hook running on install).
- Invoking the script directly with no args writes a usage string to `stderr`
  and exits 2.
- The wrapper is the **only** place `process.exit` is permitted in this plan.

**Estimated Effort:** 0.25 day

**Track:** Operator entry point

**Risks:**
- **Low:** `chmod +x` not preserved on Windows.
  - **Mitigation:** `.gitattributes` line `bin/reload-plugins.js text eol=lf
    executable` plus the `npm prepare` belt-and-braces.

---

### TASK-003: Plugin-reload integration test (FR-1643)

**Description:** Write the single end-to-end jest integration test that proves
the wiring. Boots a daemon in a temp dir via `child_process.spawn`, installs a
test plugin at v1.0.0, modifies the manifest to v1.1.0, invokes
`bin/reload-plugins.js` via `child_process.spawn`, and asserts the §7.4 contract.

**Files to create:**
- `plugins/autonomous-dev/tests/integration/plugin-reload.test.ts`
- `plugins/autonomous-dev/tests/integration/fixtures/test-plugin/manifest.json`
  (v1.0.0 base; the test rewrites it to v1.1.0 mid-test)
- `plugins/autonomous-dev/tests/integration/fixtures/test-plugin/index.js`
  (minimal plugin entry point; one exported function returning the version)

**Files to modify:** none

**Dependencies:** [TASK-001, TASK-002]

**Acceptance Criteria** (per TDD-030 §7.4):
- Test creates a per-run `mkdtempSync` directory; `afterAll` removes it.
- Daemon and CLI are spawned via `child_process.spawn`; both are killed in
  `afterAll` (and on test failure via `try/finally`).
- After the reload invocation: CLI exit code is 0, a follow-up daemon RPC
  reports the plugin at v1.1.0, and the daemon PID is unchanged from before
  the reload.
- Total runtime ≤ 10 s on a laptop.
- No `process.exit` anywhere in the test file (PRD-016 FR-1660).
- One additional negative-path case: invoking the CLI against a daemon that is
  **not** running exits 1 (transient error) within 2 s. This proves the §7.3
  exit-code contract end-to-end without inflating the runtime budget.
- The test runs under `npx jest --runInBand`.

**Estimated Effort:** 1 day

**Track:** Integration

**Risks:**
- **Medium:** Daemon boot is non-trivial in a temp dir; existing
  `tests/integration/test_full_lifecycle.sh` may already encode the recipe.
  Reuse its setup pattern if so (without `cd`-ing — keep absolute paths).
  - **Mitigation:** Inspect the existing integration suite for boot helpers
    before writing the test; do not duplicate.
- **Medium:** The 10 s budget is tight if the daemon is slow to start on CI
  hosts.
  - **Mitigation:** If consistently > 8 s on CI, bump the per-test timeout to
    20 s and add a note in the PR; do not let a tight budget cause flake.
- **Low:** PID-unchanged assertion is racy if the daemon restarts itself for
  reasons unrelated to reload.
  - **Mitigation:** Capture PID immediately before the reload call and assert
    on the same value immediately after; ignore any later restarts.

---

### TASK-004: Manual canary + closeout

**Description:** Per TDD-030 §10.4, run a manual canary on a developer laptop:
`autonomous-dev plugin reload <test-plugin>` against a running daemon returns
exit 0. Document the exact command and observed output in the PR description.
Confirm the SPEC reconciliation (the `src/cli/...` → `intake/cli/...` path
divergence per OQ-30-04) is **not** silently fixed here — TDD-031 owns the SPEC
amendment.

**Files to create:** none

**Files to modify:** none (a manual verification step; evidence captured in the
PR description)

**Dependencies:** [TASK-001, TASK-002, TASK-003]

**Acceptance Criteria:**
- Manual canary command and output are pasted into the PR description per
  TDD-030 §10.4.
- The PR description explicitly lists the path divergence (`src/cli/...` per
  PRD-016 vs `intake/cli/...` as built) and links the open TDD-031 issue.
- No SPEC text in the codebase is modified by this plan.
- `npx jest --runInBand` from the autonomous-dev plugin exits 0 with the new
  integration test running.
- 3 consecutive green CI runs on the PR branch (flake check).

**Estimated Effort:** 0.25 day

**Track:** Closeout

**Risks:**
- **Low:** Manual canary is paste-only evidence; if the maintainer wants
  reproducible CI evidence the canary becomes a CI step in a follow-up PR
  (out of scope here).

---

## Dependency Graph

```
TASK-001 (dispatcher.ts + commands/plugin.ts)
└── TASK-002 (bin/reload-plugins.js + bin map + chmod)
    └── TASK-003 (plugin-reload.test.ts)
        └── TASK-004 (manual canary + closeout)
```

**Critical path:** TASK-001 → TASK-002 → TASK-003 → TASK-004
(≈ 2.5 days, single engineer; tasks are strictly sequential because each builds
on the previous file).

**Parallelism:** None within this plan. Across plans: PLAN-030-2 and PLAN-030-3
share no code and can run concurrently.

## Testing Strategy

This plan ships both production code and a single end-to-end integration test.
Verification:

1. `npx jest --runInBand` exits 0 with the new test running and ≤ 10 s budget.
2. The integration test exercises the §7.3 contract (exit codes 0 and 1 — exit 2
   is exercised at the dispatcher level with unknown commands; arguably worth a
   tiny unit test but not strictly required by FR-1643).
3. Manual canary per §10.4 captured in the PR description.
4. CI runs three times in a row green before merging (flake check; the
   integration test is the most likely flake source in TDD-030).

## Risks

| Risk | Probability | Impact | Affected tasks | Mitigation |
|------|-------------|--------|----------------|------------|
| TDD-019's daemon "reload hook" does not exist as an importable function | Medium | High (blocking) | TASK-001 | Inspect the daemon source before writing `commands/plugin.ts`; if absent, escalate as a discovery and pause the plan rather than invent daemon mechanics |
| Integration test exceeds 10 s on CI | Medium | Medium (flake) | TASK-003 | Bump per-test timeout to 20 s with PR note if observed; do not chase the budget at the cost of stability |
| Daemon-PID assertion races a self-restart | Low | Medium (false negative) | TASK-003 | Capture PID immediately before/after reload; ignore later restarts |
| `chmod +x` lost on Windows checkout | Low | Low | TASK-002 | `.gitattributes` + `npm prepare` belt-and-braces |
| The `src/cli/...` → `intake/cli/...` path divergence causes import confusion | Low | Low | TASK-001, TASK-003 | Use the as-built path consistently; PR description explicitly notes the divergence and links TDD-031 (per TDD-030 OQ-30-04) |
| `process.exit` accidentally lands in a test file | Low | Medium (CI gate) | TASK-003 | Lint rule from PRD-016 FR-1660 catches it; pre-commit hook fails before push |
| File-watcher temptation during implementation | Low | Low (scope creep) | TASK-001 | Hard-coded reject: NG-3006 says deterministic-only; reviewer enforces |

## Definition of Done

- [ ] `bin/reload-plugins.js`, `intake/cli/dispatcher.ts`,
      `intake/cli/commands/plugin.ts`, and
      `tests/integration/plugin-reload.test.ts` all exist.
- [ ] `bin/reload-plugins.js` is executable (verified via
      `git ls-files --stage` showing `100755`, or via the `npm prepare` hook).
- [ ] `package.json` declares `"reload-plugins"` in its `bin` map (per OQ-30-05).
- [ ] Exit-code contract per TDD-030 §7.3 (0 / 1 / 2) is enforced by the
      dispatcher and exercised by the integration test.
- [ ] Integration test boots a daemon, modifies a plugin manifest, invokes the
      CLI, and asserts exit 0 + new version + unchanged PID — per TDD-030 §7.4.
- [ ] Integration test runs under `npx jest --runInBand` in ≤ 10 s.
- [ ] No `process.exit` calls in any test file (PRD-016 FR-1660).
- [ ] Manual canary per TDD-030 §10.4 is captured in the PR description.
- [ ] PR description explicitly notes the `src/cli/...` vs `intake/cli/...`
      path divergence and links the TDD-031 SPEC-reconciliation issue.
- [ ] No SPEC text or `state-pipeline.ts` or auth-surface code is modified.
- [ ] Portal's existing `bun test` continues to pass (no regression — though
      this plan is autonomous-dev plugin only, the gate runs both).
- [ ] CI runs 3 consecutive green builds on the PR branch (flake check).
- [ ] PR description notes "depends on TDD-029 merged" and links the merge SHA.
