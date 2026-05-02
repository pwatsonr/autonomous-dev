/**
 * SPEC-023-2-01 EnvironmentResolver tests.
 *
 * @module tests/deploy/test-environment-resolver.test
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configPathFor,
  loadConfig,
  resolveEnvironment,
} from '../../intake/deploy/environment';
import {
  ConfigValidationError,
  UnknownEnvironmentError,
} from '../../intake/deploy/errors';

const FIXTURES = join(__dirname, 'fixtures-023-2');

async function makeRepoWith(fixtureName: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'env-resolver-'));
  await mkdir(join(tmp, '.autonomous-dev'), { recursive: true });
  await copyFile(join(FIXTURES, fixtureName), join(tmp, '.autonomous-dev', 'deploy.yaml'));
  return tmp;
}

async function makeEmptyRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'env-resolver-empty-'));
}

describe('SPEC-023-2-01 loadConfig', () => {
  it('returns null when no deploy.yaml exists', async () => {
    const repo = await makeEmptyRepo();
    try {
      expect(await loadConfig(repo)).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns DeployConfig for the canonical valid fixture', async () => {
    const repo = await makeRepoWith('deploy-config-valid.yaml');
    try {
      const cfg = await loadConfig(repo);
      expect(cfg).not.toBeNull();
      expect(cfg!.version).toBe('1.0');
      expect(Object.keys(cfg!.environments).sort()).toEqual(['dev', 'prod', 'staging']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError on bad approval enum', async () => {
    const repo = await makeRepoWith('deploy-config-bad-enum.yaml');
    try {
      await expect(loadConfig(repo)).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError when env is missing backend', async () => {
    const repo = await makeRepoWith('deploy-config-missing-backend.yaml');
    try {
      await expect(loadConfig(repo)).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError on malformed YAML', async () => {
    const repo = await makeEmptyRepo();
    try {
      await mkdir(join(repo, '.autonomous-dev'), { recursive: true });
      await fs.writeFile(
        join(repo, '.autonomous-dev', 'deploy.yaml'),
        ': : : not yaml :::',
        'utf8',
      );
      await expect(loadConfig(repo)).rejects.toBeInstanceOf(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('configPathFor returns conventional path', () => {
    expect(configPathFor('/repo')).toBe('/repo/.autonomous-dev/deploy.yaml');
  });
});

describe('SPEC-023-2-01 resolveEnvironment', () => {
  it('returns fallback ResolvedEnvironment when config is null', () => {
    const r = resolveEnvironment(null, 'prod');
    expect(r.source).toBe('fallback');
    expect(r.backend).toBe('local');
    expect(r.approval).toBe('none');
    expect(r.costCapUsd).toBe(0);
    expect(r.configPath).toBeNull();
  });

  it('throws UnknownEnvironmentError for missing env', async () => {
    const repo = await makeRepoWith('deploy-config-valid.yaml');
    try {
      const cfg = await loadConfig(repo);
      let err: unknown;
      try {
        resolveEnvironment(cfg, 'ghost');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UnknownEnvironmentError);
      expect((err as UnknownEnvironmentError).available).toEqual(['dev', 'prod', 'staging']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('merges repo-level params with env-specific params (env wins)', () => {
    const cfg = {
      version: '1.0' as const,
      parameters: { region: 'us-east-1', shared: 'A' },
      environments: {
        prod: {
          backend: 'static',
          parameters: { shared: 'B', specific: 'X' },
          approval: 'two-person' as const,
          cost_cap_usd: 25,
        },
      },
    };
    const r = resolveEnvironment(cfg, 'prod');
    expect(r.parameters).toEqual({ region: 'us-east-1', shared: 'B', specific: 'X' });
    expect(r.source).toBe('deploy.yaml');
  });

  it('source is "deploy.yaml" for config-backed resolution', () => {
    const cfg = {
      version: '1.0' as const,
      environments: {
        dev: { backend: 'local', approval: 'none' as const, cost_cap_usd: 0 },
      },
    };
    const r = resolveEnvironment(cfg, 'dev');
    expect(r.source).toBe('deploy.yaml');
    expect(r.backend).toBe('local');
  });
});
