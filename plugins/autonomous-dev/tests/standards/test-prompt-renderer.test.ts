/**
 * Unit tests for the standards prompt renderer (SPEC-021-3-04, Task 11).
 *
 * Exercises every branch of `renderStandardsSection()`:
 *   - empty-set sentinel
 *   - single-rule rendering
 *   - multi-severity ordering + within-severity alpha sort
 *   - cap fallback (advisory drops; blocking/warn never dropped)
 *   - custom maxBytes override
 *   - UTF-8 byte counting on multi-byte content
 *   - per-assertion-kind "Do this" derivation table + unknown fallback
 *
 * @module tests/standards/test-prompt-renderer.test
 */

import {
  renderStandardsSection,
  EMPTY_SENTINEL,
  DEFAULT_MAX_BYTES,
  deriveDoThis,
} from '../../intake/standards/prompt-renderer';
import type { Rule } from '../../intake/standards/types';
import type { ResolvedStandards } from '../../intake/standards/resolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResolved(rules: Rule[]): ResolvedStandards {
  const ruleMap = new Map<string, Rule>();
  const sourceMap = new Map<string, 'default' | 'org' | 'repo' | 'request'>();
  for (const r of rules) {
    ruleMap.set(r.id, r);
    sourceMap.set(r.id, 'repo');
  }
  return { rules: ruleMap, source: sourceMap };
}

function makeRule(partial: Partial<Rule> & { id: string; severity: Rule['severity'] }): Rule {
  return {
    id: partial.id,
    severity: partial.severity,
    description: partial.description ?? `Description for ${partial.id}`,
    applies_to: partial.applies_to ?? { language: 'typescript' },
    requires: partial.requires ?? { excludes_pattern: 'eval\\(' },
    evaluator: partial.evaluator ?? 'pattern-matcher',
    immutable: partial.immutable,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('renderStandardsSection', () => {
  it('returns the literal sentinel when the resolver is empty', () => {
    const out = renderStandardsSection(buildResolved([]));
    expect(out).toBe(EMPTY_SENTINEL);
    expect(out).toBe('No standards apply.');
  });

  it('renders a single blocking rule with the derived "Do this" line', () => {
    const rule = makeRule({
      id: 'security:no-sql',
      severity: 'blocking',
      description: 'No string interpolation in SQL',
      requires: { excludes_pattern: '${.*}' },
    });
    const out = renderStandardsSection(buildResolved([rule]));
    expect(out).toContain('### [blocking] security:no-sql');
    expect(out).toContain('No string interpolation in SQL');
    expect(out).toContain('Do this: do not introduce code matching ${.*}.');
    // Exactly one blocking header
    expect(out.match(/### \[blocking\]/g)?.length).toBe(1);
  });

  it('orders blocking → warn → advisory in the rendered output', () => {
    const rules = [
      makeRule({ id: 'a:adv1', severity: 'advisory' }),
      makeRule({ id: 'a:warn1', severity: 'warn' }),
      makeRule({ id: 'a:warn2', severity: 'warn' }),
      makeRule({ id: 'a:block1', severity: 'blocking' }),
      makeRule({ id: 'a:block2', severity: 'blocking' }),
      makeRule({ id: 'a:block3', severity: 'blocking' }),
    ];
    const out = renderStandardsSection(buildResolved(rules));
    const idxBlock = out.indexOf('### [blocking]');
    const idxWarn = out.indexOf('### [warn]');
    const idxAdv = out.indexOf('### [advisory]');
    expect(idxBlock).toBeGreaterThan(-1);
    expect(idxWarn).toBeGreaterThan(idxBlock);
    expect(idxAdv).toBeGreaterThan(idxWarn);
  });

  it('sorts ascending by id within the same severity', () => {
    const rules = [
      makeRule({ id: 'security:zzz', severity: 'blocking' }),
      makeRule({ id: 'security:aaa', severity: 'blocking' }),
    ];
    const out = renderStandardsSection(buildResolved(rules));
    const idxA = out.indexOf('security:aaa');
    const idxZ = out.indexOf('security:zzz');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxZ).toBeGreaterThan(idxA);
  });

  it('drops advisory rules when over the byte cap and emits the summary line', () => {
    const rules: Rule[] = [];
    for (let i = 0; i < 50; i++) {
      const id = String(i).padStart(3, '0');
      rules.push(
        makeRule({
          id: `pad:adv-${id}`,
          severity: 'advisory',
          description:
            'Advisory rule with deliberately verbose description '.repeat(3),
        }),
      );
    }
    const out = renderStandardsSection(buildResolved(rules));
    expect(out).toContain('additional advisory rules apply; see standards.yaml for full list.');
    // Byte length should be capped near the default; allow a small overshoot
    // for the directive footer + summary line that sits OUTSIDE the body.
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 256);
  });

  it('never drops blocking or warn rules even if the cap is exceeded', () => {
    const rules: Rule[] = [];
    for (let i = 0; i < 100; i++) {
      const id = String(i).padStart(3, '0');
      rules.push(
        makeRule({
          id: `pad:block-${id}`,
          severity: 'blocking',
          description: 'Blocking rule, must never be dropped.',
        }),
      );
    }
    const out = renderStandardsSection(buildResolved(rules));
    const headers = out.match(/### \[blocking\]/g) ?? [];
    expect(headers.length).toBe(100);
  });

  it('honors a custom maxBytes override (larger cap retains more advisory rules)', () => {
    const rules: Rule[] = [];
    for (let i = 0; i < 50; i++) {
      const id = String(i).padStart(3, '0');
      rules.push(
        makeRule({
          id: `pad:adv-${id}`,
          severity: 'advisory',
          description: 'Advisory body '.repeat(5),
        }),
      );
    }
    const tight = renderStandardsSection(buildResolved(rules), { maxBytes: 256 });
    const loose = renderStandardsSection(buildResolved(rules), { maxBytes: 8192 });
    expect(loose.length).toBeGreaterThan(tight.length);
  });

  it('renders multi-byte UTF-8 descriptions verbatim and counts bytes correctly', () => {
    const rule = makeRule({
      id: 'i18n:utf8',
      severity: 'blocking',
      description: '使用 UTF-8 编码',
    });
    const out = renderStandardsSection(buildResolved([rule]));
    expect(out).toContain('使用 UTF-8 编码');
    // Sanity: byte length > char length for CJK content
    expect(Buffer.byteLength(out, 'utf8')).toBeGreaterThan(out.length);
  });

  it('renders the safe fallback "Do this" line for unknown assertion kinds', () => {
    const rule: Rule = {
      id: 'future:kind',
      severity: 'advisory',
      description: 'A rule of an as-yet-unknown kind.',
      applies_to: { language: 'go' },
      // Empty requires triggers the fallback derivation path.
      requires: {},
      evaluator: 'future-evaluator',
    };
    const out = renderStandardsSection(buildResolved([rule]));
    expect(out).toContain('Do this: see standards.yaml rule future:kind for the full requirement.');
  });

  describe('per-assertion-kind "Do this" derivation', () => {
    const cases: Array<[string, Rule['requires'], string]> = [
      [
        'framework_match',
        { framework_match: 'fastapi' },
        'Do this: use the fastapi framework for this work.',
      ],
      [
        'exposes_endpoint',
        { exposes_endpoint: { method: 'GET', path_pattern: '/health' } },
        'Do this: ensure the application exposes the /health endpoint with method GET.',
      ],
      [
        'uses_pattern',
        { uses_pattern: '\\bawait\\b' },
        'Do this: use the pattern matching \\bawait\\b in qualifying code.',
      ],
      [
        'excludes_pattern',
        { excludes_pattern: 'console\\.log' },
        'Do this: do not introduce code matching console\\.log.',
      ],
      [
        'dependency_present',
        { dependency_present: 'helmet' },
        'Do this: ensure dependency helmet is declared.',
      ],
      [
        'custom_evaluator_args',
        { custom_evaluator_args: { foo: 'bar' } },
        'Do this: see standards.yaml rule k:custom for the full requirement.',
      ],
    ];

    it.each(cases)('derives the right line for %s', (kind, requires, expected) => {
      const id = kind === 'custom_evaluator_args' ? 'k:custom' : `k:${kind}`;
      const rule = makeRule({
        id,
        severity: 'blocking',
        description: `Test for ${kind}`,
        requires,
      });
      const out = deriveDoThis(rule);
      expect(out).toBe(expected);
    });
  });
});
