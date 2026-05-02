/**
 * Unit tests for DnsRefreshLoop (SPEC-024-3-04).
 *
 * Uses a manual clock + a fake timer factory + a stubbed resolver. No
 * real DNS or wall-clock timers are involved.
 */

import {
  DnsRefreshLoop,
  REFRESH_INTERVAL_MS,
  STALE_TTL_MS,
  type DnsResolver,
  type TimerFactory,
} from '../../intake/firewall/dns-refresh';
import type { FirewallBackend } from '../../intake/firewall/types';

class FakeBackend implements FirewallBackend {
  readonly platform = 'linux' as const;
  readonly replaceCalls: Array<{ key: number; rules: any[] }> = [];
  async init(): Promise<void> {}
  async applyRulesForPid(): Promise<void> {}
  async replaceRulesForPid(key: number, rules: any[]): Promise<void> {
    this.replaceCalls.push({ key, rules: [...rules] });
  }
  async removeRulesForPid(): Promise<void> {}
  listActiveAllowlists() {
    return new Map();
  }
}

function mkLoop(opts: {
  resolver?: Partial<DnsResolver>;
  initialNow?: number;
}) {
  let now = opts.initialNow ?? 1_000_000;
  let intervalSet: { handler: () => void; ms: number } | null = null;
  const timers: TimerFactory = {
    setInterval: (h, ms) => {
      intervalSet = { handler: h, ms };
      return Symbol('handle') as unknown as NodeJS.Timeout;
    },
    clearInterval: () => {
      intervalSet = null;
    },
  };
  const resolver: DnsResolver = {
    resolve4: opts.resolver?.resolve4 ?? (async () => []),
    resolve6: opts.resolver?.resolve6 ?? (async () => []),
  };
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const loop = new DnsRefreshLoop({
    resolver,
    clock: () => now,
    timers,
    logger: { warn: (msg, fields) => warns.push({ msg, fields }) },
  });
  return {
    loop,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (v: number) => {
      now = v;
    },
    getInterval: () => intervalSet,
    warns,
  };
}

describe('DnsRefreshLoop.register', () => {
  test('first register schedules the 5-min interval', () => {
    const { loop, getInterval } = mkLoop({});
    expect(loop.isRunning()).toBe(false);
    loop.register(1, [{ fqdn: 'a.com', port: 443, protocol: 'tcp' }], new FakeBackend());
    expect(loop.isRunning()).toBe(true);
    expect(getInterval()!.ms).toBe(REFRESH_INTERVAL_MS);
  });

  test('second register does not re-schedule', () => {
    const { loop } = mkLoop({});
    loop.register(1, [], new FakeBackend());
    const first = (loop as any).intervalHandle;
    loop.register(2, [], new FakeBackend());
    expect((loop as any).intervalHandle).toBe(first);
  });
});

describe('DnsRefreshLoop.resolveOnce', () => {
  test('combines IPv4 + IPv6 results', async () => {
    const { loop } = mkLoop({
      resolver: {
        resolve4: async () => ['1.1.1.1', '2.2.2.2'],
        resolve6: async () => ['2606::1'],
      },
    });
    const rules = await loop.resolveOnce([{ fqdn: 'a.com', port: 443, protocol: 'tcp' }]);
    expect(rules).toHaveLength(3);
    expect(rules.filter((r) => r.family === 'inet')).toHaveLength(2);
    expect(rules.filter((r) => r.family === 'inet6')).toHaveLength(1);
  });

  test('wildcard FQDN is skipped with WARN', async () => {
    const { loop, warns } = mkLoop({});
    const rules = await loop.resolveOnce([{ fqdn: '*.foo.com', port: 443, protocol: 'tcp' }]);
    expect(rules).toHaveLength(0);
    expect(warns.some((w) => /wildcard/i.test(w.msg))).toBe(true);
  });
});

describe('DnsRefreshLoop.refresh', () => {
  test('adds new IP and calls backend.replaceRulesForPid', async () => {
    let resolved = ['1.1.1.1'];
    const backend = new FakeBackend();
    const { loop } = mkLoop({
      resolver: { resolve4: async () => [...resolved], resolve6: async () => [] },
    });
    loop.register(7, [{ fqdn: 'a.com', port: 443, protocol: 'tcp' }], backend);
    await loop.refresh(); // initial population
    expect(backend.replaceCalls).toHaveLength(1);
    expect(backend.replaceCalls[0].rules.map((r: any) => r.ip)).toEqual(['1.1.1.1']);
    resolved = ['1.1.1.1', '2.2.2.2'];
    await loop.refresh();
    expect(backend.replaceCalls).toHaveLength(2);
    expect(backend.replaceCalls[1].rules.map((r: any) => r.ip).sort()).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  test('IP not seen for >1h is removed on next refresh', async () => {
    const backend = new FakeBackend();
    let resolved = ['1.1.1.1', '2.2.2.2'];
    const env = mkLoop({
      resolver: { resolve4: async () => [...resolved], resolve6: async () => [] },
    });
    env.loop.register(1, [{ fqdn: 'a.com', port: 443, protocol: 'tcp' }], backend);
    await env.loop.refresh();
    // Drop 2.2.2.2 from DNS; advance >1h.
    resolved = ['1.1.1.1'];
    env.advance(STALE_TTL_MS + 1000);
    await env.loop.refresh();
    const ips = env.loop.rulesFor(1).map((r) => r.ip).sort();
    expect(ips).toEqual(['1.1.1.1']);
  });

  test('failed DNS for one fqdn does not affect rules of another fqdn', async () => {
    const backend = new FakeBackend();
    const env = mkLoop({
      resolver: {
        resolve4: async (fqdn: string) => {
          if (fqdn === 'broken.com') throw new Error('NXDOMAIN');
          return ['9.9.9.9'];
        },
        resolve6: async () => [],
      },
    });
    env.loop.register(
      1,
      [
        { fqdn: 'broken.com', port: 443, protocol: 'tcp' },
        { fqdn: 'ok.com', port: 443, protocol: 'tcp' },
      ],
      backend,
    );
    await env.loop.refresh();
    const ips = env.loop.rulesFor(1).map((r) => r.ip);
    expect(ips).toEqual(['9.9.9.9']);
  });
});

describe('DnsRefreshLoop.unregister', () => {
  test('clears interval when last key unregistered', () => {
    const { loop } = mkLoop({});
    const b = new FakeBackend();
    loop.register(1, [], b);
    loop.register(2, [], b);
    expect(loop.isRunning()).toBe(true);
    loop.unregister(1);
    expect(loop.isRunning()).toBe(true);
    loop.unregister(2);
    expect(loop.isRunning()).toBe(false);
  });
});
