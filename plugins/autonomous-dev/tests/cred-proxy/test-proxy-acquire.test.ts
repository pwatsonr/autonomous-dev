/**
 * CredentialProxy end-to-end acquire/revoke/expire/shutdown tests
 * (SPEC-024-2-04).
 *
 * Uses mock scopers + a fake AuditSink to assert event shape, retry
 * behaviour, and TTL-timer wiring without real cloud SDK calls.
 */

import {
  ActiveTokenRegistry,
} from '../../intake/cred-proxy/active-tokens';
import {
  CredentialAuditEmitter,
  type AuditSink,
  type CredentialEventType,
} from '../../intake/cred-proxy/audit-emitter';
import {
  __resetLiveBackendsForTests,
} from '../../intake/cred-proxy/caller-identity';
import { CredentialProxy } from '../../intake/cred-proxy/proxy';
import {
  type CredentialScoper,
  type Provider,
} from '../../intake/cred-proxy/types';

interface RecordedEntry {
  type: CredentialEventType;
  caller: string;
  provider: Provider;
  operation: string;
  token_id?: string;
  reason?: string;
}

function makeAuditSink(): {
  sink: AuditSink;
  entries: RecordedEntry[];
  setThrow: (e: Error | null) => void;
} {
  const entries: RecordedEntry[] = [];
  let nextThrow: Error | null = null;
  const sink: AuditSink = {
    async append(entry) {
      if (nextThrow) {
        const e = nextThrow;
        nextThrow = null;
        throw e;
      }
      entries.push({
        type: entry.type,
        caller: entry.caller,
        provider: entry.provider,
        operation: entry.operation,
        token_id: entry.token_id,
        reason: entry.reason,
      });
    },
  };
  return { sink, entries, setThrow: (e) => (nextThrow = e) };
}

function makeScoper(opts: {
  payload?: string;
  failRevokeNTimes?: number;
} = {}): {
  scoper: CredentialScoper;
  scopeCalls: number;
  revokeCalls: number;
} {
  const ctx = { scopeCalls: 0, revokeCalls: 0 };
  let revokeFailures = opts.failRevokeNTimes ?? 0;
  const scoper: CredentialScoper = {
    provider: 'aws',
    async scope(_op, _scope) {
      ctx.scopeCalls += 1;
      return {
        payload: opts.payload ?? '{"k":"v"}',
        expires_at: '2030-01-01T00:15:00.000Z',
        revoke: async () => {
          ctx.revokeCalls += 1;
          if (revokeFailures > 0) {
            revokeFailures -= 1;
            throw new Error('cloud revoke failure');
          }
        },
      };
    },
  };
  return Object.assign(ctx, { scoper });
}

interface TestSetup {
  proxy: CredentialProxy;
  registry: ActiveTokenRegistry;
  audit: ReturnType<typeof makeAuditSink>;
  scoperCtx: ReturnType<typeof makeScoper>;
  setTimerCalls: Array<{ ms: number; cb: () => void }>;
  fireTimer: (idx?: number) => void;
}

function setup(opts: {
  privileged?: string[];
  scoperOpts?: Parameters<typeof makeScoper>[0];
} = {}): TestSetup {
  const audit = makeAuditSink();
  const scoperCtx = makeScoper(opts.scoperOpts);
  const registry = new ActiveTokenRegistry();
  const setTimerCalls: TestSetup['setTimerCalls'] = [];
  const fakeTimer = {} as NodeJS.Timeout;
  const proxy = new CredentialProxy({
    scopers: new Map<Provider, CredentialScoper>([['aws', scoperCtx.scoper]]),
    privilegedBackends: new Set(opts.privileged ?? ['plugin-good']),
    registry,
    audit: new CredentialAuditEmitter(audit.sink),
    setTimer: (cb, ms) => {
      setTimerCalls.push({ ms, cb });
      return fakeTimer;
    },
    delay: () => Promise.resolve(),
    retryDelaysMs: [0, 0, 0, 0],
  });
  return {
    proxy,
    registry,
    audit,
    scoperCtx,
    setTimerCalls,
    fireTimer: (idx = 0) => setTimerCalls[idx].cb(),
  };
}

describe('CredentialProxy.acquire (full)', () => {
  const originalEnv = process.env.AUTONOMOUS_DEV_PLUGIN_ID;

  beforeEach(() => {
    __resetLiveBackendsForTests();
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.AUTONOMOUS_DEV_PLUGIN_ID;
    else process.env.AUTONOMOUS_DEV_PLUGIN_ID = originalEnv;
  });

  it('returns ScopedCredential with delivery=stdin when no socketPeer', async () => {
    const t = setup();
    const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
    expect(cred.delivery).toBe('stdin');
    expect(cred.provider).toBe('aws');
    expect(cred.payload).toBe('{"k":"v"}');
    expect(cred.expires_at).toBe('2030-01-01T00:15:00.000Z');
    expect(cred.token_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cred.scope).toEqual({
      operation: 'op',
      resources: { region: 'us-east-1' },
    });
  });

  it('registers exactly one ActiveToken in the registry', async () => {
    const t = setup();
    expect(t.registry.size()).toBe(0);
    const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
    expect(t.registry.size()).toBe(1);
    expect(t.registry.get(cred.token_id)).toBeDefined();
  });

  it('emits exactly one credential_issued audit event with full fields', async () => {
    const t = setup();
    const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
    const issued = t.audit.entries.filter((e) => e.type === 'credential_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      type: 'credential_issued',
      caller: 'plugin-good',
      provider: 'aws',
      operation: 'op',
      token_id: cred.token_id,
    });
  });

  it('schedules a TTL timer at exactly 900_000 ms', async () => {
    const t = setup();
    await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
    expect(t.setTimerCalls).toHaveLength(1);
    expect(t.setTimerCalls[0].ms).toBe(900_000);
  });

  it('emits credential_denied with reason=CALLER_UNKNOWN when env missing', async () => {
    delete process.env.AUTONOMOUS_DEV_PLUGIN_ID;
    const t = setup();
    await expect(t.proxy.acquire('aws', 'op', { region: 'us-east-1' })).rejects.toMatchObject({
      code: 'CALLER_UNKNOWN',
    });
    const denied = t.audit.entries.filter((e) => e.type === 'credential_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toBe('CALLER_UNKNOWN');
  });

  it('emits credential_denied with reason=NOT_ALLOWLISTED', async () => {
    const t = setup({ privileged: ['someone-else'] });
    await expect(t.proxy.acquire('aws', 'op', { region: 'us-east-1' })).rejects.toMatchObject({
      code: 'NOT_ALLOWLISTED',
    });
    const denied = t.audit.entries.filter((e) => e.type === 'credential_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toBe('NOT_ALLOWLISTED');
    expect(denied[0].caller).toBe('plugin-good');
  });

  it('throwing audit emitter does NOT fail the credential flow', async () => {
    const t = setup();
    t.audit.setThrow(new Error('audit-disk-full'));
    // The first append call (credential_issued) throws but the proxy's
    // emitSafe wrapper swallows the error.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
      expect(cred).toBeDefined();
      expect(t.registry.size()).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('CredentialProxy.revoke (full)', () => {
  const originalEnv = process.env.AUTONOMOUS_DEV_PLUGIN_ID;

  beforeEach(() => {
    __resetLiveBackendsForTests();
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.AUTONOMOUS_DEV_PLUGIN_ID;
    else process.env.AUTONOMOUS_DEV_PLUGIN_ID = originalEnv;
  });

  it('revokes immediately, emits credential_revoked, and removes from registry', async () => {
    const t = setup();
    const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
    await t.proxy.revoke(cred.token_id);
    expect(t.registry.size()).toBe(0);
    expect(t.scoperCtx.revokeCalls).toBe(1);
    const revoked = t.audit.entries.filter((e) => e.type === 'credential_revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      token_id: cred.token_id,
      reason: 'released',
    });
  });

  it('revoke(unknown-id) is a no-op (no error, no audit event)', async () => {
    const t = setup();
    await expect(t.proxy.revoke('does-not-exist')).resolves.toBeUndefined();
    expect(t.audit.entries.filter((e) => e.type === 'credential_revoked')).toHaveLength(0);
  });

  it('retries scoper revoke up to 4 attempts and swallows final failure', async () => {
    const t = setup({ scoperOpts: { failRevokeNTimes: 5 } });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
      await t.proxy.revoke(cred.token_id);
      // 4 attempts (0, 100, 400, 1600 — overridden to 0 in tests).
      expect(t.scoperCtx.revokeCalls).toBe(4);
      // Despite all-fail, the audit event still fires.
      const revoked = t.audit.entries.filter((e) => e.type === 'credential_revoked');
      expect(revoked).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('retries succeed after 2 failures (returns success on attempt 3)', async () => {
    const t = setup({ scoperOpts: { failRevokeNTimes: 2 } });
    const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
    await t.proxy.revoke(cred.token_id);
    expect(t.scoperCtx.revokeCalls).toBe(3);
  });
});

describe('CredentialProxy auto-expire', () => {
  const originalEnv = process.env.AUTONOMOUS_DEV_PLUGIN_ID;

  beforeEach(() => {
    __resetLiveBackendsForTests();
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.AUTONOMOUS_DEV_PLUGIN_ID;
    else process.env.AUTONOMOUS_DEV_PLUGIN_ID = originalEnv;
  });

  it('TTL fires → token removed + credential_expired emitted', async () => {
    const t = setup();
    const cred = await t.proxy.acquire('aws', 'op', { region: 'us-east-1' });
    expect(t.registry.size()).toBe(1);
    // Fire the timer callback.
    t.fireTimer();
    // Allow microtasks for the async expire chain.
    await new Promise((r) => setImmediate(r));
    expect(t.registry.size()).toBe(0);
    const expired = t.audit.entries.filter((e) => e.type === 'credential_expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].token_id).toBe(cred.token_id);
  });
});

describe('CredentialProxy.shutdown', () => {
  const originalEnv = process.env.AUTONOMOUS_DEV_PLUGIN_ID;

  beforeEach(() => {
    __resetLiveBackendsForTests();
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.AUTONOMOUS_DEV_PLUGIN_ID;
    else process.env.AUTONOMOUS_DEV_PLUGIN_ID = originalEnv;
  });

  it('revokes every token with reason=daemon-shutdown', async () => {
    const t = setup();
    await t.proxy.acquire('aws', 'op-a', { region: 'us-east-1' });
    await t.proxy.acquire('aws', 'op-b', { region: 'us-east-1' });
    expect(t.registry.size()).toBe(2);
    await t.proxy.shutdown();
    expect(t.registry.size()).toBe(0);
    const events = t.audit.entries.filter(
      (e) => e.type === 'credential_revoked' && e.reason === 'daemon-shutdown',
    );
    expect(events).toHaveLength(2);
  });

  it('one failed revoke does not block the others (Promise.allSettled)', async () => {
    const t = setup();
    await t.proxy.acquire('aws', 'op-a', { region: 'us-east-1' });
    await t.proxy.acquire('aws', 'op-b', { region: 'us-east-1' });
    // Mutate the registry's first entry to force its revoke to throw.
    const entries = t.registry.list();
    const originalRevoke = entries[0].revoke;
    (entries[0] as { revoke: () => Promise<void> }).revoke = async () => {
      throw new Error('forced fail');
    };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await t.proxy.shutdown();
      expect(t.registry.size()).toBe(0);
      // Both audit events still fired (one for each token). The first
      // had its revoke fail 4 times → audit still emits.
      const events = t.audit.entries.filter(
        (e) => e.type === 'credential_revoked' && e.reason === 'daemon-shutdown',
      );
      expect(events).toHaveLength(2);
    } finally {
      errSpy.mockRestore();
    }
    void originalRevoke;
  });
});
