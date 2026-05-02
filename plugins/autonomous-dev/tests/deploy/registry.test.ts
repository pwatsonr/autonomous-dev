/**
 * SPEC-023-1-04 BackendRegistry tests.
 *
 * @module tests/deploy/registry.test
 */

import { BackendNotFoundError } from '../../intake/deploy/errors';
import { LocalBackend } from '../../intake/deploy/backends/local';
import { StaticBackend } from '../../intake/deploy/backends/static';
import { DockerLocalBackend } from '../../intake/deploy/backends/docker-local';
import { GithubPagesBackend } from '../../intake/deploy/backends/github-pages';
import { BackendRegistry } from '../../intake/deploy/registry';
import { registerBundledBackendsSync } from '../../intake/deploy/registry-bootstrap';

describe('SPEC-023-1-04 BackendRegistry', () => {
  beforeEach(() => BackendRegistry.clear());
  afterEach(() => BackendRegistry.clear());

  it('registerSync followed by get returns the same instance', () => {
    const inst = new LocalBackend();
    BackendRegistry.registerSync(inst);
    expect(BackendRegistry.get('local')).toBe(inst);
  });

  it('get throws BackendNotFoundError for an unknown name', () => {
    let err: unknown;
    try {
      BackendRegistry.get('does-not-exist');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BackendNotFoundError);
    expect((err as BackendNotFoundError).backendName).toBe('does-not-exist');
  });

  it('registerBundledBackendsSync produces 4 entries in alphabetical order', () => {
    registerBundledBackendsSync();
    const list = BackendRegistry.list();
    expect(list.map((e) => e.backend.metadata.name)).toEqual([
      'docker-local',
      'github-pages',
      'local',
      'static',
    ]);
  });

  it('clear() empties the registry', () => {
    registerBundledBackendsSync();
    expect(BackendRegistry.list().length).toBe(4);
    BackendRegistry.clear();
    expect(BackendRegistry.list().length).toBe(0);
  });

  it('async register marks unavailable when tool probe fails', async () => {
    await BackendRegistry.register(new DockerLocalBackend(), {
      runTool: () => Promise.reject(new Error('docker not found')),
      logger: { warn: () => {} },
    });
    const entry = BackendRegistry.getEntry('docker-local');
    expect(entry.available).toBe(false);
    expect(entry.unavailableReason).toMatch(/docker/);
  });

  it('async register marks available when tool probe succeeds', async () => {
    await BackendRegistry.register(new StaticBackend(), {
      runTool: async () => ({ stdout: 'rsync v3.x', stderr: '' }),
      logger: { warn: () => {} },
    });
    const entry = BackendRegistry.getEntry('static');
    expect(entry.available).toBe(true);
    expect(entry.unavailableReason).toBeUndefined();
  });

  it('register is idempotent (overwrites by name)', () => {
    const a = new GithubPagesBackend();
    const b = new GithubPagesBackend();
    BackendRegistry.registerSync(a);
    BackendRegistry.registerSync(b);
    expect(BackendRegistry.get('github-pages')).toBe(b);
    expect(BackendRegistry.list().length).toBe(1);
  });
});
