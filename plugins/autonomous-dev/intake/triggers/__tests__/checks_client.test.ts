/**
 * Unit tests for the gh-backed checks client (ONBOARD Phase 4, #596).
 *
 * @module intake/triggers/checks_client.test
 */

import { ghChecksClient, reduceChecks, type ExecFn } from '../checks_client';

describe('reduceChecks', () => {
  it('all passing → green', () => {
    expect(reduceChecks([{ bucket: 'pass' }, { bucket: 'pass' }]).state).toBe('green');
  });

  it('pass + skip → green', () => {
    expect(reduceChecks([{ bucket: 'pass' }, { bucket: 'skipping' }]).state).toBe('green');
  });

  it('any failure → red (even with passes)', () => {
    expect(reduceChecks([{ bucket: 'pass' }, { bucket: 'fail' }]).state).toBe('red');
  });

  it('a pending (no failures) → pending', () => {
    expect(reduceChecks([{ bucket: 'pass' }, { state: 'in_progress' }]).state).toBe('pending');
  });

  it('failure dominates pending', () => {
    expect(reduceChecks([{ state: 'in_progress' }, { conclusion: 'failure' }]).state).toBe('red');
  });

  it('no checks → unknown (not green)', () => {
    expect(reduceChecks([]).state).toBe('unknown');
  });

  it('normalizes conclusion + state fields too', () => {
    expect(reduceChecks([{ conclusion: 'success' }]).state).toBe('green');
    expect(reduceChecks([{ state: 'failure' }]).state).toBe('red');
  });
});

describe('ghChecksClient', () => {
  it('parses gh JSON into a status', async () => {
    const exec: ExecFn = async () => ({ stdout: JSON.stringify([{ bucket: 'pass' }]), ok: true });
    const client = ghChecksClient(exec);
    expect((await client.getStatus('acme/orders', 'pr-1')).state).toBe('green');
  });

  it('passes repo + branch to gh', async () => {
    let seen: string[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      seen = args;
      return { stdout: '[]', ok: true };
    };
    await ghChecksClient(exec).getStatus('acme/orders', 'feature-x');
    expect(seen).toContain('acme/orders');
    expect(seen).toContain('feature-x');
  });

  it('a non-zero gh exit → unknown', async () => {
    const exec: ExecFn = async () => ({ stdout: '', ok: false });
    expect((await ghChecksClient(exec).getStatus('a/b', 'c')).state).toBe('unknown');
  });

  it('unparseable JSON → unknown (never throws)', async () => {
    const exec: ExecFn = async () => ({ stdout: 'not json', ok: true });
    expect((await ghChecksClient(exec).getStatus('a/b', 'c')).state).toBe('unknown');
  });

  it('an exec that throws → unknown', async () => {
    const exec: ExecFn = async () => {
      throw new Error('gh not found');
    };
    expect((await ghChecksClient(exec).getStatus('a/b', 'c')).state).toBe('unknown');
  });
});
