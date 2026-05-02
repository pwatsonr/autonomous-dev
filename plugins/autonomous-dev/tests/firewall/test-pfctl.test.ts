/**
 * Unit tests for PfctlBackend (SPEC-024-3-04).
 *
 * Mocks `runPfctl` entirely; assertions on stdin payloads are platform-
 * agnostic so the suite runs everywhere.
 */

import { PfctlBackend, ANCHOR_ROOT } from '../../intake/firewall/pfctl';
import { FirewallUnavailableError } from '../../intake/firewall/types';
import type { DnsRefreshLoop } from '../../intake/firewall/dns-refresh';

interface PfctlCall {
  args: string[];
  stdin?: string;
}

function mkBackend(opts: {
  runResults: Array<{ exitCode: number; stdout?: string; stderr?: string }>;
  resolveOnceResult?: any[];
}) {
  const calls: PfctlCall[] = [];
  const queue = [...opts.runResults];
  const pfctl = (async (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    const r = queue.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  }) as any;
  const refresh = {
    register: jest.fn(),
    unregister: jest.fn(),
    resolveOnce: jest.fn().mockResolvedValue(opts.resolveOnceResult ?? []),
  } as unknown as DnsRefreshLoop;
  return { backend: new PfctlBackend({ pfctl, refresh }), calls, refresh };
}

describe('PfctlBackend.init', () => {
  test('exit 0 → ok', async () => {
    const { backend } = mkBackend({ runResults: [{ exitCode: 0 }] });
    await backend.init();
  });

  test('"pf not enabled" → throws with both pfctl -e and allow_unfirewalled hints', async () => {
    const { backend } = mkBackend({
      runResults: [{ exitCode: 1, stderr: 'pfctl: pf not enabled' }],
    });
    await expect(backend.init()).rejects.toBeInstanceOf(FirewallUnavailableError);
    try {
      await new PfctlBackend({
        pfctl: (async () => ({ exitCode: 1, stderr: 'pf not enabled', stdout: '' })) as any,
      }).init();
    } catch (e) {
      expect((e as Error).message).toMatch(/pfctl -e/);
      expect((e as Error).message).toMatch(/allow_unfirewalled_backends/);
    }
  });

  test('init is no-op on second call', async () => {
    const { backend, calls } = mkBackend({ runResults: [{ exitCode: 0 }] });
    await backend.init();
    await backend.init();
    expect(calls).toHaveLength(1);
  });
});

describe('PfctlBackend.applyRulesForPid', () => {
  test('writes one pass-rule per resolved IP plus trailing block return', async () => {
    const { backend, calls } = mkBackend({
      runResults: [{ exitCode: 0 }, { exitCode: 0 }],
      resolveOnceResult: [
        { fqdn: 'a', ip: '1.1.1.1', family: 'inet', port: 443, protocol: 'tcp', lastSeenMs: 1 },
        { fqdn: 'a', ip: '2.2.2.2', family: 'inet', port: 443, protocol: 'tcp', lastSeenMs: 1 },
      ],
    });
    await backend.applyRulesForPid(502, [{ fqdn: 'a', port: 443, protocol: 'tcp' }]);
    const replaceCall = calls[1];
    expect(replaceCall.args).toEqual(['-a', `${ANCHOR_ROOT}/uid-502`, '-f', '-']);
    expect(replaceCall.stdin).toContain('pass out quick proto tcp from any to 1.1.1.1 port 443 user 502');
    expect(replaceCall.stdin).toContain('pass out quick proto tcp from any to 2.2.2.2 port 443 user 502');
    expect(replaceCall.stdin).toContain('block return out quick from any to any user 502');
  });
});

describe('PfctlBackend.removeRulesForPid', () => {
  test('runs pfctl -a anchor -F all and unregisters', async () => {
    const { backend, calls, refresh } = mkBackend({
      runResults: [{ exitCode: 0 }, { exitCode: 0 }],
    });
    await backend.init();
    await backend.removeRulesForPid(502);
    expect(calls[1].args).toEqual(['-a', `${ANCHOR_ROOT}/uid-502`, '-F', 'all']);
    expect((refresh.unregister as jest.Mock).mock.calls[0][0]).toBe(502);
  });
});

describe('PfctlBackend.replaceRulesForPid', () => {
  test('failure throws FirewallUnavailableError', async () => {
    const { backend } = mkBackend({
      runResults: [{ exitCode: 0 }, { exitCode: 1, stderr: 'syntax error' }],
    });
    await backend.init();
    await expect(
      backend.replaceRulesForPid(502, [
        { fqdn: 'a', ip: '1.1.1.1', family: 'inet', port: 443, protocol: 'tcp', lastSeenMs: 1 },
      ]),
    ).rejects.toBeInstanceOf(FirewallUnavailableError);
  });

  test('empty rule set still emits block-return backstop', async () => {
    const { backend, calls } = mkBackend({ runResults: [{ exitCode: 0 }, { exitCode: 0 }] });
    await backend.init();
    await backend.replaceRulesForPid(7, []);
    expect(calls[1].stdin).toContain('block return out quick from any to any user 7');
    expect(calls[1].stdin).not.toContain('pass out quick');
  });
});

describe('PfctlBackend.listActiveAllowlists', () => {
  test('returns empty initially', () => {
    const { backend } = mkBackend({ runResults: [{ exitCode: 0 }] });
    expect(backend.listActiveAllowlists().size).toBe(0);
  });
});
