/**
 * Tests for framework-detector built-in evaluator (SPEC-021-2-01).
 *
 * Acceptance criteria coverage:
 *   - package.json hit (fastapi)
 *   - package.json miss (flask only)
 *   - no manifest → finding line 0
 *   - alias + implication (next implies react)
 *   - pyproject.toml PEP 621 hit
 *   - malformed manifest does not throw
 *   - determinism (snapshot of two consecutive calls)
 *
 * @module tests/standards/evaluators/framework-detector.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import frameworkDetector from '../../../intake/standards/evaluators/framework-detector';
import type { EvaluatorContext } from '../../../intake/standards/evaluators/types';

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'fd-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ctx(root: string): EvaluatorContext {
  return { workspaceRoot: root };
}

describe('framework-detector', () => {
  it('passes when package.json declares the framework (positive: fastapi)', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'package.json'),
        JSON.stringify({ dependencies: { fastapi: '^0.100' } }),
      );
      const r = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(r.passed).toBe(true);
      expect(r.findings).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  it('fails when package.json declares a different framework (negative)', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'package.json'),
        JSON.stringify({ dependencies: { flask: '^2.0' } }),
      );
      const r = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(r.passed).toBe(false);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].file).toContain('package.json');
      expect(r.findings[0].message).toContain("framework 'fastapi' not declared");
    } finally {
      ws.cleanup();
    }
  });

  it('returns missing-manifest finding when no manifest exists', async () => {
    const ws = workspace();
    try {
      const r = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(r.passed).toBe(false);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].line).toBe(0);
      expect(r.findings[0].message).toContain('no dependency manifest found');
    } finally {
      ws.cleanup();
    }
  });

  it('alias resolution: next satisfies a request for react', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'package.json'),
        JSON.stringify({ dependencies: { next: '^14' } }),
      );
      const r = await frameworkDetector([], { framework_match: 'react' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('PEP 621 pyproject.toml: dependencies = ["fastapi>=0.100"]', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'pyproject.toml'),
        [
          '[project]',
          'name = "demo"',
          'dependencies = ["fastapi>=0.100", "uvicorn"]',
        ].join('\n'),
      );
      const r = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('Poetry-style pyproject.toml is parsed', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'pyproject.toml'),
        [
          '[tool.poetry.dependencies]',
          'python = "^3.11"',
          'fastapi = "^0.100"',
        ].join('\n'),
      );
      const r = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('multi-line PEP 621 dependencies array is handled', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'pyproject.toml'),
        [
          '[project]',
          'dependencies = [',
          '  "fastapi>=0.100",',
          '  "uvicorn",',
          ']',
        ].join('\n'),
      );
      const r = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('requirements.txt with version specs and comments', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'requirements.txt'),
        '# top comment\nflask==2.0.3\n# trailing\n-r dev.txt\n',
      );
      const r = await frameworkDetector([], { framework_match: 'flask' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('malformed package.json does not throw — returns parse-failure finding', async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.root, 'package.json'), '{not-json');
      const r = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].severity).toBe('major');
      expect(r.findings[0].message).toContain('failed to parse');
    } finally {
      ws.cleanup();
    }
  });

  it('empty framework_match args produces a configuration finding', async () => {
    const ws = workspace();
    try {
      const r = await frameworkDetector([], {}, ctx(ws.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('framework_match');
    } finally {
      ws.cleanup();
    }
  });

  it('package.json devDependencies are also matched', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'package.json'),
        JSON.stringify({ devDependencies: { jest: '^29' } }),
      );
      const r = await frameworkDetector([], { framework_match: 'jest' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('determinism: two consecutive calls with identical inputs return identical results', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'package.json'),
        JSON.stringify({ dependencies: { fastapi: '^0.100' } }),
      );
      const a = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      const b = await frameworkDetector([], { framework_match: 'fastapi' }, ctx(ws.root));
      expect(a).toEqual(b);
    } finally {
      ws.cleanup();
    }
  });
});
