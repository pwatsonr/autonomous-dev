/**
 * Orchestrator wiring integration tests for issues #665, #666, #667.
 *
 * These tests exercise the REAL `runDeploy()` path — not stubs of the
 * orchestrator — to prove the wiring is live.
 *
 * Covers:
 *   - #666: runDeploy blocks on unsatisfied stateful precondition (throws
 *     StatefulPreconditionError).
 *   - #666: runDeploy proceeds when backupOverride=true.
 *   - #666: runDeploy proceeds when verifiedBackupRef is supplied.
 *   - #667: runDeploy returns failed when secretBindings set but no proxy.
 *   - #667: runDeploy resolves secret bindings JIT; record has safeBindings.
 *   - #667: resolved secretMaterial never appears in DeploymentRecord.
 *   - #665: runDeploy delegates to homelandDispatch for homelab location.
 *   - #665: homelandDispatch result sets location:'homelab' on the record.
 *   - #665: cloud path (resolvedTarget location=cloud) uses backend unchanged.
 *   - #665: backward compat — no resolvedTarget → existing backend path.
 *
 * @module tests/deploy/test-orchestrator-contract.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDeploy } from '../../intake/deploy/orchestrator';
import { StatefulPreconditionError } from '../../intake/deploy/errors';
import { BackendRegistry } from '../../intake/deploy/registry';
import { makeStubRegistry } from './helpers/test-registry';
import type {
  BackendMetadata,
  BuildArtifact,
  BuildContext,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../intake/deploy/types';
import type { ResolvedTarget } from '../../intake/deploy/target-resolver';
import type { CredentialProxy } from '../../intake/deploy/credential-proxy-types';
import type { HomelabDispatchContext } from '../../intake/deploy/orchestrator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orch-contract-'));
}

/** Minimal backend that always returns a successful deployed record. */
function makeNoopBackend(name: string): DeploymentBackend {
  const meta: BackendMetadata = {
    name,
    version: '1.0.0',
    supportedTargets: [],
    capabilities: [],
    requiredTools: [],
  };
  const record = (): DeploymentRecord => ({
    deployId: 'test-deploy-id',
    backend: name,
    environment: 'test',
    artifactId: 'test-artifact',
    deployedAt: new Date().toISOString(),
    status: 'deployed',
    details: {},
    hmac: '',
  });
  const artifact: BuildArtifact = {
    artifactId: 'test-artifact',
    type: 'directory',
    location: '/tmp/test',
    checksum: 'abc',
    sizeBytes: 0,
    metadata: {},
  };
  return {
    metadata: meta,
    async build(_ctx: BuildContext): Promise<BuildArtifact> {
      return artifact;
    },
    async deploy(): Promise<DeploymentRecord> {
      return record();
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true, checks: [] };
    },
    async rollback(): Promise<RollbackResult> {
      return { success: true, errors: [] };
    },
  };
}

function makeHomelabTarget(): ResolvedTarget {
  return {
    target: {
      id: 'homelab-node-42',
      name: 'Homelab Node 42',
      kind: 'swarm-node',
      provider: 'homelab-subprocess',
      capabilities: ['stateful'],
      tags: { location: 'homelab', node: 'rack-2-worker' },
      source: 'discovery',
      backup_class: 'orchestrated',
    },
    source: 'explicit-id',
  };
}

function makeCloudTarget(): ResolvedTarget {
  return {
    target: {
      id: 'cloud-run-svc',
      name: 'Cloud Run Service',
      kind: 'cloud-run-service',
      provider: 'gcp-cloud-run',
      capabilities: ['gcp-cloud-run'],
      tags: { location: 'cloud' },
      source: 'config',
    },
    source: 'config-default',
  };
}

function makeProxy(secretsByRef: Record<string, string>): CredentialProxy {
  return {
    async acquire(_provider, _op, scope) {
      const ref = scope.resource;
      const material = secretsByRef[ref];
      if (material === undefined) throw new Error(`permission denied for: ${ref}`);
      return {
        cloud: _provider,
        expiresAt: new Date(Date.now() + 900_000),
        tokenId: `tok-${ref}`,
        token: material,
      };
    },
  };
}

const BACKEND_NAME = 'noop-contract-test';
const selectorRegistry = makeStubRegistry({ [BACKEND_NAME]: { schema: {}, defaults: {} } });

function baseArgs(requestDir: string) {
  return {
    deployId: 'test-deploy-123',
    envName: 'integration-test',
    requestDir,
    actor: 'test-user',
    cliBackendOverride: BACKEND_NAME,
    selectorRegistry,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('#666 orchestrator stateful precondition wiring', () => {
  let requestDir: string;

  beforeAll(async () => {
    requestDir = await tmp();
    BackendRegistry.register(makeNoopBackend(BACKEND_NAME));
  });
  afterAll(async () => {
    await rm(requestDir, { recursive: true, force: true });
  });

  it('throws StatefulPreconditionError when backup required but no ref or override', async () => {
    const args = {
      ...baseArgs(requestDir),
      resolvedTarget: makeHomelabTarget(),
      requiresVerifiedBackup: true,
      // homelandDispatch omitted intentionally — should throw before reaching dispatch
      homelandDispatch: async () => ({
        status: 'deployed' as const,
        artifactId: 'a',
        deployedAt: '',
        details: {},
      }),
    };
    await expect(runDeploy(args)).rejects.toThrow(StatefulPreconditionError);
  });

  it('proceeds when backupOverride=true on stateful target', async () => {
    let dispatched = false;
    const args = {
      ...baseArgs(requestDir),
      resolvedTarget: makeHomelabTarget(),
      requiresVerifiedBackup: true,
      backupOverride: true,
      homelandDispatch: async (_ctx: HomelabDispatchContext) => {
        dispatched = true;
        expect(_ctx.overrideApplied).toBe(true);
        return {
          status: 'deployed' as const,
          artifactId: 'art-1',
          deployedAt: new Date().toISOString(),
          details: {},
        };
      },
    };
    const result = await runDeploy(args);
    expect(result.status).toBe('completed');
    expect(dispatched).toBe(true);
  });

  it('proceeds when verifiedBackupRef supplied on stateful target', async () => {
    let dispatched = false;
    const args = {
      ...baseArgs(requestDir),
      resolvedTarget: makeHomelabTarget(),
      requiresVerifiedBackup: true,
      verifiedBackupRef: 'backup-manifest-xyz',
      homelandDispatch: async (_ctx: HomelabDispatchContext) => {
        dispatched = true;
        expect(_ctx.verifiedBackupRef).toBe('backup-manifest-xyz');
        return {
          status: 'deployed' as const,
          artifactId: 'art-2',
          deployedAt: new Date().toISOString(),
          details: {},
        };
      },
    };
    const result = await runDeploy(args);
    expect(result.status).toBe('completed');
    expect(dispatched).toBe(true);
  });
});

describe('#667 orchestrator secret binding wiring', () => {
  let requestDir: string;

  beforeAll(async () => {
    requestDir = await tmp();
  });
  afterAll(async () => {
    await rm(requestDir, { recursive: true, force: true });
  });

  it('returns failed when secretBindings set but credentialProxy absent', async () => {
    const args = {
      ...baseArgs(requestDir),
      secretBindings: [{ credentialRef: 'vault/x', injectAs: 'env' as const, name: 'X' }],
      // No credentialProxy
    };
    const result = await runDeploy(args);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/credentialProxy/i);
  });

  it('resolves secretBindings JIT and persists only refHash on homelab record', async () => {
    const proxy = makeProxy({ 'vault/prod/db': 's3cr3t' });
    const args = {
      ...baseArgs(requestDir),
      resolvedTarget: makeHomelabTarget(),
      backupOverride: true,
      requiresVerifiedBackup: false,
      secretBindings: [{ credentialRef: 'vault/prod/db', injectAs: 'env' as const, name: 'DB_PW' }],
      credentialProxy: proxy,
      homelandDispatch: async (_ctx: HomelabDispatchContext) => {
        // ctx.secretBindings must contain only refHash — not the raw ref or material
        expect(_ctx.secretBindings).toHaveLength(1);
        expect(_ctx.secretBindings[0].refHash).toBeDefined();
        expect(Object.keys(_ctx.secretBindings[0])).not.toContain('credentialRef');
        expect(Object.keys(_ctx.secretBindings[0])).not.toContain('secretMaterial');
        return {
          status: 'deployed' as const,
          artifactId: 'art-3',
          deployedAt: new Date().toISOString(),
          details: {},
        };
      },
    };
    const result = await runDeploy(args);
    expect(result.status).toBe('completed');
    // record.secretBindings must not contain raw material
    if (result.record?.secretBindings) {
      for (const sb of result.record.secretBindings) {
        expect(Object.keys(sb)).not.toContain('secretMaterial');
        expect(Object.keys(sb)).not.toContain('credentialRef');
        expect(sb.refHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('#665 orchestrator location branching wiring', () => {
  let requestDir: string;

  beforeAll(async () => {
    requestDir = await tmp();
    BackendRegistry.register(makeNoopBackend(BACKEND_NAME));
  });
  afterAll(async () => {
    await rm(requestDir, { recursive: true, force: true });
  });

  it('delegates to homelandDispatch for homelab target', async () => {
    let dispatchCalled = false;
    const args = {
      ...baseArgs(requestDir),
      resolvedTarget: makeHomelabTarget(),
      homelandDispatch: async (_ctx: HomelabDispatchContext) => {
        dispatchCalled = true;
        expect(_ctx.resolvedTarget.target.id).toBe('homelab-node-42');
        return {
          status: 'deployed' as const,
          artifactId: 'hl-art',
          deployedAt: new Date().toISOString(),
          details: {},
        };
      },
    };
    const result = await runDeploy(args);
    expect(result.status).toBe('completed');
    expect(dispatchCalled).toBe(true);
    expect(result.record?.location).toBe('homelab');
    expect(result.record?.targetId).toBe('homelab-node-42');
    expect(result.record?.node).toBe('rack-2-worker');
  });

  it('returns failed when homelab target but no homelandDispatch', async () => {
    const args = {
      ...baseArgs(requestDir),
      resolvedTarget: makeHomelabTarget(),
      // no homelandDispatch
    };
    const result = await runDeploy(args);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/homelandDispatch/i);
  });

  it('takes cloud backend path when location=cloud', async () => {
    let dispatchCalled = false;
    const args = {
      ...baseArgs(requestDir),
      resolvedTarget: makeCloudTarget(),
      homelandDispatch: async () => {
        dispatchCalled = true;
        return { status: 'deployed' as const, artifactId: 'x', deployedAt: '', details: {} };
      },
    };
    const result = await runDeploy(args);
    // Cloud path goes through backend; no buildContext → failed (expected)
    // but homelandDispatch must NOT have been called
    expect(dispatchCalled).toBe(false);
    // Record has location:cloud from the target override
    if (result.record) {
      expect(result.record.location).toBe('cloud');
      expect(result.record.targetId).toBe('cloud-run-svc');
    }
  });

  it('backward compat: no resolvedTarget uses existing backend path', async () => {
    const args = baseArgs(requestDir);
    // No resolvedTarget → falls through to existing path (no buildContext → failed but no throw)
    const result = await runDeploy(args);
    // Should not throw; should return a record (failed due to no buildContext)
    expect(['completed', 'failed', 'paused', 'rejected']).toContain(result.status);
    // No location/targetId/node on record (no resolvedTarget)
    if (result.record) {
      expect(result.record.location).toBeUndefined();
      expect(result.record.targetId).toBeUndefined();
    }
  });
});
