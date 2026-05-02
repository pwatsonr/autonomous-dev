/**
 * Loader + validator for `--bug-context-path <file>` (SPEC-018-3-02).
 *
 * Used by both `request submit --type bug --bug-context-path …` and
 * `request submit-bug --bug-context-path …` to admit pre-built bug
 * payloads (e.g. from `gh issue view | jq …` pipelines). Errors are
 * shaped to match the AC strings in SPEC-018-3-02 verbatim so callers
 * can write them straight to stderr.
 *
 * @module intake/cli/bug-context-loader
 */

import * as fs from 'fs';

import type { BugReport } from '../types/bug-report';
import { formatErrors, validateBugReport } from './bug-prompts';

/**
 * Result of a load attempt. Either a populated, validated {@link BugReport}
 * or a single human-readable error message that the CLI will write to
 * stderr verbatim before exiting 1.
 */
export type LoadResult =
  | { ok: true; report: BugReport }
  | { ok: false; error: string };

/**
 * Read, parse, and validate a JSON bug-context file.
 *
 * Error messages match the spec's AC strings exactly:
 *   - missing: `"bug context file not found: <path>"`
 *   - bad JSON: `"bug context file is not valid JSON: <path>"`
 *   - schema fail: `"bug context validation failed:\n<errors>"`
 */
export function loadBugContext(filePath: string): LoadResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `bug context file not found: ${filePath}` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, error: `bug context file not found: ${filePath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `bug context file is not valid JSON: ${filePath}`,
    };
  }
  const errors = validateBugReport(parsed as Partial<BugReport>);
  if (errors.length > 0) {
    return {
      ok: false,
      error: `bug context validation failed:\n${formatErrors(errors)}`,
    };
  }
  return { ok: true, report: parsed as BugReport };
}
