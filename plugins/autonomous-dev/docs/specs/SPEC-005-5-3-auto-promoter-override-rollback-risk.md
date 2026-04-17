# SPEC-005-5-3: Autonomous Promoter, Override Window, Auto-Rollback, and Risk-Tier Gating

## Metadata
- **Parent Plan**: PLAN-005-5
- **Tasks Covered**: Task 5 (Autonomous patch-level promoter), Task 6 (Operator override window), Task 7 (Post-promotion auto-rollback), Task 8 (Risk-tier gating)
- **Estimated effort**: 20 hours

## Description

Implement the autonomous promotion system that auto-promotes validated patch-level changes for low-risk agents, the 24-hour operator override window, the 48-hour post-promotion quality monitoring with auto-rollback, and the risk-tier gating that restricts which agents are eligible for autonomous promotion. These components form the guardrailed autonomy layer of Phase 3.

## Files to Create/Modify

### New Files

**`src/agent-factory/promotion/auto-promoter.ts`**
- Exports: `AutoPromoter` class with `attemptAutoPromote(agentName: string, proposal: AgentProposal): AutoPromoteResult`

**`src/agent-factory/promotion/override-window.ts`**
- Exports: `OverrideWindowManager` class tracking post-promotion override periods

**`src/agent-factory/promotion/auto-rollback.ts`**
- Exports: `AutoRollbackMonitor` class with quality decline detection and auto-rollback

### Modified Files

**`src/agent-factory/promotion/auto-promoter.ts`** (risk-tier gating integrated)

## Implementation Details

### Risk-Tier Gating

Every autonomous promotion decision starts with risk-tier validation.

**Risk tier derivation from role (when `risk_tier` not explicitly set):**

| Agent Role | Default Risk Tier |
|------------|-------------------|
| `author` | `low` |
| `executor` | `medium` |
| `reviewer` | `low` |
| `meta` | `high` |

**Autonomous promotion eligibility:**

| Risk Tier | Autonomous Eligible? | Approval Required |
|-----------|---------------------|-------------------|
| `low` | Yes (patch only) | None for patch; human for minor/major |
| `medium` | No | Human always |
| `high` | No | Human always |
| `critical` | No | Human always |

```typescript
function isEligibleForAutoPromotion(agent: ParsedAgent, proposal: AgentProposal, config: AgentFactoryConfig): EligibilityResult {
  // Gate 1: Config must enable autonomous promotion
  if (!config.autonomousPromotion?.enabled) {
    return { eligible: false, reason: 'Autonomous promotion is disabled in config' };
  }

  // Gate 2: Must be patch-level change
  if (proposal.version_bump !== 'patch') {
    return { eligible: false, reason: `Version bump '${proposal.version_bump}' requires human approval (only patch is auto-eligible)` };
  }

  // Gate 3: Risk tier must be low
  const riskTier = agent.risk_tier || deriveRiskTier(agent.role);
  if (riskTier !== 'low') {
    return { eligible: false, reason: `Risk tier '${riskTier}' requires human approval` };
  }

  return { eligible: true };
}

interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}
```

### Autonomous Patch-Level Promoter (`promotion/auto-promoter.ts`)

```typescript
interface AutoPromoteResult {
  promoted: boolean;
  agentName: string;
  previousVersion: string;
  newVersion: string;
  commitHash?: string;
  overrideWindowExpiresAt?: string;
  reason?: string;                   // if not promoted
}

class AutoPromoter {
  constructor(
    private promoter: Promoter,       // reuses promotion infrastructure
    private overrideManager: OverrideWindowManager,
    private autoRollbackMonitor: AutoRollbackMonitor,
    private registry: IAgentRegistry,
    private config: AgentFactoryConfig,
    private auditLogger: AuditLogger,
    private notificationService: NotificationService
  ) {}

  async attemptAutoPromote(agentName: string, proposal: AgentProposal): Promise<AutoPromoteResult> {
    // 1. Eligibility check
    const agent = this.registry.get(agentName);
    const eligibility = isEligibleForAutoPromotion(agent.agent, proposal, this.config);
    if (!eligibility.eligible) {
      this.auditLogger.log({
        event_type: 'auto_promotion_ineligible',
        agent_name: agentName,
        details: { reason: eligibility.reason }
      });
      return { promoted: false, reason: eligibility.reason, ... };
    }

    // 2. Auto-promote using existing promotion infrastructure
    const commitMessage = `fix(agents): auto-promote ${agentName} v${proposal.current_version} -> v${proposal.proposed_version} -- ${proposal.rationale}`;
    const result = await this.promoter.promoteWithMessage(agentName, proposal.proposal_id, commitMessage);

    if (!result.success) {
      return { promoted: false, reason: result.error, ... };
    }

    // 3. Open override window
    this.overrideManager.openWindow(agentName, proposal.proposed_version, result.commitHash);

    // 4. Start auto-rollback monitoring
    this.autoRollbackMonitor.startMonitoring(agentName, proposal);

    // 5. Notify operator
    this.notificationService.send({
      severity: 'info',
      message: `Auto-promoted ${agentName} v${proposal.current_version} -> v${proposal.proposed_version}. Override window open until ${overrideExpiry}.`,
      details: { diff: proposal.diff, comparisons: proposal.canaryComparisons }
    });

    // 6. Log
    this.auditLogger.log({
      event_type: 'agent_auto_promoted',
      agent_name: agentName,
      details: { ... }
    });

    return { promoted: true, commitHash: result.commitHash, overrideWindowExpiresAt: overrideExpiry, ... };
  }
}
```

### Override Window Manager (`promotion/override-window.ts`)

```typescript
interface OverrideWindow {
  agent_name: string;
  version: string;
  commit_hash: string;
  opened_at: string;              // ISO 8601
  expires_at: string;             // ISO 8601 (opened_at + override_hours)
  status: 'open' | 'expired' | 'used';
}

class OverrideWindowManager {
  constructor(
    private config: AgentFactoryConfig,  // config.autonomousPromotion.overrideHours (default 24)
    private auditLogger: AuditLogger
  ) {}

  openWindow(agentName: string, version: string, commitHash: string): OverrideWindow;
  getActiveWindow(agentName: string): OverrideWindow | null;
  isWindowOpen(agentName: string): boolean;
  closeWindow(agentName: string, reason: 'expired' | 'used'): void;
  checkExpiry(): void;  // called periodically, closes expired windows
}
```

**Persistence:** `data/override-windows.json`

**Behavior:**
- Window opens immediately after autonomous promotion.
- Duration: configurable, default 24 hours.
- During the window, operator can run `agent rollback <name>` to undo the promotion.
- If rollback occurs during window: window status set to `used`, rollback proceeds normally with additional metadata `override_rollback: true`.
- When window expires: log `override_window_expired` event. No action taken (promotion stands).

### Auto-Rollback Monitor (`promotion/auto-rollback.ts`)

```typescript
interface MonitoringState {
  agent_name: string;
  promoted_version: string;
  previous_version: string;
  monitoring_started_at: string;
  monitoring_ends_at: string;     // started_at + 48 hours
  pre_promotion_baseline: QualityBaseline;
  rollback_triggered: boolean;
  cooldown_until?: string;        // set if rollback occurs
}

interface QualityBaseline {
  approval_rate: number;
  avg_quality_score: number;
  sample_size: number;
}

class AutoRollbackMonitor {
  constructor(
    private metricsEngine: IMetricsEngine,
    private rollbackManager: RollbackManager,
    private config: AgentFactoryConfig,
    private auditLogger: AuditLogger,
    private notificationService: NotificationService
  ) {}

  startMonitoring(agentName: string, proposal: AgentProposal): void;
  checkForDecline(agentName: string): DeclineResult;
  isInCooldown(agentName: string): boolean;
}

interface DeclineResult {
  declined: boolean;
  reason?: string;
  evidence?: DeclineEvidence;
}

interface DeclineEvidence {
  pre_approval_rate: number;
  post_approval_rate: number;
  pre_avg_quality: number;
  post_avg_quality: number;
  quality_delta: number;
}
```

**Monitoring logic:**

After autonomous promotion, monitor for 48 hours (configurable via `config.autonomousPromotion.autoRollbackHours`).

**`checkForDecline()` (called after each invocation metric for the agent):**

1. Compute post-promotion metrics from invocations since promotion.
2. Compare against `pre_promotion_baseline`:
   - Approval rate drop: `post_approval_rate < pre_approval_rate - 0.1` (10% drop).
   - Quality score drop: `post_avg_quality < pre_avg_quality - 0.5`.
3. Require minimum 3 post-promotion invocations before evaluating (avoid false positives).
4. If decline detected:
   - Auto-rollback to previous version.
   - Set `cooldown_until = now + 30 days` (configurable via `config.autonomousPromotion.cooldownDays`).
   - During cooldown: autonomous promotion disabled for this agent.
   - Log `auto_rollback_quality_decline` event.
   - Send critical notification.

**Cooldown enforcement:**
```typescript
isInCooldown(agentName: string): boolean {
  const state = this.getState(agentName);
  if (!state?.cooldown_until) return false;
  return new Date(state.cooldown_until) > new Date();
}
```

Cooldown is checked during `isEligibleForAutoPromotion()`:
```typescript
if (autoRollbackMonitor.isInCooldown(agentName)) {
  return { eligible: false, reason: `Agent in cooldown until ${cooldownUntil} (previous auto-rollback)` };
}
```

**Persistence:** `data/auto-rollback-state.json`

## Acceptance Criteria

1. Autonomous promotion only applies when `autonomous-promotion: enabled` in config.
2. Only patch-level version bumps eligible for auto-promotion.
3. Only `risk_tier: low` agents eligible (explicit or derived from role).
4. Medium/high/critical risk agents always require human approval.
5. Commit message uses `fix(agents): auto-promote ...` format.
6. Operator notified after auto-promotion with diff and comparison results.
7. 24-hour override window opens after auto-promotion.
8. Rollback during override window closes window with `used` status.
9. Expired override window logged.
10. Post-promotion monitoring runs for 48 hours.
11. Quality decline (approval rate or quality score drop) triggers auto-rollback.
12. Auto-rollback applies 30-day cooldown to the agent.
13. During cooldown, autonomous promotion disabled for that agent.
14. Minimum 3 post-promotion invocations required before decline evaluation.

## Test Cases

### Risk-Tier Gating Tests

```
test_low_risk_patch_eligible
  Input: risk_tier="low", version_bump="patch", config enabled
  Expected: eligible=true

test_low_risk_minor_not_eligible
  Input: risk_tier="low", version_bump="minor"
  Expected: eligible=false, reason="only patch is auto-eligible"

test_medium_risk_not_eligible
  Input: risk_tier="medium", version_bump="patch"
  Expected: eligible=false

test_high_risk_not_eligible
  Input: risk_tier="high"
  Expected: eligible=false

test_critical_risk_not_eligible
  Input: risk_tier="critical"
  Expected: eligible=false

test_config_disabled_not_eligible
  Input: config.autonomousPromotion.enabled = false
  Expected: eligible=false

test_derive_risk_from_author_role
  Input: role="author", no explicit risk_tier
  Expected: derived risk_tier="low"

test_derive_risk_from_executor_role
  Input: role="executor", no explicit risk_tier
  Expected: derived risk_tier="medium" -> not eligible

test_derive_risk_from_meta_role
  Input: role="meta", no explicit risk_tier
  Expected: derived risk_tier="high" -> not eligible

test_cooldown_prevents_eligibility
  Setup: agent in 30-day cooldown
  Expected: eligible=false, reason mentions cooldown
```

### Auto-Promoter Tests

```
test_auto_promote_success
  Setup: eligible agent, positive canary
  Expected: promoted=true, commitHash set, override window opened

test_auto_promote_commit_message
  Expected: starts with "fix(agents): auto-promote"

test_auto_promote_notification
  Expected: operator notified with diff and comparison data

test_auto_promote_starts_monitoring
  Expected: auto-rollback monitoring started for 48 hours

test_auto_promote_audit_log
  Expected: agent_auto_promoted event logged
```

### Override Window Tests

```
test_window_opens_after_promotion
  Action: auto-promote
  Expected: window open with 24-hour expiry

test_window_duration_configurable
  Setup: config.overrideHours = 12
  Expected: window expires 12 hours after opening

test_rollback_during_window
  Setup: window open
  Action: agent rollback
  Expected: rollback succeeds, window status="used"

test_window_expiry
  Setup: window opened 25 hours ago
  Action: checkExpiry()
  Expected: window status="expired", event logged

test_is_window_open
  Setup: window opened 10 hours ago, duration 24 hours
  Expected: isWindowOpen() returns true

test_is_window_closed
  Setup: window opened 25 hours ago, duration 24 hours
  Expected: isWindowOpen() returns false
```

### Auto-Rollback Monitor Tests

```
test_no_decline_detected
  Setup: baseline approval_rate=0.85, post-promotion rate=0.82
  Expected: declined=false (0.03 < 0.1 threshold)

test_approval_rate_decline_triggers_rollback
  Setup: baseline approval_rate=0.85, post-promotion rate=0.70
  Expected: declined=true, auto-rollback triggered

test_quality_score_decline_triggers_rollback
  Setup: baseline avg_quality=4.0, post-promotion avg=3.3
  Expected: declined=true (delta > 0.5)

test_minimum_3_invocations_required
  Setup: only 2 post-promotion invocations
  Expected: decline check deferred (not evaluated)

test_cooldown_applied_after_rollback
  Action: auto-rollback triggers
  Expected: cooldown_until set to now + 30 days

test_cooldown_duration_configurable
  Setup: config.cooldownDays = 14
  Expected: cooldown for 14 days

test_monitoring_ends_after_48_hours
  Setup: monitoring started 50 hours ago
  Expected: checkForDecline does nothing (monitoring period over)

test_monitoring_duration_configurable
  Setup: config.autoRollbackHours = 72
  Expected: monitoring continues for 72 hours

test_auto_rollback_audit_event
  Action: auto-rollback triggers
  Expected: auto_rollback_quality_decline event logged

test_auto_rollback_notification
  Action: auto-rollback triggers
  Expected: critical notification sent with evidence

test_rollback_uses_rollback_manager
  Action: auto-rollback triggers
  Expected: RollbackManager.rollback called with force=true
```
