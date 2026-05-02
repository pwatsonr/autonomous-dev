/**
 * `pattern-grep` built-in evaluator (SPEC-021-2-02, Task 5).
 *
 * Generic regex match for `uses_pattern` / `excludes_pattern` rules. This
 * is the ONLY built-in evaluator that runs USER-supplied regex; therefore
 * it is the only one routed through the ReDoS sandbox. The sandbox enforces
 * a 100ms timeout and a 10KB input cap (per file, not per call).
 *
 * Args contract: `{ uses_pattern?: string, excludes_pattern?: string, flags?: string }`.
 * Exactly one of `uses_pattern` / `excludes_pattern` MUST be provided.
 *
 * Behavior is asymmetric:
 *   - `uses_pattern` mode  → passed if AT LEAST ONE file matches.
 *   - `excludes_pattern`   → passed if NO file matches; failures list each
 *                            matching file as a finding.
 *
 * @module intake/standards/evaluators/pattern-grep
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { evaluateRegex } from '../redos-sandbox';
import type {
  BuiltinEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  Finding,
} from './types';

const patternGrep: BuiltinEvaluator = async (
  filePaths: string[],
  args: Record<string, unknown>,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> => {
  const usesPattern = typeof args.uses_pattern === 'string' ? args.uses_pattern : undefined;
  const excludesPattern =
    typeof args.excludes_pattern === 'string' ? args.excludes_pattern : undefined;
  const flags = typeof args.flags === 'string' ? args.flags : '';

  const haveUses = usesPattern !== undefined && usesPattern !== '';
  const haveExcludes = excludesPattern !== undefined && excludesPattern !== '';
  if (haveUses === haveExcludes) {
    // Both or neither — configuration error.
    return {
      passed: false,
      findings: [
        {
          file: ctx.workspaceRoot,
          line: 0,
          severity: 'major',
          message: 'pattern-grep requires uses_pattern or excludes_pattern',
        },
      ],
    };
  }

  const pattern = (haveUses ? usesPattern : excludesPattern) as string;
  const findings: Finding[] = [];
  let matchedFiles = 0;
  let scanned = 0;

  for (const relOrAbs of filePaths) {
    const abs = isAbsolute(relOrAbs) ? relOrAbs : join(ctx.workspaceRoot, relOrAbs);
    let contents: string;
    try {
      contents = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    let result;
    try {
      result = await evaluateRegex(pattern, contents, flags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        file: abs,
        line: 0,
        severity: 'major',
        message: `pattern-grep failed on ${abs}: ${message}`,
      });
      continue;
    }
    if (result.matches) {
      matchedFiles += 1;
      if (haveExcludes) {
        findings.push({
          file: abs,
          line: result.matchLine ?? 0,
          severity: 'major',
          message: `excluded pattern matched: ${pattern}`,
        });
      }
    }
  }

  if (haveUses) {
    if (matchedFiles > 0) return { passed: true, findings: [] };
    return {
      passed: false,
      findings: [
        {
          file: ctx.workspaceRoot,
          line: 0,
          severity: 'major',
          message: `pattern "${pattern}" matched in 0 of ${scanned} scanned files`,
        },
      ],
    };
  }
  // excludes mode
  return { passed: matchedFiles === 0, findings };
};

export default patternGrep;
