/**
 * Governance step (3e) logic for the observation runner lifecycle
 * (SPEC-007-5-3, Task 5).
 *
 * Wires cooldown, oscillation, and effectiveness governance checks
 * into the runner at two integration points:
 *
 *   Point A -- Run start (step 2):
 *     Evaluate effectiveness for all eligible observations before
 *     processing new data.
 *
 *   Point B -- After deduplication (step 3e):
 *     Apply cooldown and oscillation checks to each candidate
 *     observation. Returns GovernanceFlags that the report generator
 *     uses to populate frontmatter and append warning sections.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { evaluateEffectiveness } from '../governance/effectiveness';
import { writeEffectivenessResult, findPendingEffectivenessObservations } from '../governance/effectiveness-writeback';
import { checkCooldown } from '../governance/cooldown';
import { checkOscillation, buildOscillationWarningMarkdown } from '../governance/oscillation';
import type {
  GovernanceConfig,
  CooldownResult,
  OscillationResult,
  EffectivenessCandidate,
  EffectivenessResult,
  DeploymentInfo,
  PrometheusClient,
  ObservationSummary,
  FixDeployment,
} from '../governance/types';
import type { AuditLogger } from './audit-logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Governance flags attached to each candidate observation */
export interface GovernanceFlags {
  cooldown_active: boolean;
  cooldown_result: CooldownResult;
  oscillation_warning: boolean;
  oscillation_result: OscillationResult;
  oscillation_markdown: string;
}

/** Summary of effectiveness evaluations performed during a run */
export interface EffectivenessRunSummary {
  evaluated: number;
  improved: number;
  degraded: number;
  unchanged: number;
  still_pending: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Point A: Effectiveness evaluations at run start (step 2)
// ---------------------------------------------------------------------------

/**
 * Run effectiveness evaluation for all pending observations.
 * Called at the start of each observation run (step 2 in TDD 3.2.2).
 *
 * Returns a summary of evaluations performed for the audit log.
 */
export async function runEffectivenessEvaluations(
  rootDir: string,
  config: GovernanceConfig,
  getDeployment: (id: string) => DeploymentInfo | null,
  prometheus: PrometheusClient,
  logger: AuditLogger,
): Promise<EffectivenessRunSummary> {
  const pendingFiles = await findPendingEffectivenessObservations(rootDir);
  const summary: EffectivenessRunSummary = {
    evaluated: 0,
    improved: 0,
    degraded: 0,
    unchanged: 0,
    still_pending: 0,
    errors: 0,
  };

  for (const filePath of pendingFiles) {
    const observation = await parseObservationForEffectiveness(filePath);
    if (!observation) {
      summary.errors++;
      logger.warn(`Failed to parse observation for effectiveness: ${filePath}`);
      continue;
    }

    try {
      const result = await evaluateEffectiveness(
        observation, config, getDeployment, prometheus,
      );

      if (result.status !== 'pending') {
        const writeResult = await writeEffectivenessResult(filePath, result);
        if (writeResult.updated) {
          summary.evaluated++;
          summary[result.status]++;
          logger.info(
            `Effectiveness evaluated: ${observation.id} -> ${result.status}` +
            (result.detail ? ` (${result.detail.improvement_pct}%)` : ''),
          );
        }
      } else {
        summary.still_pending++;
        logger.info(`Effectiveness still pending: ${observation.id} -- ${result.reason}`);
      }
    } catch (err) {
      summary.errors++;
      logger.error(`Effectiveness evaluation failed for ${observation.id}: ${err}`);
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Point B: Governance checks at step 3e
// ---------------------------------------------------------------------------

/**
 * Apply governance checks to a candidate observation.
 * Called after deduplication (step 3d) and before report generation (step 3f)
 * in TDD section 3.2.2.
 *
 * Returns GovernanceFlags that the report generator uses to populate
 * frontmatter and append oscillation warning sections.
 */
export async function applyGovernanceChecks(
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  rootDir: string,
  readDeploymentMetadata: (id: string) => DeploymentInfo | null,
  logger: AuditLogger,
): Promise<GovernanceFlags> {
  // 3e.i -- Check cooldown
  const cooldownResult = checkCooldown(
    service,
    errorClass,
    config,
    (svc, ec) => findRecentFixDeploymentFromStore(rootDir, svc, ec, readDeploymentMetadata),
  );

  if (cooldownResult.active) {
    logger.info(
      `Cooldown active for ${service}/${errorClass}: ${cooldownResult.reason}`,
    );
  }

  // 3e.ii -- Check oscillation
  const oscillationResult = checkOscillation(
    service,
    errorClass,
    config,
    (svc, ec, after) => findObservationsByServiceAndErrorFromStore(rootDir, svc, ec, after),
  );

  let oscillationMarkdown = '';
  if (oscillationResult.oscillating) {
    // Mark the current observation in the summaries
    if (oscillationResult.observation_summaries) {
      oscillationResult.observation_summaries.push({
        id: '(this observation)',
        triage_status: cooldownResult.active ? 'cooldown' : 'pending',
        effectiveness: null,
        is_current: true,
      });
    }
    oscillationMarkdown = buildOscillationWarningMarkdown(oscillationResult);
    logger.warn(
      `Oscillation detected for ${service}/${errorClass}: ` +
      `${oscillationResult.count} observations in ${oscillationResult.window_days} days`,
    );
  }

  // 3e.iii -- Flag observations accordingly
  return {
    cooldown_active: cooldownResult.active,
    cooldown_result: cooldownResult,
    oscillation_warning: oscillationResult.oscillating,
    oscillation_result: oscillationResult,
    oscillation_markdown: oscillationMarkdown,
  };
}

// ---------------------------------------------------------------------------
// Store lookups
// ---------------------------------------------------------------------------

/**
 * Find the most recent fix deployment for a service + error class
 * combination by scanning the deployments store directory.
 */
export function findRecentFixDeploymentFromStore(
  rootDir: string,
  service: string,
  errorClass: string,
  readDeploymentMetadata: (id: string) => DeploymentInfo | null,
): FixDeployment | null {
  // In the real implementation, this would scan the deployments
  // directory or query a deployments index. For now, it delegates
  // to the provided readDeploymentMetadata function.
  //
  // The deployment store is at:
  //   .autonomous-dev/deployments/<deployment-id>.yaml
  //
  // Each deployment file contains service, error_class, deployed_at, etc.
  // This function is intentionally synchronous to match the checkCooldown
  // callback signature.

  // Stub: in production this scans the deployment store
  // The actual scanning logic is provided by SPEC-007-5-1
  return null;
}

/**
 * Find observations matching a service + error class from the
 * observation file store, after the given date.
 */
export function findObservationsByServiceAndErrorFromStore(
  rootDir: string,
  service: string,
  errorClass: string,
  afterDate: Date,
): ObservationSummary[] {
  // In the real implementation, this would scan observation files
  // in the .autonomous-dev/observations/ directory tree and filter
  // by service, error_class, and timestamp.
  //
  // This function is intentionally synchronous to match the
  // checkOscillation callback signature.

  // Stub: in production this scans the observations store
  // The actual scanning logic is provided by SPEC-007-5-1
  return [];
}

// ---------------------------------------------------------------------------
// Observation parsing for effectiveness
// ---------------------------------------------------------------------------

/**
 * Parse an observation file's YAML frontmatter into the fields needed
 * for effectiveness evaluation.
 *
 * @param filePath  Absolute path to the observation Markdown file.
 * @returns EffectivenessCandidate or null if parsing fails.
 */
export async function parseObservationForEffectiveness(
  filePath: string,
): Promise<EffectivenessCandidate | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;

    const parsed = yaml.load(frontmatterMatch[1]) as Record<string, any>;
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      id: parsed.id ?? '',
      file_path: filePath,
      linked_deployment: parsed.linked_deployment ?? null,
      effectiveness: parsed.effectiveness ?? null,
      target_metric: parsed.target_metric ?? `error_rate{service="${parsed.service}"}`,
      metric_direction: parsed.metric_direction ?? 'decrease',
      service: parsed.service ?? '',
    };
  } catch {
    return null;
  }
}
