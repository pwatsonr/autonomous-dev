# SPEC-032-2-03: `observe.yml.example` Workflow Template + Doc Cross-Reference + Doc-Only Test

## Metadata
- **Parent Plan**: PLAN-032-2 (SHA Pinning + observe.yml.example + lint guard)
- **Parent TDD**: TDD-032 §5.3 (WS-3)
- **Parent PRD**: PRD-017 (FR-1712, FR-1713, FR-1714)
- **Tasks Covered**: PLAN-032-2 Task 6 (ship example), Task 7 (cross-reference observe.md), Task 8 (doc-only test)
- **Estimated effort**: 1 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-2-03-observe-yml-example-and-doc-test.md`

## Summary
Ship the missing `observe.yml.example` GitHub Actions workflow
template that downstream operators copy into their own repos to
schedule weekly autonomous-dev observability digests. Default the
workflow to `if: false` so an unconfigured operator does not silently
schedule runs (Risk R5 mitigation). Cross-reference the example from
`commands/observe.md`. Author a doc-only regression test that fails
if the example file or the cross-reference disappears (FR-1714).

This spec ships ONE new YAML file, ONE prose section in
`commands/observe.md`, and ONE new test file. No runtime behavior
changes for the autonomous-dev repo itself; the `.example` file is
never invoked by autonomous-dev's own CI.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/.github/workflows/observe.yml.example` | Create | Workflow template with `if: false` default, opt-in |
| `plugins/autonomous-dev/commands/observe.md` | Modify | Append `## Workflow template` section (≤ 120 words) |
| `plugins/autonomous-dev/tests/docs/test-observe-yml-example.test.ts` | Create | Doc-only regression test (or co-locate per existing convention) |

If the existing test convention places doc-only tests under a
different path (`plugins/autonomous-dev/tests/docs/**` may not exist
yet), the implementer co-locates with existing doc tests and notes
the chosen path in the PR description.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A new file `plugins/autonomous-dev/.github/workflows/observe.yml.example` exists. | T6 |
| FR-2 | The file's `name:` is `Observe (autonomous-dev digest)`. | T6 |
| FR-3 | The file has a `schedule:` trigger with `cron: '0 14 * * 1'` (Mondays 14:00 UTC) AND a `workflow_dispatch:` trigger. | T6 |
| FR-4 | The file declares `permissions: contents: read, pull-requests: write, issues: write`. | T6 |
| FR-5 | The file has exactly ONE job named `digest` with `runs-on: ubuntu-latest` and `if: false` at the JOB level (not the step level). | T6 |
| FR-6 | The `digest` job's steps are: (a) `actions/checkout@<sha>`, (b) `npx @autonomous-dev/observe digest --window 7d` with `AUTONOMOUS_DEV_OBSERVE_TOKEN: ${{ secrets.AUTONOMOUS_DEV_OBSERVE_TOKEN }}` in `env:`, (c) `marocchino/sticky-pull-request-comment@<sha>` posting `observe-digest.md` with `header: autonomous-dev-observe`. | T6 |
| FR-7 | All third-party `uses:` references in the file are SHA-pinned with the same comment format used by SPEC-032-2-01 (`# {action}@v{semver} (pinned 2026-05-02)`). | T6 |
| FR-8 | The file ends with a trailing newline. | T6 |
| FR-9 | `actionlint plugins/autonomous-dev/.github/workflows/observe.yml.example` exits 0 with no warnings. | T6 |
| FR-10 | The file's leading comment block documents: (a) opt-in nature, (b) copy-target instructions, (c) required secret `AUTONOMOUS_DEV_OBSERVE_TOKEN`, (d) required configuration to flip `if: false` to `if: true`, (e) pointer to `commands/observe.md`. | T6 |
| FR-11 | `plugins/autonomous-dev/commands/observe.md` has a new section titled `## Workflow template` (or `## Scheduled workflow`; pick one and document) of ≤ 120 words. | T7 |
| FR-12 | The new section in `observe.md` links to the example via a relative path (`./.github/workflows/observe.yml.example` or equivalent), names the required secret `AUTONOMOUS_DEV_OBSERVE_TOKEN`, and references "opt-in" + "if: false default". | T7 |
| FR-13 | A doc-only test at `plugins/autonomous-dev/tests/docs/test-observe-yml-example.test.ts` (or per-convention path) MUST: (a) assert `fs.existsSync` returns true for the example file, (b) spawn `actionlint <path>` and assert exit 0 (skip if `actionlint` not on `$PATH`, with a clear skip message), (c) assert the file contents contain `if: false` and `AUTONOMOUS_DEV_OBSERVE_TOKEN`, (d) assert `commands/observe.md` contains the relative link to the example. | T8 |
| FR-14 | Deleting the example file makes the test fail with a clear message naming the missing file. | T8 |
| FR-15 | Deleting the cross-reference paragraph from `commands/observe.md` makes the test fail with a clear message naming the missing cross-reference. | T8 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| YAML validity | `actionlint` exit 0 with no warnings | Per-file invocation |
| Comment-format consistency | All third-party `uses:` references match SPEC-032-2-01's format | `grep -c '@[a-f0-9]\{40\}'` matches `grep -c 'uses:'` minus first-party refs |
| Default-off safety | A copy-paste of the file into a downstream repo with no further edits MUST NOT trigger any workflow run | `if: false` at job level; `actionlint` confirms job is gated |
| Cross-reference discoverability | A reader of `commands/observe.md` arrives at the example via a single click (relative link) | Manual click-test from rendered markdown |
| Test signal quality | Test failure message names the missing file or section explicitly | Manually delete each artifact and inspect the failure output |
| Test runtime | < 2s | `time npm test -- test-observe-yml-example` |
| Regression posture | `npm test` pass count strictly increases by exactly the number of new test cases this spec ships | TG-06 |

## Technical Approach

### Example workflow body

`plugins/autonomous-dev/.github/workflows/observe.yml.example`:

```yaml
# Observe — autonomous-dev digest (opt-in)
#
# Copy this file into your repo as
#   .github/workflows/observe.yml
# Flip `if: false` → `if: true` on the digest job once configured.
# Configure secret AUTONOMOUS_DEV_OBSERVE_TOKEN in repo settings.
# See plugins/autonomous-dev/commands/observe.md for usage.

name: Observe (autonomous-dev digest)

on:
  schedule:
    # Mondays 14:00 UTC. Customize as desired.
    - cron: '0 14 * * 1'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  digest:
    if: false  # FLIP TO `true` AFTER CONFIGURING SECRET
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        # actions/checkout@v4.1.7 (pinned 2026-05-02)
        uses: actions/checkout@<SHA-FROM-SPEC-032-2-01>

      - name: Generate observability digest
        run: npx @autonomous-dev/observe digest --window 7d
        env:
          AUTONOMOUS_DEV_OBSERVE_TOKEN: ${{ secrets.AUTONOMOUS_DEV_OBSERVE_TOKEN }}

      - name: Post sticky comment
        # marocchino/sticky-pull-request-comment@v2.9.0 (pinned 2026-05-02)
        uses: marocchino/sticky-pull-request-comment@<SHA-FROM-SPEC-032-2-01>
        with:
          path: observe-digest.md
          header: autonomous-dev-observe
```

The `<SHA-FROM-SPEC-032-2-01>` placeholders MUST be replaced with the
actual 40-char SHAs resolved by SPEC-032-2-01's audit. The pinned date
matches that spec (`2026-05-02`). If the audit defers a SHA (per
SPEC-032-2-01 FR-7), document the deferral in the same line's comment
and DO NOT ship a literal `<SHA-FROM-...>` placeholder — instead, use
the floating tag for that specific reference and call out the
deferral in the closeout PR description.

### `commands/observe.md` cross-reference

Append after existing content:

```markdown
## Workflow template

A ready-to-copy GitHub Actions workflow template ships at
[`./.github/workflows/observe.yml.example`](../.github/workflows/observe.yml.example).
The template is opt-in and defaults to `if: false` on its digest job
to prevent unconfigured runs. To adopt:

1. Copy the file into your repo as `.github/workflows/observe.yml`.
2. Configure the `AUTONOMOUS_DEV_OBSERVE_TOKEN` secret in your repo
   settings (the digest CLI reads it from `env:`).
3. Flip `if: false` to `if: true` on the `digest` job.
4. Customize the cron schedule if you want a cadence other than
   Mondays at 14:00 UTC.
```

The relative link path depends on where `commands/observe.md` lives
relative to the example file. Verify the link resolves before commit.

### Doc-only test

`plugins/autonomous-dev/tests/docs/test-observe-yml-example.test.ts`
(adapt to the project's actual test runner — Jest, Vitest, or
node-test):

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');
const EXAMPLE_PATH = join(
  REPO_ROOT,
  'plugins/autonomous-dev/.github/workflows/observe.yml.example',
);
const COMMAND_PATH = join(
  REPO_ROOT,
  'plugins/autonomous-dev/commands/observe.md',
);
const RELATIVE_LINK_FRAGMENT = 'observe.yml.example';

describe('observe.yml.example doc-only contract', () => {
  it('the example workflow file exists', () => {
    expect(existsSync(EXAMPLE_PATH)).toBe(true);
  });

  it('the example workflow passes actionlint (when available)', () => {
    const probe = spawnSync('actionlint', ['--version']);
    if (probe.status !== 0) {
      console.warn('actionlint not on $PATH; skipping');
      return;
    }
    const result = spawnSync('actionlint', [EXAMPLE_PATH]);
    expect(result.status).toBe(0);
  });

  it('the example contains if: false and the observe-token secret', () => {
    const body = readFileSync(EXAMPLE_PATH, 'utf8');
    expect(body).toContain('if: false');
    expect(body).toContain('AUTONOMOUS_DEV_OBSERVE_TOKEN');
  });

  it('commands/observe.md cross-references the example', () => {
    const body = readFileSync(COMMAND_PATH, 'utf8');
    expect(body).toContain(RELATIVE_LINK_FRAGMENT);
  });
});
```

If the project uses a different test runner, translate the assertions
faithfully and keep the four cases.

## Interfaces and Dependencies

**Consumes:**
- The pinned SHAs from SPEC-032-2-01 for `actions/checkout` and
  `marocchino/sticky-pull-request-comment`.
- `actionlint` (verified by SPEC-032-2-02).
- The existing test runner used by `plugins/autonomous-dev/tests/**`.

**Produces:**
- The `.example` workflow file referenced by:
  - AMENDMENT-002's setup-wizard onboarding (consumed there).
  - The runbook (SPEC-032-2-04) as the canonical opt-in template.

**Cross-references:**
- SPEC-032-2-01: pin set.
- SPEC-032-2-02: lint guard (does NOT scan the `.example` file
  because it lives under `plugins/autonomous-dev/.github/workflows/`,
  outside the guard's path scope).
- SPEC-032-2-04: runbook documents how operators adopt this template.

## Acceptance Criteria

```
Given the worktree after this spec lands
When `ls plugins/autonomous-dev/.github/workflows/observe.yml.example` runs
Then the file exists

Given the example workflow file
When `actionlint plugins/autonomous-dev/.github/workflows/observe.yml.example` runs
Then exit code is 0 with no warnings

Given the example workflow file
When the file contents are read
Then it contains `name: Observe (autonomous-dev digest)`
And it contains `cron: '0 14 * * 1'`
And it contains `workflow_dispatch:`
And it contains `permissions:` with `contents: read`, `pull-requests: write`, `issues: write`
And it contains a single `jobs.digest` block
And `jobs.digest.if` resolves to the literal `false`
And the steps include `actions/checkout`, `npx @autonomous-dev/observe digest --window 7d`, and `marocchino/sticky-pull-request-comment`
And every third-party `uses:` reference is a 40-char SHA
And every third-party `uses:` reference has an accompanying `# {action}@v{semver} (pinned 2026-05-02)` comment
And the file ends with a trailing newline

Given a downstream operator copies the file to .github/workflows/observe.yml without further edits
When the next Monday 14:00 UTC arrives
Then the digest job does NOT run (because if: false)
And no schedule-triggered run appears in the Actions tab beyond the workflow being recognized

Given commands/observe.md after this spec lands
When the file is rendered
Then it contains a `## Workflow template` (or `## Scheduled workflow`) section of ≤ 120 words
And the section links to the example file via a relative path
And the section names AUTONOMOUS_DEV_OBSERVE_TOKEN as the required secret
And the section references "opt-in" and "if: false default"

Given the doc-only test test-observe-yml-example.test.ts
When `npm test` is invoked
Then all four test cases pass
And the test runtime is < 2s

Given the doc-only test in place
When the example file is deleted (locally, not committed)
Then `npm test` fails with a message naming the missing example path

Given the doc-only test in place
When the cross-reference paragraph is removed from commands/observe.md
Then `npm test` fails with a message naming the missing cross-reference fragment

Given an environment without actionlint on $PATH
When the doc-only test runs
Then the actionlint case is skipped with a clear skip message
And the other three cases still pass
```

## Test Requirements

- **Doc-only contract test (FR-13):** four cases as enumerated above.
  Lives under the existing test layout. Wired into the default
  `npm test` invocation.
- **Negative-case validation (FR-14, FR-15):** the implementer
  manually deletes the example and the cross-reference (separately)
  and confirms each deletion produces the expected failure. Document
  the failure messages in the PR description as evidence.
- **`actionlint` skip path:** verify the skip path manually by
  temporarily aliasing `actionlint` to a non-existent command (e.g.
  `PATH=/tmp:/usr/bin npm test`) and confirming the test logs the
  skip but does not fail.
- **No new test framework:** use whatever Jest/Vitest/node-test the
  rest of `plugins/autonomous-dev/tests/**` already uses (per
  PRD-017 NG-04).

## Implementation Notes

- The `<SHA-FROM-SPEC-032-2-01>` placeholders in the example body
  MUST be replaced with the actual 40-char SHAs before commit. If
  this spec is implemented in the same PR as SPEC-032-2-01, the SHAs
  are already known. If implemented in separate PRs, either:
  (a) wait for SPEC-032-2-01 to merge first and copy the SHAs, OR
  (b) ship the example with floating tags, document as a "pin
  follows in PR-N+1" note, and re-pin in the closeout PR.
- The `if: false` MUST be at the JOB level. Step-level `if: false` is
  a different contract (the steps are skipped but the job still runs
  and reports green). Risk R5 mitigation requires JOB-level gating
  so an unconfigured workflow does not appear in the Actions tab as
  "succeeded with no work."
- The cross-reference word count cap (≤ 120 words) is enforced by
  the doc-only test? NO — the test just checks for the link
  fragment. The 120-word cap is a reviewer check at PR time. Keep
  the section terse.
- `commands/observe.md` may live at a different relative path than
  the example file, depending on the autonomous-dev plugin layout.
  The relative link in the cross-reference MUST resolve from the
  rendered markdown; verify with `lychee` (PLAN-016-2) before commit.
- `marocchino/sticky-pull-request-comment` posts to PRs only — the
  scheduled cron-triggered run will not have a PR to comment on.
  The action handles this gracefully (posts to the latest open PR
  in the repo, or no-ops). Operators who want issue-based digests
  customize the action call after copying. This is documented in
  the example's leading comment block as a known limitation.
- The doc-only test uses the running tree's relative paths; if the
  test is run from a sub-directory of the repo (e.g. via a Jest
  `rootDir` override), the `REPO_ROOT` constant must adapt. The
  reference implementation walks up from `__dirname`; verify the
  hop count against the chosen test location.
- **Comment vs. trailing-comment placement:** SPEC-032-2-01 picks one
  convention. This spec MUST follow the same placement decision.
- The `npx @autonomous-dev/observe digest --window 7d` command
  assumes the CLI is published at that name. If it is not (yet),
  the example body still references the intended command per
  AMENDMENT-002; the example is opt-in and operators run it after
  the CLI ships.

## Rollout Considerations

- **Adoption is opt-in.** This spec ships the template; no operator
  is auto-onboarded. AMENDMENT-002's setup wizard is the eventual
  onramp; until then, operators copy the file by hand.
- **No CI behavior change.** The autonomous-dev repo's own CI does
  not invoke `observe.yml.example`. Adding the file does not change
  any existing job, status check, or scheduled run.
- **Rollback:** delete the example file, the cross-reference
  paragraph, and the test file in a single revert PR. The doc-only
  test goes with the artifacts it tests.
- **Forward-compat:** future updates to the example (e.g. new step,
  new permission) can edit the file in-place. The doc-only test only
  pins the structural invariants (existence, `if: false`, secret
  name, cross-reference). Other body changes do not break the test.
- **Deferred-pin scenario (per SPEC-032-2-01 FR-7):** if a referenced
  action's pin is deferred, the example may ship temporarily with a
  floating tag. The closeout PR description and the runbook list
  the deferral.

## Effort Estimate

- Workflow file authoring + actionlint verification: 0.5 day
- `commands/observe.md` cross-reference: 0.1 day
- Doc-only test + negative-case validation: 0.4 day
- Total: 1 day
