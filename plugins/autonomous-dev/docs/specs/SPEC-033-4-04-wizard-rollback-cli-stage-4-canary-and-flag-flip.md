# SPEC-033-4-04: Wizard Rollback CLI + Stage 4 Canary Doc + Phase 16 Feature-Flag Default Flip

## Metadata
- **Parent Plan**: PLAN-033-4
- **Parent TDD**: TDD-033 §8.2 (rollout stages), §12.2 (rollback)
- **Parent PRD**: AMENDMENT-002 §4.7, §4.8
- **Tasks Covered**: PLAN-033-4 Tasks 8, 10
- **Estimated effort**: 1 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Implement the `autonomous-dev wizard rollback --phase NN` CLI per
TDD-033 §12.2. Rollback reverts the config keys listed in the phase's
`output_state.config_keys_written` to pre-phase snapshot values from
`~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json`, revokes any
external resources listed in `output_state.external_resources_created`
(cred-proxy handles, firewall allowlists), and resets
`phases.NN.status` to `not-run`. Snapshot capture happens automatically
at phase start (extends SPEC-033-1-03's orchestrator loop). Also ships
the Stage 4 canary doc and the final feature-flag default flip
(`wizard.phase_16_module_enabled: false → true`) gated on the canary
criteria.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                              | Task |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A new CLI command `autonomous-dev wizard rollback --phase NN` MUST be implemented at `plugins/autonomous-dev/src/cli/commands/wizard-rollback.ts` (or wherever the wizard CLI sub-commands live, following existing conventions). | T8   |
| FR-2  | The orchestrator (extending SPEC-033-1-03) MUST take a snapshot at phase entry. The snapshot captures the values of EVERY key listed in the phase's `output_state.config_keys_written` (read from current config file) and the values of any external_resources_created (read from current state file). The snapshot is written to `~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json` ATOMICALLY (tmp + rename). | T8   |
| FR-3  | Multiple successive runs of the same phase MUST stack snapshots: `~/.autonomous-dev/wizard-snapshots/phase-NN-pre-<ISO8601>.json` for each attempt; the most recent symlinked or referenced as `phase-NN-pre.json`. Rollback walks the stack: most-recent first; multi-attempt rollback supports `--depth N` (default 1). | T8   |
| FR-4  | `wizard rollback --phase NN` MUST: (a) read the most recent snapshot for phase NN; (b) revert each config key in `config_keys_written` to its snapshot value (keys that didn't exist pre-phase are deleted); (c) for each entry in `external_resources_created`, dispatch the matching revocation: `cred-proxy-handle:<env>` → `cred_proxy_revoke <handle-from-current-state>`; `firewall-allowlist:<env>` → `autonomous-dev firewall rollback --env <env>`; (d) reset `phases.NN.status` to `not-run` in `wizard-state.json`; (e) remove the phase from `phases_complete[]` if present; (f) emit a structured summary on stdout: `{"phase": NN, "config_keys_reverted": [...], "external_resources_revoked": [...], "snapshot_used": "<filename>"}`. | T8   |
| FR-5  | Rollback MUST be atomic at the wizard-state level: writes to `wizard-state.json` happen via tmp+rename. Partial failure (e.g. `cred_proxy_revoke` fails for one of three handles) MUST NOT leave the state in a half-rolled-back condition. The implementation: build the new state in memory, attempt all revocations, only persist the new state if revocations all succeed; on any revocation failure, emit a recovery diagnostic listing which resources were revoked and which remain, exit 1, leave wizard-state.json unmodified. | T8   |
| FR-6  | Rollback MUST handle corrupt-snapshot: if the snapshot file is malformed JSON or missing required fields, exit 2 with diagnostic `[wizard-rollback] snapshot corrupt or missing for phase NN`; do NOT attempt revocations; do NOT modify state. | T8   |
| FR-7  | Rollback CLI MUST support `--phase NN` (required) and `--depth N` (optional, default 1). When `--depth >1`, walk the snapshot stack and apply rollbacks oldest-on-stack first (i.e. revert the most recent attempt, then the next, etc.) so that the resulting state matches the state before the Nth-most-recent attempt. | T8   |
| FR-8  | Rollback CLI MUST refuse to rollback a phase whose `phases.NN.status` is `not-run` (no-op with informational message). | T8   |
| FR-9  | Rollback CLI MUST emit a confirmation prompt before executing if any `external_resources_created` are present, unless `--yes` is given. The prompt enumerates the resources to be revoked. | T8   |
| FR-10 | Tests at `plugins/autonomous-dev/tests/cli/wizard-rollback.test.ts` MUST cover: (a) happy single-attempt rollback for a phase with no external resources (e.g. phase 8); (b) happy single-attempt rollback for phase 16 (3 cred-proxy handles + 3 firewall rollbacks); (c) multi-attempt rollback with `--depth 3`; (d) corrupt-snapshot handling; (e) partial revocation-failure recovery; (f) refusal on `not-run` phase; (g) `--yes` flag bypasses confirmation; (h) snapshot-stack ordering by ISO8601 filename. | T8   |
| FR-11 | A document at `plugins/autonomous-dev-assist/skills/setup-wizard/STAGE-4-CANARY.md` MUST exist documenting the Stage 4 gate criteria, extending the format of PLAN-033-2's STAGE-3 doc. | T10  |
| FR-12 | STAGE-4-CANARY.md MUST list at minimum: (a) security review sign-off on `lib/cred-proxy-bridge.sh` (named reviewer + date); (b) ≥ 90% pass on phase 16 eval suite (six cases); (c) credential-leak case auto-fails the suite if any leak is detected; (d) zero credential-pattern matches across the full-flow extended E2E transcript; (e) all composition tests pass (SPEC-033-4-03 group e for phase 16 specifically); (f) no regression on inline phases 1-7, 9, 10. | T10  |
| FR-13 | STAGE-4-CANARY.md MUST contain a checklist (markdown task-list `- [ ]`) for each gate criterion plus a sign-off section to be filled in the merging PR's description: reviewer name, date, eval-run hash, transcript-sweep summary. | T10  |
| FR-14 | After all Stage 4 gate criteria are satisfied (recorded in PR description), `plugins/autonomous-dev-assist/config_defaults.json` MUST be modified to set `wizard.phase_16_module_enabled: true` (replacing the prior `false` initial value from SPEC-033-4-02 rollout note). This change MUST be the FINAL commit of PLAN-033-4 to ensure PRs through the canary period see the flag as `false`. | T10  |
| FR-15 | The flag-flip commit MUST include in its commit message a reference to the PR/issue where Stage 4 sign-off is recorded. The message format: `feat(wizard): flip phase_16_module_enabled default to true (Stage 4 canary signed off in #<PR>)`. | T10  |
| FR-16 | Snapshot directory `~/.autonomous-dev/wizard-snapshots/` MUST be created lazily at first phase entry. The directory MUST be readable only by the owner (mode 0700) since snapshots may contain sensitive configuration values (no credentials per phase contract, but config values like internal URLs). | T8   |

## 3. Non-Functional Requirements

| Requirement                                | Target                                                              | Measurement Method                                  |
|--------------------------------------------|---------------------------------------------------------------------|-----------------------------------------------------|
| Rollback wall-clock                        | < 30s for phase 16 (3 cred-proxy revokes + 3 firewall rollbacks)    | bats `time` measurement                             |
| Rollback atomicity                         | partial-failure leaves wizard-state.json unmodified                 | bats: kill mid-revocation; assert state intact      |
| Snapshot directory permissions             | mode 0700                                                           | `stat -c %a` returns `700`                          |
| Snapshot file permissions                  | mode 0600                                                           | `stat -c %a` returns `600`                          |
| Snapshot capture overhead at phase entry   | < 100ms                                                             | bats `time` measurement                             |
| Stage 4 canary doc completeness            | every gate criterion has a matching task-list checkbox              | grep validation                                     |
| Flag flip is final commit                  | last commit on PLAN-033-4 branch matches FR-15 message format       | git log inspection in PR review                     |
| No-op rollback                             | rollback against not-run phase exits 0 with informational message; no state change | bats: jq diff before/after == empty   |

## 4. Technical Approach

### 4.1 Snapshot capture (FR-2, FR-3, FR-16)

Extend SPEC-033-1-03's orchestrator loop. At phase entry, before any
`output_state` write:

```typescript
// Pseudocode (TypeScript-style for the CLI wrapper; bash equivalent acceptable
// if existing CLI is bash-based — follow project convention).
async function takeSnapshot(phaseNumber: number, contract: PhaseContract) {
  const snapshotDir = `${homedir()}/.autonomous-dev/wizard-snapshots`;
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${snapshotDir}/phase-${pad2(phaseNumber)}-pre-${ts}.json`;
  const tmp = `${file}.tmp`;
  const config = await loadConfig();
  const state = await loadState();
  const snapshot = {
    phase: phaseNumber,
    captured_at: new Date().toISOString(),
    config_keys: Object.fromEntries(
      contract.output_state.config_keys_written.map(k => [k, getNestedKey(config, k)])
    ),
    external_resources_pre: state.phases?.[phaseNumber]?.external_resources ?? [],
  };
  await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  await rename(tmp, file);
  // Update the "current" pointer:
  const current = `${snapshotDir}/phase-${pad2(phaseNumber)}-pre.json`;
  await unlink(current).catch(() => {});
  await symlink(file, current);
}
```

### 4.2 Rollback CLI (FR-1, FR-4, FR-5, FR-7)

Command surface:

```
$ autonomous-dev wizard rollback --phase 16 [--depth 1] [--yes]
```

Implementation outline:

```typescript
async function rollback(phaseNumber: number, depth: number, yes: boolean) {
  const stack = await listSnapshotStack(phaseNumber);  // sorted by ISO8601 filename desc
  if (stack.length < depth) {
    fail(`requested depth=${depth} but only ${stack.length} snapshot(s) available`);
  }
  const snapshots = stack.slice(0, depth);  // most-recent first

  // Validate all snapshots before any mutation.
  for (const s of snapshots) {
    const data = await loadSnapshot(s).catch(() => null);
    if (!data) fail(`[wizard-rollback] snapshot corrupt or missing for phase ${phaseNumber}`, 2);
  }

  // Determine target state by composing rollbacks oldest-first.
  const state = await loadState();
  const config = await loadConfig();
  const contract = await loadPhaseContract(phaseNumber);

  // Enumerate revocations.
  const externalResources = state.phases?.[phaseNumber]?.external_resources ?? [];
  if (externalResources.length > 0 && !yes) {
    confirmPrompt(`Will revoke: ${externalResources.join(", ")}. Proceed? [y/N]`);
  }

  // Build target config in memory.
  const targetConfig = structuredClone(config);
  for (const s of snapshots.reverse()) {  // oldest-first to compose
    for (const [key, value] of Object.entries(s.config_keys)) {
      if (value === undefined) deleteNestedKey(targetConfig, key);
      else setNestedKey(targetConfig, key, value);
    }
  }

  // Attempt all revocations BEFORE persisting state.
  const revoked: string[] = [];
  for (const r of externalResources) {
    const ok = await dispatchRevocation(r, state);
    if (!ok) {
      fail(
        `[wizard-rollback] revocation failed for ${r}. ` +
        `Already revoked: ${revoked.join(", ")}. State NOT modified.`,
        1
      );
    }
    revoked.push(r);
  }

  // Persist new state and config atomically.
  const targetState = structuredClone(state);
  if (targetState.phases?.[phaseNumber]) {
    targetState.phases[phaseNumber].status = "not-run";
    targetState.phases[phaseNumber].external_resources = [];
  }
  targetState.phases_complete = (targetState.phases_complete || []).filter((n: number) => n !== phaseNumber);

  await atomicWrite(configPath, targetConfig);
  await atomicWrite(statePath, targetState);

  console.log(JSON.stringify({
    phase: phaseNumber,
    config_keys_reverted: Object.keys(snapshots[0].config_keys),
    external_resources_revoked: revoked,
    snapshot_used: snapshots[0].file,
  }));
}

function dispatchRevocation(resource: string, state: any): Promise<boolean> {
  const [kind, env] = resource.split(":");
  switch (kind) {
    case "cred-proxy-handle": {
      const handle = state.deploy?.envs?.[env]?.cred_proxy_handle;
      if (!handle) return Promise.resolve(true);  // already absent
      return runCmd("autonomous-dev", ["cred-proxy", "revoke", "--handle", handle]).then(rc => rc === 0);
    }
    case "firewall-allowlist": {
      return runCmd("autonomous-dev", ["firewall", "rollback", "--env", env]).then(rc => rc === 0);
    }
    default:
      return Promise.resolve(false);
  }
}
```

The `--yes` confirmation bypass and `--depth` parameter are wired
through the CLI argument parser. If the project uses a bash-based CLI
instead of TypeScript, an equivalent implementation in bash is
acceptable; `wizard-rollback.sh` parsing flags via `getopts` and
calling `jq` for state edits.

### 4.3 Stage 4 canary doc (FR-11, FR-12, FR-13)

`plugins/autonomous-dev-assist/skills/setup-wizard/STAGE-4-CANARY.md`:

```markdown
# Stage 4 Canary Gate — Phase 16 (Deployment Backends)

This document MUST be filled out and merged before
`wizard.phase_16_module_enabled` is flipped from `false` to `true`.

## Gate Criteria

- [ ] Security review sign-off on `lib/cred-proxy-bridge.sh`
      Reviewer: _________________________  Date: __________
- [ ] Phase 16 eval suite ≥ 90% pass (six cases)
      Eval-run hash: _________________________
- [ ] `credential-leak.md` case asserts ZERO leaks (suite auto-fails if any)
      Run hash: _________________________
- [ ] Full-flow extended E2E transcript: zero credential-pattern matches
      Sweep summary: _________________________
- [ ] Composition tests group (e) pass for phase 16:
      forward → rollback → forward round-trip succeeds
      Test run: _________________________
- [ ] No regression on inline phases 1-7, 9, 10
      Baseline-eval run: _________________________

## Sign-off Section (fill in PR description, link below)

PR: __________________________________________
Reviewer: _____________________________________
Date: ________________________________________

## Rollback Procedure (if canary fails)

1. Set `wizard.phase_16_module_enabled: false` in config_defaults.json
   (revert the flag-flip commit).
2. Run `autonomous-dev wizard rollback --phase 16` for any operator
   who already ran phase 16 with the canary flag flipped on.
3. File a triage issue documenting the canary failure mode.
```

### 4.4 Feature-flag default flip (FR-14, FR-15)

Final commit of PLAN-033-4 modifies
`plugins/autonomous-dev-assist/config_defaults.json`:

```diff
-  "wizard.phase_16_module_enabled": false,
+  "wizard.phase_16_module_enabled": true,
```

Commit message format (FR-15):

```
feat(wizard): flip phase_16_module_enabled default to true (Stage 4 canary signed off in #<PR>)
```

Reviewer should validate that all FR-12 checkboxes are filled in the
PR description before approving the flag-flip commit.

### 4.5 Test plan

`tests/cli/wizard-rollback.test.ts`:

| Test ID  | Scenario                                                           | Assert                                                              |
|----------|--------------------------------------------------------------------|---------------------------------------------------------------------|
| WR-101   | Rollback phase 8 (no external resources, single attempt)           | config keys reverted; status=not-run; no revocations attempted      |
| WR-102   | Rollback phase 16 (3 cred-proxy + 3 firewall rollbacks)            | revoke counter == 3; firewall rollback counter == 3; config reverted |
| WR-103   | Rollback `--depth 3` walks stack oldest-first                      | resulting state matches state before 3rd-most-recent attempt        |
| WR-104   | Corrupt snapshot                                                   | exit 2; diagnostic; no state change                                 |
| WR-105   | Partial revocation failure                                         | exit 1; first revocation succeeded but state NOT modified           |
| WR-106   | Rollback against `not-run` phase                                   | exit 0; informational message; no state change                      |
| WR-107   | `--yes` bypasses confirmation                                      | no prompt; rollback proceeds                                        |
| WR-108   | Snapshot stack ordering                                            | files sorted by ISO8601 timestamp desc                              |
| WR-201   | Snapshot directory permissions                                     | mode 0700 after first phase entry                                   |
| WR-202   | Snapshot file permissions                                          | mode 0600                                                           |
| WR-203   | Snapshot capture under 100ms                                       | `time` shows < 100ms wall                                            |
| WR-301   | Atomic write to wizard-state.json                                  | kill mid-write; state intact (either pre or post, never partial)    |

`tests/setup-wizard/stage-4-canary-doc.bats`:

| Test ID  | Scenario                                                       | Assert                                                  |
|----------|----------------------------------------------------------------|---------------------------------------------------------|
| S4-101   | STAGE-4-CANARY.md exists                                        | file present                                            |
| S4-102   | All FR-12 checkboxes present                                    | grep counts each criterion                              |
| S4-103   | Sign-off section present                                        | grep "Sign-off Section"                                 |

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01: orchestrator + phase contract + state schema.
- SPEC-033-1-03: orchestrator loop (extended for snapshot capture).
- SPEC-033-4-01: `cred_proxy_revoke` for handle revocation.
- SPEC-033-4-02: phase 16's `output_state.external_resources_created` schema (`cred-proxy-handle:<env>`, `firewall-allowlist:<env>`).
- SPEC-033-4-03: composition group (e) round-trip tests consume the rollback CLI.
- `autonomous-dev firewall rollback` CLI (TDD-024).
- Existing wizard CLI argument parser (`commander` / `yargs` / bash `getopts` per project convention).

**Produced:**
- `plugins/autonomous-dev/src/cli/commands/wizard-rollback.ts` (or bash equivalent).
- Snapshot capture extension in orchestrator loop (≤ 50 LOC change to SPEC-033-1-03's loop file).
- `plugins/autonomous-dev/tests/cli/wizard-rollback.test.ts`.
- `plugins/autonomous-dev-assist/skills/setup-wizard/STAGE-4-CANARY.md`.
- Modification to `plugins/autonomous-dev-assist/config_defaults.json` (final commit).

## 6. Acceptance Criteria

### Snapshot capture (FR-2, FR-3, FR-16, NFR overhead, NFR perms)

```
Given any phase NN enters via the orchestrator
When the snapshot step runs
Then ~/.autonomous-dev/wizard-snapshots/phase-NN-pre-<ISO8601>.json is created
And ~/.autonomous-dev/wizard-snapshots/phase-NN-pre.json points to that file
And the snapshot contains all keys from contract.output_state.config_keys_written with their pre-phase values
And the snapshot file mode is 0600
And the directory mode is 0700
And the snapshot capture wall-clock is < 100ms
```

### Rollback happy path (FR-4)

```
Given phase 8 has been run successfully (no external_resources_created)
When `autonomous-dev wizard rollback --phase 8 --yes` is invoked
Then exit code is 0
And every key in phase-8 config_keys_written is restored to its snapshot value
  (or removed if absent in the snapshot)
And phases.08.status is reset to "not-run"
And phases_complete[] no longer contains 8
And stdout contains a JSON object with config_keys_reverted, external_resources_revoked=[], snapshot_used
```

### Phase 16 rollback dispatches revocations (FR-4, NFR phase-16-wall)

```
Given phase 16 has been run successfully with 3 non-local backends
When `autonomous-dev wizard rollback --phase 16 --yes` is invoked
Then cred_proxy_revoke is invoked exactly 3 times (one per env handle)
And `autonomous-dev firewall rollback --env <env>` is invoked exactly 3 times
And the 12 deploy.envs.* config keys are reverted
And phases.16.status == "not-run"
And total wall-clock < 30s
```

### Atomic rollback on partial failure (FR-5, NFR atomicity)

```
Given phase 16 has 3 cred-proxy handles and the second revoke fails
When rollback is invoked
Then the first revoke succeeded
And rollback exits 1
And stderr lists which resources were revoked and which remain
And wizard-state.json is unchanged from its pre-rollback state
And config_defaults file is unchanged
```

### Corrupt snapshot (FR-6)

```
Given the most recent snapshot file is malformed JSON
When rollback is invoked
Then exit code is 2
And stderr contains "[wizard-rollback] snapshot corrupt or missing for phase NN"
And no revocations are attempted
And wizard-state.json is unchanged
```

### Multi-attempt depth (FR-7)

```
Given 3 successful run-rollback-rerun cycles produced 3 stacked snapshots
When `wizard rollback --phase NN --depth 3 --yes` is invoked
Then the resulting state matches the state captured before the first run
And all 3 snapshots are accounted for in the structured stdout
```

### Refuse rollback on not-run phase (FR-8)

```
Given phases.NN.status == "not-run"
When `wizard rollback --phase NN` is invoked
Then exit code is 0
And stdout contains an informational message ("phase NN is not-run; nothing to rollback")
And wizard-state.json is unchanged
```

### Confirmation prompt (FR-9)

```
Given phase 16 was run with 3 external resources
When `wizard rollback --phase 16` is invoked WITHOUT --yes
Then a prompt is emitted listing the 3 resources to be revoked
And rollback waits for operator confirmation

When the same command is invoked WITH --yes
Then no prompt is emitted
And rollback proceeds immediately
```

### Stage 4 canary doc completeness (FR-11, FR-12, FR-13)

```
Given STAGE-4-CANARY.md
When checked against FR-12 criteria list
Then every criterion (a-f) has a corresponding "- [ ]" task-list entry
And the sign-off section contains placeholders for PR, Reviewer, Date
And a rollback procedure section exists
```

### Flag-flip final commit (FR-14, FR-15)

```
Given the PLAN-033-4 branch's commit history
When the final commit is inspected
Then it modifies config_defaults.json setting wizard.phase_16_module_enabled to true
And the commit message matches "feat(wizard): flip phase_16_module_enabled default to true (Stage 4 canary signed off in #<PR>)"
And the PR description contains all FR-12 checkboxes filled in (verified manually at review time)
```

## 7. Test Requirements

- `tests/cli/wizard-rollback.test.ts` — see WR-101 through WR-301 above.
- `tests/setup-wizard/snapshot-capture.bats` — orchestrator-loop extension; permissions; latency.
- `tests/setup-wizard/stage-4-canary-doc.bats` — see S4-101 through S4-103.
- Mock cred-proxy and firewall CLIs reused from SPEC-033-4-01 / SPEC-033-4-02.
- Snapshot fixtures under `tests/fixtures/wizard-snapshots/` for corrupt and stack-of-3 scenarios.

## 8. Implementation Notes

- The atomicity guarantee in FR-5 is the most subtle requirement.
  Build the `targetConfig` and `targetState` entirely in memory,
  attempt all revocations against external systems, and ONLY persist
  to disk if every revocation succeeds. On any failure, the state on
  disk is identical to pre-rollback.
- "Atomic write" of wizard-state.json uses tmp+rename; on a POSIX
  filesystem this is atomic per dirent. The orchestrator already does
  this for other state writes (see SPEC-033-1-01); reuse the helper.
- `cred_proxy_revoke` is idempotent (SPEC-033-4-01 FR-4): re-running
  rollback after a partial-failure recovery is safe.
- The snapshot-stack symlink trick (`phase-NN-pre.json` → most recent
  timestamped file) keeps probes simple; older snapshots remain on
  disk for `--depth >1`. No automatic pruning in this SPEC; an operator
  can `rm` old files manually. Document this in implementation notes
  in the rollback file.
- The `--depth` semantics: `depth=1` reverts the most recent attempt;
  `depth=N` composes rollbacks of the N most recent attempts, in
  oldest-first order, so the resulting state is what would have been
  in place before the (N)th-most-recent attempt began.
- The flag-flip commit (FR-14) must be the LAST commit on the
  PLAN-033-4 branch. CI/PR reviewers should verify this via
  `git log --oneline` showing `feat(wizard): flip ...` at HEAD.
- If the project's wizard CLI is currently bash (no TypeScript),
  implement `wizard-rollback.sh` in bash following the same logic;
  use `jq` for JSON edits, `flock` for state-file locking, and the
  bash equivalent of `getopts` for flag parsing. Tests then live in
  bats under `tests/setup-wizard/wizard-rollback.bats`.
- Snapshot files may contain non-credential config values. Mode 0600
  is defense in depth; the wizard contract still says no credential
  bytes ever enter wizard-process state, so snapshots should not need
  to redact, but a scanner sweep over snapshot files in CI is still
  recommended (out of scope for this SPEC; future hardening).

## 9. Rollout Considerations

- Snapshot capture is unconditionally on; cost is < 100ms per phase
  entry and disk space is small (per-phase JSON, kilobytes). No
  feature flag.
- Rollback CLI is gated by NO feature flag; it's a recovery tool that
  must always be available. If feature flag systems are buggy, the
  rollback CLI is the escape hatch.
- The flag-flip commit is gated on the Stage 4 canary criteria. The
  PR description is the source of truth for sign-off; reviewer
  responsibility to verify before merge.
- Post-flip, operators receive `wizard.phase_16_module_enabled=true`
  by default. Any operator who explicitly set it to `false` in their
  local config is unaffected (config overrides defaults).
- If the canary fails post-flip, follow STAGE-4-CANARY.md's
  Rollback Procedure section.

## 10. Effort Estimate

| Activity                                                     | Estimate |
|--------------------------------------------------------------|----------|
| Snapshot capture extension to orchestrator loop              | 0.15 day |
| Rollback CLI implementation (parsing + dispatch + atomicity) | 0.4 day  |
| Tests (`wizard-rollback.test.ts` + snapshot-capture.bats)    | 0.25 day |
| STAGE-4-CANARY.md authoring                                  | 0.1 day  |
| Flag-flip commit + commit-message validation                 | 0.05 day |
| Implementation notes + CLI help text                         | 0.05 day |
| **Total**                                                    | **1 day** |
