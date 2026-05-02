/**
 * CredentialProxy skeleton tests (SPEC-024-2-01).
 *
 * Verifies:
 *   - TTL_SECONDS is exactly 900 (compile-time const).
 *   - Allowlist enforcement throws BEFORE any scoper is called.
 *   - Missing env identity throws CALLER_UNKNOWN before allowlist.
 *   - Spoofed socket peer throws CALLER_SPOOFED.
 *   - Allowlisted caller proceeds past auth → throws NotImplemented (the
 *     SPEC-024-2-04 placeholder; the throw is the success signal here).
 *   - Missing scoper throws generic Error (not SecurityError).
 */

import {
  CredentialProxy,
  TTL_SECONDS,
} from '../../intake/cred-proxy/proxy';
import {
  SecurityError,
  type CredentialScoper,
  type Provider,
} from '../../intake/cred-proxy/types';
import {
  __resetLiveBackendsForTests,
  registerLiveBackend,
} from '../../intake/cred-proxy/caller-identity';

class SpyScoper implements CredentialScoper {
  readonly provider: Provider = 'aws';
  public calls = 0;
  async scope() {
    this.calls += 1;
    return {
      payload: '{}',
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      revoke: async () => {
        // no-op
      },
    };
  }
}

function buildProxy(opts: {
  privileged?: string[];
  scopers?: ReadonlyMap<Provider, CredentialScoper>;
} = {}) {
  const scopers =
    opts.scopers ??
    new Map<Provider, CredentialScoper>([['aws', new SpyScoper()]]);
  return {
    proxy: new CredentialProxy({
      scopers,
      privilegedBackends: new Set(opts.privileged ?? []),
    }),
    scopers,
  };
}

describe('TTL_SECONDS', () => {
  it('is the const value 900', () => {
    expect(TTL_SECONDS).toBe(900);
  });
});

describe('CredentialProxy.acquire allowlist enforcement', () => {
  const originalEnv = process.env.AUTONOMOUS_DEV_PLUGIN_ID;

  beforeEach(() => {
    __resetLiveBackendsForTests();
    delete process.env.AUTONOMOUS_DEV_PLUGIN_ID;
  });

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.AUTONOMOUS_DEV_PLUGIN_ID;
    } else {
      process.env.AUTONOMOUS_DEV_PLUGIN_ID = originalEnv;
    }
  });

  it('throws CALLER_UNKNOWN when env identity is missing', async () => {
    const { proxy } = buildProxy({ privileged: ['plugin-a'] });
    await expect(
      proxy.acquire('aws', 'op', { region: 'us-east-1' }),
    ).rejects.toMatchObject({ code: 'CALLER_UNKNOWN' });
  });

  it('throws NOT_ALLOWLISTED for non-allowlisted caller and never invokes scoper', async () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-evil';
    const spy = new SpyScoper();
    const { proxy } = buildProxy({
      privileged: ['plugin-good'],
      scopers: new Map<Provider, CredentialScoper>([['aws', spy]]),
    });
    await expect(
      proxy.acquire('aws', 'op', { region: 'us-east-1' }),
    ).rejects.toMatchObject({ code: 'NOT_ALLOWLISTED' });
    expect(spy.calls).toBe(0);
  });

  it('throws CALLER_SPOOFED when env says plugin-a but socket peer is unregistered', async () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    const { proxy } = buildProxy({ privileged: ['plugin-a'] });
    await expect(
      proxy.acquire(
        'aws',
        'op',
        { region: 'us-east-1' },
        { socketPeer: { pid: 9999, uid: 1000 } },
      ),
    ).rejects.toMatchObject({ code: 'CALLER_SPOOFED' });
  });

  it('throws CALLER_SPOOFED when env says plugin-a but registry says plugin-b for that pid', async () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-b' });
    const { proxy } = buildProxy({ privileged: ['plugin-a', 'plugin-b'] });
    await expect(
      proxy.acquire(
        'aws',
        'op',
        { region: 'us-east-1' },
        { socketPeer: { pid: 1234, uid: 1000 } },
      ),
    ).rejects.toMatchObject({ code: 'CALLER_SPOOFED' });
  });

  it('proceeds past allowlist for valid stdin caller (NotImplemented signals success)', async () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
    const { proxy } = buildProxy({ privileged: ['plugin-good'] });
    await expect(
      proxy.acquire('aws', 'op', { region: 'us-east-1' }),
    ).rejects.toThrow(/NotImplemented/);
  });

  it('proceeds past allowlist for valid socket caller', async () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-good' });
    const { proxy } = buildProxy({ privileged: ['plugin-good'] });
    await expect(
      proxy.acquire(
        'aws',
        'op',
        { region: 'us-east-1' },
        { socketPeer: { pid: 1234, uid: 1000 } },
      ),
    ).rejects.toThrow(/NotImplemented/);
  });

  it('throws generic Error (not SecurityError) when provider has no scoper', async () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
    const { proxy } = buildProxy({
      privileged: ['plugin-good'],
      scopers: new Map<Provider, CredentialScoper>(),
    });
    let caught: unknown;
    try {
      await proxy.acquire('aws', 'op', { region: 'us-east-1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SecurityError);
    expect((caught as Error).message).toMatch(/no scoper registered/);
  });
});

describe('CredentialProxy.revoke skeleton', () => {
  it('throws NotImplemented (placeholder for SPEC-024-2-04)', async () => {
    const { proxy } = buildProxy();
    await expect(proxy.revoke('any-id')).rejects.toThrow(/NotImplemented/);
  });
});
