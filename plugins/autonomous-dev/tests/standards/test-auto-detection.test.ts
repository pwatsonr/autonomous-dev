/**
 * Unit tests for the auto-detection scanner (SPEC-021-1-05, TDD-021 §9).
 *
 * Three blocks:
 *   1. Per-signal correctness — one or more `it` per signal kind, building
 *      throwaway repos under `os.tmpdir()` to keep each test hermetic.
 *   2. Writer determinism — `writeInferredStandards` produces byte-identical
 *      output across two runs on the same input, sorts by id, emits the
 *      mandated comment lines, and the comment-stripped body round-trips
 *      through `loadStandardsFile`.
 *   3. Precision report — runs the scanner against the corpus under
 *      `tests/fixtures/standards/repos/` and asserts the SPEC-021-1-05
 *      ≥0.80 precision floor for every signal kind that produced any
 *      observations. The full report is written to disk for forensic
 *      inspection on regressions.
 *
 * @module tests/standards/test-auto-detection.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AutoDetectionScanner,
  writeInferredStandards,
} from '../../intake/standards/auto-detection';
import { loadStandardsFile } from '../../intake/standards/loader';
import {
  computePrecisionReport,
  ALL_SIGNALS,
} from './precision-report';
import type {
  DetectedRule,
  SignalKind,
} from '../../intake/standards/auto-detection-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpRepo(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `auto-detection-${prefix}-`));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeFile(repo: string, rel: string, content: string): Promise<void> {
  const target = path.join(repo, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function findBySignal(
  detected: DetectedRule[],
  signal: SignalKind,
): DetectedRule[] {
  return detected.filter((d) => d.signal === signal);
}

// ---------------------------------------------------------------------------
// Per-signal correctness
// ---------------------------------------------------------------------------

describe('AutoDetectionScanner — per-signal correctness', () => {
  let repo: string;
  afterEach(async () => {
    if (repo) await rmTmp(repo);
  });

  // ---- framework-dep ---------------------------------------------------

  it('framework-dep (Python): detects fastapi from requirements.txt', async () => {
    repo = await makeTmpRepo('py-req');
    await writeFile(repo, 'requirements.txt', 'fastapi==0.110.0\n');
    const r = await new AutoDetectionScanner(repo).scan();
    const ids = findBySignal(r.detected, 'framework-dep').map((d) => d.rule.id);
    expect(ids).toContain('auto:python-fastapi');
  });

  it('framework-dep (Python): detects fastapi from pyproject.toml', async () => {
    repo = await makeTmpRepo('py-pyproject');
    await writeFile(
      repo,
      'pyproject.toml',
      '[tool.poetry.dependencies]\nfastapi = "^0.110"\n',
    );
    const r = await new AutoDetectionScanner(repo).scan();
    const ids = findBySignal(r.detected, 'framework-dep').map((d) => d.rule.id);
    expect(ids).toContain('auto:python-fastapi');
  });

  it('framework-dep (Node): detects react, vue, express, angular from package.json', async () => {
    repo = await makeTmpRepo('node-fw');
    await writeFile(
      repo,
      'package.json',
      JSON.stringify({
        name: 'fixture',
        dependencies: { react: '18.0.0', express: '4.0.0' },
        devDependencies: { vue: '3.0.0', '@angular/core': '17.0.0' },
      }),
    );
    const r = await new AutoDetectionScanner(repo).scan();
    const ids = findBySignal(r.detected, 'framework-dep').map((d) => d.rule.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'auto:js-react',
        'auto:js-vue',
        'auto:node-express',
        'auto:js-angular',
      ]),
    );
  });

  // ---- linter-config ---------------------------------------------------

  it('linter-config: emits auto:eslint-configured + per-rule entries (capped)', async () => {
    repo = await makeTmpRepo('eslint');
    const rules: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) rules[`rule-${i}`] = 'error';
    await writeFile(repo, '.eslintrc.json', JSON.stringify({ rules }));
    const r = await new AutoDetectionScanner(repo).scan();
    const linter = findBySignal(r.detected, 'linter-config');
    const ids = linter.map((d) => d.rule.id);
    expect(ids).toContain('auto:eslint-configured');
    // 50 per-rule entries, plus the umbrella `auto:eslint-configured`.
    expect(linter).toHaveLength(51);
    expect(ids).toContain('auto:eslint-rule-0');
    // 60 rules > 50 cap — scanner must warn.
    expect(r.warnings.some((w) => w.includes('capped'))).toBe(true);
  });

  // ---- formatter-config -----------------------------------------------

  it.each([
    ['.prettierrc', '{}'],
    ['.prettierrc.json', '{}'],
    ['.prettierrc.yaml', 'semi: true\n'],
    ['.prettierrc.js', 'module.exports = {};\n'],
  ])('formatter-config: detects %s', async (filename, contents) => {
    repo = await makeTmpRepo('prettier');
    await writeFile(repo, filename, contents);
    const r = await new AutoDetectionScanner(repo).scan();
    const ids = findBySignal(r.detected, 'formatter-config').map((d) => d.rule.id);
    expect(ids).toContain('auto:prettier-formatting');
  });

  // ---- tsconfig-strict ------------------------------------------------

  it('tsconfig-strict: full strict mode → auto:typescript-strict-mode', async () => {
    repo = await makeTmpRepo('tsstrict-full');
    await writeFile(
      repo,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const r = await new AutoDetectionScanner(repo).scan();
    const ids = findBySignal(r.detected, 'tsconfig-strict').map((d) => d.rule.id);
    expect(ids).toEqual(['auto:typescript-strict-mode']);
  });

  it('tsconfig-strict: only strictNullChecks → partial entry', async () => {
    repo = await makeTmpRepo('tsstrict-partial');
    await writeFile(
      repo,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { strictNullChecks: true } }),
    );
    const r = await new AutoDetectionScanner(repo).scan();
    const ids = findBySignal(r.detected, 'tsconfig-strict').map((d) => d.rule.id);
    expect(ids).toContain('auto:typescript-strict-null-checks');
    expect(ids).not.toContain('auto:typescript-strict-mode');
  });

  // ---- test-runner-pattern --------------------------------------------

  it('test-runner-pattern: jest.config.json with testMatch', async () => {
    repo = await makeTmpRepo('jest-cfg');
    await writeFile(
      repo,
      'jest.config.json',
      JSON.stringify({ testMatch: ['**/specs/**/*.spec.ts'] }),
    );
    const r = await new AutoDetectionScanner(repo).scan();
    const detected = findBySignal(r.detected, 'test-runner-pattern');
    expect(detected).toHaveLength(1);
    expect(detected[0].rule.id).toBe('auto:test-file-pattern');
    expect(detected[0].rule.requires.uses_pattern).toBe('**/specs/**/*.spec.ts');
  });

  it('test-runner-pattern: package.json#jest field', async () => {
    repo = await makeTmpRepo('jest-pkg');
    await writeFile(
      repo,
      'package.json',
      JSON.stringify({ name: 'fixture', jest: { testMatch: ['**/?(*.)test.ts'] } }),
    );
    const r = await new AutoDetectionScanner(repo).scan();
    const detected = findBySignal(r.detected, 'test-runner-pattern');
    expect(detected).toHaveLength(1);
    expect(detected[0].rule.requires.uses_pattern).toBe('**/?(*.)test.ts');
  });

  // ---- readme-mention -------------------------------------------------

  it('readme-mention: Black, isort, mypy, pytest each fire at confidence 0.6', async () => {
    repo = await makeTmpRepo('readme');
    await writeFile(
      repo,
      'README.md',
      '# project\nUses Black, isort, mypy, and pytest.\n',
    );
    const r = await new AutoDetectionScanner(repo).scan();
    const readme = findBySignal(r.detected, 'readme-mention');
    const ids = readme.map((d) => d.rule.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'auto:readme-mentions-black',
        'auto:readme-mentions-isort',
        'auto:readme-mentions-mypy',
        'auto:readme-mentions-pytest',
      ]),
    );
    for (const d of readme) expect(d.confidence).toBeCloseTo(0.6, 5);
  });

  // ---- negatives ------------------------------------------------------

  it('empty repo returns no detections, no warnings, does not throw', async () => {
    repo = await makeTmpRepo('empty');
    const r = await new AutoDetectionScanner(repo).scan();
    expect(r.detected).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('malformed package.json warns but does not throw', async () => {
    repo = await makeTmpRepo('bad-pkg');
    await writeFile(repo, 'package.json', '{ this is not json');
    const r = await new AutoDetectionScanner(repo).scan();
    expect(r.warnings.some((w) => w.includes('package.json'))).toBe(true);
    // Detection still completes — other signals may still fire.
    expect(Array.isArray(r.detected)).toBe(true);
  });

  it('malformed .eslintrc.json warns but does not throw', async () => {
    repo = await makeTmpRepo('bad-eslint');
    await writeFile(repo, '.eslintrc.json', '{ broken');
    const r = await new AutoDetectionScanner(repo).scan();
    expect(r.warnings.some((w) => w.includes('.eslintrc.json'))).toBe(true);
    const ids = findBySignal(r.detected, 'linter-config').map((d) => d.rule.id);
    expect(ids).not.toContain('auto:eslint-configured');
  });

  it('missing files do not throw (scanner is read-only and best-effort)', async () => {
    repo = await makeTmpRepo('nofiles');
    // No files at all.
    await expect(new AutoDetectionScanner(repo).scan()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Writer determinism
// ---------------------------------------------------------------------------

describe('writeInferredStandards — determinism', () => {
  let repo: string;
  afterEach(async () => {
    if (repo) await rmTmp(repo);
  });

  // Stable input shared by the determinism tests below.
  const fixedDetected: DetectedRule[] = [
    {
      rule: {
        id: 'auto:js-react',
        severity: 'advisory',
        description: 'Detected React dependency',
        applies_to: { language: 'javascript' },
        requires: { framework_match: 'react' },
        evaluator: 'framework-detector',
      },
      confidence: 0.9,
      evidence: ['package.json'],
      signal: 'framework-dep',
    },
    {
      rule: {
        id: 'auto:eslint-configured',
        severity: 'advisory',
        description: 'ESLint configured at the repo root',
        applies_to: { language: 'javascript' },
        requires: { dependency_present: 'eslint' },
        evaluator: 'pattern-grep',
      },
      confidence: 0.9,
      evidence: ['.eslintrc.json'],
      signal: 'linter-config',
    },
    {
      rule: {
        id: 'auto:python-fastapi',
        severity: 'advisory',
        description: 'Detected FastAPI dependency',
        applies_to: { language: 'python' },
        requires: { framework_match: 'fastapi' },
        evaluator: 'framework-detector',
      },
      confidence: 0.9,
      evidence: ['requirements.txt'],
      signal: 'framework-dep',
    },
  ];

  it('byte-identical across two runs on the same input', async () => {
    repo = await makeTmpRepo('det-bytes');
    const a = await writeInferredStandards(repo, fixedDetected);
    const aBytes = await fs.readFile(a.path, 'utf8');
    const b = await writeInferredStandards(repo, fixedDetected);
    const bBytes = await fs.readFile(b.path, 'utf8');
    expect(aBytes).toBe(bBytes);
  });

  it('rules appear sorted alphabetically by rule.id', async () => {
    repo = await makeTmpRepo('det-sort');
    const { path: outPath } = await writeInferredStandards(repo, fixedDetected);
    const text = await fs.readFile(outPath, 'utf8');
    const idLines = text
      .split('\n')
      .filter((l) => /-\s+id:\s+/.test(l));
    const ids = idLines.map((l) => {
      const m = l.match(/-\s+id:\s+(\S+)/);
      return m ? m[1] : '';
    });
    expect(ids).toEqual([...ids].sort());
  });

  it('emits # confidence:, # evidence:, # signal: comments above each rule', async () => {
    repo = await makeTmpRepo('det-comments');
    const { path: outPath } = await writeInferredStandards(repo, fixedDetected);
    const text = await fs.readFile(outPath, 'utf8');
    const confidenceLines = text.match(/^\s*#\s*confidence:/gm) ?? [];
    const evidenceLines = text.match(/^\s*#\s*evidence:/gm) ?? [];
    const signalLines = text.match(/^\s*#\s*signal:/gm) ?? [];
    expect(confidenceLines).toHaveLength(fixedDetected.length);
    expect(evidenceLines).toHaveLength(fixedDetected.length);
    expect(signalLines).toHaveLength(fixedDetected.length);
  });

  it('comment-stripped body round-trips through loadStandardsFile', async () => {
    repo = await makeTmpRepo('det-roundtrip');
    const { path: outPath } = await writeInferredStandards(repo, fixedDetected);
    const r = await loadStandardsFile(outPath);
    // The file IS valid v1 (the inline `#` lines are valid YAML comments)
    // so we don't actually need to strip. But the spec calls out that it
    // must round-trip *with* the comments present, which is the same
    // behavior we exercise here.
    expect(r.errors).toEqual([]);
    expect(r.artifact).not.toBeNull();
    expect(r.artifact?.rules.map((rule) => rule.id).sort()).toEqual(
      fixedDetected.map((d) => d.rule.id).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Precision report
// ---------------------------------------------------------------------------

describe('AutoDetectionScanner — precision report', () => {
  it('per-signal precision ≥ 0.80 across the repo fixture corpus', async () => {
    const report = await computePrecisionReport();

    // Persist the report alongside the test for forensic inspection.
    const outPath = path.join(__dirname, 'precision-report.json');
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    for (const signal of ALL_SIGNALS) {
      const observed =
        report.counts[signal].tp + report.counts[signal].fp;
      // Vacuous precision (no observations) reports as 1.0; either way,
      // the floor must hold.
      expect(
        report.precision[signal],
        // jest-printable label — fails make it obvious which signal slipped.
      ).toBeGreaterThanOrEqual(0.8);
      // Sanity: each repo fixture ought to be parseable.
      if (observed > 0) {
        expect(report.precision[signal]).toBeLessThanOrEqual(1);
      }
    }
  });
});
