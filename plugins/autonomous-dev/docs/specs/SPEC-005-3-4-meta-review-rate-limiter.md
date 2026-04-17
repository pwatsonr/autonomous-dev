# SPEC-005-3-4: Meta-Review Orchestration, Self-Review Bypass, and Modification Rate Limiter

## Metadata
- **Parent Plan**: PLAN-005-3
- **Tasks Covered**: Task 8 (Meta-review orchestration), Task 9 (Meta-reviewer self-review bypass), Task 10 (Modification rate limiter)
- **Estimated effort**: 14 hours

## Description

Implement the meta-review gate that invokes the `agent-meta-reviewer` to evaluate proposals against the 6-point security checklist, the self-review bypass that prevents the meta-reviewer from reviewing its own modifications, and the modification rate limiter that enforces per-agent weekly modification limits. Together these form the safety gates that every proposal must pass before reaching validation.

## Files to Create/Modify

### New Files

**`src/agent-factory/improvement/meta-reviewer.ts`**
- Exports: `MetaReviewOrchestrator` class with `review(proposal: AgentProposal): MetaReviewResult`

**`src/agent-factory/improvement/rate-limiter.ts`**
- Exports: `ModificationRateLimiter` class with `checkLimit(agentName: string): RateLimitResult`

### Modified Files

**`src/agent-factory/improvement/types.ts`** (extend)
- Add: `MetaReviewResult`, `MetaReviewFinding`, `MetaReviewVerdict`, `ChecklistItem`, `RateLimitResult`

## Implementation Details

### Meta-Review Orchestration (`improvement/meta-reviewer.ts`)

```typescript
type MetaReviewVerdict = 'approved' | 'rejected';
type FindingSeverity = 'info' | 'warning' | 'blocker';

interface MetaReviewResult {
  review_id: string;              // UUID v4
  proposal_id: string;
  verdict: MetaReviewVerdict;
  findings: MetaReviewFinding[];
  checklist_results: ChecklistResult[];
  reviewed_at: string;            // ISO 8601
  bypassed: boolean;              // true if self-review bypass
  bypass_reason?: string;
}

interface MetaReviewFinding {
  checklist_item: number;         // 1-6
  severity: FindingSeverity;
  description: string;
  evidence: string;               // specific text from the proposal that triggered the finding
}

interface ChecklistResult {
  item: number;
  name: string;
  passed: boolean;
  finding?: MetaReviewFinding;
}
```

**The 6-point security checklist (TDD 3.4.5):**

| # | Name | Description | Blocker if found |
|---|------|-------------|------------------|
| 1 | Tool access escalation | Does the proposal add, change, or imply access to tools not in the current allowlist? | Yes |
| 2 | Role change | Does the proposal change the agent's role or imply role-level capability changes? | Yes |
| 3 | Scope creep | Do the changes go beyond the identified weaknesses? Are unrelated capabilities added? | If severity is blocker |
| 4 | Prompt injection vectors | Could the new prompt text be manipulated by malicious input to bypass safety? | Yes |
| 5 | Schema compliance | Does the proposed definition pass all schema validation rules? | Yes |
| 6 | Proportionality | Are the changes proportional to the weakness severity? Minor weakness shouldn't trigger major changes. | If severity is blocker |

**Review steps:**

**Step 1: Look up the meta-reviewer agent**
- `registry.get('agent-meta-reviewer')`.
- If not found: error (meta-reviewer is required).
- If FROZEN: this is expected (meta-reviewer is normally frozen). It must still be invocable even in FROZEN state for its review function.

**Step 2: Construct review input**

```
You are the Agent Meta-Reviewer. Evaluate this agent modification proposal for safety.

## Proposal Summary
- Agent: {agent_name} ({current_version} -> {proposed_version})
- Version bump: {bump}
- Weakness report assessment: {overall_assessment}

## Unified Diff
```diff
{diff}
```

## Current Definition (for reference)
```markdown
{current_definition}
```

## Proposed Definition
```markdown
{proposed_definition}
```

## 6-Point Security Checklist
Evaluate each item. For each, provide: PASS or FAIL, severity (info/warning/blocker), and evidence.

1. **Tool access escalation**: Does the proposal change the tools field or imply tool access changes in the prompt?
2. **Role change**: Does the proposal change the role field or imply role-level capability shifts?
3. **Scope creep**: Do changes go beyond addressing the identified weaknesses?
4. **Prompt injection vectors**: Could new prompt text be manipulated by adversarial input?
5. **Schema compliance**: Does the proposed definition maintain valid schema?
6. **Proportionality**: Are changes proportional to weakness severity?

Output a JSON object with: verdict ("approved"/"rejected"), findings array, and checklist_results array.
```

**Step 3: Invoke meta-reviewer and parse output**
- Invoke via Agent Runtime.
- Parse JSON response into `MetaReviewResult`.
- If any finding has severity `blocker`: verdict must be `rejected` (override if agent said approved).

**Step 4: Hard override for blocker findings**
- After parsing the meta-reviewer's output, apply a hard-coded check:
  ```typescript
  const hasBlocker = result.findings.some(f => f.severity === 'blocker');
  if (hasBlocker && result.verdict === 'approved') {
    result.verdict = 'rejected';  // override: blockers always reject
  }
  ```

**Step 5: Update proposal status**
- If verdict is `approved`: set proposal status to `meta_approved`.
- If verdict is `rejected`: set proposal status to `meta_rejected`.
- Log `meta_review_completed` to audit log with verdict, findings count, and any blocker details.

### Self-Review Bypass (`meta-reviewer.ts`)

Before invoking the meta-reviewer, check if the target agent is the meta-reviewer itself:

```typescript
if (proposal.agent_name === 'agent-meta-reviewer') {
  return {
    review_id: uuid(),
    proposal_id: proposal.proposal_id,
    verdict: 'approved',   // bypasses meta-review
    findings: [],
    checklist_results: [],
    reviewed_at: now(),
    bypassed: true,
    bypass_reason: 'Self-referential proposal: meta-reviewer cannot review its own modifications'
  };
  // Status set to 'pending_human_review' (not 'meta_approved')
}
```

- Log `meta_review_bypassed_self_referential` to audit log.
- Proposal status set to `pending_human_review` instead of `meta_approved`.
- This means meta-reviewer modifications always require human approval and skip A/B validation.

### Modification Rate Limiter (`improvement/rate-limiter.ts`)

```typescript
interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  nextAllowedAt?: string;      // ISO 8601, when rate limit resets
  currentCount: number;
  maxPerWeek: number;
}

class ModificationRateLimiter {
  constructor(
    private config: AgentFactoryConfig,
    private auditLogger: AuditLogger
  ) {}

  checkLimit(agentName: string): RateLimitResult { ... }
  recordModification(agentName: string): void { ... }
}
```

**Rate limit tracking:**
- Persisted to `data/rate-limits.json`:
```json
{
  "modifications": {
    "code-executor": [
      { "timestamp": "2026-04-07T10:00:00.000Z", "proposal_id": "..." }
    ]
  }
}
```

**Calendar week definition:**
- Monday 00:00:00 UTC to Sunday 23:59:59 UTC.
- Use ISO 8601 week numbering.

**`checkLimit()` logic:**
1. Get all modification records for the agent in the current calendar week.
2. If count >= `config.rateLimits.modificationsPerAgentPerWeek` (default 1):
   - Return `{ allowed: false, nextAllowedAt: nextMondayUTC }`.
   - Log `modification_rate_limited` to audit log.
3. Otherwise return `{ allowed: true }`.

**Rate limit behavior:**
- When rate limit is hit, the proposal is **deferred** (not rejected).
- The proposal remains in `pending_meta_review` or `meta_approved` status.
- It will be processed when the next calendar week begins.
- The caller is responsible for checking the rate limit before generating proposals.

## Acceptance Criteria

1. Meta-reviewer invoked with the full proposal including diff and both definitions.
2. 6-point security checklist evaluated; each item produces a pass/fail result.
3. Any finding with severity `blocker` causes proposal rejection (hard-coded override).
4. Warnings included in the result but do not block.
5. Meta-reviewer output parsed into structured `MetaReviewResult`.
6. Proposal status updated to `meta_approved` or `meta_rejected`.
7. Self-review bypass: proposals for `agent-meta-reviewer` skip meta-review.
8. Self-review bypass sets status to `pending_human_review` (not `meta_approved`).
9. Self-review bypass logged to audit log.
10. Rate limiter enforces 1 modification per agent per calendar week (configurable).
11. Rate-limited proposals are deferred (not rejected).
12. Calendar week uses Monday-Sunday boundaries.

## Test Cases

### Meta-Review Tests

```
test_meta_review_all_pass
  Input: proposal with no security issues
  Expected: verdict="approved", all 6 checklist items passed

test_meta_review_blocker_finding_rejects
  Input: proposal where meta-reviewer finds tool escalation (blocker)
  Expected: verdict="rejected", finding with severity="blocker" on checklist item 1

test_meta_review_warning_does_not_reject
  Input: proposal with minor scope creep (warning)
  Expected: verdict="approved", finding with severity="warning"

test_hard_override_blocker_always_rejects
  Input: meta-reviewer says "approved" but has a blocker finding
  Expected: verdict overridden to "rejected"

test_meta_review_updates_proposal_status_approved
  Action: meta-review approves
  Expected: proposal.status = "meta_approved"

test_meta_review_updates_proposal_status_rejected
  Action: meta-review rejects
  Expected: proposal.status = "meta_rejected"

test_meta_review_audit_log
  Action: meta-review completes
  Expected: audit log contains meta_review_completed with verdict and findings count

test_meta_review_parse_failure
  Input: meta-reviewer returns unparseable output
  Expected: proposal status stays at pending_meta_review, error logged

test_schema_compliance_check
  Input: proposed definition fails validation (bad semver)
  Expected: checklist item 5 fails, blocker severity
```

### Self-Review Bypass Tests

```
test_self_review_bypass_detected
  Input: proposal.agent_name = "agent-meta-reviewer"
  Expected: meta-reviewer NOT invoked, bypassed=true

test_self_review_status_pending_human
  Input: proposal for agent-meta-reviewer
  Expected: proposal.status = "pending_human_review" (not "meta_approved")

test_self_review_bypass_logged
  Expected: audit log contains meta_review_bypassed_self_referential

test_non_self_proposal_not_bypassed
  Input: proposal.agent_name = "code-executor"
  Expected: normal meta-review flow, bypassed=false
```

### Rate Limiter Tests

```
test_first_modification_allowed
  Setup: no prior modifications for agent this week
  Expected: allowed=true

test_second_modification_blocked
  Setup: 1 modification already recorded this week (limit=1)
  Expected: allowed=false, nextAllowedAt = next Monday

test_modification_allowed_next_week
  Setup: modification recorded last Monday
  Action: check on following Monday
  Expected: allowed=true (new week)

test_calendar_week_boundary_monday
  Setup: modification on Sunday 23:59
  Action: check on Monday 00:01
  Expected: allowed=true (new week)

test_configurable_limit
  Setup: config limit = 3
  Action: record 2 modifications, check
  Expected: allowed=true (2 < 3)

test_rate_limit_logged
  Setup: rate limit hit
  Expected: audit log contains modification_rate_limited

test_deferred_not_rejected
  Setup: rate limit hit
  Expected: proposal status unchanged (still pending, not rejected)

test_rate_limit_per_agent
  Setup: 1 modification for "code-executor" (limit=1)
  Action: check for "prd-author"
  Expected: allowed=true (different agent)

test_rate_limit_persistence
  Setup: record modification
  Action: create new RateLimiter instance (simulating restart)
  Expected: previous modification still counted
```
