# PLAN-005-3: Agent Improvement Lifecycle (Analysis, Proposal, Meta-Review)

## Metadata
- **Parent TDD**: TDD-005-agent-factory
- **Estimated effort**: 10 days
- **Dependencies**: PLAN-005-1 (Agent Registry Foundation), PLAN-005-2 (Metrics & Observation)
- **Blocked by**: PLAN-005-2
- **Priority**: P1
- **Risk Level**: Medium

## Objective

Implement the first half of the agent improvement lifecycle: the observation-to-proposal pipeline. When an agent accumulates enough invocations, the system triggers automated analysis via the `performance-analyst` agent, generates a structured weakness report, produces a constrained modification proposal (as a diff), and gates that proposal through the `agent-meta-reviewer` for security review. After this plan, the system can autonomously identify agent weaknesses and produce reviewed, safe improvement proposals that await validation (PLAN-005-4) and human approval.

This is the first plan where the system starts making judgments about agent quality and proposing changes. The risk is medium because all proposals are gated by meta-review and no changes are applied without subsequent validation and human approval.

## Scope

### In Scope

- Observation phase: automatic trigger when threshold met (TDD 3.4.2)
- Analysis phase: invoke `performance-analyst` agent with metrics data, produce `WeaknessReport` (TDD 3.4.3)
- Weakness report schema and storage (TDD 3.4.3)
- Decision logic: healthy -> no action; needs_improvement -> propose; critical -> propose; propose_specialist -> route to dynamic creation (deferred to PLAN-005-5, logged only) (TDD 3.4.3)
- Proposal phase: generate constrained modification diff from weakness report (TDD 3.4.4)
- Proposal constraints: tools field immutable, role field immutable, expertise refinement only, rubric dimensions not removed (TDD 3.4.4)
- Proposal schema (`AgentProposal`) and storage (TDD 3.4.4)
- Version bump determination: major/minor/patch classification based on diff scope (TDD 3.6.1)
- Meta-review phase: invoke `agent-meta-reviewer` with proposal, enforce 6-point checklist (TDD 3.4.5)
- Meta-review result schema (`MetaReviewResult`, `MetaReviewFinding`) and storage (TDD 3.4.5)
- Meta-reviewer self-review prohibition: changes to meta-reviewer bypass meta-review (TDD 3.8.4)
- Hard-coded rejection of tool field changes in proposals (TDD 3.8.2 Boundary 4)
- Modification rate limiting: 1 modification per agent per calendar week (TDD 3.7.3)
- Agent state transitions: ACTIVE -> UNDER_REVIEW (TDD 2.2)
- ImprovementLifecycle API: `getObservationStatus()`, `triggerAnalysis()`, `generateProposal()`, `metaReview()` (TDD 5.2)
- CLI commands: `agent analyze <name> [--force]` (TDD 5.1)
- Audit log entries for proposal generation and meta-review events (TDD 3.8.3)

### Out of Scope

- A/B validation (PLAN-005-4)
- Human-approved promotion workflow (PLAN-005-4)
- Canary phase (PLAN-005-5)
- Autonomous promotion (PLAN-005-5)
- Dynamic agent creation pipeline (PLAN-005-5) -- gap detection is logged but not actioned in this plan
- Domain gap `accept`/`reject` CLI commands (PLAN-005-5)

## Tasks

1. **Observation trigger** -- Detect when an agent crosses the observation threshold and initiate the analysis phase.
   - Files to create: `src/agent-factory/improvement/observation-trigger.ts`
   - Files to modify: `src/agent-factory/metrics/engine.ts` (hook after `record()`)
   - Acceptance criteria: After each metric record, checks observation state for the agent. If invocations_recorded >= threshold and agent is not FROZEN and no analysis is currently in progress: triggers analysis. Respects per-agent threshold overrides from config. Manual trigger via `--force` bypasses threshold check but respects FROZEN state.
   - Estimated effort: 4 hours

2. **Weakness report schema and storage** -- Define `WeaknessReport` and `Weakness` types; persist reports.
   - Files to create: `src/agent-factory/improvement/types.ts`
   - Acceptance criteria: Implements all fields from TDD 3.4.3: `agent_name`, `agent_version`, `analysis_date`, `overall_assessment` (healthy/needs_improvement/critical), `weaknesses[]` (dimension, severity, evidence, affected_domains, suggested_focus), `strengths[]`, `recommendation` (no_action/propose_modification/propose_specialist). Reports stored as JSONL at `data/weakness-reports.jsonl`.
   - Estimated effort: 3 hours

3. **Performance analysis orchestration** -- Prepare input for and invoke the `performance-analyst` agent to produce a weakness report.
   - Files to create: `src/agent-factory/improvement/analyzer.ts`
   - Acceptance criteria: Collects all per-invocation metrics, aggregate metrics, trend data, per-dimension quality scores, and domain-specific breakdowns for the target agent. Formats this data as structured input for the `performance-analyst` agent. Invokes the agent via the registry. Parses the agent's output into a `WeaknessReport`. Handles analysis failure gracefully (logs error, does not crash, retries on next threshold crossing).
   - Estimated effort: 8 hours

4. **Analysis decision logic** -- Route the analysis result to the appropriate next step.
   - Files to modify: `src/agent-factory/improvement/analyzer.ts`
   - Acceptance criteria: If `overall_assessment` is "healthy": no action, re-evaluate after next threshold crossing (reset observation count). If "needs_improvement" or "critical" AND recommendation is "propose_modification": proceed to proposal generation. If recommendation is "propose_specialist": log domain gap to `data/domain-gaps.jsonl` with status "specialist_recommended", do not proceed to proposal (dynamic creation is PLAN-005-5).
   - Estimated effort: 2 hours

5. **Proposal generator** -- Generate a constrained modification proposal as a diff against the current agent definition.
   - Files to create: `src/agent-factory/improvement/proposer.ts`
   - Acceptance criteria: Takes current agent definition as base and weakness report as input. Uses a prompt template to instruct an LLM to modify the agent's system prompt addressing the identified weaknesses. Enforces constraints: `tools` field MUST NOT change, `role` MUST NOT change, `expertise` may be refined but not expanded, `evaluation_rubric` dimensions may be adjusted but not removed. Computes unified diff between current and proposed. Bumps version per TDD 3.6.1 rules (major/minor/patch based on diff scope). Outputs `AgentProposal` record.
   - Estimated effort: 10 hours

6. **Proposal constraint enforcement (hard-coded)** -- Validate that the generated proposal does not violate immutable field constraints.
   - Files to modify: `src/agent-factory/improvement/proposer.ts`
   - Acceptance criteria: After LLM generates the proposed definition, a hard-coded (not prompt-based) check verifies: `tools` field is identical to current, `role` field is identical to current, no new expertise tags added (only refinements of existing), no rubric dimensions removed. If any constraint violated: reject the proposal immediately, log violation to audit log, do not proceed to meta-review.
   - Estimated effort: 4 hours

7. **Version bump classifier** -- Determine the appropriate semver bump based on diff analysis.
   - Files to create: `src/agent-factory/improvement/version-classifier.ts`
   - Acceptance criteria: Computes the percentage of markdown body changed. If `role`, `expertise` (new tags), or >50% body changed: major. If rubric dimensions changed, new instructions added, or 10-50% body changed: minor. If <10% body changed and no frontmatter fields changed (except version/version_history): patch.
   - Estimated effort: 4 hours

8. **Meta-review orchestration** -- Invoke the `agent-meta-reviewer` with the full proposal for security review.
   - Files to create: `src/agent-factory/improvement/meta-reviewer.ts`
   - Acceptance criteria: Passes full proposal record including diff to `agent-meta-reviewer` agent. Agent evaluates the 6-point checklist from TDD 3.4.5: tool access escalation, role change, scope creep, prompt injection vectors, schema compliance, proportionality. Parses agent output into `MetaReviewResult` with verdict and findings. If any finding has severity "blocker": proposal is rejected. Warnings are included for human review but do not block.
   - Estimated effort: 8 hours

9. **Meta-reviewer self-review bypass** -- Ensure the meta-reviewer cannot review proposals that modify itself.
   - Files to modify: `src/agent-factory/improvement/meta-reviewer.ts`
   - Acceptance criteria: If the target agent is `agent-meta-reviewer`: skip meta-review step, set proposal status directly to "pending_human_review", log that meta-review was bypassed for self-referential proposal.
   - Estimated effort: 2 hours

10. **Modification rate limiter** -- Enforce per-agent weekly modification limits.
    - Files to create: `src/agent-factory/improvement/rate-limiter.ts`
    - Acceptance criteria: Tracks modifications per agent per calendar week. Default: 1 modification per agent per week (configurable). If rate limit reached: proposal is deferred (not rejected), logged, and queued for next calendar week. Calendar week boundary uses Monday-Sunday.
    - Estimated effort: 4 hours

11. **Proposal storage and lifecycle state** -- Store proposals and manage their state transitions.
    - Files to create: `src/agent-factory/improvement/proposal-store.ts`
    - Acceptance criteria: Proposals stored as JSONL at `data/proposals.jsonl` and indexed in SQLite (new table). Status transitions: `pending_meta_review` -> `meta_approved` or `meta_rejected`. Additional transitions (`validating`, `validated_positive`, etc.) are persisted by PLAN-005-4 and PLAN-005-5. Provides query API: list proposals by agent, by status, by date range.
    - Estimated effort: 6 hours

12. **Agent state transition: ACTIVE -> UNDER_REVIEW** -- Update registry state when a proposal is generated.
    - Files to modify: `src/agent-factory/registry.ts`
    - Acceptance criteria: When a proposal is generated, the agent's state transitions from ACTIVE to UNDER_REVIEW. Guards: agent must be ACTIVE (not FROZEN, not already UNDER_REVIEW), observation threshold met (or forced), not rate-limited. State change logged to audit log.
    - Estimated effort: 3 hours

13. **CLI command: `agent analyze`** -- Trigger analysis for a specific agent.
    - Files to modify: `src/agent-factory/cli.ts`
    - Acceptance criteria: `agent analyze <name>` triggers analysis if observation threshold met. `--force` flag bypasses threshold. Displays weakness report summary on completion. Displays error if agent is FROZEN or rate-limited.
    - Estimated effort: 3 hours

14. **Audit log entries for improvement events** -- Log proposal and meta-review events.
    - Files to modify: `src/agent-factory/audit.ts`
    - Acceptance criteria: Logs `proposal_generated`, `proposal_rejected_constraint_violation`, `meta_review_completed` (with verdict and findings count), `meta_review_bypassed_self_referential`, `modification_rate_limited` events. Each entry includes timestamp, agent name, proposal ID, and event-specific details.
    - Estimated effort: 3 hours

## Dependencies & Integration Points

- **PLAN-005-1 (Agent Registry Foundation)**: Registry provides `get()` for agent lookup, `getState()` for state checking, and the Agent Runtime for invoking the performance-analyst and meta-reviewer agents.
- **PLAN-005-2 (Metrics & Observation)**: MetricsEngine provides `getInvocations()` and `getAggregate()` for the analysis input. Observation tracker provides threshold crossing detection.
- **PLAN-005-4 (A/B Validation)**: Meta-approved proposals feed into the A/B validation pipeline. This plan produces proposals with status `meta_approved`; PLAN-005-4 consumes them.
- **PLAN-005-5 (Autonomous Capabilities)**: "propose_specialist" recommendations are logged as domain gaps for PLAN-005-5 to process.

## Testing Strategy

**Unit tests:**
- Proposal constraint enforcement: verify `tools` field change is hard-rejected; verify `role` change is hard-rejected; verify new expertise tag is rejected; verify rubric dimension removal is rejected; verify legitimate changes pass.
- Version bump classifier: verify major (>50% body change); verify minor (rubric change, 15% body change); verify patch (<10% body change, no frontmatter change).
- Rate limiter: verify per-agent weekly limit; verify calendar week boundary handling; verify deferred (not rejected) behavior.
- Meta-reviewer self-review bypass: verify bypass when target is `agent-meta-reviewer`.

**Integration tests:**
- Full observation-to-proposal pipeline: seed 15 invocations with a known weakness pattern -> observe analysis trigger -> verify weakness report generated -> verify proposal generated with correct version bump -> verify meta-review invoked -> verify proposal status updated.
- Proposal rejection on constraint violation: generate a proposal that attempts to add a tool -> verify hard-coded rejection before meta-review.
- Rate limiting: generate two proposals for the same agent in the same calendar week -> verify second is deferred.
- Meta-reviewer gate: verify that a proposal with a blocker finding is rejected and does not proceed to validation.

**Security tests:**
- Proposal tool field change: generate a proposal that adds `Bash` to an author agent -> verify automatic rejection at constraint enforcement (not relying on meta-reviewer).
- Meta-reviewer bypass: attempt to promote a proposal without meta-review completion -> verify lifecycle rejects it.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Performance-analyst produces low-quality weakness reports | Medium | Medium | Start with structured prompts and clear examples; human reviews reports during Phase 2; iterate on analyst prompt |
| LLM-generated proposals violate constraints despite prompting | Medium | High | Hard-coded constraint enforcement after generation, not reliance on prompt; reject and retry |
| Meta-reviewer false positive rate blocks legitimate improvements | Medium | Medium | Track false positive rate; expose meta-review warnings (not just verdicts) to human reviewer; adjust meta-reviewer prompt based on false positive data |
| Proposal generation is expensive in tokens | Low | Medium | Budget enforcement per proposal; limit to 1 proposal per agent per week; track token consumption |
| Observation threshold too low leads to noisy proposals | Medium | Low | Start at 10, make configurable per-agent; track proposal quality vs. observation count to calibrate |

## Definition of Done

- [ ] Observation trigger fires when threshold crossed and agent is eligible
- [ ] Performance-analyst agent produces structured WeaknessReport from metrics data
- [ ] Decision logic correctly routes: healthy -> no action, needs_improvement -> propose, propose_specialist -> log gap
- [ ] Proposal generator produces constrained diffs addressing identified weaknesses
- [ ] Hard-coded constraint enforcement rejects tool/role/expertise/rubric violations (verified with tests)
- [ ] Version bump classifier correctly categorizes major/minor/patch changes
- [ ] Meta-reviewer gate invoked for all proposals; blocker findings reject the proposal
- [ ] Meta-reviewer self-review bypass works correctly for `agent-meta-reviewer` proposals
- [ ] Modification rate limiter enforces per-agent weekly limits
- [ ] Proposals stored with correct lifecycle state transitions
- [ ] Agent state transitions to UNDER_REVIEW when proposal is generated
- [ ] CLI `agent analyze` command works with and without `--force`
- [ ] All security-relevant events logged to audit log
- [ ] All unit, integration, and security tests pass
