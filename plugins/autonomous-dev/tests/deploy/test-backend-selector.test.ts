/**
 * SPEC-023-2-02 BackendSelector tests.
 *
 * @module tests/deploy/test-backend-selector.test
 */

import {
  ParameterValidationError,
  UnknownBackendError,
} from '../../intake/deploy/errors';
import { mergeParameters, selectBackend } from '../../intake/deploy/selector';
import { makeStubRegistry } from './helpers/test-registry';
import type { ResolvedEnvironment } from '../../intake/deploy/types-config';

function makeResolved(
  partial: Partial<ResolvedEnvironment> = {},
): ResolvedEnvironment {
  return {
    envName: 'dev',
    backend: 'local-stub',
    parameters: {},
    approval: 'none',
    costCapUsd: 0,
    autoPromoteFrom: null,
    source: 'deploy.yaml',
    configPath: null,
    ...partial,
  };
}

describe('SPEC-023-2-02 selectBackend priority', () => {
  it('uses request-override when present', () => {
    const r = selectBackend({
      resolved: makeResolved({ backend: 'static-stub' }),
      registry: makeStubRegistry(),
      override: { backend: 'docker-stub' },
    });
    expect(r.backendName).toBe('docker-stub');
    expect(r.source).toBe('request-override');
  });

  it('uses env-config when no override and config-backed', () => {
    const r = selectBackend({
      resolved: makeResolved({ backend: 'static-stub' }),
      registry: makeStubRegistry(),
    });
    expect(r.backendName).toBe('static-stub');
    expect(r.source).toBe('env-config');
  });

  it('uses repo-default when no override and source=fallback', () => {
    const r = selectBackend({
      resolved: makeResolved({ backend: 'local', source: 'fallback' }),
      registry: makeStubRegistry(),
      repoDefaultBackend: 'static-stub',
    });
    expect(r.backendName).toBe('static-stub');
    expect(r.source).toBe('repo-default');
  });

  it('uses fallback "local" when source=fallback and no repo-default', () => {
    const reg = makeStubRegistry({ local: { schema: {} } });
    const r = selectBackend({
      resolved: makeResolved({ backend: 'irrelevant', source: 'fallback' }),
      registry: reg,
    });
    expect(r.backendName).toBe('local');
    expect(r.source).toBe('fallback');
  });
});

describe('SPEC-023-2-02 selectBackend errors', () => {
  it('throws UnknownBackendError when backend not registered', () => {
    let err: unknown;
    try {
      selectBackend({
        resolved: makeResolved({ backend: 'nope' }),
        registry: makeStubRegistry(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownBackendError);
    expect((err as UnknownBackendError).available).toEqual([
      'docker-stub',
      'local-stub',
      'static-stub',
    ]);
  });

  it('throws ParameterValidationError on bad path parameter', () => {
    let err: unknown;
    try {
      selectBackend({
        resolved: makeResolved({
          backend: 'static-stub',
          parameters: { target_dir: '/etc/passwd' },
        }),
        registry: makeStubRegistry(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ParameterValidationError);
  });
});

describe('SPEC-023-2-02 parameter merging (shallow)', () => {
  it('env params override defaults; missing keys preserved', () => {
    const reg = makeStubRegistry({
      'docker-stub': {
        schema: {
          port: { type: 'number', range: [1, 65535] },
          host: { type: 'string' },
        },
        defaults: { port: 8080, host: '0.0.0.0' },
      },
    });
    const r = selectBackend({
      resolved: makeResolved({ backend: 'docker-stub', parameters: { port: 9090 } }),
      registry: reg,
    });
    expect(r.parameters).toEqual({ port: 9090, host: '0.0.0.0' });
  });

  it('shallow merge: nested objects are replaced, not deep-merged', () => {
    const merged = mergeParameters(
      { tls: { cert: '/a', key: '/b' }, port: 8080 },
      { tls: { cert: '/x' } },
    );
    expect(merged).toEqual({ tls: { cert: '/x' }, port: 8080 });
  });

  it('mergeParameters preserves keys present only in defaults', () => {
    const merged = mergeParameters({ a: 1, b: 2 }, { b: 99 });
    expect(merged).toEqual({ a: 1, b: 99 });
  });
});

describe('SPEC-023-2-02 selector purity', () => {
  it('produces identical outputs across repeated calls', () => {
    const reg = makeStubRegistry();
    const args = {
      resolved: makeResolved({ backend: 'static-stub', parameters: { target_dir: '/tmp/x' } }),
      registry: reg,
    };
    const a = selectBackend(args);
    const b = selectBackend(args);
    expect(a).toEqual(b);
  });
});
