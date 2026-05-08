# PLAN-030-3 Plugin-Reload CLI Manual Canary

This runbook closes out PLAN-030-3 (TDD-019 plugin-reload CLI) per
TDD-030 §10.4. It contains:

1. The PR-description evidence template the closeout PR must include.
2. The smoke-test recipe an operator runs on a developer laptop to fill
   that template.
3. The TDD-031 path-divergence breadcrumb (`src/cli/...` per PRD-016 vs
   the as-built `intake/cli/...` per OQ-30-04).

The runbook is checked into the repo as a permanent reference; the
*evidence itself* (the verbatim canary command + output) lives in the
closeout PR's description per SPEC-030-3-04 — GitHub preserves PR
descriptions, which is the right home for human-paste evidence.

## 1. Smoke-test recipe

Run this on a developer laptop with the merged PLAN-030-3 branch
checked out. Replace paths as needed for your local layout.

```bash
# 0. Sanity: confirm the four PLAN-030-3 deliverables are on disk.
ls -1 \
  plugins/autonomous-dev/bin/reload-plugins.js \
  plugins/autonomous-dev/intake/cli/dispatcher.ts \
  plugins/autonomous-dev/intake/cli/commands/plugin.ts \
  plugins/autonomous-dev/tests/integration/test-plugin-reload.test.ts

# 1. Run the integration test (SPEC-030-3-03) under jest --runInBand.
cd plugins/autonomous-dev
npx jest tests/integration/test-plugin-reload.test.ts --runInBand
echo "jest exit: $?"   # expect 0

# 2. Drive the bin wrapper directly with a bare-shorthand argv. With no
#    daemon hook wired (production state today), the wrapper returns
#    exit 2 with a "daemon reload hook not configured" stderr line —
#    that is the documented configuration-error contract (TDD-030 §7.3,
#    PRD-016 FR-1643). The smoke confirms the wrapper itself parses
#    argv, dispatches, and translates the dispatcher's Promise<number>
#    into a process exit code.
node bin/reload-plugins.js my-test-plugin
echo "bin exit: $?"    # expect 2

# 3. Drive the bin wrapper with an invalid argv. Exit 2 + "Usage:" line.
node bin/reload-plugins.js
echo "bin exit (no args): $?"   # expect 2

# 4. Drive the bin wrapper with a path-traversal name. Exit 2 + "Invalid
#    plugin name" + "Usage:" lines.
node bin/reload-plugins.js ../etc/passwd
echo "bin exit (traversal): $?" # expect 2
```

Capture all four exit codes and the stderr text; paste them into the
PR description per the template in §3 below.

## 2. Why no real daemon in this canary

The autonomous-dev plugin does not yet ship a runnable daemon binary
that exposes a reload RPC. PRD-016 OQ-30-03 / OQ-30-04 are the open
questions that block "wire a real daemon hook into `bin/reload-plugins.js`";
TDD-031 (or successor) owns the resolution. Until then:

- The dispatcher (`intake/cli/dispatcher.ts`) and command module
  (`intake/cli/commands/plugin.ts`) are pure and fully unit-tested
  (SPEC-030-3-01, 21 unit tests).
- The bin wrapper (`bin/reload-plugins.js`) is the only file in
  PLAN-030-3 permitted to call `process.exit` (FR-1660); it is unit-
  tested via the dispatcher contract.
- The integration test (SPEC-030-3-03) spawns a daemon-shim subprocess
  and drives `dispatch()` end-to-end through an injected file-based
  reload hook, exercising the full pipeline minus the real daemon
  RPC layer.

The "happy path with a real daemon" canary is therefore a **future**
work item once OQ-30-03 / OQ-30-04 are resolved and a daemon hook
exists. For PLAN-030-3 closeout, the four-step recipe above is
sufficient evidence that the operator-facing wrapper works.

## 3. PR description evidence template

Paste the following block into the PLAN-030-3 closeout PR description,
filled in with the actual recorded values:

```md
## Manual canary (TDD-030 §10.4 / SPEC-030-3-04)

**Host**: <macOS x.y.z / Linux distro x.y.z>
**Node**: <output of `node --version`>
**Date**: <YYYY-MM-DD>
**Branch SHA**: <git rev-parse HEAD>

### Step 1 — integration test
```
$ npx jest tests/integration/test-plugin-reload.test.ts --runInBand
PASS autonomous-dev tests/integration/test-plugin-reload.test.ts
  plugin-reload CLI (integration, SPEC-030-3-03)
    ✓ reloads a plugin without restarting the daemon ...
    ✓ returns exit 1 within 2 s when the daemon is not running
jest exit: 0
```

### Step 2 — bin wrapper, no daemon hook wired
```
$ node bin/reload-plugins.js my-test-plugin
reload-plugins: daemon reload hook not configured
bin exit: 2
```

### Step 3 — bin wrapper, missing argv
```
$ node bin/reload-plugins.js
Usage:
  reload-plugins <plugin-name>           # equivalent to: plugin reload <plugin-name>
  reload-plugins plugin reload <name>
...
bin exit (no args): 2
```

### Step 4 — bin wrapper, path-traversal name rejected
```
$ node bin/reload-plugins.js ../etc/passwd
Invalid plugin name: "../etc/passwd"
Usage:
...
bin exit (traversal): 2
```

## Path divergence note (TDD-031 breadcrumb)

PRD-016 originally cited `src/cli/...` as the dispatcher path. The
as-built path is `intake/cli/...` per TDD-030 OQ-30-04. The SPEC
amendment that reconciles PRD-016 with the as-built layout is owned
by **TDD-031** (link: <issue-or-PR-URL>). It is intentionally **not**
part of this PR — leaving the SPEC text unmodified preserves the audit
trail and avoids rolling SPEC drift into a closeout.

## Dependencies
- TDD-029 merged: <SHA-or-PR-URL>

## Flake-check evidence
- CI run 1 (green): <URL>
- CI run 2 (green): <URL>
- CI run 3 (green): <URL>
```

## 4. Acceptance checklist (for the closeout PR reviewer)

The reviewer of the PLAN-030-3 closeout PR confirms each of the
following by inspection of the description (no automated check is
feasible because the evidence lives in PR text, not files):

- [ ] All four canary steps were run end-to-end on a developer laptop.
- [ ] Step 1's jest exit code is 0.
- [ ] Steps 2–4's bin exit codes match the documented contract
  (`{2, 2, 2}` for the production-no-hook configuration).
- [ ] The path-divergence note is present and links a real TDD-031
  issue/PR (placeholder issue is acceptable).
- [ ] The TDD-029 merge SHA is present and points at a merged commit
  on `main`.
- [ ] Three consecutive green CI runs on the PR branch SHA are linked
  (TDD-030 §8.4 flake check). A green-on-rebase does NOT count — the
  rebase produces a different SHA, which resets the count.

If any item is missing, the reviewer requests changes with a one-line
ask. No SPEC text is modified by the closeout PR (`git diff main --
'plugins/autonomous-dev/docs/specs/'` returns only the new SPEC-030-3
docs). PRD-016's `src/cli/...` references are intentionally left as-is;
TDD-031 owns the cleanup.

## 5. Rollback

Revert the closeout PR's merge commit. The four PLAN-030-3 deliverables
(`bin/reload-plugins.js`, `intake/cli/dispatcher.ts`,
`intake/cli/commands/plugin.ts`,
`tests/integration/test-plugin-reload.test.ts`) all roll out together
and roll back together. The autonomous-dev plugin's existing CLIs and
the jest suite are unaffected by either direction.
