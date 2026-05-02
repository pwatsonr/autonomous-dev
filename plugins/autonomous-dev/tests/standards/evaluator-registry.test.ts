/**
 * Tests for EvaluatorRegistry (SPEC-021-2-03).
 *
 * @module tests/standards/evaluator-registry.test
 */

import { EvaluatorRegistry } from '../../intake/standards/evaluator-registry';
import { EvaluatorNotFoundError } from '../../intake/standards/errors';

const BUILTIN_NAMES = [
  'framework-detector',
  'endpoint-scanner',
  'sql-injection-detector',
  'dependency-checker',
  'pattern-grep',
];

describe('EvaluatorRegistry', () => {
  it('auto-registers exactly the 5 built-ins on construction', () => {
    const reg = new EvaluatorRegistry(() => []);
    const list = reg.list();
    expect(list).toHaveLength(5);
    for (const name of BUILTIN_NAMES) {
      const entry = list.find((e) => e.name === name);
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe('builtin');
    }
  });

  it('get(builtin) returns the registered handler; get(unknown) throws EvaluatorNotFoundError', () => {
    const reg = new EvaluatorRegistry(() => []);
    expect(reg.get('framework-detector').kind).toBe('builtin');
    expect(() => reg.get('nope')).toThrow(EvaluatorNotFoundError);
    try {
      reg.get('nope');
    } catch (e) {
      expect((e as EvaluatorNotFoundError).evaluatorName).toBe('nope');
    }
  });

  it('custom evaluator from allowlist is registered with basename name', () => {
    const reg = new EvaluatorRegistry(() => ['/abs/path/to/my-eval.sh']);
    const entry = reg.get('my-eval');
    expect(entry).toEqual({
      kind: 'custom',
      name: 'my-eval',
      absolutePath: '/abs/path/to/my-eval.sh',
    });
  });

  it('basename collision with built-in: built-in wins, custom skipped, warning logged', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reg = new EvaluatorRegistry(() => ['/x/framework-detector.sh']);
    expect(reg.get('framework-detector').kind).toBe('builtin');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('collides'))).toBe(true);
    spy.mockRestore();
  });

  it('reload() preserves built-ins and re-applies the new allowlist', () => {
    let allowlist: string[] = ['/abs/a.sh'];
    const reg = new EvaluatorRegistry(() => allowlist);
    expect(reg.get('a').kind).toBe('custom');

    allowlist = ['/abs/b.sh'];
    reg.reload();
    // Old custom is gone:
    expect(() => reg.get('a')).toThrow(EvaluatorNotFoundError);
    // New custom is present:
    expect(reg.get('b').kind).toBe('custom');
    // All built-ins still present:
    for (const name of BUILTIN_NAMES) {
      expect(reg.get(name).kind).toBe('builtin');
    }
  });

  it('reload() with empty allowlist removes ALL custom entries', () => {
    let allowlist: string[] = ['/abs/a.sh', '/abs/b.sh'];
    const reg = new EvaluatorRegistry(() => allowlist);
    expect(reg.list()).toHaveLength(7); // 5 + 2
    allowlist = [];
    reg.reload();
    expect(reg.list()).toHaveLength(5);
  });

  it('loadAllowlist throwing does not crash construction; logs warning', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reg = new EvaluatorRegistry(() => {
      throw new Error('config read failure');
    });
    expect(reg.list()).toHaveLength(5);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('config read failure'))).toBe(
      true,
    );
    spy.mockRestore();
  });
});
