/**
 * `deploy estimate` CLI tests (SPEC-024-3-04).
 *
 * Captures stdout/stderr through a `Writable`-shaped buffer so the CLI's
 * exit-code contract and output formats stay observable in tests.
 */

import { Writable } from 'node:stream';

import { runDeployEstimate, type DeployEstimateLookup } from '../../intake/cli/deploy_estimate_command';
import type { CostEstimator, EstimateResult } from '../../intake/deploy/cost-estimation';

class BufferStream extends Writable {
  chunks: string[] = [];
  _write(c: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof c === 'string' ? c : c.toString('utf8'));
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

function mkEstimate(): EstimateResult {
  return {
    estimated_cost_usd: 1.2345,
    currency: 'USD',
    breakdown: [
      { label: 'Fargate vCPU-hours', quantity: 1, unit: 'vCPU-hour', unit_price_usd: 0.04048, subtotal_usd: 0.04048 },
      { label: 'ECR storage (prorated)', quantity: 0.001, unit: 'GB-month', unit_price_usd: 0.10, subtotal_usd: 0.0001 },
    ],
    confidence: 0.85,
    notes: 'Excludes data transfer.',
  };
}

function mkLookup(opts: {
  resolved: 'ok' | 'missing' | 'estimator-throws';
  err?: Error;
}): {
  lookup: DeployEstimateLookup;
  estimator: CostEstimator<any>;
  estimateCalls: number;
} {
  let estimateCalls = 0;
  const estimator: CostEstimator<any> = {
    async estimateDeployCost() {
      estimateCalls++;
      if (opts.resolved === 'estimator-throws') {
        throw opts.err ?? new Error('boom');
      }
      return mkEstimate();
    },
  };
  const lookup: DeployEstimateLookup = {
    async resolveEnv(env: string) {
      if (opts.resolved === 'missing') {
        return { ok: false, reason: `no spec for ${env}` };
      }
      return { ok: true, backend: 'aws', params: {}, estimator };
    },
  };
  return {
    lookup,
    estimator,
    get estimateCalls() {
      return estimateCalls;
    },
  } as any;
}

describe('runDeployEstimate', () => {
  test('table mode: exit 0; stdout has backend, env, total, confidence, and one row per line item', async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const { lookup } = mkLookup({ resolved: 'ok' });
    const code = await runDeployEstimate({ env: 'staging' }, lookup, { stdout: out, stderr: err });
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain('aws');
    expect(text).toContain('staging');
    expect(text).toContain('total:');
    expect(text).toContain('confidence: 0.85');
    expect(text).toContain('Fargate vCPU-hours');
    expect(text).toContain('ECR storage (prorated)');
    expect(err.text()).toBe('');
  });

  test('json mode: stdout is parseable JSON matching EstimateResult & {env, backend}', async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const { lookup } = mkLookup({ resolved: 'ok' });
    const code = await runDeployEstimate({ env: 'staging', json: true }, lookup, {
      stdout: out,
      stderr: err,
    });
    expect(code).toBe(0);
    const text = out.text().trim();
    // Must be a single JSON object with no extra log lines.
    const parsed = JSON.parse(text);
    expect(parsed.env).toBe('staging');
    expect(parsed.backend).toBe('aws');
    expect(parsed.currency).toBe('USD');
    expect(parsed.estimated_cost_usd).toBeCloseTo(1.2345, 6);
    expect(Array.isArray(parsed.breakdown)).toBe(true);
    expect(err.text()).toBe('');
  });

  test('unknown env exits 2; stderr contains "env not found"', async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const { lookup } = mkLookup({ resolved: 'missing' });
    const code = await runDeployEstimate({ env: 'nonexistent' }, lookup, {
      stdout: out,
      stderr: err,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain('env not found');
  });

  test('backend error during estimate exits 3; stderr surfaces the error message', async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const { lookup } = mkLookup({
      resolved: 'estimator-throws',
      err: new Error('upstream pricing API timeout'),
    });
    const code = await runDeployEstimate({ env: 'staging' }, lookup, { stdout: out, stderr: err });
    expect(code).toBe(3);
    expect(err.text()).toContain('upstream pricing API timeout');
  });

  test('does NOT call deploy() and does NOT touch the ledger (lookup contract has no such surfaces)', async () => {
    // The CLI's lookup contract only exposes `resolveEnv`; the lack of `deploy`
    // / ledger functions on the contract is itself the assertion. We sanity-check
    // by spying on properties added to the lookup that the CLI must never call.
    const out = new BufferStream();
    const err = new BufferStream();
    const { lookup } = mkLookup({ resolved: 'ok' });
    const ledgerSpy = jest.fn();
    const deploySpy = jest.fn();
    (lookup as any).recordEstimate = ledgerSpy;
    (lookup as any).deploy = deploySpy;
    const code = await runDeployEstimate({ env: 'staging' }, lookup, { stdout: out, stderr: err });
    expect(code).toBe(0);
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(deploySpy).not.toHaveBeenCalled();
  });
});
