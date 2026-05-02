/**
 * Caller-identity unit tests (SPEC-024-2-01).
 *
 * Covers:
 *   - Stdin path: env var IS the identity.
 *   - Socket path: env+registry cross-check returns env id.
 *   - Spoof detection: env mismatch / unregistered pid → CALLER_SPOOFED.
 *   - Missing env → CALLER_UNKNOWN.
 */

import {
  __resetLiveBackendsForTests,
  registerLiveBackend,
  resolveCaller,
  unregisterLiveBackend,
} from '../../intake/cred-proxy/caller-identity';
import { SecurityError } from '../../intake/cred-proxy/types';

describe('resolveCaller', () => {
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

  it('throws CALLER_UNKNOWN when env var is unset (stdin path)', () => {
    expect(() => resolveCaller(undefined)).toThrow(SecurityError);
    try {
      resolveCaller(undefined);
    } catch (err) {
      expect((err as SecurityError).code).toBe('CALLER_UNKNOWN');
    }
  });

  it('throws CALLER_UNKNOWN when env var is unset (socket path)', () => {
    expect(() =>
      resolveCaller({ socketPeer: { pid: 1, uid: 1000 } }),
    ).toThrow(SecurityError);
  });

  it('returns env value on stdin path (no socket peer)', () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    expect(resolveCaller(undefined)).toBe('plugin-a');
    expect(resolveCaller({})).toBe('plugin-a');
  });

  it('returns env value when socket peer matches registered backend', () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-a' });
    expect(
      resolveCaller({ socketPeer: { pid: 1234, uid: 1000 } }),
    ).toBe('plugin-a');
  });

  it('throws CALLER_SPOOFED when peer pid is not registered', () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    // No registration for pid 9999
    expect(() =>
      resolveCaller({ socketPeer: { pid: 9999, uid: 1000 } }),
    ).toThrow(SecurityError);
    try {
      resolveCaller({ socketPeer: { pid: 9999, uid: 1000 } });
    } catch (err) {
      expect((err as SecurityError).code).toBe('CALLER_SPOOFED');
    }
  });

  it('throws CALLER_SPOOFED when env says plugin-a but registry says plugin-b', () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-b' });
    expect(() =>
      resolveCaller({ socketPeer: { pid: 1234, uid: 1000 } }),
    ).toThrow(SecurityError);
    try {
      resolveCaller({ socketPeer: { pid: 1234, uid: 1000 } });
    } catch (err) {
      expect((err as SecurityError).code).toBe('CALLER_SPOOFED');
    }
  });

  it('throws CALLER_SPOOFED when uid does not match', () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-a' });
    expect(() =>
      resolveCaller({ socketPeer: { pid: 1234, uid: 9999 } }),
    ).toThrow(SecurityError);
  });

  it('rejects after unregisterLiveBackend', () => {
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-a';
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-a' });
    unregisterLiveBackend(1234);
    expect(() =>
      resolveCaller({ socketPeer: { pid: 1234, uid: 1000 } }),
    ).toThrow(SecurityError);
  });
});

describe('SecurityError', () => {
  it('is an instance of Error', () => {
    const e = new SecurityError('NOT_ALLOWLISTED', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NOT_ALLOWLISTED');
    expect(e.name).toBe('SecurityError');
  });

  it('exposes one of the three documented codes', () => {
    const codes = [
      new SecurityError('NOT_ALLOWLISTED', 'x').code,
      new SecurityError('CALLER_UNKNOWN', 'x').code,
      new SecurityError('CALLER_SPOOFED', 'x').code,
    ];
    expect(codes).toEqual([
      'NOT_ALLOWLISTED',
      'CALLER_UNKNOWN',
      'CALLER_SPOOFED',
    ]);
  });
});
