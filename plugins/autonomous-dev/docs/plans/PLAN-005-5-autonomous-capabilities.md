# PLAN-005-5: Autonomous Capabilities (Canary, Auto-Promotion, Dynamic Creation)

## Metadata
- **Parent TDD**: TDD-005-agent-factory
- **Estimated effort**: 12 days
- **Dependencies**: PLAN-005-1 through PLAN-005-4 (all prior plans)
- **Blocked by**: PLAN-005-4 (A/B Validation & Promotion)
- **Priority**: P2
- **Risk Level**: High

## Objective

Deliver the Phase 3 autonomous capabilities: canary (shadow mode) validation, autonomous patch-level promotion with guardrails, dynamic agent creation pipeline, agent compatibility tracking, and pipeline-level re-validation. After this plan, the Agent Factory can operate with limited autonomy -- proposing, validating, and promoting patch-level changes without human intervention, while maintaining strict safety guardrails including auto-rollback, override windows, and risk-tier gating.

This is the highest-risk plan in the TDD-005 series. It requires explicit operator opt-in (`autonomous-promotion: enabled`) and all Phase 2 exit criteria must be met before this work begins. Every autonomous action is bounded by rate limits, risk-tier restrictions, and rollback mechanisms.

**Phase 3 gate:** This plan does NOT begin implementation unless Phase 2 exit criteria are met AND the operator has opted in.

## Scope

### In Scope

- Canary phase: shadow mode dual-run for configurable duration (default 7 days) (TDD 3.4.7)
- Canary state management: tracking comparisons, auto-rollback on regression (TDD 3.4.7)
- Canary exit criteria: 60%+ win threshold, catastrophic regression guard (1.5 point drop), minimum 3 comparisons (TDD 3.4.7)
- Autonomous patch-level promotion (Phase 3 behavior from TDD 3.4.8)
- Autonomous promotion guardrails: 24-hour operator override window, 48-hour auto-rollback on quality decline, 30-day cooldown after auto-rollback (TDD 3.4.8)
- Risk-tier gating: autonomous promotion ONLY for `risk_tier: low` agents; medium requires human; high/critical always require human (TDD OQ-10)
- Dynamic agent creation pipeline: domain gap -> research -> archetype selection -> template selection -> generation -> validation -> meta-review -> human approval queue (TDD 3.7)
- Domain gap queuing and prioritization (FIFO with manual override) (TDD 3.7.1)
- Agent creation rate limiting: 1 new agent per calendar week (TDD 3.7.3)
- Proposed agent staging at `data/proposed-agents/` (TDD 3.7.2)
- `agent accept` / `agent reject` for proposed new agents (TDD 3.7.2 Step 8)
- Agent compatibility tracking: version compatibility matrix at `data/agent-compatibility.json` (TDD Appendix A)
- Pipeline-level re-validation on agent change (TDD 10.3)
- Agent state transitions: VALIDATING -> CANARY -> PROMOTED/REJECTED (TDD 2.2)
- Configuration: canary settings, autonomous promotion settings from `config/agent-factory.yaml` (Appendix B)
- CLI: `agent gaps --reprioritize` (TDD OQ-12)

### Out of Scope

- Cross-installation agent sharing or federation (TDD 1.2)
- Multi-reviewer panel scoring (deferred per TDD 9.2, may revisit in Phase 3)
- Agent consolidation (`agent consolidate` for overlapping agents -- mentioned in TDD OQ-09, not fully specified)

## Tasks

1. **Canary state manager** -- Track and manage canary periods for agents under extended validation.
   - Files to create: `src/agent-factory/canary/state-manager.ts`
   - Acceptance criteria: Creates canary state records with: agent_name, current_version, proposed_version, canary_started_at, canary_ends_at (default 7 days), comparisons array, auto_rollback_triggered flag. Persists state to `data/canary-state.json`. Supports querying active canaries. Duration configurable via `agent-factory.yaml`.
   - Estimated effort: 4 hours

2. **Canary shadow runner** -- Execute proposed agent in shadow mode alongside current agent on every new invocation.
   - Files to create: `src/agent-factory/canary/shadow-runner.ts`
   - Acceptance criteria: When a canary is active for an agent, every new invocation runs both current and proposed versions. The orchestrator uses the current agent's output for the pipeline (zero production impact). The proposed agent runs in shadow mode with output discarded from the pipeline. Both outputs are scored by the appropriate reviewer agent. Comparison results appended to canary state. Shadow invocations tagged with environment "canary" in metrics.
   - Estimated effort: 10 hours

3. **Canary exit evaluator** -- Determine when a canary period should end and with what outcome.
   - Files to create: `src/agent-factory/canary/exit-evaluator.ts`
   - Acceptance criteria: Evaluates after each comparison and at canary_ends_at: PROMOTE if proposed wins 60%+ of comparisons and canary period complete. REJECT if proposed loses 40%+ of comparisons. REJECT IMMEDIATELY if any single comparison shows proposed scoring > 1.5 points lower than current (catastrophic regression guard). WAIT if minimum 3 comparisons not yet reached. Auto-rollback if quality decline detected. Logs evaluation rationale.
   - Estimated effort: 6 hours

4. **Canary auto-termination** -- Automatically terminate a canary on catastrophic regression without waiting for the full period.
   - Files to modify: `src/agent-factory/canary/exit-evaluator.ts`, `src/agent-factory/canary/state-manager.ts`
   - Acceptance criteria: If a single comparison shows proposed scoring > 1.5 points lower than current: immediately terminate canary, reject proposal, set auto_rollback_triggered to true, log critical event to audit log, send notification to operator. No need to wait for minimum comparisons for catastrophic regression.
   - Estimated effort: 3 hours

5. **Autonomous patch-level promoter** -- Auto-promote validated patch-level changes with guardrails.
   - Files to create: `src/agent-factory/promotion/auto-promoter.ts`
   - Acceptance criteria: Applies ONLY when: `autonomous-promotion: enabled` in config, proposed_version is a patch increment (x.y.Z), agent has `risk_tier: low`, and canary results are positive. Auto-promotes with commit message: `fix(agents): auto-promote <name> v<old> -> v<new> -- <rationale>`. Sends notification to operator with diff and comparison results. Minor and major version changes always require human approval regardless of config.
   - Estimated effort: 6 hours

6. **Operator override window** -- Provide 24-hour window for operator to override autonomous promotions.
   - Files to create: `src/agent-factory/promotion/override-window.ts`
   - Acceptance criteria: After autonomous promotion, a 24-hour override window opens. During this window, the operator can run `agent rollback <name>` to undo the promotion. Window tracked in promotion metadata. Override window expiry logged. If rollback occurs during window: treated as a normal rollback with additional metadata indicating override.
   - Estimated effort: 4 hours

7. **Post-promotion auto-rollback** -- Automatically rollback if quality decline detected within 48 hours of auto-promotion.
   - Files to create: `src/agent-factory/promotion/auto-rollback.ts`
   - Acceptance criteria: After autonomous promotion, monitor the agent's invocation metrics for 48 hours. If quality decline detected (approval rate drops or average quality score drops by > 0.5 from pre-promotion baseline): auto-rollback to previous version, log auto-rollback event to audit log with decline evidence, disable autonomous promotion for this agent for 30 days (cooldown), send critical notification to operator. Decline detection uses the same anomaly detection rules from PLAN-005-2.
   - Estimated effort: 8 hours

8. **Risk-tier gating for autonomous promotion** -- Enforce that only low-risk agents are eligible for autonomous promotion.
   - Files to modify: `src/agent-factory/promotion/auto-promoter.ts`
   - Acceptance criteria: `risk_tier: low` -> eligible for autonomous patch promotion. `risk_tier: medium` -> always requires human approval. `risk_tier: high` -> always requires human approval. `risk_tier: critical` -> always requires human approval. Risk tier checked before any autonomous promotion decision. Agents without explicit risk_tier derive it from role per TDD 3.1.1.
   - Estimated effort: 2 hours

9. **Dynamic agent creation: domain gap pipeline** -- Full creation pipeline from gap detection through human review queue.
   - Files to create: `src/agent-factory/creation/pipeline.ts`
   - Acceptance criteria: Implements all 8 steps from TDD 3.7.2: (1) Research domain via WebSearch (5-minute time-box), (2) select archetype from task type, (3) select highest-quality existing agent in same archetype as template, (4) generate complete `.md` file with frontmatter and system prompt, (5) validate schema, (6) submit to meta-reviewer with overlap check, (7) write proposed agent to `data/proposed-agents/<name>.md`, (8) notify operator. Tools MUST match archetype allowlist. Version 1.0.0. Creation rate limited to 1 per calendar week.
   - Estimated effort: 12 hours

10. **Domain gap queue manager** -- Manage the queue of detected domain gaps with prioritization.
    - Files to create: `src/agent-factory/creation/gap-queue.ts`
    - Acceptance criteria: Reads and writes `data/domain-gaps.jsonl`. Supports FIFO ordering with manual override via `agent gaps --reprioritize`. Status tracking: detected -> proposed -> accepted/rejected or deferred (rate-limited). When rate limit reached, new gaps queued as "deferred" and processed in subsequent calendar weeks.
    - Estimated effort: 4 hours

11. **`agent accept` / `agent reject` for proposed agents** -- Human approval workflow for dynamically created agents.
    - Files to create: `src/agent-factory/creation/approval.ts`
    - Files to modify: `src/agent-factory/cli.ts`
    - Acceptance criteria: `agent accept <name>`: moves file from `data/proposed-agents/` to `agents/`, commits with `feat(agents): create <name> v1.0.0 -- <rationale>`, reloads registry, updates domain-gaps.jsonl status to "accepted". `agent reject <name> --reason "<reason>"`: updates domain-gaps.jsonl status to "rejected", deletes file from `data/proposed-agents/`, logs reason to audit log.
    - Estimated effort: 4 hours

12. **Agent compatibility tracking** -- Track which agent versions are known to work together in pipeline compositions.
    - Files to create: `src/agent-factory/compatibility/tracker.ts`
    - Acceptance criteria: Maintains `data/agent-compatibility.json` mapping pipeline compositions to agent version sets that produced successful (approved) pipeline runs. When an agent version changes, identifies pipeline compositions that included the old version and flags them for re-validation. Compatibility is informational (warning), not blocking.
    - Estimated effort: 6 hours

13. **Pipeline-level re-validation on agent change** -- Trigger end-to-end re-validation when an agent version changes.
    - Files to create: `src/agent-factory/compatibility/revalidator.ts`
    - Acceptance criteria: After any agent promotion (human or autonomous), identifies pipeline compositions that use the promoted agent. For each affected composition, schedules a re-validation run using a recent historical input. Results compared against pre-promotion baseline. Quality decline triggers a warning to the operator. Does not auto-rollback based on pipeline-level results (informational only).
    - Estimated effort: 8 hours

14. **Agent state transitions: CANARY state** -- Extend the registry to support the CANARY state and its transitions.
    - Files to modify: `src/agent-factory/registry.ts`
    - Acceptance criteria: VALIDATING -> CANARY (A/B positive, Phase 3 enabled). CANARY -> PROMOTED (canary positive + human/auto approval). CANARY -> REJECTED (canary negative or catastrophic regression). All transitions logged to audit log. Phase 3 gate check: canary state only reachable if Phase 3 is enabled in config. If Phase 3 disabled, VALIDATING -> PROMOTED (with human approval, per Phase 1-2 behavior).
    - Estimated effort: 4 hours

15. **Configuration: Phase 3 settings** -- Extend `agent-factory.yaml` with canary and autonomous promotion settings.
    - Files to modify: `config/agent-factory.yaml`, `src/agent-factory/config.ts`
    - Acceptance criteria: Canary settings: duration-days (7), win-threshold (0.60), catastrophic-regression (1.5), min-comparisons (3). Autonomous promotion settings: enabled/disabled toggle, override-hours (24), auto-rollback-hours (48), cooldown-days (30). All configurable with defaults from Appendix B. Phase 3 activation gated by `autonomous-promotion: enabled`.
    - Estimated effort: 3 hours

## Dependencies & Integration Points

- **PLAN-005-4 (A/B Validation & Promotion)**: The canary phase extends the A/B-validated promotion pipeline. Proposals that pass A/B validation proceed to canary (if Phase 3 enabled) instead of directly to human approval.
- **PLAN-005-3 (Improvement Lifecycle)**: Proposals and meta-review results feed into this plan. Domain gap "propose_specialist" recommendations trigger the dynamic creation pipeline.
- **PLAN-005-2 (Metrics & Observation)**: Post-promotion monitoring uses the same anomaly detection rules for auto-rollback decisions. Canary metrics are recorded via the MetricsEngine.
- **PLAN-005-1 (Agent Registry Foundation)**: Registry state machine is extended with CANARY state. Agent Runtime invokes shadow runs for canary.
- **TDD-004 (Orchestrator)**: Pipeline-level re-validation interacts with the orchestrator's pipeline composition model.

## Testing Strategy

**Unit tests:**
- Canary exit evaluator: verify 60%+ win threshold; verify 40%+ loss rejection; verify catastrophic regression guard (1.5 point drop); verify minimum 3 comparisons enforced.
- Risk-tier gating: verify low -> eligible; verify medium/high/critical -> ineligible for autonomous; verify derived risk tier from role.
- Override window: verify 24-hour window tracking; verify rollback during window; verify window expiry.
- Auto-rollback: verify quality decline triggers rollback; verify 30-day cooldown; verify notification sent.
- Gap queue: verify FIFO ordering; verify rate limit enforcement; verify reprioritization.

**Integration tests:**
- Full canary cycle: proposal passes A/B -> canary initiated -> shadow runs for 3+ comparisons -> canary exit evaluates positive -> promotion.
- Catastrophic regression: during canary, inject a comparison where proposed scores 2.0 points lower -> verify immediate termination and rejection.
- Autonomous promotion: low-risk agent patch change -> canary positive -> auto-promote -> verify commit message -> verify notification -> verify override window opened.
- Auto-rollback: auto-promote -> inject quality decline (approval rate drop) within 48 hours -> verify auto-rollback -> verify 30-day cooldown applied.
- Dynamic creation: submit task in unrecognized domain -> verify gap detection -> verify creation pipeline (research, archetype, template, generate, validate, meta-review) -> verify file in `data/proposed-agents/` -> verify human notification.
- Agent accept/reject: `agent accept` moves file to `agents/`, commits, reloads; `agent reject` deletes file, logs reason.

**End-to-end tests (from TDD 8.5):**
- Full improvement lifecycle: seed 15 invocations with known weakness -> observe analysis trigger -> verify proposal -> verify meta-review -> verify A/B validation -> canary (if Phase 3) -> promote -> verify new version active.
- Domain gap to agent creation: submit task in unrecognized domain -> verify gap detection -> verify creation pipeline -> verify human review queue.

**Security tests:**
- Autonomous promotion risk-tier bypass: attempt to auto-promote a high-risk agent -> verify rejection.
- Rate limit: attempt to create 2 agents in the same calendar week -> verify second is deferred.
- Dynamic creation tool escalation: verify generated agent's tools exactly match archetype allowlist.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Autonomous promotion introduces subtle quality degradation | Medium | High | Auto-rollback within 48 hours; 30-day cooldown; risk-tier gating to low-risk only; patch-level only |
| Canary shadow mode doubles token costs during canary period | High | Medium | Canary duration configurable; only active for agents with validated proposals; budget monitoring |
| Dynamic agent creation produces low-quality agents | Medium | Medium | Schema validation, meta-review with overlap check, and human approval are all required before any created agent enters `agents/` |
| Catastrophic regression guard has false negatives (gradual decline) | Low | High | 60%/40% win/loss thresholds catch gradual decline; post-promotion monitoring via anomaly detection rules covers residual risk |
| Pipeline re-validation is expensive and slow | Medium | Medium | Informational only (no auto-rollback on pipeline results); scheduled async; limited to recent historical input |
| Phase 3 gate bypass | Low | Critical | Hard-coded config check; autonomous promotion config default is "disabled"; logged to audit on every autonomous action |

## Definition of Done

- [ ] Canary phase runs in shadow mode with zero production impact
- [ ] Canary exit criteria enforced: 60%+ win, catastrophic regression guard (1.5 drop), minimum 3 comparisons
- [ ] Auto-termination on catastrophic regression works with immediate rejection
- [ ] Autonomous promotion works for low-risk patch-level changes only
- [ ] 24-hour operator override window functional after autonomous promotion
- [ ] 48-hour auto-rollback triggers on quality decline with 30-day cooldown
- [ ] Risk-tier gating prevents autonomous promotion of medium/high/critical agents
- [ ] Dynamic agent creation pipeline produces valid agent definitions from domain gaps
- [ ] Created agents staged at `data/proposed-agents/` requiring human approval
- [ ] Agent creation rate limited to 1 per calendar week
- [ ] `agent accept` / `agent reject` move or remove proposed agents correctly
- [ ] Agent compatibility tracking identifies affected pipeline compositions on version change
- [ ] Pipeline-level re-validation triggers after agent promotion (informational warnings)
- [ ] CANARY state transitions enforced with Phase 3 gate check
- [ ] Phase 3 configuration settings loadable and defaulted correctly
- [ ] All unit, integration, end-to-end, and security tests pass
- [ ] Phase 3 exit criteria achievable: 10+ autonomous patch promotions, zero regressions, auto-rollback tested, operator override tested
