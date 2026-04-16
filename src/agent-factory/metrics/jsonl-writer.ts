/**
 * Append-only JSONL writer/reader for per-invocation metrics (SPEC-005-2-1, Task 2).
 *
 * Primary durable storage. Each write appends a single JSON-serialised
 * `InvocationMetric` followed by a newline to the configured file path.
 *
 * Crash safety: each write is a single `appendFileSync` call.  If the
 * process crashes mid-write, at most one partial line is lost; the reader
 * silently skips lines that fail `JSON.parse`.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { InvocationMetric } from './types';

// ---------------------------------------------------------------------------
// Logger interface (keep dependency-free; callers can inject)
// ---------------------------------------------------------------------------

export interface JsonlLogger {
  warn(message: string): void;
}

const defaultLogger: JsonlLogger = {
  warn: (msg: string) => console.warn(`[jsonl-writer] ${msg}`),
};

// ---------------------------------------------------------------------------
// JsonlWriter
// ---------------------------------------------------------------------------

export class JsonlWriter {
  private readonly filePath: string;
  private readonly logger: JsonlLogger;

  /**
   * @param filePath  Absolute or relative path to the `.jsonl` file.
   * @param logger    Optional logger; defaults to `console.warn`.
   */
  constructor(filePath: string, logger?: JsonlLogger) {
    this.filePath = path.resolve(filePath);
    this.logger = logger ?? defaultLogger;
  }

  // -----------------------------------------------------------------------
  // Write
  // -----------------------------------------------------------------------

  /**
   * Append a single `InvocationMetric` to the JSONL file.
   *
   * The parent directory is created lazily on first write.  On write error
   * the exception propagates to the caller (the buffering layer in
   * SPEC-005-2-2 handles retries).
   */
  append(record: InvocationMetric): void {
    this.ensureDirectory();
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(this.filePath, line, { encoding: 'utf-8' });
  }

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /**
   * Read every valid `InvocationMetric` from the JSONL file.
   *
   * Lines that fail `JSON.parse` are silently skipped (with a warning
   * logged).  If the file does not exist an empty array is returned.
   */
  readAll(): InvocationMetric[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n');
    const metrics: InvocationMetric[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;

      try {
        const parsed = JSON.parse(line) as InvocationMetric;
        metrics.push(parsed);
      } catch {
        this.logger.warn(
          `Skipping malformed line ${i + 1} in ${this.filePath}: ${line.substring(0, 80)}...`,
        );
      }
    }

    return metrics;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Return the resolved file path (useful for tests / diagnostics). */
  getFilePath(): string {
    return this.filePath;
  }

  /** Ensure the parent directory exists. */
  private ensureDirectory(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
