# SPEC-017-3-02: Claude Changelog Generation, GitHub Release Creation, and Smoke Tests

## Metadata
- **Parent Plan**: PLAN-017-3
- **Tasks Covered**: Task 3 (Claude-generated changelog), Task 4 (GitHub Release creation), Task 12 (full-flow smoke tests)
- **Estimated effort**: 8 hours
- **Spec path (after promotion)**: `plugins/autonomous-dev/docs/specs/SPEC-017-3-02-changelog-release-smoke.md`

## Description
Layer the Claude-powered changelog generation step and the `softprops/action-gh-release@v2` publish step onto the `release.yml` scaffold built in SPEC-017-3-01, then exercise the entire flow with three smoke-test tag pushes (success + version-mismatch failure + eval-regression failure). The changelog step uses the `claude-trust-gate` composite from PLAN-017-1 and passes the commit log via `--attach` exclusively — no string interpolation of commit content into the prompt. The `create-release` job depends on `generate-changelog`, which in turn depends on `verify-version` (SPEC-017-3-01) and `verify-evals` (SPEC-017-3-04).

The smoke-test acceptance criteria are not "tests" in the unit sense — they are operator-executed validation runs against the live GitHub repo. They exist to verify the three failure modes the workflow advertises and to spot-check Claude-generated changelog quality before the workflow goes routine.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/release.yml` | Modify | Add `generate-changelog` and `create-release` jobs; update spend emitter to include changelog cost |
| `docs/operators/release-smoke-tests.md` | Create | Operator-runbook documenting the three smoke-test procedures from task 12 |

## Implementation Details

### Job Graph (after this spec)

```
verify-version ──┐
                 ├──> generate-changelog ──> create-release
verify-evals  ───┘     (SPEC-017-3-04)
```

`verify-evals` is added by SPEC-017-3-04. This spec assumes the job exists; if it does not exist at implementation time (specs implemented out of order), `generate-changelog` MAY temporarily depend only on `verify-version` with a TODO comment referencing this spec.

### `generate-changelog` Job

```yaml
generate-changelog:
  name: Generate changelog with Claude
  needs: [verify-version, verify-evals]
  runs-on: ubuntu-latest
  timeout-minutes: 10
  outputs:
    changelog-path: ${{ steps.locate.outputs.path }}
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0     # need full history to compute git log between tags

    - name: Determine previous tag
      id: prev
      run: |
        set -euo pipefail
        PREV_TAG="$(git describe --tags --abbrev=0 "${GITHUB_REF_NAME}^" 2>/dev/null || echo '')"
        echo "previous=$PREV_TAG" >> "$GITHUB_OUTPUT"
        echo "Previous tag: ${PREV_TAG:-<none, first release>}"

    - name: Collect commit log
      run: |
        set -euo pipefail
        if [ -n "${{ steps.prev.outputs.previous }}" ]; then
          git log "${{ steps.prev.outputs.previous }}..${GITHUB_REF_NAME}" \
            --pretty=format:"%h %s" > /tmp/commits.txt
        else
          git log --pretty=format:"%h %s" > /tmp/commits.txt
        fi
        wc -l /tmp/commits.txt

    - name: Trust gate (composite)
      id: trust
      uses: ./.github/actions/claude-trust-gate
      with:
        author-association: OWNER     # tag pushes are inherently trusted (push perms required)

    - name: Generate changelog with Claude
      if: steps.trust.outputs.is-trusted == 'true'
      uses: anthropics/claude-code-action@v1
      with:
        anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
        claude_args: "--attach /tmp/commits.txt --max-turns 5"
        prompt: |
          Generate a CHANGELOG.md entry for release ${{ github.ref_name }}.

          The attached file contains every commit in this release as
          "<sha> <subject>" lines.  Use ONLY the attached content; do not
          invent features or guess at scope.  For every line in the changelog
          you produce, include the commit SHA in parentheses, e.g.
          "- Added retry logic for token refresh (a1b2c3d)".

          Output strictly the following Markdown structure (omit any
          section that has no entries):

          ## ${{ github.ref_name }} — $(date -u +%Y-%m-%d)

          ### Added
          ### Changed
          ### Deprecated
          ### Removed
          ### Fixed
          ### Security

          Write the result to /tmp/changelog.md.  Do not write anything else.

    - name: Verify changelog produced
      id: locate
      run: |
        set -euo pipefail
        if [ ! -s /tmp/changelog.md ]; then
          echo "::error::Claude changelog generation produced no output at /tmp/changelog.md"
          exit 1
        fi
        echo "path=/tmp/changelog.md" >> "$GITHUB_OUTPUT"
        echo "Changelog preview:"
        head -40 /tmp/changelog.md

    - name: Emit spend estimate
      if: always()
      env:
        BUDGET_HMAC_KEY: ${{ secrets.BUDGET_HMAC_KEY }}
        ESTIMATED_COST_USD: "0.15"   # changelog generation, --max-turns 5
      run: bash scripts/ci/emit-spend-estimate.sh

    - name: Upload spend artifact
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: spend-estimate-${{ github.run_id }}-changelog
        path: .github/budget/spend-${{ github.run_id }}.json
        retention-days: 90

    - name: Upload changelog artifact
      uses: actions/upload-artifact@v4
      with:
        name: changelog-${{ github.ref_name }}
        path: /tmp/changelog.md
        retention-days: 90
```

### `create-release` Job

```yaml
create-release:
  name: Publish GitHub Release
  needs: [generate-changelog]
  runs-on: ubuntu-latest
  timeout-minutes: 5
  steps:
    - uses: actions/checkout@v4

    - name: Download changelog
      uses: actions/download-artifact@v4
      with:
        name: changelog-${{ github.ref_name }}
        path: /tmp

    - name: Detect prebuilt artifacts
      id: artifacts
      run: |
        set -euo pipefail
        if [ -d dist ] && [ -n "$(ls -A dist 2>/dev/null)" ]; then
          echo "files=dist/*" >> "$GITHUB_OUTPUT"
        else
          echo "files=" >> "$GITHUB_OUTPUT"
        fi

    - name: Create GitHub Release
      uses: softprops/action-gh-release@v2
      with:
        tag_name: ${{ github.ref_name }}
        body_path: /tmp/changelog.md
        generate_release_notes: false
        files: ${{ steps.artifacts.outputs.files }}
        fail_on_unmatched_files: false
```

### Trust-Gate Note

The `claude-trust-gate` composite normally inspects `github.event.comment.author_association`. For a tag-push event there is no comment author. We pass `OWNER` literally because pushing a tag requires `contents: write` (or `admin`) permission, which by definition means the actor is a trusted maintainer. If a future scenario introduces a workflow_dispatch path or a non-trusted automation, that change MUST revisit this assumption.

### Operator Runbook: `docs/operators/release-smoke-tests.md`

Document the three smoke-test procedures (target ≤ 80 lines):

1. **Success case** — Bump `plugins/autonomous-dev/.claude-plugin/plugin.json` to `0.0.1-rc.1`, push tag `v0.0.1-rc.1`, observe full pipeline, verify the published Release page shows the Claude-generated changelog body.
2. **Version-mismatch failure** — Bump manifest to `0.0.2-rc.1` but push tag `v0.0.3-rc.1`. Verify `verify-version` fails with the exact error message and `generate-changelog` and `create-release` are skipped.
3. **Eval-regression failure** — Force the `_eval-baseline` branch to a low pass-rate (e.g., 0.50), push a tag, verify `verify-evals` (added in SPEC-017-3-04) blocks the release with the documented error.

For each procedure, include: (a) preconditions, (b) commands to run, (c) expected workflow status, (d) cleanup steps (delete the test tag/release).

## Acceptance Criteria

- [ ] `release.yml` declares `generate-changelog` job with `needs: [verify-version, verify-evals]`.
- [ ] `release.yml` declares `create-release` job with `needs: [generate-changelog]`.
- [ ] `actionlint` exits 0 on the modified workflow.
- [ ] `git log` is invoked with `--pretty=format:"%h %s"` and written to `/tmp/commits.txt` BEFORE the Claude step.
- [ ] The Claude step uses `claude_args: "--attach /tmp/commits.txt --max-turns 5"` — `--attach` is present and references the file path, not the file contents.
- [ ] No grep of `release.yml` produces a line where commit-log content is interpolated into the `prompt:` field. (Test: search for `${{` adjacent to `commits` or `git log` substrings inside `prompt`.)
- [ ] `anthropics/claude-code-action@v1` is pinned to `@v1`.
- [ ] `softprops/action-gh-release@v2` is pinned to `@v2` and called with `body_path: /tmp/changelog.md`, `tag_name: ${{ github.ref_name }}`, and `generate_release_notes: false`.
- [ ] `fail_on_unmatched_files: false` so the absence of `dist/` artifacts does not break the release.
- [ ] After a successful tag push, `gh release view <tag>` displays a body that begins with `## <tag> — YYYY-MM-DD` and contains at least one of the documented section headings.
- [ ] When the changelog file is empty (Claude produced nothing), `generate-changelog` fails with `::error::Claude changelog generation produced no output at /tmp/changelog.md`.
- [ ] Spend estimate for the changelog job uses `ESTIMATED_COST_USD: "0.15"` and is emitted via the same `scripts/ci/emit-spend-estimate.sh` introduced in SPEC-017-3-01 (no duplicate emitter logic).
- [ ] `docs/operators/release-smoke-tests.md` exists and documents all three procedures (success, version-mismatch, eval-regression) with preconditions/commands/expected/cleanup.
- [ ] **Smoke test (manual)**: Execute the success procedure against a real tag push; the Release page shows a Claude-generated changelog with at least one commit SHA referenced parenthetically (e.g., `(a1b2c3d)`).
- [ ] **Smoke test (manual)**: Execute the version-mismatch procedure; `verify-version` fails and downstream jobs show "skipped" status, not "failed".
- [ ] **Smoke test (manual)**: Execute the eval-regression procedure (after SPEC-017-3-04 lands); `verify-evals` fails with the documented error and `generate-changelog`/`create-release` are skipped.

## Dependencies

- **Blocking**: SPEC-017-3-01 (release.yml scaffold + `verify-version` job + spend emitter must already exist).
- **Blocking**: PLAN-017-1's `claude-trust-gate` composite at `.github/actions/claude-trust-gate/action.yml`.
- **Soft**: SPEC-017-3-04 (`verify-evals` job). Implementable before this lands; smoke-test #3 deferred until both are merged.
- **Secret precondition**: `ANTHROPIC_API_KEY` must be configured in repo secrets.
- **Permissions**: `contents: write` (already declared at top level by SPEC-017-3-01) is required for `softprops/action-gh-release@v2`.

## Notes

- The trust-gate `author-association: OWNER` literal is a known concession for tag-push events. Document it inline in `release.yml` as a header comment so future maintainers do not assume comment-driven trust applies here.
- `fetch-depth: 0` on the changelog job is intentional — `git describe --tags --abbrev=0` and the `git log <prev>..HEAD` range require full history. Without this, the previous-tag detection silently returns the wrong value or empty.
- The first-release case (no previous tag) falls back to `git log --pretty=format:"%h %s"` for the entire repo history. For most repos this produces a long initial changelog, which is the desired behavior — operators can edit the published Release manually if they want to truncate.
- The Claude prompt explicitly instructs SHA citation. This is a defense against hallucinated entries; PLAN-017-3 §Risks calls out manual spot-checks for the first three releases. The smoke-test runbook should remind operators of this.
- `generate_release_notes: false` is critical — without it, GitHub auto-generates its own changelog and concatenates with ours, producing a confusing duplicate.
- Spend artifacts are uploaded with two distinct names per run (`spend-estimate-<run_id>` from SPEC-017-3-01 and `spend-estimate-<run_id>-changelog` from this spec). PLAN-017-4's aggregator must handle multi-artifact-per-run; this is a documented contract there. If single-artifact aggregation is preferred, a follow-up spec consolidates emission into a final post-job step.
