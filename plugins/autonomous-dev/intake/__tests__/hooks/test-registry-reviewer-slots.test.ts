/**
 * HookRegistry reviewer-slot index unit tests (SPEC-019-4-01).
 *
 * Covers `getReviewersForGate()`, multi-gate isolation, unregister cleanup,
 * duplicate-rejection, and the defensive-copy contract.
 *
 * @module __tests__/hooks/test-registry-reviewer-slots
 */

import { HookRegistry } from '../../hooks/registry';
import {
  FailureMode,
  HookPoint,
  type HookEntry,
  type HookManifest,
  type ReviewGate,
  type ReviewerSlot,
} from '../../hooks/types';

const ROOT = '/tmp/plugin-root';

function slot(gates: ReviewGate[], agent = 'agent.review'): ReviewerSlot {
  return {
    agent_name: agent,
    review_gates: gates,
    expertise_domains: ['general'],
    minimum_threshold: 60,
  };
}

function entry(
  id: string,
  reviewerSlot?: ReviewerSlot,
  point: HookPoint = HookPoint.ReviewPreScore,
  priority = 50,
): HookEntry {
  const e: HookEntry = {
    id,
    hook_point: point,
    entry_point: `./${id}.js`,
    priority,
    failure_mode: FailureMode.Warn,
  };
  if (reviewerSlot) e.reviewer_slot = reviewerSlot;
  return e;
}

function manifest(id: string, hooks: HookEntry[]): HookManifest {
  return { id, name: id, version: '1.0.0', hooks };
}

describe('HookRegistry reviewer-slot index (SPEC-019-4-01)', () => {
  let reg: HookRegistry;

  beforeEach(() => {
    reg = new HookRegistry();
  });

  test('single-gate registration: only the declared gate sees the reviewer', () => {
    reg.register(manifest('p1', [entry('h', slot(['code-review']))]), ROOT);
    expect(reg.getReviewersForGate('code-review')).toHaveLength(1);
    expect(reg.getReviewersForGate('code-review')[0].pluginId).toBe('p1');
    expect(reg.getReviewersForGate('security-review')).toEqual([]);
    expect(reg.getReviewersForGate('document-review-prd')).toEqual([]);
  });

  test('multi-gate registration: hook is discoverable via every declared gate', () => {
    reg.register(
      manifest('p1', [entry('h', slot(['code-review', 'security-review']))]),
      ROOT,
    );
    expect(reg.getReviewersForGate('code-review')).toHaveLength(1);
    expect(reg.getReviewersForGate('security-review')).toHaveLength(1);
    expect(reg.getReviewersForGate('document-review-tdd')).toEqual([]);
  });

  test('multiple plugins per gate: lookup returns them in registration order', () => {
    reg.register(manifest('plug-a', [entry('ha', slot(['code-review']))]), ROOT);
    reg.register(manifest('plug-b', [entry('hb', slot(['code-review']))]), ROOT);
    const list = reg.getReviewersForGate('code-review');
    expect(list.map((r) => r.pluginId)).toEqual(['plug-a', 'plug-b']);
  });

  test('unregister cleanup: gate key is removed when last reviewer leaves', () => {
    reg.register(manifest('p1', [entry('h', slot(['code-review']))]), ROOT);
    reg.unregister('p1');
    expect(reg.getReviewersForGate('code-review')).toEqual([]);
  });

  test('cross-gate isolation on unregister: every declared gate is cleaned', () => {
    reg.register(
      manifest('p1', [entry('h', slot(['code-review', 'security-review']))]),
      ROOT,
    );
    reg.unregister('p1');
    expect(reg.getReviewersForGate('code-review')).toEqual([]);
    expect(reg.getReviewersForGate('security-review')).toEqual([]);
  });

  test('duplicate registration on the same (plugin_id, gate) is rejected', () => {
    reg.register(manifest('p1', [entry('h1', slot(['code-review']))]), ROOT);
    expect(() =>
      reg.register(manifest('p1', [entry('h2', slot(['code-review']))]), ROOT),
    ).toThrow(/duplicate reviewer-slot/i);
  });

  test('getReviewersForGate returns a defensive copy', () => {
    reg.register(manifest('p1', [entry('h', slot(['code-review']))]), ROOT);
    const first = reg.getReviewersForGate('code-review');
    first.push({} as never);
    const second = reg.getReviewersForGate('code-review');
    expect(second).toHaveLength(1);
    expect(second[0].pluginId).toBe('p1');
  });

  test('hook with no reviewer_slot is invisible to gate lookup but visible at hook point', () => {
    reg.register(manifest('p1', [entry('h', undefined)]), ROOT);
    expect(reg.getReviewersForGate('code-review')).toEqual([]);
    expect(reg.getHooksForPoint(HookPoint.ReviewPreScore)).toHaveLength(1);
  });

  test('legacy string-form reviewer_slot is treated as opaque (not gate-routable)', () => {
    const e = entry('h');
    e.reviewer_slot = 'some-legacy-slot-name';
    reg.register(manifest('p1', [e]), ROOT);
    expect(reg.getReviewersForGate('code-review')).toEqual([]);
    expect(reg.getReviewersForGate('security-review')).toEqual([]);
    // But still indexed by hook point.
    expect(reg.getHooksForPoint(HookPoint.ReviewPreScore)).toHaveLength(1);
  });

  test('clear() empties the reviewer-slot index alongside the hook-point index', () => {
    reg.register(
      manifest('p1', [entry('h', slot(['code-review', 'security-review']))]),
      ROOT,
    );
    reg.clear();
    expect(reg.getReviewersForGate('code-review')).toEqual([]);
    expect(reg.getReviewersForGate('security-review')).toEqual([]);
    expect(reg.size()).toBe(0);
  });

  test('unregister of unrelated plugin leaves reviewer index untouched', () => {
    reg.register(manifest('plug-a', [entry('ha', slot(['code-review']))]), ROOT);
    reg.register(manifest('plug-b', [entry('hb', slot(['code-review']))]), ROOT);
    reg.unregister('plug-a');
    const list = reg.getReviewersForGate('code-review');
    expect(list).toHaveLength(1);
    expect(list[0].pluginId).toBe('plug-b');
  });
});
