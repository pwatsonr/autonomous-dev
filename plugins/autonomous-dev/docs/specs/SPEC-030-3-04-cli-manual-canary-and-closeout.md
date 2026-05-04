# SPEC-030-3-04: Plugin-Reload CLI Manual Canary + Closeout

## Metadata
- **Parent Plan**: PLAN-030-3 (TDD-019 plugin-reload CLI closeout)
- **Parent TDD**: TDD-030 §10.4; PRD-016
- **Tasks Covered**: TASK-004 (manual canary + closeout)
- **Estimated effort**: 0.25 day
- **Depends on**: SPEC-030-3-01, 3-02, 3-03 merged
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-3-04-cli-manual-canary-and-closeout.md`

## Description

Closeout for PLAN-030-3. Run a manual canary on a developer laptop per TDD-030 §10.4 and capture the evidence in the PR description. Confirm that the SPEC-text divergence (`src/cli/...` per PRD-016 vs the as-built `intake/cli/...` per OQ-30-04) is **NOT** silently fixed in this PR — TDD-031 owns that SPEC amendment.

This spec ships **no code, no tests, and no doc files in the repo**. The only deliverable is the merged PR description. That PR description must include:
- The exact `reload-plugins` command run on the canary laptop.
- The observed stdout/stderr.
- The observed exit code.
- The path divergence note (`src/cli/...` vs `intake/cli/...`) with a link to the TDD-031 issue.
- A link to the merged TDD-029 SHA (PLAN-030-3 dependency).
- A 3-green CI flake-check evidence link.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| _(none)_ | _(none)_ | Evidence captured in the PR description, not in tracked files |

This spec is intentionally devoid of file changes. If any reviewer feels the canary evidence should be a permanent artifact, the right home is the PR description (which GitHub preserves) — not a markdown file in the repo (which decays).

## Implementation Details

### Canary recipe (developer laptop)

```bash
# 1. Install the autonomous-dev plugin from the merged PR branch
cd /tmp
mkdir canary && cd canary
npm init -y
npm i ../path/to/checked-out/autonomous-dev/plugins/autonomous-dev

# 2. Set up a test plugin
mkdir -p plugins/canary-plugin
cat > plugins/canary-plugin/manifest.json <<'JSON'
{ "name": "canary-plugin", "version": "1.0.0", "main": "./index.js" }
JSON
cat > plugins/canary-plugin/index.js <<'JS'
const m = require('./manifest.json');
module.exports = { getVersion: () => m.version };
JS

# 3. Start the daemon (whatever bin/daemon command this repo provides)
node node_modules/@autonomous-dev/plugin/bin/daemon.js --plugins-root ./plugins &
DAEMON_PID=$!

# 4. Bump the manifest
sed -i '' 's/1.0.0/1.1.0/' plugins/canary-plugin/manifest.json

# 5. Run the CLI
npx reload-plugins canary-plugin
echo "exit code: $?"

# 6. Cleanup
kill $DAEMON_PID
```

The PR description includes:
- The verbatim shell session above (or its equivalent on the canary machine — adjust paths as needed).
- The observed output (e.g., `reload-plugins: canary-plugin reloaded (version 1.1.0)`).
- The observed exit code (`exit code: 0`).
- The OS / Node version of the canary host.

### PR description template

```md
## Manual canary (TDD-030 §10.4)

**Host**: macOS 14.4 / Node 22.3.0 (or whatever was used)
**Date**: 2026-MM-DD

### Command
```bash
npx reload-plugins canary-plugin
```

### Output
```
reload-plugins: canary-plugin reloaded (version 1.1.0)
exit code: 0
```

### Daemon side
- Pre-reload PID: 12345
- Post-reload PID: 12345 (unchanged)
- Pre-reload version: 1.0.0
- Post-reload version: 1.1.0

## Path divergence note

This PR uses the as-built path `intake/cli/...` per TDD-030 OQ-30-04.
PRD-016 originally cited `src/cli/...`; the SPEC amendment is owned by
TDD-031 (link: <issue-or-PR-URL>) and is **not** part of this PR.

## Dependencies
- Depends on TDD-029 merged: <SHA-or-PR-URL>

## Flake-check evidence
- CI run 1 (green): <URL>
- CI run 2 (green): <URL>
- CI run 3 (green): <URL>
```

### Acceptance via PR review

The reviewer for this PR confirms each of the following by inspection of the description (no automated check is feasible because the evidence lives in PR text, not files):

1. The canary recipe was run end-to-end (not partially).
2. The observed exit code is 0.
3. The observed daemon PID is the same before and after reload.
4. The TDD-031 link is present and points to a real issue/PR.
5. The TDD-029 merge SHA is present and points to a merged commit.
6. The 3 flake-check CI URLs are present and all green.

If any of those is missing, the PR is changes-requested with a one-line ask.

## Acceptance Criteria

- AC-1: The PR description includes the verbatim canary command and observed output (per the template above), captured on a developer laptop.
- AC-2: The PR description includes the daemon's pre/post PID and pre/post version.
- AC-3: The PR description includes the path-divergence note and a link to the TDD-031 SPEC-reconciliation issue (or PR).
- AC-4: The PR description includes the TDD-029 merge SHA.
- AC-5: The PR description links 3 consecutive green CI runs on the PR branch (TDD-030 §8.4 flake check).
- AC-6: No SPEC text in the codebase is modified by this PR. `git diff main -- 'plugins/autonomous-dev/docs/specs/'` against any pre-PLAN-030 spec returns empty (only the new SPEC-030 docs are added).
- AC-7: `npx jest --runInBand` from the autonomous-dev plugin exits 0 with the SPEC-030-3-03 integration test running.
- AC-8: `tsc --noEmit` from the autonomous-dev plugin passes.
- AC-9: Portal's `bun test` continues to pass (no regression — even though this plan is autonomous-dev plugin only, the gate runs both per PRD-016 G-02).
- AC-10: The four PLAN-030-3 deliverables (`bin/reload-plugins.js`, `intake/cli/dispatcher.ts`, `intake/cli/commands/plugin.ts`, `tests/integration/plugin-reload.test.ts`) all exist on the merge SHA.

### Given/When/Then

```
Given an operator running on a developer laptop with the merged-PR plugin installed
When the canary recipe (start daemon → bump manifest → npx reload-plugins canary-plugin) is executed
Then the CLI exits 0
And the daemon RPC reports the new version
And the daemon PID is unchanged
And the verbatim command, output, and exit code are pasted into the PR description

Given a reviewer of the PLAN-030-3 closeout PR
When the reviewer reads the PR description
Then they find the canary evidence (command + output + exit code)
And they find the path-divergence note linking TDD-031
And they find the TDD-029 dependency SHA
And they find 3 green CI run URLs
And only then is the PR approvable
```

## Test Requirements

This spec adds no test files. Verification is:
1. The integration test from SPEC-030-3-03 passes under `npx jest --runInBand`.
2. The portal's `bun test` continues to pass.
3. The manual-canary recipe was run by a human and the evidence pasted into the PR description.
4. CI 3-green flake check before merge.

## Implementation Notes

- **Why no canary script in the repo**: a "canary script" file would imply a CI step. PLAN-030-3 §10.2 / TDD-030 §10.4 explicitly defer CI canarying to a follow-up; today's evidence is human-paste-only, and the right place for human-paste evidence is the PR description (preserved by GitHub) — not a `tests/canary.sh` file (whose existence implies a stronger contract).
- **The path-divergence note matters**: if the closeout PR silently uses `intake/cli/...` without flagging the divergence, future readers comparing PRD-016 ("`src/cli/...`") with the codebase will be confused. The PR-description note is the breadcrumb until TDD-031 lands the SPEC amendment.
- **TDD-031 link**: if the TDD-031 issue/PR does not yet exist when this closeout merges, file it as a placeholder issue first ("TDD-031: SPEC-amendment for `intake/cli/` path divergence") and link that. A dangling reference is worse than a placeholder.
- **CI flake-check**: 3 greens on the SAME branch SHA is the standard. A green-on-rebase does not count (the rebase is a different SHA). If the integration test flakes once, the count resets.
- **No SPEC modifications in this PR**: PRD-016's `src/cli/...` references are intentionally left as-is; TDD-031 owns the cleanup. This rule is repeated in AC-6 because reviewers are likely to "helpfully" propose fixing the SPEC inline; that helpfulness is out of scope here.

## Rollout Considerations

- **Forward**: this PR is the merge gate for PLAN-030-3. Once merged, the operator-facing CLI is shipped. Operators run `npx reload-plugins <name>` against a running daemon to reload a plugin without restarting the daemon.
- **Rollback**: revert the merge commit. The four PLAN-030-3 files vanish; daemon and existing CLIs are unaffected.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Canary recipe cannot be run on the work-window laptop (daemon hard to bring up) | Low | Medium | Per TDD-030 §10.4: defer evidence to canary checklist on the PR; document the gap. Approval still possible with reviewer sign-off |
| TDD-031 issue does not yet exist | Low | Low | File a placeholder issue first; link the placeholder |
| Reviewer objects to the canary-as-PR-description pattern | Low | Low | The pattern is sanctioned by TDD-030 §10.4; reviewer escalates to TDD owner if disagreement |
| Reviewer "helpfully" proposes inline SPEC amendment in this PR | Medium | Medium (scope creep) | AC-6 forbids it; reviewer rebases the suggestion into TDD-031 |
| 3-green CI flake-check takes many runs because the integration test is flaky | Medium | Medium (schedule) | Bump the integration-test test-level timeout per PLAN-030-3 TASK-003 risk; do not approve a PR that has not achieved 3 green |
| The TDD-029 merge SHA is forgotten / linked to wrong PR | Low | Low | Reviewer checklist verifies the SHA points at a merged commit on `main` |
