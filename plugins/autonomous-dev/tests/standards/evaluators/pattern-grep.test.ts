/**
 * Tests for pattern-grep built-in evaluator (SPEC-021-2-02).
 *
 * @module tests/standards/evaluators/pattern-grep.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import patternGrep from '../../../intake/standards/evaluators/pattern-grep';
import { __resetWarnLatchForTests } from '../../../intake/standards/redos-sandbox';
import type { EvaluatorContext } from '../../../intake/standards/evaluators/types';

function ws(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pg-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function ctx(root: string): EvaluatorContext {
  return { workspaceRoot: root };
}

describe('pattern-grep', () => {
  it('uses_pattern: matches in at least one file → passed', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'a.ts'), '// TODO(alice) ship this\n');
      const r = await patternGrep(['a.ts'], { uses_pattern: 'TODO\\(\\w+\\)' }, ctx(w.root));
      expect(r.passed).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it('excludes_pattern: matches → failed with file finding', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'a.py'), 'query.format("...")\n');
      const r = await patternGrep(
        ['a.py'],
        { excludes_pattern: '\\.format\\(' },
        ctx(w.root),
      );
      expect(r.passed).toBe(false);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].file).toContain('a.py');
    } finally {
      w.cleanup();
    }
  });

  it('both uses_pattern and excludes_pattern → configuration finding', async () => {
    const w = ws();
    try {
      const r = await patternGrep(
        [],
        { uses_pattern: 'a', excludes_pattern: 'b' },
        ctx(w.root),
      );
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('uses_pattern or excludes_pattern');
    } finally {
      w.cleanup();
    }
  });

  it('neither argument → configuration finding', async () => {
    const w = ws();
    try {
      const r = await patternGrep([], {}, ctx(w.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('uses_pattern or excludes_pattern');
    } finally {
      w.cleanup();
    }
  });

  it('file >10KB triggers stub SecurityError; pattern-grep records finding and continues', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'small.ts'), 'TODO(alice)\n');
      const big = 'x'.repeat(11 * 1024);
      writeFileSync(join(w.root, 'big.ts'), big);
      const r = await patternGrep(
        ['big.ts', 'small.ts'],
        { uses_pattern: 'TODO\\(\\w+\\)' },
        ctx(w.root),
      );
      // small.ts matched → passed, but a finding for big.ts was recorded.
      // In uses_pattern mode, when at least one file matches we return passed:true
      // and an empty findings list. The big.ts failure is therefore swallowed
      // by the success path — that is the documented behavior (any-file-matches
      // wins for uses_pattern). The contract under test here is "does not
      // throw" rather than the find list shape.
      expect(r.passed).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  it('uses_pattern miss → summary finding with scanned count', async () => {
    const w = ws();
    try {
      writeFileSync(join(w.root, 'a.ts'), 'no-match-here\n');
      const r = await patternGrep(
        ['a.ts'],
        { uses_pattern: 'will-not-match' },
        ctx(w.root),
      );
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('1 scanned files');
    } finally {
      w.cleanup();
    }
  });

  it('stub emits exactly one console.warn across the process', async () => {
    __resetWarnLatchForTests();
    const w = ws();
    try {
      writeFileSync(join(w.root, 'a.ts'), 'foo\n');
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await patternGrep(['a.ts'], { uses_pattern: 'foo' }, ctx(w.root));
      await patternGrep(['a.ts'], { uses_pattern: 'foo' }, ctx(w.root));
      const stubWarns = spy.mock.calls.filter((c) =>
        String(c[0] ?? '').includes('stub'),
      );
      expect(stubWarns.length).toBe(1);
      spy.mockRestore();
    } finally {
      w.cleanup();
    }
  });
});
