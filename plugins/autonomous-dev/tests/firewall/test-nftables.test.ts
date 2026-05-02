/**
 * Unit tests for NftablesBackend (SPEC-024-3-04).
 *
 * Mocks `runNft`, the filesystem, and the DNS refresh so no real `nft` /
 * cgroup / DNS calls run in CI.
 */

import {
  NftablesBackend,
  TABLE_NAME,
  CGROUP_BASE,
  type FsLike,
  type NftRunner,
} from '../../intake/firewall/nftables';
import { FirewallUnavailableError } from '../../intake/firewall/types';
import type { DnsRefreshLoop } from '../../intake/firewall/dns-refresh';

interface NftCall {
  stdin: string;
}

function mkBackend(opts: {
  runResults: Array<{ exitCode: number; stdout?: string; stderr?: string }>;
  fs?: Partial<FsLike>;
  resolveOnceResult?: any[];
}) {
  const calls: NftCall[] = [];
  const queue = [...opts.runResults];
  const nft: NftRunner = async (stdin: string) => {
    calls.push({ stdin });
    const r = queue.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  const fs: FsLike = {
    mkdir: opts.fs?.mkdir ?? (async () => undefined),
    writeFile: opts.fs?.writeFile ?? (async () => undefined),
    readFile: opts.fs?.readFile ?? (async () => ''),
    rm: opts.fs?.rm ?? (async () => undefined),
  };
  const refresh = {
    register: jest.fn(),
    unregister: jest.fn(),
    resolveOnce: jest.fn().mockResolvedValue(opts.resolveOnceResult ?? []),
  } as unknown as DnsRefreshLoop;
  const backend = new NftablesBackend({ nft, fs, refresh });
  return { backend, calls, refresh };
}

describe('NftablesBackend.init', () => {
  test('table missing on first probe → creates table + chain', async () => {
    const { backend, calls } = mkBackend({
      runResults: [
        { exitCode: 1, stderr: 'No such file or directory' }, // probe
        { exitCode: 0 }, // create
      ],
    });
    await backend.init();
    expect(calls).toHaveLength(2);
    expect(calls[1].stdin).toContain(`add table ip ${TABLE_NAME}`);
    expect(calls[1].stdin).toContain('output { type filter hook output');
  });

  test('second init() call is a no-op', async () => {
    const { backend, calls } = mkBackend({
      runResults: [{ exitCode: 1 }, { exitCode: 0 }],
    });
    await backend.init();
    await backend.init();
    expect(calls).toHaveLength(2);
  });

  test('Operation not permitted → throws FirewallUnavailableError mentioning CAP_NET_ADMIN', async () => {
    const { backend } = mkBackend({
      runResults: [{ exitCode: 1, stderr: 'Operation not permitted' }, { exitCode: 4, stderr: 'Operation not permitted' }],
    });
    await expect(backend.init()).rejects.toBeInstanceOf(FirewallUnavailableError);
    try {
      await backend.init();
    } catch (e) {
      expect((e as Error).message).toMatch(/CAP_NET_ADMIN/);
      expect((e as Error).message).toMatch(/root/);
    }
  });
});

describe('NftablesBackend.applyRulesForPid', () => {
  test('writes pid to cgroup, registers refresh, issues atomic transaction', async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const mkdirs: string[] = [];
    const { backend, calls, refresh } = mkBackend({
      runResults: [
        { exitCode: 1 }, // probe missing
        { exitCode: 0 }, // create table
        { exitCode: 0 }, // replaceRulesForPid
      ],
      fs: {
        mkdir: async (p: string) => {
          mkdirs.push(p);
        },
        writeFile: async (p: string, d: string) => {
          writes.push({ path: p, data: d });
        },
      },
      resolveOnceResult: [
        {
          fqdn: 'sts.amazonaws.com',
          ip: '203.0.113.5',
          family: 'inet',
          port: 443,
          protocol: 'tcp',
          lastSeenMs: 1,
        },
      ],
    });
    await backend.applyRulesForPid(12345, [
      { fqdn: 'sts.amazonaws.com', port: 443, protocol: 'tcp' },
    ]);
    expect(mkdirs).toContain(`${CGROUP_BASE}/pid-12345`);
    expect(writes[0].path).toBe(`${CGROUP_BASE}/pid-12345/cgroup.procs`);
    expect(writes[0].data).toBe('12345');
    expect((refresh.register as jest.Mock).mock.calls[0][0]).toBe(12345);
    const txn = calls[2].stdin;
    expect(txn).toContain(`flush chain ip ${TABLE_NAME} pid-12345`);
    expect(txn).toContain('jump pid-12345');
    expect(txn).toContain('ip daddr 203.0.113.5 tcp dport 443 accept');
    expect(txn).toContain('reject with icmp type admin-prohibited');
  });

  test('EACCES on cgroup write → FirewallUnavailableError mentions CAP_NET_ADMIN', async () => {
    const { backend } = mkBackend({
      runResults: [{ exitCode: 0 }],
      fs: {
        writeFile: async () => {
          const err = new Error('permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        },
      },
    });
    await expect(
      backend.applyRulesForPid(7, [{ fqdn: 'sts.amazonaws.com', port: 443, protocol: 'tcp' }]),
    ).rejects.toMatchObject({ code: 'FIREWALL_UNAVAILABLE' });
  });
});

describe('NftablesBackend.replaceRulesForPid', () => {
  test('emits a single nft transaction', async () => {
    const { backend, calls } = mkBackend({
      runResults: [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }],
    });
    await backend.init();
    await backend.replaceRulesForPid(99, [
      { fqdn: 'a', ip: '1.1.1.1', family: 'inet', port: 443, protocol: 'tcp', lastSeenMs: 1 },
      { fqdn: 'a', ip: '2606::1', family: 'inet6', port: 443, protocol: 'tcp', lastSeenMs: 1 },
    ]);
    const txn = calls[1].stdin;
    expect(txn.match(/flush chain/g) ?? []).toHaveLength(1);
    expect(txn).toContain('ip daddr 1.1.1.1');
    expect(txn).toContain('ip6 daddr 2606::1');
  });
});

describe('NftablesBackend.removeRulesForPid', () => {
  test('deletes per-PID chain, removes cgroup directory, unregisters', async () => {
    const rms: string[] = [];
    const { backend, calls, refresh } = mkBackend({
      runResults: [{ exitCode: 0 }, { exitCode: 0 }],
      fs: { rm: async (p: string) => { rms.push(p); } },
    });
    await backend.init();
    await backend.removeRulesForPid(42);
    expect(calls[1].stdin).toContain(`delete chain ip ${TABLE_NAME} pid-42`);
    expect(rms).toContain(`${CGROUP_BASE}/pid-42`);
    expect((refresh.unregister as jest.Mock).mock.calls[0][0]).toBe(42);
  });

  test('idempotent: missing chain does not throw on second call', async () => {
    const { backend } = mkBackend({
      runResults: [
        { exitCode: 0 }, // probe ok
        { exitCode: 1, stderr: 'No such file or directory' },
        { exitCode: 1, stderr: 'No such file or directory' },
      ],
    });
    await backend.init();
    await backend.removeRulesForPid(7);
    await backend.removeRulesForPid(7);
  });
});

describe('NftablesBackend.listActiveAllowlists', () => {
  test('returns empty before any apply', async () => {
    const { backend } = mkBackend({ runResults: [{ exitCode: 0 }] });
    expect(backend.listActiveAllowlists().size).toBe(0);
  });
});
