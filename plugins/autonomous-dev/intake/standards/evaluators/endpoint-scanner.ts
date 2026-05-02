/**
 * `endpoint-scanner` built-in evaluator (SPEC-021-2-01, Task 2).
 *
 * Greps a list of source files for HTTP route declarations matching the
 * requested endpoint path across Python, TypeScript/JavaScript, and Go.
 * Patterns are evaluator-controlled (no user-supplied regex); the endpoint
 * path itself is regex-escaped before insertion to prevent accidental regex
 * injection from rule authors.
 *
 * Returns `passed: true` as soon as ANY file matches. On no match, returns
 * one summary finding (`line: 0`) so reviewers see a single signal per
 * missing endpoint rather than per-file noise.
 *
 * Args contract: `{ exposes_endpoint: string }`. Unknown args are ignored.
 *
 * @module intake/standards/evaluators/endpoint-scanner
 */

import { readFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';

import type {
  BuiltinEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  Finding,
} from './types';

type Lang = 'python' | 'tsjs' | 'go';

const LANG_BY_EXT: Record<string, Lang> = {
  '.py': 'python',
  '.ts': 'tsjs',
  '.tsx': 'tsjs',
  '.js': 'tsjs',
  '.jsx': 'tsjs',
  '.mjs': 'tsjs',
  '.cjs': 'tsjs',
  '.go': 'go',
};

/** Escape regex metacharacters in user-supplied endpoint paths. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the language-specific patterns with the endpoint substituted in. */
function buildPatterns(escaped: string): Record<Lang, RegExp[]> {
  return {
    python: [
      new RegExp(
        `@app\\.(get|post|put|delete|patch|route)\\(['"]${escaped}['"]`,
      ),
      new RegExp(
        `@router\\.(get|post|put|delete|patch)\\(['"]${escaped}['"]`,
      ),
      new RegExp(
        `@blueprint\\.(get|post|put|delete|patch|route)\\(['"]${escaped}['"]`,
      ),
    ],
    tsjs: [
      new RegExp(
        `(app|router)\\.(get|post|put|delete|patch|use)\\(['"]${escaped}['"]`,
      ),
      new RegExp(
        `\\.route\\(['"]${escaped}['"]\\)\\.(get|post|put|delete|patch)`,
      ),
    ],
    go: [
      new RegExp(`(mux|router|r)\\.HandleFunc\\(['"]${escaped}['"]`),
      // chi/gin/echo: r.GET("/path", ...)
      new RegExp(
        `(mux|router|r)\\.(GET|POST|PUT|DELETE|PATCH)\\(['"]${escaped}['"]`,
      ),
    ],
  };
}

const endpointScanner: BuiltinEvaluator = async (
  filePaths: string[],
  args: Record<string, unknown>,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> => {
  const endpoint =
    typeof args.exposes_endpoint === 'string' ? args.exposes_endpoint : '';
  if (!endpoint) {
    const finding: Finding = {
      file: ctx.workspaceRoot,
      line: 0,
      severity: 'major',
      message:
        'endpoint-scanner requires args.exposes_endpoint (got empty/undefined)',
    };
    return { passed: false, findings: [finding] };
  }

  const escaped = escapeRegex(endpoint);
  const patterns = buildPatterns(escaped);
  let scanned = 0;

  for (const relOrAbs of filePaths) {
    const ext = extname(relOrAbs).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;
    const abs = isAbsolute(relOrAbs)
      ? relOrAbs
      : join(ctx.workspaceRoot, relOrAbs);
    let contents: string;
    try {
      contents = readFileSync(abs, 'utf8');
    } catch {
      // Unreadable — skip without finding; this evaluator scans for route
      // presence, not file health.
      continue;
    }
    scanned += 1;
    for (const re of patterns[lang]) {
      if (re.test(contents)) {
        return { passed: true, findings: [] };
      }
    }
  }

  const finding: Finding = {
    file: ctx.workspaceRoot,
    line: 0,
    severity: 'major',
    message: `endpoint ${endpoint} not found in ${scanned} scanned files`,
  };
  return { passed: false, findings: [finding] };
};

export default endpointScanner;
