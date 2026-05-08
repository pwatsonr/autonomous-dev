# SPEC-027-2-02: Cloud Prompt Tree Instructions File (`instructions/cloud-prompt-tree.md`)

## Metadata
- **Parent Plan**: PLAN-027-2
- **Parent TDD**: TDD-027 §6.1 (cloud-prompt-tree shape), §6.2 (TDD-033 boundary), §8.1 / §8.2 (no secrets), §15 (coordination)
- **Tasks Covered**: PLAN-027-2 Task 4 (author `instructions/cloud-prompt-tree.md`)
- **Estimated effort**: 2.0 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-027-2-02-cloud-prompt-tree-instructions.md`
- **Depends on**: None (new file). Consumed at runtime by TDD-033 phase-16 module after that runtime ships; forward-compatible per TDD-027 §15.

## Summary
Create a new static instruction file at `plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md` (~80 lines) that codifies the four-branch prompt tree TDD-027 §6.1 specifies. The file is the **content-side artifact** of the phase-16 boundary contract; TDD-033's phase-16 runtime loads it at execution time and walks the operator through Branch A (cloud-plugin choice), Branch B (cred-proxy bootstrap), Branch C (firewall backend by OS), and Branch D (dry-run deploy). The document is text-only Markdown (Mermaid deferred per OQ-2), contains no secrets / tenant IDs / verbatim credentials (per §8.1 / §8.2), and is forward-compatible — the assist plugin can ship it before TDD-033 lands without breaking anything.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md` | Create | New file. ~80 lines. Verbatim per TDD-027 §6.1 with the structural requirements in this spec. |

## Functional Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| FR-1 | The file MUST exist at the path `plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md`. | TDD-027 §6.1, PLAN-027-2 Task 4 |
| FR-2 | The first line MUST be the H1 heading: `# Phase-16 prompt tree`. | TDD-027 §6.1 |
| FR-3 | The file MUST contain exactly four H2 branch sections, in this order: `## Branch A: Cloud plugin choice`, `## Branch B: Cred-proxy bootstrap`, `## Branch C: Firewall backend`, `## Branch D: Dry-run deploy`. | TDD-027 §6.1 |
| FR-4 | Branch A MUST list exactly five operator choices in this order: `gcp` → `autonomous-dev-deploy-gcp`, `aws` → `autonomous-dev-deploy-aws`, `azure` → `autonomous-dev-deploy-azure`, `k8s` → `autonomous-dev-deploy-k8s`, `none` → "abort phase 16, return to phase 11". | TDD-027 §6.1 |
| FR-5 | Branch A MUST contain a "plugin not installed" handling clause stating that if the chosen cloud's plugin is NOT installed, the runtime should surface the install command and EXIT phase 16 cleanly. | TDD-027 §6.1, §10.2 |
| FR-6 | Branch B MUST gate `cred-proxy bootstrap --cloud <chosen>` on `cred-proxy doctor` reporting unhealthy. If `cred-proxy doctor` reports healthy, Branch B MUST be marked as skipped. | TDD-027 §6.1 |
| FR-7 | Branch C MUST contain an OS-detection table or list mapping: Linux → `nftables` (require sudo); macOS → `pfctl` (require sudo); other / opt-out → `disabled` (warn the operator). | TDD-027 §6.1 |
| FR-8 | Branch D MUST surface the verbatim command `deploy plan REQ-WIZARD-DRYRUN --env staging --dry-run` and state that successful inspection completes phase 16. | TDD-027 §6.1 |
| FR-9 | The file MUST NOT contain any verbatim cloud secrets, tenant IDs, AWS account IDs, GCP project IDs, Azure subscription IDs, or example credentials. Cloud names appear only as placeholders (`<cloud>`, `<chosen>`). | TDD-027 §8.1, §8.2 |
| FR-10 | The total file length MUST be ≤ 100 lines (~80 expected per TDD-027 §6.1). | TDD-027 §6.1 |
| FR-11 | The file MUST be valid CommonMark / GitHub-flavored Markdown that renders without lint errors at default `markdownlint` strictness (no broken code fences, no malformed tables). | PLAN-027-2 Task 4 acceptance |
| FR-12 | The file MUST NOT contain a Mermaid diagram (deferred per OQ-2). It MAY use plain text arrows (`→`) and indentation. | TDD-027 OQ-2 (Open / deferred) |
| FR-13 | The file MUST NOT contain a frontmatter block; it is an instruction document, not an agent or skill prompt. | Convention: existing `instructions/*.md` files (e.g., `runbook.md`) carry no frontmatter |

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|------------|--------|--------------------|
| Markdown lint | Zero errors at default strictness | `markdownlint plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md` exits 0 |
| File length | ≤ 100 lines | `wc -l` |
| Token cost (loaded at runtime) | ≤ 1200 tokens | Per TDD-027 §8.3 budget headroom; `wc -w` × 1.3 estimator |
| Phase-16 contract self-consistency | Filename `cloud-prompt-tree.md` matches the `provides:` list in the SKILL.md marker (SPEC-027-2-03) | Cross-check at PR review; SPEC-027-2-03's `provides:` line must list this exact filename |
| Secrets scan | Zero hits for known credential patterns (`AKIA*`, `ASIA*`, `arn:aws:*`, GCP project IDs, hex tokens) | `grep -E "(AKIA[A-Z0-9]{16}\|ASIA[A-Z0-9]{16}\|arn:aws:\|[a-f0-9]{40})" cloud-prompt-tree.md` returns empty |

## Technical Approach

### Authoring strategy
1. Create the file at the exact path in FR-1.
2. Author H1 + 4 H2 sections in the order specified by FR-3.
3. Branch A uses an indented bulleted list with `→` arrows, matching the TDD-027 §6.1 example block.
4. Branch B uses an `If`/`Else` Markdown structure (plain text; no code).
5. Branch C uses either a 3-row table or an indented list keyed by OS family.
6. Branch D contains a fenced code block with the `deploy plan` invocation.
7. End the file with a one-line forward-pointer to TDD-033's runtime ownership (e.g., "*This document is consumed at runtime by the setup-wizard phase-16 module owned by TDD-033 §5.*").

### Authoritative content (from TDD-027 §6.1)

The file body MUST match the following structure (text wording is reproduced verbatim from the TDD; the implementer MAY reflow long lines but MUST NOT change choice ordering, command verbatims, or branch logic):

```markdown
# Phase-16 prompt tree

## Branch A: Cloud plugin choice
Q: Which cloud do you intend to deploy to?
  → gcp:    autonomous-dev-deploy-gcp
  → aws:    autonomous-dev-deploy-aws
  → azure:  autonomous-dev-deploy-azure
  → k8s:    autonomous-dev-deploy-k8s
  → none:   abort phase 16, return to phase 11.

If the chosen cloud's plugin is NOT installed, surface the install command and EXIT phase 16 cleanly.

## Branch B: Cred-proxy bootstrap
If `cred-proxy doctor` reports unhealthy:
  → run `cred-proxy bootstrap --cloud <chosen>`
Else: skip Branch B.

## Branch C: Firewall backend
On Linux: backend = nftables (require sudo)
On macOS: backend = pfctl (require sudo)
On other / opt-out: backend = disabled (warn the operator)

## Branch D: Dry-run deploy
Run `deploy plan REQ-WIZARD-DRYRUN --env staging --dry-run`
Inspect output; if successful, phase 16 complete.
```

The implementer MAY add a brief 1–2-sentence intro paragraph after the H1 explaining what consumes the document (TDD-033 phase-16 runtime), and MAY add the closing forward-pointer noted above.

### Error handling at edit time
- If the directory `plugins/autonomous-dev-assist/instructions/` does not exist, abort with an explicit error (do NOT silently `mkdir -p`).
- If the file already exists on disk, abort and surface the conflict (this spec creates the file fresh).

## Acceptance Criteria

```
Given the autonomous-dev-assist plugin tree on main
When this spec's file creation is applied
Then the file plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md exists
And the file is ≤ 100 lines
And the file's first non-blank line is "# Phase-16 prompt tree"
```

```
Given the new cloud-prompt-tree.md
When the H2 headings are extracted in document order
Then they are exactly:
  - "## Branch A: Cloud plugin choice"
  - "## Branch B: Cred-proxy bootstrap"
  - "## Branch C: Firewall backend"
  - "## Branch D: Dry-run deploy"
And no other H2 headings are present
```

```
Given Branch A
When the operator-choice list is read
Then it lists, in order: gcp, aws, azure, k8s, none
And each cloud option references its corresponding plugin name (e.g., gcp → autonomous-dev-deploy-gcp)
And the "none" option states "abort phase 16, return to phase 11"
And there is text stating that if the chosen cloud's plugin is NOT installed, the runtime surfaces the install command and exits phase 16 cleanly
```

```
Given Branch B
When the gating logic is read
Then it conditions on "cred-proxy doctor" health
And the unhealthy branch invokes "cred-proxy bootstrap --cloud <chosen>"
And the healthy branch is marked as skipped (e.g., "Else: skip Branch B")
```

```
Given Branch C
When the OS-to-backend mapping is read
Then Linux maps to "nftables" with a sudo requirement
And macOS maps to "pfctl" with a sudo requirement
And "other / opt-out" maps to "disabled" with an operator warning
```

```
Given Branch D
When the dry-run command is read
Then it contains the verbatim substring "deploy plan REQ-WIZARD-DRYRUN --env staging --dry-run"
And there is text stating that successful inspection completes phase 16
```

```
Given the new file
When a secrets-pattern scan is run
Then no AWS access key (AKIA*/ASIA*), AWS ARN, GCP project ID-like token, or 40-character hex token is found
And cloud names appear only as placeholders ("<cloud>", "<chosen>") or short identifiers (gcp/aws/azure/k8s)
```

```
Given the new file
When `markdownlint` is run with default rules
Then it exits 0
And no broken code fences, malformed tables, or unclosed inline code spans are reported
```

### Edge cases / sad paths

```
Given TDD-033 has not yet shipped the phase-16 runtime
When an operator runs `/autonomous-dev-assist:setup-wizard --with-cloud`
Then the runtime returns "no such flag" or "phase 16 not implemented"
And the cloud-prompt-tree.md remains a valid forward-compatible artifact (no operator harm)
And TDD-027 §15 / OQ-3 confirms this is acceptable
```

```
Given a future TDD adds a fifth cloud plugin (e.g., Oracle Cloud)
When that future plan amends Branch A
Then the amendment is a single-line append within Branch A's choice list
And no schema change to the file is required
And no other branch is affected (per PLAN-027-2 Risks table)
```

```
Given the implementer is tempted to embed an example AWS account ID for clarity
When this spec is consulted
Then they MUST refuse and use only the placeholder "<cloud>" or "<chosen>"
And FR-9 / NFR secrets scan blocks the violation
```

## Test Requirements

### Static
- `test -f plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md` exits 0.
- `head -1 plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md` equals `# Phase-16 prompt tree`.
- `grep -c "^## Branch [A-D]" plugins/autonomous-dev-assist/instructions/cloud-prompt-tree.md` returns exactly 4.
- `grep -c "deploy plan REQ-WIZARD-DRYRUN --env staging --dry-run" cloud-prompt-tree.md` returns ≥ 1.
- `grep -c "cred-proxy bootstrap --cloud" cloud-prompt-tree.md` returns ≥ 1.
- `grep -c "nftables" cloud-prompt-tree.md` returns ≥ 1; `grep -c "pfctl" cloud-prompt-tree.md` returns ≥ 1.
- `wc -l cloud-prompt-tree.md` returns ≤ 100.
- `markdownlint cloud-prompt-tree.md` exits 0.
- `grep -E "AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|arn:aws:" cloud-prompt-tree.md` returns empty.

### Integration / regression
- The phase-16 boundary marker authored by SPEC-027-2-03 lists `cloud-prompt-tree.md` in its `provides:` list — cross-checked at PR-review time.
- The standards-meta-reviewer (PLAN-021-3) verifies the file contains no secrets and is well-formed Markdown.
- No existing assist eval suite exercises this file directly; SPEC-027-2-04's `onboard-cloud-001` indirectly references the wizard invocation that loads it (forward-compatible).

### Manual review
- Reviewer reads the four branches aloud and confirms branch ordering, cloud-plugin enumeration, OS-detection mapping, and absence of secrets.

## Implementation Notes

- **Why a flat Markdown text format and not Mermaid?** TDD-027 OQ-2 defers Mermaid as a style decision; the runtime (TDD-033 §5) consumes the document by parsing H2 anchors and bullet lines, not by rendering a diagram. A future plan can layer a Mermaid diagram on top without changing the parse surface.
- **Why no frontmatter?** The existing `plugins/autonomous-dev-assist/instructions/runbook.md` carries no frontmatter; matching its convention keeps the directory uniform and avoids accidentally introducing a "frontmatter required" rule that downstream tooling would have to handle.
- **Forward compatibility note.** Per TDD-027 §15, this file can ship in any order relative to TDD-033's runtime. If the runtime is missing, the file sits as static documentation; if the runtime ships first, it can no-op until this file lands. Neither order causes operator harm.
- **The `<chosen>` placeholder.** Branch A names the chosen cloud as the operator's selection (gcp/aws/azure/k8s); Branch B references that same selection as `<chosen>`. Implementers MUST use `<chosen>` (or `<cloud>` — both acceptable; the TDD §5.2.2 onboarding appendix uses `<cloud>`) and MUST NOT bind it to a concrete cloud name in Branch B.
- **No frontmatter `tools:` change is required by this spec** — the file is data, not an executable agent prompt.

## Rollout Considerations

- **Rollout**: Markdown-only PR; no daemon restart, no migration.
- **Feature flag**: None. The file sits as static content until TDD-033's phase-16 runtime loads it.
- **Rollback**: `git rm` the file. The phase-16 runtime (when present) gracefully no-ops on missing content per TDD-027 §15 / OQ-4.
- **Coordination**: This spec is a content-only forward dependency for TDD-033. The PR description should link the absolute file path and the phase-16 marker line in SPEC-027-2-03.

## Effort Estimate

| Activity | Hours |
|----------|-------|
| Author the H1 + 4 H2 branch sections (verbatim per TDD-027 §6.1) | 1.0 |
| Add intro/outro paragraphs and TDD-033 forward pointer | 0.25 |
| Markdown-lint + secrets-scan + manual proofread | 0.5 |
| Cross-check against SPEC-027-2-03 boundary marker `provides:` list | 0.25 |
| **Total** | **2.0** |
