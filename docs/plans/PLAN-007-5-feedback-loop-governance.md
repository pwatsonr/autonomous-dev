# PLAN-007-5: Feedback Loop Governance

## Metadata
- **Parent TDD**: TDD-007-production-intelligence
- **Estimated effort**: 9 days
- **Dependencies**: [PLAN-007-1, PLAN-007-2, PLAN-007-3, PLAN-007-4]
- **Blocked by**: [PLAN-007-4] (requires triage decisions and deployed fixes to measure against)
- **Priority**: P1

## Objective

Close the production intelligence loop by implementing governance controls that prevent runaway observation generation, measure whether fixes actually work, and surface systemic patterns. This plan covers cooldown enforcement, oscillation detection, effectiveness tracking, the weekly digest report, and Phase 3 capabilities (notification-based triage, auto-promotion with human override). These components transform the system from a one-way detector into a true feedback loop.

## Scope

### In Scope
- Cooldown enforcement: suppress triage for a service+error class combination while a fix is deployed and being evaluated (section 3.11.1)
- Oscillation detection: flag recurring observations that suggest incremental fixes are not working (section 3.11.2)
- Effectiveness tracking: compare pre-fix and post-fix metrics to measure fix impact (section 3.11.3)
- Effectiveness result writeback to observation reports (section 3.11.3)
- Weekly digest report generation (Appendix A)
- Notification-based triage via Slack/Discord webhooks (Phase 3, section 3.10.3)
- Auto-promotion engine for high-confidence P0/P1 observations with human override window (Phase 3, section 3.12.3)
- Integration of governance checks into the runner lifecycle (section 3.2.2 step 3e)
- End-to-end loop testing: observation -> promote -> PRD -> deploy -> effectiveness verified (section 8.4)
- Sentry MCP integration for enriched error reports (Phase 3, section 3.1.2)

### Out of Scope
- MCP data collection infrastructure (PLAN-007-1)
- PII/secret scrubbing (PLAN-007-2)
- Error detection, analytics, deduplication, scoring (PLAN-007-3)
- Report file format and basic triage processing (PLAN-007-4)
- Event-driven webhook-triggered observation runs (future Phase 3+)
- Adaptive scheduling (OQ-6, deferred to Phase 2)
- Cross-service cascade detection (OQ-1, partially addressed by weekly digest)

## Tasks

1. **Implement cooldown enforcement** -- Build the cooldown checker that suppresses triage queue entry for a service+error class combination while a recent fix deployment is within the cooldown window.
   - Files to create/modify: `src/governance/cooldown.ts`
   - Acceptance criteria: `check_cooldown(service, error_class, config)` function returns active/inactive status with reason and linked deployment ID. Cooldown period is `config.governance.cooldown_days` days from the deployment date. During cooldown, observations are still generated (for audit) but flagged with `cooldown_active: true` and `triage_status: cooldown`. Cooldown observations are excluded from the triage queue. When cooldown expires, the observation becomes eligible for effectiveness evaluation (task 3).
   - Estimated effort: 4 hours

2. **Implement oscillation detection** -- Build the oscillation detector that flags service+error class combinations generating too many observations within a rolling window.
   - Files to create/modify: `src/governance/oscillation.ts`
   - Acceptance criteria: `check_oscillation(service, error_class, config)` function counts observations within the `oscillation_window_days` window. If count >= `oscillation_threshold`, returns oscillating=true with count, window, observation IDs, and recommendation "systemic_investigation". Oscillation warning is written into the observation report Markdown body per TDD section 3.11.2 (includes list of previous observations and recommendation for architectural investigation PRD). The `oscillation_warning` boolean is set in YAML frontmatter.
   - Estimated effort: 4 hours

3. **Implement effectiveness tracking** -- Build the effectiveness evaluator that compares pre-fix and post-fix metric averages after a cooldown period expires.
   - Files to create/modify: `src/governance/effectiveness.ts`
   - Acceptance criteria: `evaluate_effectiveness(observation, config)` retrieves the linked deployment. Computes pre-fix window `[deploy_date - comparison_days, deploy_date]` and post-fix window `[deploy_date + cooldown_days, deploy_date + cooldown_days + comparison_days]`. Queries Prometheus for the target metric average in both windows. Computes improvement percentage accounting for metric direction (error rate/latency: decrease is improvement; throughput: increase is improvement). Returns `improved` (>= threshold), `degraded` (<= -threshold), `unchanged`, or `pending`. Default improvement threshold from `config.governance.effectiveness_improvement_threshold`.
   - Estimated effort: 6 hours

4. **Implement effectiveness writeback** -- Write the effectiveness result and detail back into the observation report YAML frontmatter.
   - Files to create/modify: `src/governance/effectiveness.ts`, report update logic
   - Acceptance criteria: Updates the observation file with `effectiveness` field (improved|unchanged|degraded|pending) and `effectiveness_detail` block (pre_fix_avg, post_fix_avg, improvement_pct, measured_window). File is updated in-place, preserving all other frontmatter and Markdown content. Writeback only occurs once per observation; subsequent runs skip already-evaluated observations.
   - Estimated effort: 3 hours

5. **Integrate governance checks into the runner lifecycle** -- Wire cooldown, oscillation, and effectiveness evaluation into step 3e of the runner lifecycle (section 3.2.2).
   - Files to create/modify: Observation runner module (from PLAN-007-1)
   - Acceptance criteria: After deduplication (step 3d) and before report generation (step 3f), the runner checks cooldown status and oscillation history for each candidate observation. Cooldown-active observations are flagged accordingly. Oscillation warnings are appended. At the start of each run (step 2), effectiveness evaluation runs for observations whose cooldown has expired and whose effectiveness is still `pending`. Governance check results are logged in the run audit log.
   - Estimated effort: 4 hours

6. **Implement weekly digest report generator** -- Build the digest that aggregates observations, triage decisions, effectiveness results, and recurring patterns across all services for the past week.
   - Files to create/modify: `src/reports/weekly-digest.ts`
   - Acceptance criteria: Digest follows the format from TDD Appendix A. Includes: summary table (total observations, by severity, by type, triage decisions, signal-to-noise ratio, average triage latency, average tokens per run), observations by service table, effectiveness tracking table, recurring patterns table, and recommendations section. Written to `.autonomous-dev/observations/digests/DIGEST-YYYYWNN.md`. Generated weekly (e.g., end of day Sunday) via the scheduled runner. Signal-to-noise ratio computed as `(promoted + investigating) / total`.
   - Estimated effort: 8 hours

7. **Implement notification-based triage (Phase 3)** -- Build the Slack/Discord webhook integration for posting observation summaries and receiving triage commands.
   - Files to create/modify: `src/triage/notification.ts`, webhook configuration in `intelligence.yaml`
   - Acceptance criteria: When configured with a webhook URL, the system posts a formatted observation summary for P0/P1 observations (or all, if configured). Summary includes severity, service, title, error rate, confidence, and recommended action. Reply commands (`/promote`, `/dismiss`, `/defer`, `/investigate`) are documented. Decisions from the notification channel write back to the file-based system (file remains source of truth). Notification channel health is checked before posting; if unreachable, falls back to file-only triage. Emoji/formatting appropriate for Slack/Discord.
   - Estimated effort: 8 hours

8. **Implement auto-promotion engine (Phase 3)** -- Build the auto-promotion logic for high-confidence P0/P1 observations with a human override window.
   - Files to create/modify: `src/governance/auto-promote.ts`
   - Acceptance criteria: `evaluate_auto_promote(observation, config)` checks: (1) `auto_promote.enabled` is true in config, (2) severity is P0 or P1, (3) confidence >= 0.9, (4) cooldown is not active, (5) oscillation is not detected, (6) notification channel is reachable. If all conditions met: observation is auto-promoted (PRD generated), PM Lead is notified immediately, and an override window of `auto_promote.override_hours` (default 2h) begins. If PM Lead overrides within the window, the PRD is cancelled and observation returns to `pending`. Auto-promoted flag `auto_promoted: true` is set in triage audit log. Override check is scheduled and runs at the end of the override window.
   - Estimated effort: 8 hours

9. **Implement Sentry MCP integration (Phase 3)** -- Wire the Sentry MCP tools (`sentry_list_issues`, `sentry_get_issue_events`, `sentry_get_release_health`) into the data collection pipeline.
   - Files to create/modify: `src/adapters/sentry-adapter.ts`, observation runner Sentry integration
   - Acceptance criteria: `sentry_list_issues` retrieves error issues for a project. `sentry_get_issue_events` retrieves events and stack traces for a specific issue. `sentry_get_release_health` retrieves crash-free rate and adoption for a release. Sentry data is scrubbed through the safety pipeline before use. Sentry data enriches error observations with user counts, stack trace details, and release health metrics. Query budget for Sentry (10 queries, 30s timeout) is enforced.
   - Estimated effort: 6 hours

10. **Write unit and integration tests for governance and Phase 3** -- Test all governance components and Phase 3 features per TDD sections 8.1, 8.2, and 8.4.
    - Files to create/modify: Test files for all governance, digest, notification, auto-promote, and Sentry modules
    - Acceptance criteria: **Cooldown**: deploy 3 days ago with 7-day cooldown -> active=true. Deploy 8 days ago -> active=false. **Oscillation**: 3 observations in 25 days with threshold=3 -> oscillating=true. 2 observations -> false. **Effectiveness**: pre=12.3%, post=0.6% -> improved, 95.1%. Pre=5%, post=5.1% -> unchanged. Pre=0.5%, post=3% -> degraded. **Weekly digest**: aggregation math is correct (signal-to-noise, triage latency averages). **Auto-promote**: all six conditions tested individually (confidence too low, severity P2, cooldown active, etc.). Override within window cancels PRD. Override after window has no effect. **E2E test** (section 8.4): full loop from mock error injection -> observation -> promote -> PRD -> mock deploy -> effectiveness confirms improvement. **Oscillation loop test**: inject recurring error -> 3 observations -> oscillation warning on third. **Auto-promote E2E**: high-confidence P0 -> auto-promoted -> override within window -> PRD cancelled.
    - Estimated effort: 14 hours

## Dependencies & Integration Points
- **Upstream**: All previous plans must be complete. PLAN-007-4 provides observation files and triage processing. PLAN-007-3 provides fingerprints and baselines. PLAN-007-1 provides the runner lifecycle and MCP adapters.
- **Downstream**: Effectiveness results feed back into the next observation run (the feedback loop itself). Weekly digests are consumed by the PM Lead for strategic decisions.
- **External**: Deployment tracking requires integration with the deployment pipeline (TDD-003). Prometheus must retain enough historical data for pre-fix/post-fix comparison windows. Slack/Discord webhooks require external configuration.
- **Pipeline integration**: Auto-promoted PRDs enter the same autonomous development pipeline as manually promoted ones (TDD-001).

## Testing Strategy
- **Unit tests**: Each governance function tested with time-window arithmetic, boundary conditions, and edge cases. Cooldown with exact-day boundaries. Oscillation with threshold-1 and threshold observations. Effectiveness with zero-change, small improvement, and large improvement scenarios.
- **Integration tests**: Governance checks integrated into the runner lifecycle and confirmed to flag/skip/evaluate correctly across multiple mock runs. Weekly digest generation with a week of mock observation data.
- **End-to-end tests**: Full feedback loop from error injection through effectiveness verification. Oscillation accumulation over multiple mock runs. Auto-promote with override.
- **Phase 3 tests**: Notification posting to a mock webhook endpoint. Auto-promote with simulated PM Lead override within and outside the window. Sentry adapter with mock responses.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Effectiveness measurement is confounded by unrelated changes (OQ-8) | High | Medium | Track traffic volume and infrastructure changes during measurement window. Add `confounders_detected` flag when significant external changes occur. Document limitation. |
| Auto-promotion generates a bad PRD that reaches production | Low | High | Six safeguards: opt-in only, P0/P1 only, confidence >= 0.9, no cooldown, no oscillation, notification channel reachable. 2-hour override window. Track auto-promote approval rate; disable if <90%. |
| PM Lead unavailable for triage causes observation backlog (OQ-9) | Medium | Medium | Escalation path: notify backup triager after 24h for P0/P1, 72h for P2/P3. Weekly digest surfaces pending observation count. |
| Notification channel integration is fragile (rate limits, outages) | Medium | Low | Health check before posting. Fallback to file-only triage. Auto-promote requires reachable channel (safeguard 6). |
| Sentry data volume is larger than expected, exceeding query budget | Low | Medium | Query budget is enforced (10 queries, 30s timeout). Sentry integration is Phase 3 and can be tuned based on Phase 1-2 experience. |
| Weekly digest signal-to-noise ratio calculation is misleading with small sample sizes | Medium | Low | Digest includes absolute counts alongside ratios. Minimum observation count before ratio is displayed (e.g., 5 observations). |

## Definition of Done
- [ ] Cooldown enforcement correctly suppresses triage for service+error class combinations within the cooldown window
- [ ] Cooldown observations are flagged but still generated for audit purposes
- [ ] Oscillation detection flags recurring patterns and recommends architectural investigation
- [ ] Oscillation warning appears in observation report Markdown with previous observation history
- [ ] Effectiveness tracker compares pre-fix and post-fix metrics via Prometheus and determines improved/unchanged/degraded
- [ ] Effectiveness results are written back to observation report YAML frontmatter
- [ ] Governance checks are integrated into the runner lifecycle at the correct step
- [ ] Weekly digest aggregates observations, triage, effectiveness, and patterns per Appendix A format
- [ ] Signal-to-noise ratio is computed correctly in the digest
- [ ] (Phase 3) Notification-based triage posts summaries and receives decisions via webhook
- [ ] (Phase 3) Auto-promotion fires only when all six safeguards pass
- [ ] (Phase 3) PM Lead override within the window cancels auto-promoted PRDs
- [ ] (Phase 3) Sentry adapter retrieves issues, events, and release health within query budget
- [ ] End-to-end feedback loop test passes: error -> observation -> promote -> PRD -> deploy -> effectiveness verified
- [ ] Oscillation accumulation test passes: 3+ observations in window -> oscillation warning
- [ ] All unit, integration, and end-to-end tests pass
