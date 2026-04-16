/**
 * Abstract storage interface and filesystem implementation for metrics records.
 *
 * The MetricsStore interface defines read/write operations for ReviewMetricsRecord.
 * FileSystemMetricsStore provides a JSON-file-per-record implementation suitable
 * for development and small deployments.
 *
 * Based on SPEC-004-4-2 section 2.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReviewMetricsRecord, MetricsFilter } from './metrics-types';

// ---------------------------------------------------------------------------
// Abstract interface
// ---------------------------------------------------------------------------

/** Abstract storage interface for metrics records. */
export interface MetricsStore {
  /** Write a metrics record to storage. */
  write(record: ReviewMetricsRecord): Promise<void>;
  /** Query metrics records matching the given filter. */
  query(filter: MetricsFilter): Promise<ReviewMetricsRecord[]>;
  /** Count metrics records matching the given filter. */
  count(filter: MetricsFilter): Promise<number>;
}

// ---------------------------------------------------------------------------
// Filesystem implementation
// ---------------------------------------------------------------------------

/**
 * Filesystem-backed MetricsStore.
 *
 * Writes each record as a JSON file at `{basePath}/{gate_id}.json`.
 * Queries read all files and filter in memory.
 */
export class FileSystemMetricsStore implements MetricsStore {
  constructor(private basePath: string) {}

  /**
   * Write a metrics record as a JSON file.
   * Creates the base directory if it does not exist.
   */
  async write(record: ReviewMetricsRecord): Promise<void> {
    await fs.promises.mkdir(this.basePath, { recursive: true });
    const filePath = path.join(this.basePath, `${record.gate_id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
  }

  /**
   * Query all records matching the given filter.
   * Reads all JSON files in basePath and filters in memory.
   */
  async query(filter: MetricsFilter): Promise<ReviewMetricsRecord[]> {
    const records = await this.readAllRecords();
    return records.filter((record) => this.matchesFilter(record, filter));
  }

  /**
   * Count records matching the given filter.
   */
  async count(filter: MetricsFilter): Promise<number> {
    const results = await this.query(filter);
    return results.length;
  }

  /**
   * Read all JSON records from the base directory.
   */
  private async readAllRecords(): Promise<ReviewMetricsRecord[]> {
    try {
      const entries = await fs.promises.readdir(this.basePath);
      const jsonFiles = entries.filter((f) => f.endsWith('.json'));

      const records: ReviewMetricsRecord[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.basePath, file);
          const content = await fs.promises.readFile(filePath, 'utf-8');
          records.push(JSON.parse(content) as ReviewMetricsRecord);
        } catch {
          // Skip malformed files
        }
      }

      return records;
    } catch {
      // Directory does not exist yet
      return [];
    }
  }

  /**
   * Check if a record matches the given filter criteria.
   */
  private matchesFilter(record: ReviewMetricsRecord, filter: MetricsFilter): boolean {
    if (filter.document_type && record.document_type !== filter.document_type) {
      return false;
    }
    if (filter.pipeline_id && record.pipeline_id !== filter.pipeline_id) {
      return false;
    }
    if (filter.outcome && record.outcome !== filter.outcome) {
      return false;
    }
    if (filter.from_timestamp && record.timestamp < filter.from_timestamp) {
      return false;
    }
    if (filter.to_timestamp && record.timestamp > filter.to_timestamp) {
      return false;
    }
    if (filter.reviewer_id) {
      const hasReviewer = record.reviewer_metrics.some(
        (rm) => rm.reviewer_id === filter.reviewer_id
      );
      if (!hasReviewer) {
        return false;
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Utility: sleep
// ---------------------------------------------------------------------------

/** Returns a promise that resolves after the given milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/**
 * Write a metrics record with retry logic.
 *
 * Retries up to maxRetries times with exponential backoff (100ms, 200ms, 400ms).
 * On total failure, logs the error but does NOT throw, ensuring the pipeline
 * is never blocked by a metrics write failure.
 */
export async function writeWithRetry(
  store: MetricsStore,
  record: ReviewMetricsRecord,
  maxRetries: number = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await store.write(record);
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        console.error(
          `Metrics write failed after ${maxRetries} attempts for gate ${record.gate_id}`,
          error
        );
        return;
      }
      // Exponential backoff: 100ms, 200ms, 400ms
      await sleep(100 * Math.pow(2, attempt - 1));
    }
  }
}
