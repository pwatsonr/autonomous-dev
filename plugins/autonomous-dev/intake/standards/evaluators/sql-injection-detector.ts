/**
 * `sql-injection-detector` built-in evaluator (SPEC-021-2-02, Task 3).
 *
 * Cross-language scan for unsafe string-formed SQL: f-strings, `.format()`,
 * concatenation, template literals, `String.format` (JVM). Each detector is
 * anchored on a SQL keyword (SELECT/INSERT/UPDATE/DELETE/DROP/WHERE) so
 * arbitrary text can never trigger catastrophic backtracking — the keyword
 * is a strong literal anchor.
 *
 * All patterns are evaluator-controlled and reviewed for ReDoS at code
 * review time. They run in-process (NOT routed through the ReDoS sandbox)
 * because (a) trusted code, (b) routing trusted patterns through workers
 * adds 50ms per file with no security gain.
 *
 * Args contract: `{}` — no per-rule arguments.
 *
 * @module intake/standards/evaluators/sql-injection-detector
 */

import { readFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';

import type {
  BuiltinEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  Finding,
} from './types';

type Lang = 'python' | 'jstsx' | 'jvm';

const LANG_BY_EXT: Record<string, Lang> = {
  '.py': 'python',
  '.ts': 'jstsx',
  '.tsx': 'jstsx',
  '.js': 'jstsx',
  '.jsx': 'jstsx',
  '.java': 'jvm',
  '.kt': 'jvm',
  '.scala': 'jvm',
};

interface PatternDef {
  id: string;
  re: RegExp;
}

const PATTERNS: Record<Lang, PatternDef[]> = {
  python: [
    { id: 'PY-FSTRING-1', re: /f["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE|DROP)\b[^"'\n]*\{[^}]+\}[^"'\n]*["']/i },
    { id: 'PY-FSTRING-2', re: /f["'][^"'\n]*\bWHERE\b[^"'\n]*\{[^}]+\}[^"'\n]*["']/i },
    { id: 'PY-FORMAT', re: /["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']\.format\(/i },
    { id: 'PY-PERCENT', re: /["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*%s[^"'\n]*["']\s*%/i },
    { id: 'PY-CONCAT', re: /["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']\s*\+\s*\w+/i },
  ],
  jstsx: [
    { id: 'JS-TEMPLATE', re: /`[^`\n]*\b(SELECT|INSERT|UPDATE|DELETE|DROP)\b[^`\n]*\$\{[^}]+\}[^`\n]*`/i },
    { id: 'JS-CONCAT', re: /["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']\s*\+\s*\w+/i },
    { id: 'JS-REPLACE', re: /["'][^"'\n]*\b(SELECT|INSERT|UPDATE)\b[^"'\n]*["']\.replace\(/i },
  ],
  jvm: [
    { id: 'JAVA-FORMAT', re: /String\.format\s*\(\s*["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']/i },
    { id: 'JAVA-CONCAT', re: /["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']\s*\+\s*\w+/i },
    { id: 'JAVA-MSGFMT', re: /MessageFormat\.format\s*\(\s*["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']/i },
  ],
};

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function lineExcerpt(text: string, offset: number): string {
  let start = offset;
  while (start > 0 && text.charCodeAt(start - 1) !== 10) start -= 1;
  let end = offset;
  while (end < text.length && text.charCodeAt(end) !== 10) end += 1;
  const excerpt = text.slice(start, end).trim();
  return excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt;
}

const sqlInjectionDetector: BuiltinEvaluator = async (
  filePaths: string[],
  _args: Record<string, unknown>,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> => {
  const findings: Finding[] = [];
  for (const relOrAbs of filePaths) {
    const ext = extname(relOrAbs).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;
    const abs = isAbsolute(relOrAbs) ? relOrAbs : join(ctx.workspaceRoot, relOrAbs);
    let contents: string;
    try {
      contents = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const { id, re } of PATTERNS[lang]) {
      // Use a sticky-free, multi-match scan on a per-line basis to avoid
      // catastrophic backtracking on very long single lines while still
      // returning per-line findings. The pattern itself is anchored on a SQL
      // keyword, so per-line scanning is correct.
      const lines = contents.split(/\r?\n/);
      let offset = 0;
      for (const line of lines) {
        const m = re.exec(line);
        if (m) {
          findings.push({
            file: abs,
            line: lineOfOffset(contents, offset),
            severity: 'critical',
            message: `${id}: ${lineExcerpt(contents, offset)}`,
          });
        }
        offset += line.length + 1; // +1 for the newline that split removed
      }
    }
  }
  return { passed: findings.length === 0, findings };
};

export default sqlInjectionDetector;
