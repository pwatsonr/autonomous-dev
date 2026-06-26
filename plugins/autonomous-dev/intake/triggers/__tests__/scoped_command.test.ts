/**
 * Unit tests for the scoped-trigger command parser (ONBOARD Phase 4, #596).
 *
 * @module intake/triggers/scoped_command.test
 */

import {
  parseScopedTrigger,
  MIN_TASK_LENGTH,
  MAX_TASK_LENGTH,
} from '../scoped_command';

describe('parseScopedTrigger', () => {
  it('parses a valid project trigger and joins the task words', () => {
    const r = parseScopedTrigger(['project', 'payments', 'add', 'a', 'health', 'check', 'endpoint']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scopeType).toBe('project');
      expect(r.scopeId).toBe('payments');
      expect(r.task).toBe('add a health check endpoint');
    }
  });

  it('parses a valid repo trigger (slash-bearing scope id stays intact)', () => {
    const r = parseScopedTrigger(['repo', 'acme/orders', 'fix the flaky retry test']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scopeType).toBe('repo');
      expect(r.scopeId).toBe('acme/orders');
      expect(r.task).toBe('fix the flaky retry test');
    }
  });

  it('rejects a bad scope type', () => {
    const r = parseScopedTrigger(['team', 'x', 'do something substantial here']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-scope-type');
  });

  it('rejects a missing scope id', () => {
    const r = parseScopedTrigger(['repo']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-scope-id');
  });

  it('rejects a whitespace-only scope id', () => {
    const r = parseScopedTrigger(['repo', '   ', 'a perfectly fine task description']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-scope-id');
  });

  it('rejects an empty task', () => {
    const r = parseScopedTrigger(['repo', 'acme/orders']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty-task');
  });

  it('rejects a too-short task', () => {
    const r = parseScopedTrigger(['repo', 'acme/orders', 'short']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('task-too-short');
  });

  it('rejects a too-long task', () => {
    const r = parseScopedTrigger(['repo', 'acme/orders', 'x'.repeat(MAX_TASK_LENGTH + 1)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('task-too-long');
  });

  it('accepts a task exactly at the minimum length', () => {
    const r = parseScopedTrigger(['repo', 'acme/orders', 'x'.repeat(MIN_TASK_LENGTH)]);
    expect(r.ok).toBe(true);
  });

  it('trims surrounding whitespace from the joined task', () => {
    const r = parseScopedTrigger(['project', 'payments', '  add', 'a', 'feature  ']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task).toBe('add a feature');
  });
});
