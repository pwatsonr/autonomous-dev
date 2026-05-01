# CI Required Status Checks (Branch Protection)

Configured in: `.github/workflows/ci.yml` (PLAN-016-1, PLAN-016-2 + sibling plans).

## Required status check names

The repo admin must add the following names to the branch-protection rule
for `main` (Settings -> Branches -> Branch protection rules -> Require status
checks to pass before merging). Names are case-sensitive and must match the
job `name:` keys exactly.

- `paths-filter`  (PLAN-016-1)
- `typecheck`     (PLAN-016-1)
- `lint`          (PLAN-016-1)
- `test`          (PLAN-016-1)
- `shell`         (PLAN-016-2 / SPEC-016-2-01)
- `markdown`      (PLAN-016-2 / SPEC-016-2-02)
- `actionlint`    (PLAN-016-2 / SPEC-016-2-03)

## Conditional checks

`shell`, `markdown`, and `actionlint` are gated by `paths-filter` outputs.
A PR that does not touch the relevant file types will report these checks
as `Skipped`. GitHub treats `Skipped` as passing for required checks, so
adding all three to the required list does not block PRs that legitimately
do not touch shell/markdown/workflow files.

## How to add (one-time, by repo admin)

1. Open Settings -> Branches -> Branch protection rules.
2. Edit the rule for `main` (create one if it does not exist).
3. Enable "Require status checks to pass before merging".
4. Add each name above to the search box and select it.
5. Save.

## Troubleshooting

- A check named like `shell / shell (ubuntu-latest)` instead of `shell`
  indicates the job has a matrix without an explicit `name:` key. The
  job definition in `ci.yml` MUST set `name: shell` (likewise `markdown`
  and `actionlint`) to lock the status-check name. See SPEC-016-2-01 § Notes.
