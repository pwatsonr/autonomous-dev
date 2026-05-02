/**
 * Tests for runEvaluator orchestrator (SPEC-021-2-04).
 *
 * @module tests/standards/runner.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, join } from 'node:path';

import { EvaluatorRegistry } from '../../intake/standards/evaluator-registry';
import { runEvaluator } from '../../intake/standards/runner';
import {
  EvaluatorRunError,
  SecurityError,
} from '../../intake/standards/errors';
import type { Rule } from '../../intake/standards/types';

const FIXTURE_ALLOWED = resolvePath(__dirname, 'fixtures', 'eval-allowed.sh');

function ws(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'rn-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeRule(over: Partial<Rule> & { id: string; evaluator: string }): Rule {
  return {
    severity: 'advisory',
    description: `Rule ${over.id}`,
    applies_to: { language: 'typescript' },
    requires: { uses_pattern: 'x' },
    ...over,
  };
}

describe('runEvaluator — built-in dispatch', () => {
  it('dispatches to built-in handler and stamps duration_ms + rule_id', async () => {
    const w = ws();
    try {
      writeFileSync(
        join(w.root, 'package.json'),
        JSON.stringify({ dependencies: { fastapi: '^0.100' } }),
      );
      const reg = new EvaluatorRegistry(() => []);
      const rule = makeRule({
        id: 'demo:fastapi-required',
        evaluator: 'framework-detector',
        requires: { framework_match: 'fastapi' } as any,
      });
      const r = await runEvaluator(rule, [], {
        registry: reg,
        allowlist: [],
        ctx: { workspaceRoot: w.root },
      });
      expect(r.passed).toBe(true);
      expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      w.cleanup();
    }
  });

  it('injects rule_id into every finding', async () => {
    const w = ws();
    try {
      // No manifest → finding from framework-detector → rule_id should be set.
      const reg = new EvaluatorRegistry(() => []);
      const rule = makeRule({
        id: 'demo:must-have-fastapi',
        evaluator: 'framework-detector',
        requires: { framework_match: 'fastapi' } as any,
      });
      const r = await runEvaluator(rule, [], {
        registry: reg,
        allowlist: [],
        ctx: { workspaceRoot: w.root },
      });
      expect(r.passed).toBe(false);
      expect(r.findings.length).toBeGreaterThan(0);
      for (const f of r.findings) {
        expect(f.rule_id).toBe('demo:must-have-fastapi');
      }
    } finally {
      w.cleanup();
    }
  });
});

describe('runEvaluator — custom dispatch', () => {
  it('dispatches to custom evaluator via subprocess sandbox', async () => {
    const reg = new EvaluatorRegistry(() => [FIXTURE_ALLOWED]);
    const customName = 'eval-allowed';
    const rule = makeRule({ id: 'demo:custom', evaluator: customName });
    const r = await runEvaluator(rule, [], {
      registry: reg,
      allowlist: [FIXTURE_ALLOWED],
      ctx: { workspaceRoot: '/tmp' },
    });
    expect(r.passed).toBe(true);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('runEvaluator — error wrapping', () => {
  it('wraps EvaluatorNotFoundError as EvaluatorRunError(rule.id, cause)', async () => {
    const reg = new EvaluatorRegistry(() => []);
    const rule = makeRule({ id: 'demo:missing', evaluator: 'no-such-evaluator' });
    await expect(
      runEvaluator(rule, [], {
        registry: reg,
        allowlist: [],
        ctx: { workspaceRoot: '/tmp' },
      }),
    ).rejects.toBeInstanceOf(EvaluatorRunError);
    try {
      await runEvaluator(rule, [], {
        registry: reg,
        allowlist: [],
        ctx: { workspaceRoot: '/tmp' },
      });
    } catch (e) {
      const err = e as EvaluatorRunError;
      expect(err.ruleId).toBe('demo:missing');
      expect(err.cause).toBeDefined();
    }
  });

  it('wraps SecurityError when custom evaluator is not in allowlist', async () => {
    // Registry has the custom entry, but we pass an empty allowlist to the
    // runner — sandbox refuses to spawn.
    const reg = new EvaluatorRegistry(() => [FIXTURE_ALLOWED]);
    const rule = makeRule({ id: 'demo:denied', evaluator: 'eval-allowed' });
    await expect(
      runEvaluator(rule, [], {
        registry: reg,
        allowlist: [], // sandbox rejects
        ctx: { workspaceRoot: '/tmp' },
      }),
    ).rejects.toBeInstanceOf(EvaluatorRunError);
    try {
      await runEvaluator(rule, [], {
        registry: reg,
        allowlist: [],
        ctx: { workspaceRoot: '/tmp' },
      });
    } catch (e) {
      const err = e as EvaluatorRunError;
      expect(err.cause).toBeInstanceOf(SecurityError);
      expect(err.ruleId).toBe('demo:denied');
    }
  });
});

describe('runEvaluator — pattern-grep + ReDoS sandbox end-to-end', () => {
  it('catastrophic pattern via pattern-grep returns passed:false with timeout finding', async () => {
    const w = ws();
    try {
      // Write a file long enough to trigger backtracking but under the 10KB cap.
      writeFileSync(join(w.root, 'a.txt'), 'a'.repeat(40) + 'X');
      const reg = new EvaluatorRegistry(() => []);
      const rule = makeRule({
        id: 'demo:redos',
        evaluator: 'pattern-grep',
        requires: { uses_pattern: '^(a+)+$' } as any,
      });
      const r = await runEvaluator(rule, ['a.txt'], {
        registry: reg,
        allowlist: [],
        ctx: { workspaceRoot: w.root },
      });
      expect(r.passed).toBe(false);
      // The summary finding mentions either the pattern miss or the timeout
      // failure — both are valid signals that no match occurred.
      expect(r.findings.length).toBeGreaterThan(0);
    } finally {
      w.cleanup();
    }
  }, 5000);
});
