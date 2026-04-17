# SPEC-005-3-3: Proposal Generator, Constraint Enforcement, and Version Bump Classifier

## Metadata
- **Parent Plan**: PLAN-005-3
- **Tasks Covered**: Task 5 (Proposal generator), Task 6 (Proposal constraint enforcement), Task 7 (Version bump classifier)
- **Estimated effort**: 18 hours

## Description

Implement the constrained proposal generator that produces modification diffs from weakness reports, the hard-coded constraint enforcement that rejects proposals violating immutable field rules before meta-review, and the version bump classifier that determines major/minor/patch semver increments based on diff analysis. These three components ensure that every generated proposal is safe, correctly versioned, and addresses identified weaknesses without exceeding its authority.

## Files to Create/Modify

### New Files

**`src/agent-factory/improvement/proposer.ts`**
- Exports: `ProposalGenerator` class with `generateProposal(agentName: string, report: WeaknessReport): ProposalResult`

**`src/agent-factory/improvement/version-classifier.ts`**
- Exports: `classifyVersionBump(currentDef: ParsedAgent, proposedDef: ParsedAgent, diff: string): VersionBump`

### Modified Files

**`src/agent-factory/improvement/types.ts`** (extend)
- Add: `AgentProposal`, `ProposalResult`, `ProposalStatus`, `ConstraintViolation`, `VersionBump`

## Implementation Details

### Proposal Generator (`improvement/proposer.ts`)

```typescript
type ProposalStatus =
  | 'pending_meta_review'
  | 'meta_approved'
  | 'meta_rejected'
  | 'validating'
  | 'validated_positive'
  | 'validated_negative'
  | 'pending_human_review'
  | 'promoted'
  | 'rejected';

interface AgentProposal {
  proposal_id: string;                // UUID v4
  agent_name: string;
  current_version: string;
  proposed_version: string;
  version_bump: VersionBump;
  weakness_report_id: string;         // links to the triggering report
  current_definition: string;         // full .md content of current agent
  proposed_definition: string;        // full .md content of proposed agent
  diff: string;                       // unified diff
  rationale: string;                  // human-readable explanation of changes
  status: ProposalStatus;
  created_at: string;                 // ISO 8601
  meta_review_id?: string;           // set after meta-review
  evaluation_id?: string;            // set after A/B validation
}

type VersionBump = 'major' | 'minor' | 'patch';

interface ProposalResult {
  success: boolean;
  proposal?: AgentProposal;
  constraintViolations?: ConstraintViolation[];
  error?: string;
}

interface ConstraintViolation {
  field: string;
  rule: string;
  current_value: string;
  proposed_value: string;
}
```

**Proposal generation steps:**

**Step 1: Load current agent definition**
- Read the full `.md` file content for the agent.
- Parse into `ParsedAgent` for comparison.

**Step 2: Construct improvement prompt**

```
You are improving the agent definition for '{name}' (v{version}, role: {role}).

## Weakness Report
Overall Assessment: {assessment}
Weaknesses:
{for each weakness:}
  - Dimension: {dimension} (severity: {severity})
    Evidence: {evidence}
    Affected domains: {affected_domains}
    Suggested focus: {suggested_focus}

## Current Agent Definition
```
{full .md content}
```

## Constraints (MUST NOT VIOLATE)
1. Do NOT change the `tools` field. Keep it exactly as-is.
2. Do NOT change the `role` field.
3. Do NOT add new expertise tags. You may refine existing tags (e.g., clarify wording) but not expand scope.
4. Do NOT remove any `evaluation_rubric` dimensions. You may adjust weights or descriptions.
5. Update the `version` field appropriately.
6. Add a new entry to `version_history`.

## Task
Produce a complete, modified agent `.md` file that addresses the identified weaknesses.
Focus your changes on the system prompt (Markdown body) to improve the agent's behavior
in the weak dimensions. You may also adjust rubric dimension weights if the weakness
analysis suggests rebalancing.

Output the complete modified `.md` file in a code block.
```

**Step 3: Invoke LLM and extract proposed definition**
- Use the same model as the agent being modified (or a configurable default).
- Extract the `.md` content from the response (look for code blocks).
- If extraction fails, return error.

**Step 4: Hard-coded constraint enforcement (BEFORE meta-review)**

Parse the proposed definition and compare against current:

```typescript
function enforceConstraints(current: ParsedAgent, proposed: ParsedAgent): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  // CONSTRAINT 1: tools field must be identical
  if (!arraysEqual(current.tools, proposed.tools)) {
    violations.push({
      field: 'tools',
      rule: 'IMMUTABLE_TOOLS',
      current_value: JSON.stringify(current.tools),
      proposed_value: JSON.stringify(proposed.tools)
    });
  }

  // CONSTRAINT 2: role field must be identical
  if (current.role !== proposed.role) {
    violations.push({
      field: 'role',
      rule: 'IMMUTABLE_ROLE',
      current_value: current.role,
      proposed_value: proposed.role
    });
  }

  // CONSTRAINT 3: no new expertise tags (subset check)
  const newTags = proposed.expertise.filter(t =>
    !current.expertise.some(ct => ct.toLowerCase() === t.toLowerCase())
  );
  if (newTags.length > 0) {
    violations.push({
      field: 'expertise',
      rule: 'NO_NEW_EXPERTISE',
      current_value: JSON.stringify(current.expertise),
      proposed_value: JSON.stringify(proposed.expertise)
    });
  }

  // CONSTRAINT 4: no rubric dimensions removed
  const currentDimensions = new Set(current.evaluation_rubric.map(d => d.name));
  const proposedDimensions = new Set(proposed.evaluation_rubric.map(d => d.name));
  const removedDimensions = [...currentDimensions].filter(d => !proposedDimensions.has(d));
  if (removedDimensions.length > 0) {
    violations.push({
      field: 'evaluation_rubric',
      rule: 'NO_RUBRIC_REMOVAL',
      current_value: JSON.stringify([...currentDimensions]),
      proposed_value: JSON.stringify([...proposedDimensions])
    });
  }

  return violations;
}
```

If violations found:
- Reject immediately (do NOT proceed to meta-review).
- Log `proposal_rejected_constraint_violation` to audit log with violation details.
- Return `{ success: false, constraintViolations: violations }`.

**Step 5: Compute diff and version bump**

- Compute unified diff between current and proposed `.md` content.
- Classify version bump using the version classifier.
- Set `proposed_version` by incrementing the appropriate semver component.

**Step 6: Create proposal record**

- Assemble the `AgentProposal` with status `pending_meta_review`.
- Return the proposal for meta-review (SPEC-005-3-4).

### Version Bump Classifier (`improvement/version-classifier.ts`)

```typescript
type VersionBump = 'major' | 'minor' | 'patch';

interface VersionClassification {
  bump: VersionBump;
  reason: string;
  bodyChangePercent: number;
  frontmatterChanges: string[];
}

function classifyVersionBump(
  current: ParsedAgent,
  proposed: ParsedAgent,
  diff: string
): VersionClassification {
  // Compute body change percentage
  const bodyChangePercent = computeBodyChangePercent(
    current.system_prompt,
    proposed.system_prompt
  );

  // Check frontmatter field changes
  const frontmatterChanges = detectFrontmatterChanges(current, proposed);

  // Classification rules (TDD 3.6.1):
  // MAJOR: role or expertise (new tags) changed, or >50% body changed
  // MINOR: rubric dimensions changed, new instructions added, or 10-50% body
  // PATCH: <10% body, no frontmatter changes (except version/version_history)

  if (frontmatterChanges.includes('role') ||
      frontmatterChanges.includes('expertise_new_tags') ||
      bodyChangePercent > 50) {
    return { bump: 'major', reason: '...', bodyChangePercent, frontmatterChanges };
  }

  if (frontmatterChanges.includes('evaluation_rubric') ||
      bodyChangePercent >= 10) {
    return { bump: 'minor', reason: '...', bodyChangePercent, frontmatterChanges };
  }

  return { bump: 'patch', reason: '...', bodyChangePercent, frontmatterChanges };
}
```

**Body change percentage computation:**

Using a line-based diff:
1. Split current and proposed system_prompt into lines.
2. Count added lines, removed lines, total lines in current.
3. `changePercent = (addedLines + removedLines) / max(totalCurrentLines, 1) * 100`.

**Frontmatter change detection:**

Compare each frontmatter field (excluding `version` and `version_history` which always change):
- `role` changed -> include in list
- `expertise` has new tags -> `expertise_new_tags`
- `evaluation_rubric` dimensions changed (added, removed, weight change > 0.1) -> `evaluation_rubric`
- `temperature` changed -> `temperature`
- `turn_limit` changed -> `turn_limit`
- `model` changed -> `model`

## Acceptance Criteria

1. Proposal generator produces a complete modified `.md` file addressing weakness report findings.
2. Improvement prompt includes the weakness report, current definition, and explicit constraints.
3. Hard-coded constraint enforcement rejects proposals where `tools` field changed.
4. Hard-coded constraint enforcement rejects proposals where `role` field changed.
5. Hard-coded constraint enforcement rejects proposals adding new expertise tags.
6. Hard-coded constraint enforcement rejects proposals removing rubric dimensions.
7. Constraint violations are detected BEFORE meta-review (not relying on LLM).
8. Constraint violation logged to audit log with violation details.
9. Version bump classifier: >50% body change -> major.
10. Version bump classifier: rubric change or 10-50% body -> minor.
11. Version bump classifier: <10% body and no frontmatter changes -> patch.
12. Unified diff computed between current and proposed definitions.
13. Proposal record created with status `pending_meta_review`.

## Test Cases

### Proposal Generator Tests

```
test_generate_proposal_from_weakness_report
  Setup: agent with weakness in "test-coverage" dimension
  Action: generateProposal("code-executor", weaknessReport)
  Expected: proposal with modified system_prompt addressing test coverage

test_proposal_includes_diff
  Action: generate proposal
  Expected: proposal.diff is a valid unified diff

test_proposal_version_incremented
  Setup: current version "1.0.0"
  Expected: proposed_version follows semver (e.g., "1.0.1" for patch)

test_proposal_links_to_weakness_report
  Expected: proposal.weakness_report_id matches the report's report_id

test_proposal_status_pending_meta_review
  Expected: proposal.status === "pending_meta_review"

test_proposal_extraction_from_code_block
  Input: LLM response with ```markdown ... ``` block
  Expected: content extracted correctly

test_proposal_extraction_failure
  Input: LLM response with no code block
  Expected: error result returned
```

### Constraint Enforcement Tests

```
test_tools_field_change_rejected
  Setup: current tools=["Read","Glob"], proposed tools=["Read","Glob","Bash"]
  Expected: violation IMMUTABLE_TOOLS, proposal rejected before meta-review

test_role_field_change_rejected
  Setup: current role="author", proposed role="executor"
  Expected: violation IMMUTABLE_ROLE

test_new_expertise_tag_rejected
  Setup: current expertise=["typescript"], proposed=["typescript","python"]
  Expected: violation NO_NEW_EXPERTISE

test_expertise_refinement_allowed
  Setup: current expertise=["testing"], proposed=["testing"] (same tag, maybe different case)
  Expected: no violation

test_rubric_dimension_removal_rejected
  Setup: current rubric has ["correctness","quality","coverage"]
  Setup: proposed rubric has ["correctness","quality"]
  Expected: violation NO_RUBRIC_REMOVAL

test_rubric_dimension_addition_allowed
  Setup: proposed adds new dimension while keeping all current
  Expected: no violation

test_rubric_weight_change_allowed
  Setup: current weight=0.3, proposed weight=0.4 for same dimension
  Expected: no violation

test_multiple_violations_all_reported
  Setup: proposal changes tools AND adds expertise
  Expected: both violations reported

test_violation_logged_to_audit
  Setup: tools field changed
  Expected: audit log contains proposal_rejected_constraint_violation

test_constraint_check_is_hard_coded
  Note: constraints are enforced by code comparison, not prompt-based
  Expected: verified by inspecting that check runs without LLM invocation
```

### Version Bump Classifier Tests

```
test_major_bump_role_change
  Input: role changed from "author" to "executor"
  Expected: bump = "major"
  Note: This would be caught by constraint enforcement first; classifier still categorizes it.

test_major_bump_large_body_change
  Input: 60% of system_prompt lines changed
  Expected: bump = "major", reason includes ">50% body changed"

test_minor_bump_rubric_change
  Input: evaluation_rubric dimension weight changed by 0.15
  Expected: bump = "minor"

test_minor_bump_medium_body_change
  Input: 25% of system_prompt lines changed
  Expected: bump = "minor"

test_patch_bump_small_body_change
  Input: 5% of system_prompt lines changed, no frontmatter changes
  Expected: bump = "patch"

test_body_change_percent_computation
  Input: current=10 lines, proposed=10 lines, 3 changed
  Expected: changePercent = 30% (3 removed + 3 added = 6 / 10 * 100 = 60%)
  Note: Actual computation depends on added/removed line counting

test_frontmatter_change_detection_excludes_version
  Input: only version and version_history changed
  Expected: frontmatterChanges is empty (these are expected to change)

test_boundary_50_percent_is_major
  Input: exactly 51% body changed
  Expected: bump = "major"

test_boundary_10_percent_is_minor
  Input: exactly 10% body changed
  Expected: bump = "minor"

test_boundary_9_percent_is_patch
  Input: 9% body changed, no frontmatter
  Expected: bump = "patch"
```
