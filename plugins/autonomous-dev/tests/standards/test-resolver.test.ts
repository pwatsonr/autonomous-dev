/**
 * Unit tests for the InheritanceResolver (SPEC-021-1-05, TDD-021 §8 + §14).
 *
 * Covers the eight TDD §14 scenarios (S1-S8) and four edge cases (E1-E4)
 * defined in SPEC-021-1-05. The resolver is exercised programmatically
 * (no fixtures) so each scenario stays small enough to read in one screen.
 *
 * @module tests/standards/test-resolver.test
 */

import { performance } from 'node:perf_hooks';

import { resolveStandards } from '../../intake/standards/resolver';
import {
  ValidationError,
  AuthorizationError,
} from '../../intake/standards/errors';
import * as authModule from '../../intake/standards/auth';
import type { Rule } from '../../intake/standards/types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Build a minimal Rule, overriding any subset of fields. */
function makeRule(overrides: Partial<Rule> & { id: string }): Rule {
  return {
    severity: 'advisory',
    description: `Rule ${overrides.id}`,
    applies_to: { language: 'typescript' },
    requires: { uses_pattern: 'x' },
    evaluator: 'pattern-grep',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TDD §14 scenarios — S1..S8
// ---------------------------------------------------------------------------

describe('resolveStandards — TDD §14 scenarios', () => {
  it('S1: defaults only — every rule sourced as `default`', () => {
    const defaults = [
      makeRule({ id: 'plat:rule-a' }),
      makeRule({ id: 'plat:rule-b' }),
    ];
    const r = resolveStandards(defaults, [], [], []);
    expect(r.rules.size).toBe(2);
    expect(r.source.get('plat:rule-a')).toBe('default');
    expect(r.source.get('plat:rule-b')).toBe('default');
  });

  it('S2: org overrides default — same id, source becomes `org`', () => {
    const def = [makeRule({ id: 'plat:rule-a', description: 'from default' })];
    const org = [makeRule({ id: 'plat:rule-a', description: 'from org' })];
    const r = resolveStandards(def, org, [], []);
    expect(r.rules.get('plat:rule-a')?.description).toBe('from org');
    expect(r.source.get('plat:rule-a')).toBe('org');
  });

  it('S3: repo overrides org (mutable) — same id, source becomes `repo`', () => {
    const def = [makeRule({ id: 'plat:rule-a' })];
    const org = [makeRule({ id: 'plat:rule-a', description: 'from org' })];
    const repo = [makeRule({ id: 'plat:rule-a', description: 'from repo' })];
    const r = resolveStandards(def, org, repo, []);
    expect(r.rules.get('plat:rule-a')?.description).toBe('from repo');
    expect(r.source.get('plat:rule-a')).toBe('repo');
  });

  it('S4: repo cannot override immutable org rule — throws ValidationError with rule id', () => {
    const def: Rule[] = [];
    const org = [
      makeRule({ id: 'plat:locked', immutable: true, description: 'org locked' }),
    ];
    const repo = [makeRule({ id: 'plat:locked', description: 'repo attempt' })];
    expect(() => resolveStandards(def, org, repo, [])).toThrow(ValidationError);
    expect(() => resolveStandards(def, org, repo, [])).toThrow(/plat:locked/);
  });

  it('S5: per-request override without admin — throws AuthorizationError', () => {
    const def = [makeRule({ id: 'plat:rule-a' })];
    const requestRules = [
      makeRule({ id: 'plat:rule-a', description: 'from request' }),
    ];
    // Default isAdminRequest() returns false; do not mock here.
    expect(() => resolveStandards(def, [], [], requestRules)).toThrow(
      AuthorizationError,
    );
  });

  it('S6: per-request override with admin (mocked) — applied, source `request`', () => {
    const def = [makeRule({ id: 'plat:rule-a', description: 'from default' })];
    const requestRules = [
      makeRule({ id: 'plat:rule-a', description: 'from request' }),
    ];
    const spy = jest.spyOn(authModule, 'isAdminRequest').mockReturnValue(true);
    try {
      const r = resolveStandards(def, [], [], requestRules);
      expect(r.rules.get('plat:rule-a')?.description).toBe('from request');
      expect(r.source.get('plat:rule-a')).toBe('request');
    } finally {
      spy.mockRestore();
    }
  });

  it('S7: rule unique to org level — appears with source `org`', () => {
    const def = [makeRule({ id: 'plat:rule-a' })];
    const org = [makeRule({ id: 'org:org-only' })];
    const r = resolveStandards(def, org, [], []);
    expect(r.rules.has('org:org-only')).toBe(true);
    expect(r.source.get('org:org-only')).toBe('org');
  });

  it('S8: rule unique to repo level — appears with source `repo`', () => {
    const def = [makeRule({ id: 'plat:rule-a' })];
    const repo = [makeRule({ id: 'repo:repo-only' })];
    const r = resolveStandards(def, [], repo, []);
    expect(r.rules.has('repo:repo-only')).toBe(true);
    expect(r.source.get('repo:repo-only')).toBe('repo');
  });
});

// ---------------------------------------------------------------------------
// Edge cases — E1..E4
// ---------------------------------------------------------------------------

describe('resolveStandards — edge cases', () => {
  it('E1: all four levels empty — returns empty maps without throwing', () => {
    const r = resolveStandards([], [], [], []);
    expect(r.rules.size).toBe(0);
    expect(r.source.size).toBe(0);
  });

  it('E2: duplicate IDs within a single level — last-write-wins', () => {
    const def = [
      makeRule({ id: 'plat:dup', description: 'first' }),
      makeRule({ id: 'plat:dup', description: 'second' }),
    ];
    const r = resolveStandards(def, [], [], []);
    expect(r.rules.size).toBe(1);
    expect(r.rules.get('plat:dup')?.description).toBe('second');
    expect(r.source.get('plat:dup')).toBe('default');
  });

  it('E3: 1000+100+50 rule resolution — median elapsed < 50ms across 5 runs', () => {
    const defaults: Rule[] = Array.from({ length: 1000 }, (_, i) =>
      makeRule({ id: `plat:def-${i}` }),
    );
    const org: Rule[] = Array.from({ length: 100 }, (_, i) =>
      makeRule({ id: `plat:def-${i}`, description: 'org override' }),
    );
    const repo: Rule[] = Array.from({ length: 50 }, (_, i) =>
      makeRule({ id: `plat:def-${i}`, description: 'repo override' }),
    );

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const r = resolveStandards(defaults, org, repo, []);
      const elapsed = performance.now() - t0;
      // Touch the result so the JIT cannot DCE the call.
      expect(r.rules.size).toBe(1000);
      samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2];
    expect(median).toBeLessThan(50);
  });

  it('E4: immutable flag at default level — does not block org override (defaults always mutable)', () => {
    // Defaults can carry `immutable: true` syntactically, but the resolver
    // only enforces immutability at the org→repo step. Org must still be
    // able to override defaults regardless of the flag's value.
    const def = [
      makeRule({
        id: 'plat:rule-a',
        immutable: true,
        description: 'default (flag ignored)',
      }),
    ];
    const org = [makeRule({ id: 'plat:rule-a', description: 'from org' })];
    const r = resolveStandards(def, org, [], []);
    expect(r.rules.get('plat:rule-a')?.description).toBe('from org');
    expect(r.source.get('plat:rule-a')).toBe('org');
  });
});

// ---------------------------------------------------------------------------
// Additional inheritance / source-tracking coverage
// ---------------------------------------------------------------------------

describe('resolveStandards — inheritance & source tracking', () => {
  it('parent only: defaults present, no overrides → all sourced `default`', () => {
    const def = [
      makeRule({ id: 'plat:a' }),
      makeRule({ id: 'plat:b' }),
      makeRule({ id: 'plat:c' }),
    ];
    const r = resolveStandards(def, [], [], []);
    for (const id of ['plat:a', 'plat:b', 'plat:c']) {
      expect(r.source.get(id)).toBe('default');
    }
  });

  it('parent + child: org adds new + overrides one → mixed sources', () => {
    const def = [makeRule({ id: 'plat:a' }), makeRule({ id: 'plat:b' })];
    const org = [
      makeRule({ id: 'plat:a', description: 'org override' }),
      makeRule({ id: 'org:c' }),
    ];
    const r = resolveStandards(def, org, [], []);
    expect(r.source.get('plat:a')).toBe('org');
    expect(r.source.get('plat:b')).toBe('default');
    expect(r.source.get('org:c')).toBe('org');
  });

  it('3-level chain: default → org → repo, source tracks each step', () => {
    const def = [makeRule({ id: 'plat:a', description: 'default' })];
    const org = [makeRule({ id: 'plat:a', description: 'org' })];
    const repo = [makeRule({ id: 'plat:a', description: 'repo' })];
    const r = resolveStandards(def, org, repo, []);
    expect(r.rules.get('plat:a')?.description).toBe('repo');
    expect(r.source.get('plat:a')).toBe('repo');
  });

  it('repo overlay: repo adds rules of its own that no other level defined', () => {
    const def = [makeRule({ id: 'plat:a' })];
    const org = [makeRule({ id: 'org:b' })];
    const repo = [
      makeRule({ id: 'repo:c' }),
      makeRule({ id: 'repo:d' }),
    ];
    const r = resolveStandards(def, org, repo, []);
    expect(r.rules.size).toBe(4);
    expect(r.source.get('plat:a')).toBe('default');
    expect(r.source.get('org:b')).toBe('org');
    expect(r.source.get('repo:c')).toBe('repo');
    expect(r.source.get('repo:d')).toBe('repo');
  });
});
