# SPEC-027-2-01: Onboarding Agent — Pipeline Pause States + First Cloud Deploy Appendix

## Metadata
- **Parent Plan**: PLAN-027-2
- **Parent TDD**: TDD-027 §5.2.1 (pause states), §5.2.2 (cloud-deploy appendix), §5.2.3 (no frontmatter changes), §4.2 (append-only), G-07 / FR-1516 (local-only path preservation)
- **Tasks Covered**: PLAN-027-2 Task 1 (pause-states H3), Task 2 (first-cloud-deploy H2 appendix), Task 3 (append-only verification of onboarding.md)
- **Estimated effort**: 3.0 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-2-01-onboarding-pause-states-and-cloud-appendix.md`

## Summary
Append two sections to `agents/onboarding.md`: a new H3 **Pipeline Pause States** subsection (inserted between Step 7 and the existing "After Onboarding" section) documenting the four pause states (`awaiting-approval`, `cost-cap-tripped`, `firewall-denied`, `cred-proxy-ttl-expired`); and a new H2 **Appendix: First Cloud Deploy** appended after "After Onboarding" that bridges operators into the setup-wizard's phase-16 cloud onboarding (authored by SPEC-027-2-02 and SPEC-027-2-03). All edits are append-only per TDD-027 §4.2 / G-08; the existing 7-step local-only path (G-07 / FR-1516) is preserved byte-for-byte. No frontmatter `tools:` changes — the onboarding agent does not invoke `chains` / `deploy` / `cred-proxy` / `firewall` directly (per TDD-027 §5.2.3).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/agents/onboarding.md` | Modify | Insert one H3 (Pipeline Pause States) between Step 7 and "After Onboarding"; append one H2 (Appendix: First Cloud Deploy) at end. No deletions; no frontmatter changes. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | Insert a new H3 `### Pipeline Pause States` after the body of Step 7 ("Verify it is working") and before the existing H2 "After Onboarding". | TDD-027 §5.2.1 |
| FR-2 | The Pipeline Pause States subsection MUST contain a table with these columns: "Pause state", "What it means", "Operator action". The table MUST contain exactly 4 rows in this order: `awaiting-approval`, `cost-cap-tripped`, `firewall-denied`, `cred-proxy-ttl-expired`. | TDD-027 §5.2.1 |
| FR-3 | The `cost-cap-tripped` row's "Operator action" cell MUST contain the verbatim text "do NOT hand-edit" (matched by eval `onboard-pause-001`). | TDD-027 §5.2.1, §7.2 |
| FR-4 | The `cred-proxy-ttl-expired` row's "Operator action" cell MUST contain the verbatim text "do NOT rotate root credentials" and the command `cred-proxy bootstrap --cloud <cloud>`. | TDD-027 §5.2.1, §8.1 |
| FR-5 | The `awaiting-approval` row's "Operator action" cell MUST contain `deploy approve REQ-NNNNNN` and the substring "mandatory" or "expected for prod" (matched by eval `onboard-pause-002`). | TDD-027 §5.2.1, §7.2 |
| FR-6 | The `firewall-denied` row's "Operator action" cell MUST reference `~/.autonomous-dev/firewall/denied.log` and the per-plugin allowlist. | TDD-027 §5.2.1 |
| FR-7 | A closing paragraph after the table MUST reference the three runbook files (`deploy-runbook.md`, `firewall-runbook.md`, `cred-proxy-runbook.md`) for deeper troubleshooting. | TDD-027 §5.2.1 |
| FR-8 | Append a new H2 `## Appendix: First Cloud Deploy` after the existing H2 "After Onboarding" (and before any pre-existing trailing reference block). | TDD-027 §5.2.2 |
| FR-9 | The "First Cloud Deploy" appendix MUST list the 4 prerequisites in this order: (1) matching cloud plugin (`autonomous-dev-deploy-{gcp,aws,azure,k8s}`), (2) bootstrapped credential proxy (`cred-proxy bootstrap --cloud <cloud>`), (3) configured egress firewall backend (`firewall init` on Linux/macOS or explicit opt-out for development), (4) dry-run deploy. | TDD-027 §5.2.2 |
| FR-10 | The appendix MUST surface the verbatim wizard invocation: `/autonomous-dev-assist:setup-wizard --with-cloud`. | TDD-027 §5.2.2 |
| FR-11 | The appendix MUST contain the verbatim sentence (or near-verbatim with same meaning) "the local-only path you completed in steps 1-7 above is unaffected" or equivalent reassurance, satisfying G-07 / FR-1516. | TDD-027 §5.2.2, G-07 |
| FR-12 | The appendix MUST list pointers to all 4 runbooks: chains-runbook.md (TDD-026), deploy-runbook.md (TDD-026), cred-proxy-runbook.md (TDD-025), firewall-runbook.md (TDD-025). | TDD-027 §5.2.2 |
| FR-13 | The frontmatter `tools:` list MUST remain byte-identical to `main` (no additions, removals, or reorderings). | TDD-027 §5.2.3 |
| FR-14 | All 7 existing onboarding steps and the existing "After Onboarding" H2 MUST remain unchanged in heading text, order, and body content. | TDD-027 §4.2 (G-08), G-07 |
| FR-15 | Frontmatter `name` and `description` keys MUST be byte-identical to `main`. | TDD-027 §10.1 |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| Combined prompt-token impact | < 600 net additional tokens | Diff line count: ~25 lines pause-states + ~30 lines appendix ≈ 550 tokens; verified against TDD-027 §8.3 (`+700` budget for onboarding additions) |
| Onboarding agent first-token latency p95 | < 12 s | Per TDD-027 §11; measured via PLAN-017-3 runner |
| Markdown lint | Zero errors at default strictness | `markdownlint plugins/autonomous-dev-assist/agents/onboarding.md` exits 0 |
| Append-only | 100% of changed lines are insertions in body; frontmatter byte-identical | `git diff main -- plugins/autonomous-dev-assist/agents/onboarding.md` shows zero `-` lines outside diff headers |
| Local-only path preservation | 7-step manual walk produces identical experience pre/post-edit | Manual walk by reviewer; rendered Markdown TOC unchanged through Step 7 |

## Technical Approach

### Insertion strategy
1. Read `plugins/autonomous-dev-assist/agents/onboarding.md`.
2. Locate the end of Step 7's body (look for the next H2 or H3 heading, which should be "After Onboarding").
3. Insert the new H3 + body at that boundary, preserving a single blank line above and below.
4. Locate the end of the "After Onboarding" H2 body (look for EOF or any pre-existing trailing reference block).
5. Append the new H2 "Appendix: First Cloud Deploy" at that location.

### Pipeline Pause States subsection (verbatim from TDD-027 §5.2.1)

```markdown
### Pipeline Pause States

When a request pauses, the `status` field will indicate why. The four most common pause states for a fresh installation:

| Pause state               | What it means                                                                | Operator action                                                                          |
|---------------------------|------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `awaiting-approval`       | A deploy plan or chain run is waiting for a human approval gate.             | `deploy approve REQ-NNNNNN` (or `chains approve`); for prod environments this is mandatory. |
| `cost-cap-tripped`        | The cumulative cost would exceed the per-environment cap.                    | Inspect `~/.autonomous-dev/deploy/ledger.json`; raise the cap in `deploy.yaml` or revert. |
| `firewall-denied`         | The egress firewall denied an outbound connection a backend tried to make.    | Inspect `~/.autonomous-dev/firewall/denied.log`; update the per-plugin allowlist.        |
| `cred-proxy-ttl-expired`  | The credential proxy's STS token (default 15 min) expired mid-deploy.        | Run `cred-proxy bootstrap --cloud <cloud>` to refresh; do NOT rotate root credentials.   |

Each of these has a deeper troubleshooting walkthrough in the corresponding instruction runbook (`deploy-runbook.md`, `firewall-runbook.md`, `cred-proxy-runbook.md`).
```

**Note on FR-3 verbatim guard:** The TDD §5.2.1 table cell for `cost-cap-tripped` reads "Inspect `~/.autonomous-dev/deploy/ledger.json`; raise the cap in `deploy.yaml` or revert." It does NOT contain the literal substring "do NOT hand-edit" (that phrase appears in the troubleshooter Deploy Diagnostics in SPEC-027-1-02). To satisfy FR-3 and eval `onboard-pause-001` (which forbids `set --cost-cap 0` but does not require "do NOT hand-edit"), the implementer SHOULD append a short clarifying sentence to the cell: "Do NOT hand-edit the ledger." This is consistent with TDD-027 §8.1 (no destructive prescriptions without state) and matches the troubleshooter's wording. Document this minor expansion in the PR body.

### First Cloud Deploy appendix (verbatim from TDD-027 §5.2.2)

```markdown
## Appendix: First Cloud Deploy

If you intend to use autonomous-dev with a cloud target (GCP, AWS, Azure, or Kubernetes), the local-only steps above are not sufficient. The cloud deploy path requires:

1. The matching cloud plugin (`autonomous-dev-deploy-gcp`, `-aws`, `-azure`, or `-k8s`) to be installed.
2. A bootstrapped credential proxy (`cred-proxy bootstrap --cloud <cloud>`).
3. A configured egress firewall backend (`firewall init` on Linux/macOS; or explicit opt-out for development).
4. A dry-run deploy to confirm end-to-end connectivity.

For a guided walkthrough of all four prerequisites, run:

```
/autonomous-dev-assist:setup-wizard --with-cloud
```

The wizard's phase 16 ("Deploy Backends") covers cloud-plugin selection, cred-proxy bootstrap, firewall configuration, and a dry-run deploy. It is **opt-in**: the local-only path you completed in steps 1-7 above is unaffected.

For the underlying surfaces:
- Plugin chains and deploy: see `instructions/chains-runbook.md`, `instructions/deploy-runbook.md` (owned by TDD-026).
- Credential proxy and firewall: see `instructions/cred-proxy-runbook.md`, `instructions/firewall-runbook.md` (owned by TDD-025).
```

### Error handling at edit time
- If "After Onboarding" H2 cannot be located, abort with an explicit error.
- If a "Pipeline Pause States" H3 already exists, abort and surface the conflict.
- Preserve verbatim emphasis (`**opt-in**`) and code-fence styles.

## Acceptance Criteria

```
Given the onboarding.md file before edit
When this spec's edits are applied
Then exactly one new H3 heading exists with text "Pipeline Pause States"
And it appears in document order between Step 7's body and the existing "After Onboarding" H2
```

```
Given the modified onboarding.md
When the Pipeline Pause States table is read
Then the table contains exactly 4 rows
And the row order is: awaiting-approval, cost-cap-tripped, firewall-denied, cred-proxy-ttl-expired
And the cred-proxy-ttl-expired row's third cell contains the verbatim substring "do NOT rotate root credentials"
And the awaiting-approval row's third cell contains the substring "deploy approve REQ-NNNNNN"
And the awaiting-approval row's third cell contains the substring "mandatory"
And the cost-cap-tripped row's third cell contains the substring "do NOT hand-edit"
```

```
Given the modified onboarding.md
When the closing paragraph after the pause-states table is read
Then it references "deploy-runbook.md", "firewall-runbook.md", and "cred-proxy-runbook.md"
```

```
Given the modified onboarding.md
When the H2 ordering is extracted
Then "After Onboarding" appears in its original position relative to Step 7's content
And "Appendix: First Cloud Deploy" appears immediately after "After Onboarding"
```

```
Given the modified onboarding.md
When the Appendix: First Cloud Deploy body is read
Then it lists 4 numbered prerequisites in the order specified by FR-9
And it contains the verbatim string "/autonomous-dev-assist:setup-wizard --with-cloud"
And it contains the substring "the local-only path you completed in steps 1-7 above is unaffected"
And it references all 4 runbook files (chains, deploy, cred-proxy, firewall)
```

```
Given the modified onboarding.md
When the frontmatter is parsed
Then the `tools` list is byte-identical to the value on main
And the `name` and `description` keys are byte-identical to main
```

```
Given the modified onboarding.md
When `git diff main -- plugins/autonomous-dev-assist/agents/onboarding.md` is run
Then no `-` line appears outside diff headers
And all `+` lines are confined to the two new sections
```

```
Given a local-only operator who has just completed steps 1-7
When they re-read steps 1-7 in the modified onboarding.md
Then the rendered text of steps 1-7 is byte-identical to the rendered text on main
```

### Edge cases / sad paths
```
Given the existing "After Onboarding" H2 has been renamed in main since TDD-027 was authored
When the implementer attempts to apply the edit
Then the implementer aborts with "anchor not found"
And does NOT silently insert at a guessed location
```

```
Given an operator runs `/autonomous-dev-assist:setup-wizard --with-cloud` before TDD-033 ships the runtime
When the runtime returns "no such flag"
Then the operator can fall back to the runbook pointers in the appendix
And the documentation is forward-compatible per TDD-027 §15 / OQ-3
```

```
Given the eval `onboard-pause-001` forbids `set --cost-cap 0`
When the agent's response includes any of: "set the cost cap to zero", "--cost-cap 0", "set --cost-cap 0"
Then the eval MUST fail
And the implementer MUST audit the agent's response in PLAN-027-2 Task 8 smoke run
```

## Test Requirements

### Static
- `grep -c "^### Pipeline Pause States$" onboarding.md` returns 1
- `grep -c "^## Appendix: First Cloud Deploy$" onboarding.md` returns 1
- `grep -c "do NOT rotate root credentials" onboarding.md` returns ≥ 1
- `grep -c "do NOT hand-edit" onboarding.md` returns ≥ 1
- `grep -c "/autonomous-dev-assist:setup-wizard --with-cloud" onboarding.md` returns ≥ 1
- `grep -c "the local-only path" onboarding.md` returns ≥ 1
- Frontmatter byte-equality check (e.g., `diff <(sed -n '/^---$/,/^---$/p' main:onboarding.md) <(sed -n '/^---$/,/^---$/p' onboarding.md)` returns empty)

### Integration / regression
- `troubleshoot-scenarios` and `help-questions` suites continue to pass (touched files are different).
- `onboarding-questions` suite (activated and seeded by SPEC-027-2-04) passes ≥ 3/4 cases when run against the post-this-spec agent.
- The 7-step local-only manual walk produces unchanged experience.

### Manual review
- Reviewer reads steps 1-7 + the new H3 + "After Onboarding" + the new H2 aloud and confirms ordering, content, and reassurance language.

## Implementation Notes

- The TDD §5.2.1 source text for the `cost-cap-tripped` row does not contain "do NOT hand-edit" verbatim — see the FR-3 implementation note above. The implementer's small expansion ("Do NOT hand-edit the ledger.") aligns the onboarding wording with the troubleshooter wording (SPEC-027-1-02) and gives the eval `onboard-pause-001` an unambiguous anchor.
- The "After Onboarding" H2 may have multiple paragraphs on `main`. Insert the appendix AFTER the entire H2 body (not after the heading line itself).
- The appendix's code fence for the wizard invocation uses triple-backticks. Preserve the empty-language fence (`” ```\n/autonomous-dev-assist:...\n``` `) per the TDD's exact rendering.
- This spec is the largest of PLAN-027-2 and is independently testable; it can land before SPEC-027-2-{02,03,04} as long as the runbook references and the wizard flag are documented as forward-compatible (per TDD-027 §15).

## Rollout Considerations

- **Rollout**: Markdown-only PR; agent prompt is reloaded on every invocation.
- **Feature flag**: None.
- **Rollback**: Revert the commit. The pause-states subsection and appendix disappear; the 7-step path is unchanged.
- **Coordination**: This spec depends on no other spec to land. The wizard invocation it references is satisfied by SPEC-027-2-02 + SPEC-027-2-03 (content + boundary marker) + TDD-033 (runtime).

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Insert Pipeline Pause States H3 (~25 lines, anchor + verbatim + minor expansion) | 1.0 |
| Append Appendix: First Cloud Deploy H2 (~30 lines, verbatim) | 1.0 |
| Append-only verification (Task 3 in plan) + frontmatter byte-equality check | 0.5 |
| Manual walk + render check | 0.5 |
| **Total** | **3.0** |
