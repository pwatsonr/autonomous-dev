# SPEC-005-2-5: Rollback Mechanism, Remaining Foundation Agents, and Metrics CLI

## Metadata
- **Parent Plan**: PLAN-005-2
- **Tasks Covered**: Task 11 (Rollback mechanism), Task 12 (Remaining 7 foundation agents), Task 13 (CLI commands: metrics subset)
- **Estimated effort**: 22 hours

## Description

Implement the agent rollback mechanism that restores a previous version from git history with impact analysis and audit logging, create the remaining 7 foundation agent definitions, and build the metrics CLI commands (metrics, dashboard, rollback). This spec completes the metrics observation framework and brings the full set of 13 foundation agents online.

## Files to Create/Modify

### New Files

**`src/agent-factory/rollback.ts`**
- Exports: `RollbackManager` class with `rollback(agentName: string, opts?: RollbackOptions): RollbackResult`

**Agent definition files:**
- `agents/plan-author.md`
- `agents/spec-author.md`
- `agents/test-executor.md`
- `agents/deploy-executor.md`
- `agents/security-reviewer.md`
- `agents/architecture-reviewer.md`
- `agents/performance-analyst.md`

### Modified Files

**`src/agent-factory/cli.ts`** (extend with metrics commands)

## Implementation Details

### Rollback Mechanism (`rollback.ts`)

```typescript
interface RollbackOptions {
  force?: boolean;          // skip confirmation
  quarantine?: boolean;     // mark artifacts from rolled-back version
  targetVersion?: string;   // specific version to roll back to (default: previous)
}

interface RollbackResult {
  success: boolean;
  agentName: string;
  previousVersion: string;
  restoredVersion: string;
  commitHash: string;
  impactAnalysis: ImpactAnalysis;
  error?: string;
}

interface ImpactAnalysis {
  currentVersionInvocations: number;
  inFlightPipelineRuns: string[];
  diff: string;                     // unified diff current vs restored
  warningMessage: string | null;
}
```

**Rollback procedure:**

1. **Identify previous version:**
   - Parse the agent's `version_history` from the current definition.
   - If `targetVersion` specified, find that version in git history.
   - Otherwise, select the version immediately before the current version.
   - Use `git log --oneline -- agents/<name>.md` to find the relevant commit.

2. **Impact analysis:**
   - Count invocations for the current version: `metricsEngine.getInvocations(agentName, { sinceVersion: currentVersion })`.
   - Check for in-flight pipeline runs referencing this agent (query metrics for incomplete pipeline_run_ids).
   - Compute unified diff: `git diff <previous-commit> HEAD -- agents/<name>.md`.
   - If in-flight runs exist, set warning: "Agent is referenced in {N} in-flight pipeline runs".

3. **Confirmation gate:**
   - Unless `--force`, display impact analysis and prompt for confirmation.
   - Display: current version, target version, invocation count, in-flight warning, diff summary.

4. **Restore:**
   - Run `git show <previous-commit>:agents/<name>.md` to get the previous content.
   - Write content to `agents/<name>.md`.
   - Update `version_history` to append a rollback entry:
     ```yaml
     - version: "{restored_version}"
       date: "{today}"
       change: "Rollback from v{current} to v{restored}"
     ```
   - The `version` field is set to the restored version.

5. **Commit:**
   - Stage the file: `git add agents/<name>.md`.
   - Commit with message: `revert(agents): rollback <name> v<current> -> v<restored>`.

6. **Post-rollback:**
   - Reload the registry: `registry.reload()`.
   - Log to audit: `agent_rolled_back` event with both versions, commit hash, impact analysis.
   - Emit rollback metric event to metrics engine.
   - If `--quarantine`: mark all metrics from the rolled-back version with a quarantine flag.

### Remaining 7 Foundation Agent Definitions

Follow the same `.md` template structure from SPEC-005-1-4.

**Agent 7: `plan-author.md`**
- role: `author`, temperature: 0.6, turn_limit: 35
- tools: `[Read, Glob, Grep, WebSearch, WebFetch]`
- expertise: `[implementation-planning, task-decomposition, dependency-analysis, effort-estimation]`
- evaluation_rubric:
  - `decomposition-quality` (0.3) -- Tasks are right-sized and well-scoped
  - `dependency-accuracy` (0.25) -- Dependencies correctly identified
  - `completeness` (0.25) -- All work captured, nothing missing
  - `estimation-accuracy` (0.2) -- Effort estimates are realistic

**Agent 8: `spec-author.md`**
- role: `author`, temperature: 0.5, turn_limit: 40
- tools: `[Read, Glob, Grep, WebSearch, WebFetch]`
- expertise: `[implementation-specs, api-contracts, data-schemas, test-specifications]`
- evaluation_rubric:
  - `precision` (0.3) -- Specs are exact enough to implement without ambiguity
  - `completeness` (0.25) -- All interfaces, schemas, and edge cases specified
  - `testability` (0.25) -- Test cases are concrete and verifiable
  - `consistency` (0.2) -- Spec is consistent with the parent plan/TDD

**Agent 9: `test-executor.md`**
- role: `executor`, temperature: 0.2, turn_limit: 40
- tools: `[Read, Glob, Grep, Bash, Edit, Write, WebSearch, WebFetch]`
- expertise: `[testing, unit-tests, integration-tests, test-coverage, vitest, jest]`
- evaluation_rubric:
  - `coverage` (0.3) -- Tests cover all specified acceptance criteria
  - `correctness` (0.3) -- Tests actually verify the intended behavior
  - `isolation` (0.2) -- Tests are independent and do not leak state
  - `readability` (0.2) -- Tests are clear and serve as documentation

**Agent 10: `deploy-executor.md`**
- role: `executor`, temperature: 0.2, turn_limit: 30
- tools: `[Read, Glob, Grep, Bash, Edit, Write, WebSearch, WebFetch]`
- expertise: `[deployment, docker, ci-cd, infrastructure, configuration-management]`
- evaluation_rubric:
  - `safety` (0.35) -- Deployment steps are reversible and fail-safe
  - `completeness` (0.25) -- All deployment artifacts generated
  - `idempotency` (0.2) -- Deployment can be re-run without side effects
  - `documentation` (0.2) -- Deployment steps documented

**Agent 11: `security-reviewer.md`**
- role: `reviewer`, temperature: 0.1, turn_limit: 25
- tools: `[Read, Glob, Grep]`
- expertise: `[security, vulnerability-analysis, access-control, input-validation, secrets-management]`
- evaluation_rubric:
  - `vulnerability-detection` (0.35) -- Identifies real security issues
  - `severity-accuracy` (0.25) -- Severity ratings match actual risk
  - `actionability` (0.25) -- Recommendations are specific and implementable
  - `false-positive-rate` (0.15) -- Low rate of spurious findings

**Agent 12: `architecture-reviewer.md`**
- role: `reviewer`, temperature: 0.2, turn_limit: 25
- tools: `[Read, Glob, Grep]`
- expertise: `[architecture, system-design, scalability, maintainability, patterns]`
- evaluation_rubric:
  - `design-quality` (0.3) -- Identifies genuine architectural concerns
  - `pragmatism` (0.25) -- Recommendations balance ideal vs. practical
  - `completeness` (0.25) -- Reviews all significant design decisions
  - `clarity` (0.2) -- Feedback is clear and constructive

**Agent 13: `performance-analyst.md`**
- role: `meta`, temperature: 0.3, turn_limit: 20
- tools: `[Read, Glob, Grep]` (read-only)
- expertise: `[agent-performance, metrics-analysis, statistical-analysis, weakness-detection]`
- evaluation_rubric:
  - `diagnostic-accuracy` (0.35) -- Correctly identifies real weaknesses from metrics
  - `evidence-quality` (0.3) -- Findings backed by specific metric data
  - `actionability` (0.2) -- Recommendations lead to measurable improvements
  - `false-positive-rate` (0.15) -- Low rate of spurious weakness reports

### CLI Commands (metrics subset)

**`agent metrics <name>`**
```
Agent: code-executor (v1.2.0)
─────────────────────────────────
Invocations (30d):  47
Approval Rate:      83.0%
Avg Quality:        3.8 / 5.0
Median Quality:     4.0 / 5.0
Stddev Quality:     0.6
Avg Iterations:     1.2
Avg Wall Clock:     45.2s
Avg Turns:          12.3
Total Tokens:       1,240,000
Trend:              improving (slope: +0.08, R²: 0.45)

Domain Breakdown:
  typescript:   32 invocations, 87.5% approved, avg 4.0
  python:       15 invocations, 73.3% approved, avg 3.5

Active Alerts:
  [CRITICAL] ANOMALY_001: Approval rate in 'python' domain is 0.67
```

**`agent dashboard`**
```
AGENT FACTORY DASHBOARD
═══════════════════════════════════════════════════════════════
NAME                  VER    ROLE      RATE    QUAL   TREND
───────────────────────────────────────────────────────────────
quality-reviewer      1.0.0  reviewer  92.0%   4.2    ↑
doc-reviewer          1.0.0  reviewer  88.0%   4.0    →
prd-author            1.1.0  author    85.0%   3.9    ↑
code-executor         1.2.0  executor  83.0%   3.8    ↑
tdd-author            1.0.0  author    80.0%   3.7    →
test-executor         1.0.0  executor  78.0%   3.5    ↓
───────────────────────────────────────────────────────────────
Agents: 13 | Active Alerts: 2 (1 critical) | Last update: 12s ago
```

Trend indicators: `↑` (improving), `→` (stable), `↓` (declining)

Sorted by approval rate descending.

**`agent rollback <name>`**
- Invokes the RollbackManager.
- Displays impact analysis.
- Prompts for confirmation (unless `--force`).
- On success: displays commit hash and confirmation.

## Acceptance Criteria

1. Rollback identifies previous version from git history.
2. Impact analysis shows invocation count, in-flight runs, and diff.
3. Confirmation required unless `--force`.
4. File restored from git, version_history updated with rollback entry.
5. Committed with `revert(agents):` convention message.
6. Registry reloaded after rollback.
7. Audit log records the rollback event.
8. `--quarantine` flag marks artifacts from rolled-back version.
9. All 7 new foundation agents pass schema validation.
10. `performance-analyst` has role `meta` with read-only tools.
11. `agent metrics` displays aggregate metrics, trend, domain breakdown, and active alerts.
12. `agent dashboard` shows summary table sorted by approval rate with trend indicators.
13. `agent rollback` CLI triggers full rollback workflow.

## Test Cases

### Rollback Tests

```
test_rollback_identifies_previous_version
  Setup: agent at v1.1.0 with git history showing v1.0.0
  Action: rollback("agent-name")
  Expected: restoredVersion = "1.0.0"

test_rollback_impact_analysis
  Setup: agent at v1.1.0 with 15 invocations
  Action: rollback impact analysis
  Expected: currentVersionInvocations = 15, diff shown

test_rollback_restores_file_content
  Setup: v1.0.0 had different system prompt than v1.1.0
  Action: rollback
  Expected: agents/<name>.md contains v1.0.0 content

test_rollback_updates_version_history
  Action: rollback v1.1.0 -> v1.0.0
  Expected: version_history includes "Rollback from v1.1.0 to v1.0.0"

test_rollback_creates_git_commit
  Action: rollback
  Expected: git log shows "revert(agents): rollback <name> v1.1.0 -> v1.0.0"

test_rollback_reloads_registry
  Action: rollback
  Expected: registry.get(name) returns v1.0.0

test_rollback_audit_log
  Action: rollback
  Expected: audit log contains agent_rolled_back event

test_rollback_force_skips_confirmation
  Action: rollback with force=true
  Expected: no confirmation prompt, rollback proceeds

test_rollback_to_specific_version
  Setup: versions v1.0.0, v1.1.0, v1.2.0
  Action: rollback to v1.0.0 (skipping v1.1.0)
  Expected: restoredVersion = "1.0.0"

test_rollback_in_flight_warning
  Setup: active pipeline run referencing the agent
  Action: rollback impact analysis
  Expected: warning about in-flight pipeline run
```

### Foundation Agent Tests

```
test_all_7_agents_pass_validation
  Input: each of the 7 new agent .md files
  Expected: parser and validator return valid for all

test_performance_analyst_is_meta_role
  Input: agents/performance-analyst.md
  Expected: role = "meta"

test_performance_analyst_read_only_tools
  Input: agents/performance-analyst.md
  Expected: tools subset of ["Read", "Glob", "Grep"]

test_all_agents_have_substantive_prompts
  Input: all 7 agent files
  Expected: system_prompt >= 200 words each

test_all_agents_have_minimum_rubric
  Input: all 7 agent files
  Expected: evaluation_rubric has >= 2 dimensions

test_all_13_agents_total
  Action: load agents/ directory
  Expected: 13 total agent files discovered
```

### CLI Tests

```
test_metrics_command_displays_aggregate
  Setup: agent with 30 days of metrics
  Action: agent metrics code-executor
  Expected: output includes invocation count, approval rate, quality scores, trend

test_metrics_command_shows_domain_breakdown
  Expected: domain section with per-domain stats

test_metrics_command_shows_active_alerts
  Setup: agent with active alert
  Expected: alert displayed in output

test_dashboard_shows_all_agents
  Setup: 13 loaded agents
  Expected: 13 rows in dashboard table

test_dashboard_sorted_by_approval_rate
  Expected: rows ordered descending by approval rate

test_dashboard_trend_indicators
  Expected: ↑ for improving, → for stable, ↓ for declining

test_rollback_command_prompts_confirmation
  Action: agent rollback code-executor
  Expected: confirmation prompt displayed

test_rollback_command_force_flag
  Action: agent rollback code-executor --force
  Expected: no prompt, rollback proceeds
```
