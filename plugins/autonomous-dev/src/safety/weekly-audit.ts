/**
 * Weekly Audit Scan -- last line of defense for unscrubbed PII/secrets.
 *
 * Runs weekly over all observation report files, searching for patterns
 * that should have been caught by the real-time scrubber. Any finding
 * represents a scrubbing failure that must be investigated and the
 * pattern added to the real-time scrubber.
 *
 * Success metric: zero findings on every run.
 *
 * Based on SPEC-007-2-3, Task 8.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { shannonEntropy } from './entropy';
import { PII_PATTERNS } from './pii-scrubber';
import { SECRET_PATTERNS } from './secret-detector';
import type { PatternDefinition } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a weekly audit scan.
 */
export interface AuditScanResult {
  /** Number of files that were scanned. */
  files_scanned: number;

  /** Total number of lines scanned across all files. */
  total_lines_scanned: number;

  /** List of findings (unscrubbed PII/secrets detected). */
  findings: AuditFinding[];

  /** Wall-clock duration of the scan in milliseconds. */
  scan_duration_ms: number;

  /** ISO 8601 timestamp when the scan completed. */
  scan_timestamp: string;
}

/**
 * A single audit finding -- evidence of unscrubbed sensitive data.
 */
export interface AuditFinding {
  /** Relative path to the file within the observations directory. */
  file_path: string;

  /** 1-based line number where the finding was detected. */
  line_number: number;

  /** Category: 'pii', 'secret', or 'high_entropy'. */
  pattern_type: string;

  /** Name of the pattern that matched. */
  pattern_name: string;

  /**
   * Safe context string describing the finding without exposing raw data.
   * Format: `Line N: [pattern: <name> detected]` or
   *         `Line N: high-entropy string detected (M chars)`.
   */
  context: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively list all .md files in a directory.
 *
 * @param dir  The directory to scan.
 * @returns  Array of relative file paths.
 */
async function globMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string, prefix: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or is unreadable -- skip silently
      return;
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name), relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(relativePath);
      }
    }
  }

  await walk(dir, '');
  return results;
}

/**
 * Check whether a regex match on a line is actually inside a redaction token.
 *
 * If the line contains `[REDACTED:...]` or `[SECRET_REDACTED]` tokens, we
 * strip those tokens and re-test. If the pattern no longer matches, the
 * original match was a false alarm (the pattern matched text inside a token).
 *
 * @param line       The full line of text.
 * @param pattern    The pattern regex to re-test.
 * @returns  `true` if the match is a false alarm (inside a token).
 */
function isMatchInsideToken(line: string, pattern: RegExp): boolean {
  if (!line.includes('[REDACTED:') && !line.includes('[SECRET_REDACTED]')) {
    return false;
  }

  const cleanedLine = line
    .replace(/\[REDACTED:[^\]]+\]/g, '')
    .replace(/\[SECRET_REDACTED\]/g, '');

  const freshRegex = new RegExp(pattern.source, pattern.flags);
  return !freshRegex.test(cleanedLine);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the weekly audit scan over all observation report files.
 *
 * Scans all `.md` files in the observations directory (including
 * subdirectories and archive) for:
 *   1. PII patterns (11 built-in + any custom patterns)
 *   2. Secret patterns (15 built-in + env var pattern)
 *   3. High-entropy strings > 20 chars (broader than real-time detector)
 *
 * @param observationsDir  Absolute path to the observations directory.
 * @param piiPatterns      PII pattern definitions (defaults to built-in).
 * @param secretPatterns   Secret pattern definitions (defaults to built-in).
 * @returns  Audit scan result with findings.
 */
export async function weeklyAuditScan(
  observationsDir: string,
  piiPatterns: PatternDefinition[] = PII_PATTERNS,
  secretPatterns: PatternDefinition[] = SECRET_PATTERNS,
): Promise<AuditScanResult> {
  const findings: AuditFinding[] = [];
  const start = performance.now();

  // Scan all .md files in observations directory (recursive, including archive)
  const files = await globMdFiles(observationsDir);
  let totalLines = 0;

  for (const file of files) {
    const content = await fs.readFile(path.join(observationsDir, file), 'utf-8');
    const lines = content.split('\n');
    totalLines += lines.length;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // -----------------------------------------------------------------
      // Run all PII patterns
      // -----------------------------------------------------------------
      for (const pattern of piiPatterns) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        if (regex.test(line)) {
          // Skip matches that are inside replacement tokens
          if (isMatchInsideToken(line, pattern.regex)) {
            continue;
          }
          findings.push({
            file_path: file,
            line_number: i + 1,
            pattern_type: 'pii',
            pattern_name: pattern.name,
            context: `Line ${i + 1}: [pattern: ${pattern.name} detected]`,
          });
        }
      }

      // -----------------------------------------------------------------
      // Run all secret patterns
      // -----------------------------------------------------------------
      for (const pattern of secretPatterns) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        if (regex.test(line)) {
          // Skip matches that are inside replacement tokens
          if (isMatchInsideToken(line, pattern.regex)) {
            continue;
          }
          findings.push({
            file_path: file,
            line_number: i + 1,
            pattern_type: 'secret',
            pattern_name: pattern.name,
            context: `Line ${i + 1}: [pattern: ${pattern.name} detected]`,
          });
        }
      }

      // -----------------------------------------------------------------
      // Expanded entropy analysis (broader than real-time, slower is OK)
      // Check ALL strings > 20 chars, not just those in key=value context
      // -----------------------------------------------------------------
      const longStrings = line.match(/\S{20,}/g) || [];
      for (const s of longStrings) {
        // Skip known redaction tokens
        if (
          s.startsWith('[REDACTED') ||
          s.startsWith('[SECRET_REDACTED') ||
          s.startsWith('[SCRUB_FAILED')
        ) {
          continue;
        }
        if (shannonEntropy(s) > 4.5) {
          findings.push({
            file_path: file,
            line_number: i + 1,
            pattern_type: 'high_entropy',
            pattern_name: 'expanded_entropy_scan',
            context: `Line ${i + 1}: high-entropy string detected (${s.length} chars)`,
          });
        }
      }
    }
  }

  return {
    files_scanned: files.length,
    total_lines_scanned: totalLines,
    findings,
    scan_duration_ms: performance.now() - start,
    scan_timestamp: new Date().toISOString(),
  };
}
