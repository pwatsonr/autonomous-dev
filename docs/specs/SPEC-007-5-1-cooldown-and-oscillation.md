# SPEC-007-5-1: Cooldown Enforcement and Oscillation Detection

## Metadata
- **Parent Plan**: PLAN-007-5
- **Tasks Covered**: Task 1, Task 2
- **Estimated effort**: 8 hours

## Description

Implement the two core governance state machines that prevent the system from generating noise on known-in-progress fixes (cooldown) and flag recurring patterns that suggest incremental fixes are failing (oscillation). Together these ensure the triage queue contains only actionable observations and surfaces systemic issues that need architectural attention.

Cooldown suppresses triage queue entry for a service+error class combination while a recently deployed fix is within its evaluation window. Oscillation counts observations within a rolling window and flags combinations that exceed the threshold, appending a structured warning to the observation report.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/governance/cooldown.ts` | Create | Cooldown checker: determines whether a service+error class is in a cooldown window |
| `src/governance/oscillation.ts` | Create | Oscillation detector: counts observations in a rolling window and flags recurring patterns |
| `src/governance/types.ts` | Create | Shared TypeScript interfaces for governance results, config, and observation references |
| `src/governance/observation-store.ts` | Create | Utility to query existing observation files by service, error class, and time range |
| `tests/governance/cooldown.test.ts` | Create | Unit tests for cooldown enforcement |
| `tests/governance/oscillation.test.ts` | Create | Unit tests for oscillation detection |

## Implementation Details

### Shared Types (`src/governance/types.ts`)

```typescript
/** Governance configuration slice from intelligence.yaml */
export interface GovernanceConfig {
  cooldown_days: number;           // Default: 7
  oscillation_window_days: number; // Default: 30
  oscillation_threshold: number;   // Default: 3
  effectiveness_comparison_days: number; // Default: 7
  effectiveness_improvement_threshold: number; // Default: 10 (percent)
}

/** Return value of check_cooldown */
export interface CooldownResult {
  active: boolean;
  reason?: string;              // Human-readable explanation
  linked_deployment?: string;   // Deployment ID that triggered the cooldown
  cooldown_end?: string;        // ISO 8601 date when cooldown expires
  deploy_date?: string;         // ISO 8601 date of the linked deployment
}

/** Return value of check_oscillation */
export interface OscillationResult {
  oscillating: boolean;
  count?: number;                     // Number of observations in the window
  window_days?: number;               // Window size from config
  observation_ids?: string[];         // IDs of observations in the window
  observation_summaries?: ObservationSummary[]; // For Markdown rendering
  recommendation?: 'systemic_investigation';
}

/** Minimal observation info for oscillation rendering */
export interface ObservationSummary {
  id: string;
  triage_status: string;
  effectiveness?: string | null;
  is_current: boolean;   // True for the observation being evaluated
}

/** Reference to a deployment linked to a promoted observation */
export interface FixDeployment {
  id: string;              // Deployment ID from TDD-003 pipeline
  deployed_at: string;     // ISO 8601
  observation_id: string;  // The promoted observation that triggered the fix
  service: string;
  error_class: string;
}
```

### Task 1: Cooldown Enforcement (`src/governance/cooldown.ts`)

```typescript
import { CooldownResult, GovernanceConfig, FixDeployment } from './types';

/**
 * Check whether a service+error class combination is in a cooldown window.
 *
 * A cooldown is active when a fix deployment for this combination exists
 * and was deployed fewer than `config.cooldown_days` ago.
 *
 * Observations generated during cooldown are still created (for audit)
 * but flagged with cooldown_active: true and triage_status: cooldown.
 * They are excluded from the triage queue.
 */
export function checkCooldown(
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  findRecentFixDeployment: (service: string, errorClass: string) => FixDeployment | null,
  now?: Date
): CooldownResult {
  const currentTime = now ?? new Date();
  const recentFix = findRecentFixDeployment(service, errorClass);

  if (recentFix === null) {
    return { active: false };
  }

  const deployDate = new Date(recentFix.deployed_at);
  const cooldownEnd = new Date(deployDate);
  cooldownEnd.setDate(cooldownEnd.getDate() + config.cooldown_days);

  if (currentTime < cooldownEnd) {
    return {
      active: true,
      reason: `Fix deployed on ${recentFix.deployed_at}, cooldown until ${cooldownEnd.toISOString()}`,
      linked_deployment: recentFix.id,
      cooldown_end: cooldownEnd.toISOString(),
      deploy_date: recentFix.deployed_at,
    };
  }

  return { active: false };
}
```

**Finding recent fix deployments**: The `findRecentFixDeployment` function is injected as a dependency. The implementation scans observation files for the given service+error class where `triage_decision === 'promote'` and `linked_deployment` is non-null. It then reads the deployment metadata (from the TDD-003 deployment pipeline) to determine `deployed_at`. Only the most recent deployment is returned.

**Edge cases**:
- `deployed_at` is exactly `cooldown_days` ago (midnight boundary): cooldown is NOT active (uses strict `<` comparison on the cooldown end date, so the end date itself is the first day of eligibility)
- Multiple fix deployments for the same combination: only the most recent is considered
- Deployment metadata missing or unreadable: treated as no deployment found, returns `{ active: false }` with a warning logged
- `cooldown_days` is 0: cooldown is never active (edge case -- should be validated in config)

### Task 2: Oscillation Detection (`src/governance/oscillation.ts`)

```typescript
import { OscillationResult, GovernanceConfig, ObservationSummary } from './types';

/**
 * Check whether a service+error class combination is oscillating.
 *
 * Oscillation = the same service+error class generates observations
 * at a rate of `threshold` or more within `window_days`.
 *
 * When detected, the observation report includes a structured warning
 * with previous observation history and a recommendation for
 * architectural investigation.
 */
export function checkOscillation(
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  findObservations: (service: string, errorClass: string, afterDate: Date) => ObservationSummary[],
  now?: Date
): OscillationResult {
  const currentTime = now ?? new Date();
  const windowStart = new Date(currentTime);
  windowStart.setDate(windowStart.getDate() - config.oscillation_window_days);

  const recentObservations = findObservations(service, errorClass, windowStart);

  if (recentObservations.length >= config.oscillation_threshold) {
    return {
      oscillating: true,
      count: recentObservations.length,
      window_days: config.oscillation_window_days,
      observation_ids: recentObservations.map(obs => obs.id),
      observation_summaries: recentObservations,
      recommendation: 'systemic_investigation',
    };
  }

  return { oscillating: false };
}

/**
 * Build the Markdown section for oscillation warnings.
 * Matches TDD section 3.11.2 format exactly.
 */
export function buildOscillationWarningMarkdown(result: OscillationResult): string {
  if (!result.oscillating || !result.observation_summaries) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Oscillation Warning');
  lines.push('');
  lines.push(
    `This service + error class combination has generated ${result.count} observations in the ` +
    `last ${result.window_days} days. This suggests a systemic issue that incremental fixes are not ` +
    `resolving.`
  );
  lines.push('');
  lines.push('**Previous observations:**');

  for (const obs of result.observation_summaries) {
    const statusDetail = formatObservationStatus(obs);
    lines.push(`- ${obs.id} (${statusDetail})`);
  }

  lines.push('');
  lines.push(
    '**Recommendation:** Promote as an architectural investigation PRD rather than ' +
    'an incremental fix PRD.'
  );

  return lines.join('\n');
}

/**
 * Format a single observation's status for the oscillation warning list.
 * Examples:
 *   "promoted, fix deployed, not effective"
 *   "promoted, fix deployed, partially effective"
 *   "promoted, fix in progress"
 *   "this observation"
 *   "pending"
 *   "dismissed"
 */
function formatObservationStatus(obs: ObservationSummary): string {
  if (obs.is_current) {
    return 'this observation';
  }

  const parts: string[] = [];

  if (obs.triage_status === 'promoted') {
    parts.push('promoted');
    if (obs.effectiveness === 'improved') {
      parts.push('fix deployed, effective');
    } else if (obs.effectiveness === 'degraded') {
      parts.push('fix deployed, not effective');
    } else if (obs.effectiveness === 'unchanged') {
      parts.push('fix deployed, partially effective');
    } else if (obs.effectiveness === 'pending') {
      parts.push('fix in progress');
    } else {
      parts.push('fix deployed');
    }
  } else {
    parts.push(obs.triage_status);
  }

  return parts.join(', ');
}
```

### Observation Store (`src/governance/observation-store.ts`)

Shared utility used by both cooldown and oscillation to query existing observations.

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ObservationSummary, FixDeployment } from './types';

/**
 * Scan observation directories for files matching service+errorClass
 * criteria. Parses YAML frontmatter from each file.
 *
 * Scans only year/month directories that fall within the requested
 * time range to avoid reading the entire archive.
 */
export function findObservationsByServiceAndError(
  rootDir: string,
  service: string,
  errorClass: string,
  afterDate: Date
): ObservationSummary[] {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  const candidates: ObservationSummary[] = [];

  // Determine which YYYY/MM directories to scan
  const directories = getRelevantDirectories(obsDir, afterDate);

  for (const dir of directories) {
    const files = listMarkdownFiles(dir);
    for (const file of files) {
      const frontmatter = parseFrontmatterFromFile(file);
      if (!frontmatter) continue;

      if (
        frontmatter.service === service &&
        matchesErrorClass(frontmatter, errorClass) &&
        new Date(frontmatter.timestamp) >= afterDate
      ) {
        candidates.push({
          id: frontmatter.id,
          triage_status: frontmatter.triage_status,
          effectiveness: frontmatter.effectiveness ?? null,
          is_current: false,
        });
      }
    }
  }

  // Sort chronologically (oldest first)
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates;
}

/**
 * Find the most recent fix deployment for a service+error class.
 * Scans promoted observations with linked_deployment set.
 */
export function findRecentFixDeployment(
  rootDir: string,
  service: string,
  errorClass: string,
  readDeploymentMetadata: (deploymentId: string) => FixDeployment | null
): FixDeployment | null {
  // Scan all observations for this service+errorClass that were promoted
  // and have a linked_deployment.
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  let mostRecent: FixDeployment | null = null;

  const directories = getAllDirectories(obsDir);
  for (const dir of directories) {
    const files = listMarkdownFiles(dir);
    for (const file of files) {
      const fm = parseFrontmatterFromFile(file);
      if (!fm) continue;
      if (
        fm.service === service &&
        matchesErrorClass(fm, errorClass) &&
        fm.triage_decision === 'promote' &&
        fm.linked_deployment
      ) {
        const deploy = readDeploymentMetadata(fm.linked_deployment);
        if (deploy && (!mostRecent || deploy.deployed_at > mostRecent.deployed_at)) {
          mostRecent = deploy;
        }
      }
    }
  }

  return mostRecent;
}

/**
 * Match error class from observation fingerprint or type metadata.
 * Error class is derived from the observation's fingerprint components
 * (error type + endpoint combination stored during fingerprinting in PLAN-007-3).
 */
function matchesErrorClass(frontmatter: any, errorClass: string): boolean {
  // Primary: check fingerprint-derived error_class field
  if (frontmatter.error_class === errorClass) return true;
  // Fallback: match on type + fingerprint prefix (first 8 chars = error class hash)
  if (frontmatter.fingerprint?.startsWith(errorClass.substring(0, 8))) return true;
  return false;
}

/**
 * Return YYYY/MM directory paths that could contain observations
 * created after `afterDate`.
 */
function getRelevantDirectories(obsDir: string, afterDate: Date): string[] {
  const now = new Date();
  const dirs: string[] = [];
  const cursor = new Date(afterDate.getFullYear(), afterDate.getMonth(), 1);
  while (cursor <= now) {
    const year = cursor.getFullYear().toString();
    const month = (cursor.getMonth() + 1).toString().padStart(2, '0');
    const dirPath = path.join(obsDir, year, month);
    if (fs.existsSync(dirPath)) {
      dirs.push(dirPath);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return dirs;
}
```

## Acceptance Criteria

1. [ ] `checkCooldown(service, errorClass, config)` returns `{ active: true }` with reason, deployment ID, and cooldown end date when a fix was deployed within `config.cooldown_days` days.
2. [ ] `checkCooldown` returns `{ active: false }` when no deployment exists or the cooldown period has expired.
3. [ ] During cooldown, observations are still generated but flagged with `cooldown_active: true` and `triage_status: cooldown` (flag propagation verified via integration in SPEC-007-5-3).
4. [ ] Cooldown-flagged observations are excluded from the triage queue (consumers check the flag).
5. [ ] `checkOscillation(service, errorClass, config)` returns `{ oscillating: true }` with count, window, observation IDs, and recommendation when the count of observations in the window >= `config.oscillation_threshold`.
6. [ ] `checkOscillation` returns `{ oscillating: false }` when the count is below the threshold.
7. [ ] `buildOscillationWarningMarkdown` produces Markdown matching the TDD section 3.11.2 format: observation list with per-observation triage/effectiveness status and architectural investigation recommendation.
8. [ ] `oscillation_warning: true` is set in YAML frontmatter when oscillation is detected (propagation verified in SPEC-007-5-3).
9. [ ] `findObservationsByServiceAndError` correctly scans only relevant year/month directories and returns chronologically sorted results.
10. [ ] `findRecentFixDeployment` returns only the most recent deployment for the service+error class combination.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-5-1-01 | Cooldown active within window | Deploy 3 days ago, `cooldown_days=7` | `{ active: true, reason: "Fix deployed on ..., cooldown until ..." }` |
| TC-5-1-02 | Cooldown expired | Deploy 8 days ago, `cooldown_days=7` | `{ active: false }` |
| TC-5-1-03 | Cooldown exact boundary (day 7) | Deploy exactly 7 days ago at midnight, `cooldown_days=7` | `{ active: false }` (strict `<` comparison, cooldown_end = deploy + 7d, now = cooldown_end) |
| TC-5-1-04 | No deployment found | No promoted+deployed observations | `{ active: false }` |
| TC-5-1-05 | Multiple deployments | Deploys at day -3 and day -10, `cooldown_days=7` | Uses most recent (day -3), returns `{ active: true }` |
| TC-5-1-06 | Deployment metadata unreadable | Observation references deployment but metadata file missing | `{ active: false }`, warning logged |
| TC-5-1-07 | Oscillation triggered | 3 observations in 25 days, `threshold=3`, `window_days=30` | `{ oscillating: true, count: 3, recommendation: 'systemic_investigation' }` |
| TC-5-1-08 | Oscillation not triggered | 2 observations in 25 days, `threshold=3` | `{ oscillating: false }` |
| TC-5-1-09 | Oscillation exact threshold | 3 observations, `threshold=3` | `{ oscillating: true }` (uses `>=`) |
| TC-5-1-10 | Oscillation with observations outside window | 4 observations total but only 2 within `window_days=30` | `{ oscillating: false }` |
| TC-5-1-11 | Oscillation Markdown format | 4 observations, various triage statuses | Markdown contains "## Oscillation Warning", 4 bullet points, recommendation text |
| TC-5-1-12 | Oscillation observation status rendering | Promoted + improved observation | Status text: "promoted, fix deployed, effective" |
| TC-5-1-13 | Oscillation observation status rendering (current) | The observation being evaluated | Status text: "this observation" |
| TC-5-1-14 | Observation store directory scanning | Observations in 2026/03 and 2026/04, query from March 15 | Returns observations from both directories after March 15 only |
| TC-5-1-15 | Observation store empty directory | No observations exist for the queried range | Returns empty array |
