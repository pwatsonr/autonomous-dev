/**
 * Per-run metadata log writer (SPEC-007-4-4, Task 9).
 *
 * Written at the end of each observation run to
 * `.autonomous-dev/logs/intelligence/RUN-<id>.log`.
 * Format matches TDD section 4.5: YAML for readability.
 *
 * Records run timing, services in scope, data source connectivity,
 * observation counts, triage processing, token consumption,
 * per-source query counts, and any errors encountered.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';

import type { DataSourceStatus } from '../adapters/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-source connectivity status for the run.
 */
export interface DataSourceStatusMap {
  prometheus: DataSourceStatus;
  grafana: DataSourceStatus;
  opensearch: DataSourceStatus;
  sentry: DataSourceStatus;
}

/**
 * Per-source query counts executed during the run.
 */
export interface QueryCounts {
  prometheus: number;
  grafana: number;
  opensearch: number;
  sentry: number;
}

/**
 * Complete metadata for a single observation run.
 *
 * All fields from TDD section 4.5:
 *   run_id, started_at, completed_at, services_in_scope,
 *   data_source_status, observations_generated/deduplicated/filtered,
 *   triage_decisions_processed, total_tokens_consumed,
 *   queries_executed per source, errors.
 */
export interface RunMetadata {
  /** Unique run identifier (e.g., "RUN-20260408-143000") */
  run_id: string;
  /** ISO 8601 timestamp when the run started */
  started_at: string;
  /** ISO 8601 timestamp when the run completed */
  completed_at: string;
  /** List of services included in this run */
  services_in_scope: string[];
  /** Per-source connectivity status from the pre-run probe */
  data_source_status: DataSourceStatusMap;
  /** Number of new observations generated */
  observations_generated: number;
  /** Number of observations deduplicated (merged with existing) */
  observations_deduplicated: number;
  /** Number of candidate observations filtered out */
  observations_filtered: number;
  /** Number of triage decisions processed in this run */
  triage_decisions_processed: number;
  /** Total LLM tokens consumed across all operations */
  total_tokens_consumed: number;
  /** Per-source query counts */
  queries_executed: QueryCounts;
  /** Error messages encountered during the run */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Run metadata writer
// ---------------------------------------------------------------------------

/**
 * Writes run metadata to `.autonomous-dev/logs/intelligence/<run_id>.log`
 * in YAML format (consistent with TDD section 4.5).
 *
 * Creates parent directories if they do not exist.
 *
 * @param metadata  The complete run metadata to persist.
 * @param rootDir   The project root directory.
 * @returns The absolute path where the metadata file was written.
 */
export async function writeRunMetadata(
  metadata: RunMetadata,
  rootDir: string,
): Promise<string> {
  const logDir = path.join(rootDir, '.autonomous-dev', 'logs', 'intelligence');
  const logPath = path.join(logDir, `${metadata.run_id}.log`);

  // Ensure directory exists
  await fs.mkdir(logDir, { recursive: true });

  // Write as YAML for readability (consistent with TDD section 4.5 format)
  const content = yaml.dump(metadata, { lineWidth: 120, noRefs: true });
  await fs.writeFile(logPath, content, 'utf-8');

  return logPath;
}

// ---------------------------------------------------------------------------
// Run metadata reader (for testing and diagnostics)
// ---------------------------------------------------------------------------

/**
 * Reads and parses a run metadata file.
 *
 * @param runId    The run identifier (e.g., "RUN-20260408-143000").
 * @param rootDir  The project root directory.
 * @returns Parsed RunMetadata or null if the file does not exist.
 */
export async function readRunMetadata(
  runId: string,
  rootDir: string,
): Promise<RunMetadata | null> {
  const logPath = path.join(
    rootDir,
    '.autonomous-dev',
    'logs',
    'intelligence',
    `${runId}.log`,
  );

  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const parsed = yaml.load(content);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as RunMetadata;
    }
    return null;
  } catch {
    return null;
  }
}
