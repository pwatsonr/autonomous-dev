/**
 * Tests for dependency-checker built-in evaluator (SPEC-021-2-02).
 *
 * @module tests/standards/evaluators/dependency-checker.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import dependencyChecker from '../../../intake/standards/evaluators/dependency-checker';
import type { EvaluatorContext } from '../../../intake/standards/evaluators/types';

function ws(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dc-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function ctx(root: string): EvaluatorContext {
  return { workspaceRoot: root };
}

describe('dependency-checker', () => {
  it('package.json runtime hit', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'package.json'), JSON.stringify({ dependencies: { axios: '^1.0' } }));
      const r = await dependencyChecker([], { dependency_present: 'axios' }, ctx(w.root));
      expect(r.passed).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it('runtime-only check ignores devDependencies (jest in devDeps, dev:false)', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29' } }));
      const r = await dependencyChecker([], { dependency_present: 'jest', dev: false }, ctx(w.root));
      expect(r.passed).toBe(false);
    } finally {
      w.cleanup();
    }
  });

  it('dev:true includes devDependencies', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29' } }));
      const r = await dependencyChecker([], { dependency_present: 'jest', dev: true }, ctx(w.root));
      expect(r.passed).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it('missing manifest → finding line 0', async () => {
    const w = ws();
    try {
      const r = await dependencyChecker([], { dependency_present: 'whatever' }, ctx(w.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].line).toBe(0);
    } finally {
      w.cleanup();
    }
  });

  it('Poetry dev-dependency hit when dev:true', async () => {
    const w = ws();
    try {
      writeFileSync(
        join(w.root, 'pyproject.toml'),
        '[tool.poetry.dev-dependencies]\npytest = "^7.0"\n',
      );
      const r = await dependencyChecker([], { dependency_present: 'pytest', dev: true }, ctx(w.root));
      expect(r.passed).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it('requirements.txt hit', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'requirements.txt'), 'requests==2.31.0\n');
      const r = await dependencyChecker([], { dependency_present: 'requests' }, ctx(w.root));
      expect(r.passed).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it('miss produces structured finding mentioning the dep name', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'package.json'), JSON.stringify({ dependencies: { axios: '^1.0' } }));
      const r = await dependencyChecker([], { dependency_present: 'lodash' }, ctx(w.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('lodash');
    } finally {
      w.cleanup();
    }
  });

  it('empty dependency_present is a configuration finding', async () => {
    const w = ws();
    try {
      const r = await dependencyChecker([], {}, ctx(w.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('dependency_present');
    } finally {
      w.cleanup();
    }
  });

  it('malformed package.json does not throw', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'package.json'), '{not-json');
      const r = await dependencyChecker([], { dependency_present: 'x' }, ctx(w.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('failed to parse');
    } finally {
      w.cleanup();
    }
  });
});
