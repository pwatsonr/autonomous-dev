# SPEC-022-2-03: `code-fixer` Fixture Plugin + Human Approval Gate with State Persistence

## Metadata
- **Parent Plan**: PLAN-022-2
- **Tasks Covered**: Task 6 (canonical `code-fixer` fixture plugin), Task 7 (human approval gate with persisted state)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-2-03-code-fixer-fixture-and-approval-gate.md`

## Description
Ship the canonical end-to-end demonstration of TDD-022 §10's standards-to-fix flow by (a) creating the `code-fixer` fixture plugin that consumes `security-findings` artifacts produced by the existing `rule-set-enforcement-reviewer` (PLAN-020-1) and emits `code-patches` artifacts marked `requires_approval: true`, and (b) implementing the human approval gate inside `ChainExecutor` that pauses chains when such an artifact is produced, persists chain state to disk, raises an escalation via PLAN-009's router, and resumes when the operator approves through the CLI shipped in SPEC-022-2-04.

State persistence is critical: the daemon may be restarted while a chain is paused. State is written via two-phase commit to `<request>/.autonomous-dev/chains/<chain-id>.state.json` containing the chain ID, the paused-at-plugin ID, the topological order, the artifacts produced so far, and the timestamp. On daemon start, pending-approval state files are scanned and re-registered with the escalation router so operators can still approve.

This spec ships the fixture plugin as a stub (no real code-modification logic — that is a future plan). The fixture proves the wiring: it can be loaded by PLAN-019-1's discovery, declares the right consumes/produces shape, and produces a schema-valid `code-patches` artifact when invoked.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/fixtures/plugins/code-fixer/hooks.json` | Create | Plugin manifest declaring consumes `security-findings`, produces `code-patches` with `requires_approval: true` |
| `plugins/autonomous-dev/tests/fixtures/plugins/code-fixer/code-fixer.js` | Create | Stub entry point: read findings JSON, emit one placeholder patch per finding |
| `plugins/autonomous-dev/tests/fixtures/plugins/code-fixer/README.md` | Create | One-paragraph note that this is a fixture, not a real fixer |
| `plugins/autonomous-dev/src/chains/executor.ts` | Modify | Pause logic on `requires_approval: true`; resume entry point |
| `plugins/autonomous-dev/src/chains/state-store.ts` | Create | Two-phase-commit JSON state file writer; loader on daemon start |
| `plugins/autonomous-dev/src/chains/types.ts` | Modify | Add `ChainPausedState` interface; extend artifact metadata to include `requires_approval` |
| `plugins/autonomous-dev/src/daemon/startup.ts` | Modify | On boot, call `StateStore.recoverPending()` to re-register escalations |
| `plugins/autonomous-dev/tests/chains/test-approval-gate.test.ts` | Create | Unit tests: pause, persist, resume, daemon-restart recovery |

## Implementation Details

### `code-fixer` Fixture Manifest (`hooks.json`)

```json
{
  "name": "code-fixer",
  "version": "0.0.1-fixture",
  "description": "FIXTURE: emits placeholder code-patches for security findings. Not a real fixer.",
  "trust": { "level": "fixture", "publisher": "autonomous-dev-tests" },
  "consumes": {
    "artifact_type": "security-findings",
    "schema_version": "1.x",
    "on_failure": "warn"
  },
  "produces": {
    "artifact_type": "code-patches",
    "schema_version": "1.0",
    "requires_approval": true,
    "on_failure": "block"
  },
  "entry_point": "code-fixer.js"
}
```

### `code-fixer.js` Stub

```js
// Stub: emit one placeholder patch per finding. Real patch logic is a future plan.
module.exports = async function codeFixer({ artifacts, logger }) {
  const findings = artifacts['security-findings']?.findings ?? [];
  const patches = findings.map((f, i) => ({
    patch_id: `patch-${f.finding_id ?? i}`,
    target_file: f.location?.file ?? 'unknown',
    target_line: f.location?.line ?? 0,
    placeholder: true,
    suggestion: `// TODO: fix ${f.rule_id ?? 'unknown-rule'} (fixture stub, no real fix applied)`,
    requires_approval: true,
  }));
  logger.info(`code-fixer fixture emitted ${patches.length} placeholder patches`);
  return { artifact_type: 'code-patches', patches };
};
```

### `ChainPausedState` Shape

```ts
export interface ChainPausedState {
  chain_id: string;
  paused_at_plugin: string;        // plugin ID that produced the requires_approval artifact
  paused_at_artifact: string;      // artifact ID awaiting approval
  topological_order: string[];     // remaining plugins to run after approval
  artifacts_so_far: ArtifactRef[]; // refs to persisted artifacts (file paths under .autonomous-dev/chains/)
  request_id: string;
  paused_timestamp_iso: string;
}
```

### Two-Phase-Commit State Writer (`state-store.ts`)

```ts
async function writeStateAtomic(path: string, state: ChainPausedState): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, path); // atomic on POSIX
}

export async function recoverPending(rootDir: string, escalationRouter: EscalationRouter): Promise<number> {
  const stateDir = path.join(rootDir, '.autonomous-dev', 'chains');
  const files = (await fs.readdir(stateDir).catch(() => []))
    .filter(f => f.endsWith('.state.json'));
  let recovered = 0;
  for (const f of files) {
    const state = JSON.parse(await fs.readFile(path.join(stateDir, f), 'utf8'));
    await escalationRouter.notify({
      kind: 'chain-approval-pending',
      chain_id: state.chain_id,
      artifact_id: state.paused_at_artifact,
      paused_since: state.paused_timestamp_iso,
    });
    recovered += 1;
  }
  return recovered;
}
```

### Pause Logic in `ChainExecutor`

After a plugin returns and the produced artifact has been persisted (and the size check from SPEC-022-2-02 passed):

```ts
if (artifact.requires_approval === true) {
  const state: ChainPausedState = {
    chain_id: ctx.chain_id,
    paused_at_plugin: plugin.id,
    paused_at_artifact: artifact.id,
    topological_order: this.remainingOrder(plugin),
    artifacts_so_far: this.artifactRegistry.refs(),
    request_id: ctx.request_id,
    paused_timestamp_iso: new Date().toISOString(),
  };
  await this.stateStore.writeStateAtomic(this.statePath(ctx.chain_id), state);
  await this.escalationRouter.notify({
    kind: 'chain-approval-pending',
    chain_id: ctx.chain_id,
    artifact_id: artifact.id,
    paused_since: state.paused_timestamp_iso,
  });
  return { outcome: 'paused', state };
}
```

### Resume Entry Point

```ts
async resume(chain_id: string): Promise<ChainResult> {
  const state = await this.stateStore.read(this.statePath(chain_id));
  if (!state) throw new ChainStateMissingError(chain_id);
  // Verify the artifact is approved (approval marker file is written by SPEC-022-2-04 CLI):
  const approvedMarker = `${this.artifactPath(state.paused_at_artifact)}.approved.json`;
  if (!await this.fileExists(approvedMarker)) {
    throw new ChainNotApprovedError(chain_id, state.paused_at_artifact);
  }
  // Continue executing remaining topological order:
  const result = await this.runRemaining(state);
  await fs.unlink(this.statePath(chain_id)); // cleanup on successful resume
  return result;
}
```

## Acceptance Criteria

- [ ] `code-fixer` fixture is discoverable by PLAN-019-1's plugin loader (appears in the discovered plugins list when its directory is on the search path).
- [ ] `code-fixer` invocation with a fixture `security-findings` artifact containing 3 findings emits a `code-patches` artifact with exactly 3 patch entries, each having `requires_approval: true`.
- [ ] The emitted `code-patches` artifact validates against the existing schema (one placeholder schema is acceptable for the fixture; reused in SPEC-022-2-05).
- [ ] When `code-fixer` produces its artifact, the executor returns `outcome: 'paused'` and writes a state file at `<request>/.autonomous-dev/chains/<chain-id>.state.json` containing all `ChainPausedState` fields.
- [ ] The state file is written via `writeStateAtomic` (verified by checking that no `.tmp.*` file remains after the write completes successfully).
- [ ] An escalation is emitted with `kind: 'chain-approval-pending'`, `chain_id`, `artifact_id`, and `paused_since` (verified by capturing escalation-router calls in test).
- [ ] No downstream plugins after the paused-at plugin are invoked while in paused state.
- [ ] Calling `executor.resume(chain_id)` before an `.approved.json` marker exists throws `ChainNotApprovedError` and leaves the state file intact.
- [ ] Calling `executor.resume(chain_id)` after writing the `.approved.json` marker invokes the remaining topological-order plugins, returns success, and removes the state file.
- [ ] On daemon startup, `recoverPending()` reads each `.state.json` file under `<request>/.autonomous-dev/chains/` and re-emits one `chain-approval-pending` escalation per file; returns the count of recovered states.
- [ ] If the daemon is restarted between pause and resume (simulated by creating an in-memory `StateStore`, persisting state, then constructing a new `StateStore` over the same directory), `recoverPending()` finds the state, and a subsequent `resume(chain_id)` after writing `.approved.json` completes successfully.
- [ ] State files are written with mode `0o600` (verified via `fs.stat`).
- [ ] Unit-test coverage on pause/resume and state-store paths is ≥95% (line + branch).

## Dependencies

- **Blocked by**: SPEC-022-2-02 (failure mode `block` is used by the fixture's `produces.on_failure`).
- **Blocked by**: PLAN-022-1 (artifact registry, executor base, manifest discovery).
- **Blocked by**: PLAN-009-X escalation router (existing on main).
- **Blocked by**: PLAN-019-1 plugin discovery (existing on main).
- Provides to SPEC-022-2-04: the `.approved.json` marker contract that the CLI writes; the `executor.resume()` entry point the CLI calls.
- Provides to SPEC-022-2-05: the `code-fixer` fixture and pause/resume infrastructure used by the integration test.
- No new npm packages introduced.

## Notes

- The fixture plugin lives under `tests/fixtures/plugins/` (not under `plugins/`) so it does not ship in the production marketplace. SPEC-022-2-05's integration test loads it explicitly via the test-only discovery path.
- State file location uses the existing `<request>/.autonomous-dev/` convention (per PLAN-022-1) so state is scoped to the request and naturally cleaned up when the request directory is cleaned up.
- Two-phase commit uses `write tmp -> rename` which is atomic on POSIX. Windows users would need a different strategy; out of scope (the daemon targets POSIX).
- The `.approved.json` sidecar pattern (vs mutating the artifact in place) preserves the artifact's original signature for any future signature-verification flow (PLAN-022-3).
- `recoverPending` is idempotent on the escalation side: re-emitting the same `chain-approval-pending` notification is safe because the router dedups by `chain_id`. Documented assumption; verified by SPEC-022-2-05's restart test.
- Fixture's `consumes.on_failure: 'warn'` means if `rule-set-enforcement-reviewer` fails, the code-fixer is skipped (correct behavior — no findings means no patches needed). Fixture's `produces.on_failure: 'block'` means if the fixer itself fails, the chain halts (correct — patches are security-critical, partial failures must surface).
