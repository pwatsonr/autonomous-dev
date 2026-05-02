/**
 * AutoDetectionScanner — repo signal scanner that bootstraps a
 * `standards.yaml` (SPEC-021-1-03, TDD-021 §9).
 *
 * The scanner is intentionally best-effort: it surfaces signals from
 * config files and README mentions, then writes a comment-annotated
 * `.autonomous-dev/standards.inferred.yaml` for operator review. Nothing
 * is auto-promoted to the canonical `standards.yaml`.
 *
 * Six signals (TDD-021 §9):
 *   1. framework-dep      — package.json / requirements.txt / pyproject.toml
 *   2. linter-config      — .eslintrc.json
 *   3. formatter-config   — .prettierrc*
 *   4. tsconfig-strict    — tsconfig.json compilerOptions.strict
 *   5. test-runner-pattern — jest.config.* or package.json#jest
 *   6. readme-mention     — README.md word-boundary match
 *
 * The scanner deliberately does NOT implement the v1.1 "used in 80%+ files"
 * or "single example" rubric tiers — those need AST-aware scanning that is
 * out of scope for v1.
 *
 * @module intake/standards/auto-detection
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import type { Rule } from './types';
import type {
  DetectedRule,
  ScanResult,
  SignalKind,
} from './auto-detection-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Confidence rubric per TDD-021 §9. */
const CONFIDENCE = {
  FRAMEWORK_DEP: 0.9,
  LINTER_RULE: 0.9,
  FORMATTER: 0.9,
  TSCONFIG_STRICT: 0.85,
  JEST_PATTERN: 0.7,
  README_MENTION: 0.6,
} as const;

/** Cap on the number of `auto:eslint-<rule>` entries emitted to avoid drowning the operator. */
const ESLINT_RULE_CAP = 50;

/** Known framework packages → synthesized rule shape. */
const FRAMEWORK_MAP: Record<string, { id: string; description: string }> = {
  fastapi: { id: 'auto:python-fastapi', description: 'Detected FastAPI dependency' },
  flask: { id: 'auto:python-flask', description: 'Detected Flask dependency' },
  django: { id: 'auto:python-django', description: 'Detected Django dependency' },
  express: { id: 'auto:node-express', description: 'Detected Express dependency' },
  react: { id: 'auto:js-react', description: 'Detected React dependency' },
  vue: { id: 'auto:js-vue', description: 'Detected Vue dependency' },
  '@angular/core': { id: 'auto:js-angular', description: 'Detected Angular dependency' },
};

/** Tools we look for in README.md (case-insensitive, word-boundary). */
const README_TOOLS: ReadonlyArray<{ name: string; id: string }> = [
  { name: 'Black', id: 'auto:readme-mentions-black' },
  { name: 'isort', id: 'auto:readme-mentions-isort' },
  { name: 'mypy', id: 'auto:readme-mentions-mypy' },
  { name: 'pytest', id: 'auto:readme-mentions-pytest' },
  { name: 'RuboCop', id: 'auto:readme-mentions-rubocop' },
  { name: 'Standard', id: 'auto:readme-mentions-standard' },
];

/** Prettier config file names to probe (any one of these = formatter-config signal). */
const PRETTIER_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
];

/** Jest config file names to probe. */
const JEST_CONFIG_FILES = [
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
  'jest.config.ts',
  'jest.config.json',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Build a fully-formed Rule object that satisfies standards-v1.json. */
function makeRule(
  id: string,
  description: string,
  evaluator: string,
  applies_to: Rule['applies_to'],
  requires: Rule['requires'],
): Rule {
  return {
    id,
    severity: 'advisory',
    description,
    applies_to,
    requires,
    evaluator,
  };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export class AutoDetectionScanner {
  constructor(private readonly repoPath: string) {}

  /** Run all six signal handlers and return aggregated results. */
  async scan(): Promise<ScanResult> {
    const detected: DetectedRule[] = [];
    const warnings: string[] = [];

    detected.push(...(await this.detectFrameworkDeps(warnings)));
    detected.push(...(await this.detectLinterConfig(warnings)));
    detected.push(...(await this.detectFormatterConfig()));
    detected.push(...(await this.detectTsconfigStrict(warnings)));
    detected.push(...(await this.detectTestRunnerPattern(warnings)));
    detected.push(...(await this.detectReadmeMentions()));

    return { detected, warnings };
  }

  // ---- Signal 1: framework deps -----------------------------------------

  private async detectFrameworkDeps(warnings: string[]): Promise<DetectedRule[]> {
    const out: DetectedRule[] = [];

    // package.json (Node)
    const pkgPath = path.join(this.repoPath, 'package.json');
    const pkgRaw = await readFileSafe(pkgPath);
    if (pkgRaw !== null) {
      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(pkgRaw);
      } catch (e) {
        warnings.push(`package.json failed to parse: ${(e as Error).message}`);
        pkg = {};
      }
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const dep of Object.keys(allDeps)) {
        const meta = FRAMEWORK_MAP[dep];
        if (!meta) continue;
        out.push({
          rule: makeRule(
            meta.id,
            meta.description,
            'framework-detector',
            { language: 'javascript' },
            { framework_match: dep },
          ),
          confidence: CONFIDENCE.FRAMEWORK_DEP,
          evidence: ['package.json'],
          signal: 'framework-dep',
        });
      }
    }

    // requirements.txt (Python, simple line-based)
    const reqPath = path.join(this.repoPath, 'requirements.txt');
    const reqRaw = await readFileSafe(reqPath);
    if (reqRaw !== null) {
      for (const line of reqRaw.split('\n')) {
        const name = line
          .trim()
          .split(/[<>=!~ ;]/)[0]
          .toLowerCase();
        const meta = FRAMEWORK_MAP[name];
        if (!meta) continue;
        if (out.some((d) => d.rule.id === meta.id)) continue;
        out.push({
          rule: makeRule(
            meta.id,
            meta.description,
            'framework-detector',
            { language: 'python' },
            { framework_match: name },
          ),
          confidence: CONFIDENCE.FRAMEWORK_DEP,
          evidence: ['requirements.txt'],
          signal: 'framework-dep',
        });
      }
    }

    // pyproject.toml (Python; minimal grep — we don't pull in a TOML parser).
    const pyprojPath = path.join(this.repoPath, 'pyproject.toml');
    const pyprojRaw = await readFileSafe(pyprojPath);
    if (pyprojRaw !== null) {
      for (const name of Object.keys(FRAMEWORK_MAP)) {
        // Match `name = "..."` or `"name" = "..."` in [tool.poetry.dependencies] etc.
        const re = new RegExp(`(^|\\n)\\s*['"]?${escapeRegex(name)}['"]?\\s*=`, 'i');
        if (!re.test(pyprojRaw)) continue;
        const meta = FRAMEWORK_MAP[name];
        if (out.some((d) => d.rule.id === meta.id)) continue;
        out.push({
          rule: makeRule(
            meta.id,
            meta.description,
            'framework-detector',
            { language: 'python' },
            { framework_match: name },
          ),
          confidence: CONFIDENCE.FRAMEWORK_DEP,
          evidence: ['pyproject.toml'],
          signal: 'framework-dep',
        });
      }
    }

    return out;
  }

  // ---- Signal 2: linter config ------------------------------------------

  private async detectLinterConfig(warnings: string[]): Promise<DetectedRule[]> {
    const out: DetectedRule[] = [];
    const eslintPath = path.join(this.repoPath, '.eslintrc.json');
    const raw = await readFileSafe(eslintPath);
    if (raw === null) return out;

    let parsed: { rules?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      warnings.push(`.eslintrc.json failed to parse: ${(e as Error).message}`);
      return out;
    }

    out.push({
      rule: makeRule(
        'auto:eslint-configured',
        'ESLint configured at the repo root',
        'pattern-grep',
        { language: 'javascript' },
        { dependency_present: 'eslint' },
      ),
      confidence: CONFIDENCE.LINTER_RULE,
      evidence: ['.eslintrc.json'],
      signal: 'linter-config',
    });

    const ruleNames = Object.keys(parsed.rules ?? {});
    const capped = ruleNames.slice(0, ESLINT_RULE_CAP);
    if (ruleNames.length > ESLINT_RULE_CAP) {
      warnings.push(
        `.eslintrc.json: ${ruleNames.length} rules found; capped at ${ESLINT_RULE_CAP}.`,
      );
    }
    for (const ruleName of capped) {
      const id = `auto:eslint-${kebab(ruleName)}`;
      out.push({
        rule: makeRule(
          id,
          `ESLint rule ${ruleName} configured`,
          'pattern-grep',
          { language: 'javascript' },
          { uses_pattern: ruleName },
        ),
        confidence: CONFIDENCE.LINTER_RULE,
        evidence: ['.eslintrc.json'],
        signal: 'linter-config',
      });
    }
    return out;
  }

  // ---- Signal 3: formatter config ---------------------------------------

  private async detectFormatterConfig(): Promise<DetectedRule[]> {
    for (const f of PRETTIER_FILES) {
      if (await pathExists(path.join(this.repoPath, f))) {
        return [
          {
            rule: makeRule(
              'auto:prettier-formatting',
              'Prettier configured at the repo root',
              'pattern-grep',
              { language: 'javascript' },
              { dependency_present: 'prettier' },
            ),
            confidence: CONFIDENCE.FORMATTER,
            evidence: [f],
            signal: 'formatter-config',
          },
        ];
      }
    }
    return [];
  }

  // ---- Signal 4: tsconfig strict ----------------------------------------

  private async detectTsconfigStrict(warnings: string[]): Promise<DetectedRule[]> {
    const tsPath = path.join(this.repoPath, 'tsconfig.json');
    const raw = await readFileSafe(tsPath);
    if (raw === null) return [];
    let parsed: {
      compilerOptions?: {
        strict?: boolean;
        strictNullChecks?: boolean;
        noImplicitAny?: boolean;
        strictFunctionTypes?: boolean;
        strictBindCallApply?: boolean;
        strictPropertyInitialization?: boolean;
        alwaysStrict?: boolean;
        useUnknownInCatchVariables?: boolean;
      };
    };
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      warnings.push(`tsconfig.json failed to parse: ${(e as Error).message}`);
      return [];
    }
    const co = parsed.compilerOptions ?? {};
    if (co.strict === true) {
      return [
        {
          rule: makeRule(
            'auto:typescript-strict-mode',
            'TypeScript strict mode enabled',
            'config-flag',
            { language: 'typescript' },
            { uses_pattern: 'strict' },
          ),
          confidence: CONFIDENCE.TSCONFIG_STRICT,
          evidence: ['tsconfig.json'],
          signal: 'tsconfig-strict',
        },
      ];
    }
    // Partial strict flags.
    const partials: Array<{ key: keyof NonNullable<typeof parsed.compilerOptions>; id: string }> = [
      { key: 'strictNullChecks', id: 'auto:typescript-strict-null-checks' },
      { key: 'noImplicitAny', id: 'auto:typescript-no-implicit-any' },
      { key: 'strictFunctionTypes', id: 'auto:typescript-strict-function-types' },
    ];
    const out: DetectedRule[] = [];
    for (const { key, id } of partials) {
      if (co[key] === true) {
        out.push({
          rule: makeRule(
            id,
            `TypeScript ${key} enabled`,
            'config-flag',
            { language: 'typescript' },
            { uses_pattern: key },
          ),
          confidence: CONFIDENCE.TSCONFIG_STRICT,
          evidence: ['tsconfig.json'],
          signal: 'tsconfig-strict',
        });
      }
    }
    return out;
  }

  // ---- Signal 5: test runner pattern ------------------------------------

  private async detectTestRunnerPattern(warnings: string[]): Promise<DetectedRule[]> {
    // Standalone jest config file.
    for (const f of JEST_CONFIG_FILES) {
      const p = path.join(this.repoPath, f);
      if (!(await pathExists(p))) continue;
      const raw = await readFileSafe(p);
      let pattern = '**/*.test.{js,ts}';
      if (raw && f.endsWith('.json')) {
        try {
          const parsed = JSON.parse(raw) as { testMatch?: string[] };
          if (parsed.testMatch?.[0]) pattern = parsed.testMatch[0];
        } catch (e) {
          warnings.push(`${f} failed to parse: ${(e as Error).message}`);
        }
      } else if (raw) {
        const m = raw.match(/testMatch\s*:\s*\[\s*['"]([^'"]+)['"]/);
        if (m) pattern = m[1];
      }
      return [
        {
          rule: makeRule(
            'auto:test-file-pattern',
            'Jest test file pattern detected',
            'pattern-grep',
            { language: 'javascript' },
            { uses_pattern: pattern },
          ),
          confidence: CONFIDENCE.JEST_PATTERN,
          evidence: [f],
          signal: 'test-runner-pattern',
        },
      ];
    }

    // package.json#jest
    const pkgPath = path.join(this.repoPath, 'package.json');
    const pkgRaw = await readFileSafe(pkgPath);
    if (pkgRaw !== null) {
      try {
        const pkg = JSON.parse(pkgRaw) as { jest?: { testMatch?: string[] } };
        if (pkg.jest) {
          const pattern = pkg.jest.testMatch?.[0] ?? '**/*.test.{js,ts}';
          return [
            {
              rule: makeRule(
                'auto:test-file-pattern',
                'Jest test file pattern detected (package.json#jest)',
                'pattern-grep',
                { language: 'javascript' },
                { uses_pattern: pattern },
              ),
              confidence: CONFIDENCE.JEST_PATTERN,
              evidence: ['package.json'],
              signal: 'test-runner-pattern',
            },
          ];
        }
      } catch {
        // Already warned about in detectFrameworkDeps; do not double-warn.
      }
    }
    return [];
  }

  // ---- Signal 6: README mentions ----------------------------------------

  private async detectReadmeMentions(): Promise<DetectedRule[]> {
    const readmePath = path.join(this.repoPath, 'README.md');
    const raw = await readFileSafe(readmePath);
    if (raw === null) return [];
    const out: DetectedRule[] = [];
    for (const tool of README_TOOLS) {
      const re = new RegExp(`\\b${escapeRegex(tool.name)}\\b`, 'i');
      if (!re.test(raw)) continue;
      out.push({
        rule: makeRule(
          tool.id,
          `README.md mentions ${tool.name}`,
          'pattern-grep',
          { path_pattern: 'README.md' },
          { uses_pattern: tool.name },
        ),
        confidence: CONFIDENCE.README_MENTION,
        evidence: ['README.md'],
        signal: 'readme-mention',
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Output writer
// ---------------------------------------------------------------------------

/**
 * Serialize the detected rule list to `<repo>/.autonomous-dev/standards.inferred.yaml`.
 *
 * Determinism: sorts by rule id, sorts YAML keys, emits `last_updated` as
 * date-only — two same-day runs against identical input produce
 * byte-identical output.
 */
export async function writeInferredStandards(
  repoPath: string,
  detected: DetectedRule[],
): Promise<{ path: string; bytes: number }> {
  const outDir = path.join(repoPath, '.autonomous-dev');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'standards.inferred.yaml');

  const sorted = [...detected].sort((a, b) => a.rule.id.localeCompare(b.rule.id));

  const lines: string[] = [];
  lines.push('# This file is auto-generated by `autonomous-dev standards scan`.');
  lines.push('# Review each rule and promote to standards.yaml after operator review.');
  lines.push('# Confidence and evidence are documented as comments next to each rule.');
  lines.push('');
  lines.push('version: "1"');
  lines.push('metadata:');
  lines.push('  name: "Inferred Standards"');
  lines.push('  description: "Auto-detected from repo signals; not yet promoted."');
  lines.push('  owner: "auto-detection-scanner"');
  lines.push(`  last_updated: "${new Date().toISOString().slice(0, 10)}"`);
  lines.push('rules:');

  if (sorted.length === 0) {
    lines.push('  []');
  }

  for (const d of sorted) {
    lines.push(`  # confidence: ${d.confidence.toFixed(2)}`);
    lines.push(`  # evidence: ${JSON.stringify(d.evidence)}`);
    lines.push(`  # signal: ${d.signal}`);
    const dumped = yaml.dump([d.rule], { indent: 2, lineWidth: 100, sortKeys: true });
    // Each non-empty line gets a 2-space indent so the array sits under `rules:`.
    for (const l of dumped.split('\n')) {
      lines.push(l.length ? `  ${l}` : l);
    }
  }

  // Drop trailing blank lines, then re-add a single newline at EOF.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const content = `${lines.join('\n')}\n`;
  await fs.writeFile(outPath, content, 'utf8');
  return { path: outPath, bytes: Buffer.byteLength(content) };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function kebab(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { CONFIDENCE, ESLINT_RULE_CAP, FRAMEWORK_MAP, README_TOOLS };
export type { DetectedRule, ScanResult, SignalKind };
