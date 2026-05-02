/**
 * `static` deployment backend (SPEC-023-1-02, Task 5).
 *
 * Builds a directory artifact (typically `dist/`) via a configured build
 * command and rsyncs it to a local path or `user@host:/path` SSH target.
 *
 * Backend metadata: `name: 'static'`, capabilities `local-fs` and
 * `remote-rsync`, requires `rsync` on PATH.
 *
 * @module intake/deploy/backends/static
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  listDeploymentRecords,
  readArtifact,
  writeArtifact,
  writeDeploymentRecord,
} from '../artifact-store';
import { ParameterValidationError } from '../errors';
import { buildFileTreeManifest } from '../file-tree';
import { generateUlid } from '../id';
import { runTool, type RunToolOptions } from '../exec';
import type { DeployLogger } from '../logger';
import { validateParameters, type ParamSchema } from '../parameters';
import { signDeploymentRecord } from '../record-signer';
import type {
  BackendMetadata,
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../types';

/**
 * SSH-target shape: `user@host:/abs/path`. Validated by a dedicated
 * regex at deploy time (the parameter schema declares the value as a
 * generic string and the backend re-checks the SSH form).
 */
export const SSH_TARGET_RE =
  /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\/[A-Za-z0-9._/-]+$/;

export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  build_command: { type: 'string', default: 'npm run build', format: 'shell-safe-arg' },
  build_dir: { type: 'string', default: 'dist', format: 'path' },
  // `target` is a string; it must be EITHER an absolute local path OR a
  // user@host:/path SSH spec. We can't express the union in `format`,
  // so this schema accepts a permissive default-deny string and the
  // backend re-validates the union shape below.
  target: { type: 'string', required: true, regex: /^([A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)?\/[A-Za-z0-9._/-]+$/ },
  health_url: { type: 'string', format: 'url' },
  ssh_key_path: { type: 'string', format: 'path' },
};

export interface StaticBackendOptions {
  runTool?: typeof runTool;
  /**
   * Test seam — defaults to global `fetch`. Replaced in unit tests
   * with a fixture HTTP server response.
   */
  fetchFn?: typeof fetch;
  /** Optional structured logger (SPEC-023-3-02). Absence is non-fatal. */
  logger?: DeployLogger;
}

export class StaticBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'static',
    version: '0.1.0',
    supportedTargets: ['local-fs', 'remote-rsync'],
    capabilities: ['local-fs', 'remote-rsync'],
    requiredTools: ['rsync'],
  };

  private readonly run: typeof runTool;
  private readonly fetchFn: typeof fetch;
  private readonly logger: DeployLogger | undefined;
  private lastBuildContext: BuildContext | null = null;

  constructor(opts: StaticBackendOptions = {}) {
    this.run = opts.runTool ?? runTool;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- stable global ref
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const buildLogger = this.logger?.forComponent('build');
    const t0 = Date.now();
    buildLogger?.info('build_started', { commit: ctx.commitSha, target: ctx.branch });
    this.lastBuildContext = ctx;

    try {
      // Validate the build params (subset of full schema) so build-time
      // failures are surfaced before invoking external tools.
      const validation = validateParameters(
        {
          build_command: PARAM_SCHEMA.build_command,
          build_dir: PARAM_SCHEMA.build_dir,
        },
        {
          build_command: ctx.params.build_command ?? 'npm run build',
          build_dir: ctx.params.build_dir ?? 'dist',
        },
      );
      if (!validation.valid) throw new ParameterValidationError(validation.errors);
      const buildCommand = String(validation.sanitized.build_command);
      const buildDir = String(validation.sanitized.build_dir);

      if (isAbsolute(buildDir)) {
        throw new ParameterValidationError([
          { key: 'build_dir', message: 'must be relative to repoPath' },
        ]);
      }

      const tokens = buildCommand.split(/\s+/).filter((s) => s.length > 0);
      if (tokens.length === 0) {
        throw new ParameterValidationError([
          { key: 'build_command', message: 'is empty' },
        ]);
      }
      const [cmd, ...args] = tokens;

      const runOpts: RunToolOptions = { cwd: ctx.repoPath, timeoutMs: 600_000 };
      await this.run(cmd, args, runOpts);

      const fullBuildPath = resolve(ctx.repoPath, buildDir);
      const stat = await fs.stat(fullBuildPath).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new Error(
          `StaticBackend.build: build_dir does not exist or is not a directory: ${buildDir}`,
        );
      }

      const manifest = await buildFileTreeManifest(fullBuildPath);
      const artifact: BuildArtifact = {
        artifactId: generateUlid(),
        type: 'directory',
        location: buildDir,
        checksum: manifest.checksum,
        sizeBytes: manifest.sizeBytes,
        metadata: {
          fileCount: manifest.fileCount,
          commitSha: ctx.commitSha,
          branch: ctx.branch,
        },
      };
      buildLogger?.info('commit_validated', { commit: ctx.commitSha });
      await writeArtifact(ctx.repoPath, artifact);
      buildLogger?.info('build_completed', {
        duration_ms: Date.now() - t0,
        artifact_size_bytes: artifact.sizeBytes,
      });
      return artifact;
    } catch (err) {
      buildLogger?.error('build_failed', {
        error: (err as Error).message,
        stage: 'build',
      });
      throw err;
    }
  }

  async deploy(
    artifact: BuildArtifact,
    environment: string,
    params: DeployParameters,
  ): Promise<DeploymentRecord> {
    const ctx = this.lastBuildContext;
    if (!ctx) throw new Error('StaticBackend.deploy() called before build()');

    const deployLogger = this.logger?.forComponent('deploy');
    const t0 = Date.now();
    deployLogger?.info('deploy_started', { env: environment });

    try {
      const validation = validateParameters(PARAM_SCHEMA, params);
      if (!validation.valid) throw new ParameterValidationError(validation.errors);
      const sanitized = validation.sanitized;
      const target = String(sanitized.target);
      const buildDir = String(sanitized.build_dir);
      const sshKeyPath =
        typeof sanitized.ssh_key_path === 'string' ? sanitized.ssh_key_path : '';

      const isRemote = SSH_TARGET_RE.test(target);
      if (!isRemote && !isAbsolute(target)) {
        throw new ParameterValidationError([
          { key: 'target', message: 'target must be absolute path or user@host:/path' },
        ]);
      }

      // Trailing slash on src so rsync copies CONTENTS (not the dir itself).
      const src = `${resolve(ctx.repoPath, buildDir)}/`;
      const rsyncArgs: string[] = ['-az', '--delete'];
      if (isRemote && sshKeyPath) {
        rsyncArgs.push(
          '-e',
          `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=accept-new`,
        );
      }
      rsyncArgs.push(src, target);

      await this.run('rsync', rsyncArgs, { cwd: ctx.repoPath, timeoutMs: 300_000 });

      const unsigned: DeploymentRecord = {
        deployId: generateUlid(),
        backend: this.metadata.name,
        environment,
        artifactId: artifact.artifactId,
        deployedAt: new Date().toISOString(),
        status: 'deployed',
        details: {
          target,
          build_dir: buildDir,
          files_synced: artifact.metadata.fileCount as number,
          ...(typeof sanitized.health_url === 'string' && sanitized.health_url
            ? { health_url: sanitized.health_url }
            : {}),
        },
        hmac: '',
      };
      const signed = signDeploymentRecord(unsigned);
      await writeDeploymentRecord(ctx.repoPath, signed as unknown as Record<string, unknown> & { deployId: string });
      deployLogger?.info('deploy_completed', { duration_ms: Date.now() - t0 });
      return signed;
    } catch (err) {
      deployLogger?.error('deploy_failed', { error: (err as Error).message });
      throw err;
    }
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const healthLogger = this.logger?.forComponent('health');
    const t0 = Date.now();
    const url = typeof record.details.health_url === 'string' ? record.details.health_url : '';
    if (!url) {
      healthLogger?.info('health_check_passed', { latency_ms: Date.now() - t0 });
      return {
        healthy: true,
        checks: [{ name: 'no-health-url-configured', passed: true }],
      };
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5_000);
      try {
        const res = await this.fetchFn(url, { signal: ac.signal });
        const ok = res.status >= 200 && res.status < 300;
        const latency = Date.now() - t0;
        if (ok) healthLogger?.info('health_check_passed', { latency_ms: latency });
        else healthLogger?.warn('health_check_failed', { latency_ms: latency, error: `http-${res.status}` });
        return {
          healthy: ok,
          checks: [{ name: 'http-get', passed: ok, message: `status ${res.status}` }],
          ...(ok ? {} : { unhealthyReason: `http-${res.status}` }),
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      healthLogger?.warn('health_check_failed', {
        latency_ms: Date.now() - t0,
        error: (err as Error).message,
      });
      return {
        healthy: false,
        checks: [{ name: 'http-get', passed: false, message: (err as Error).message }],
        unhealthyReason: 'fetch-error',
      };
    }
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const ctx = this.lastBuildContext;
    if (!ctx) {
      return { success: false, errors: ['StaticBackend.rollback called before build/deploy'] };
    }
    // Find the most recent earlier deploy for the same backend+environment.
    const records = await listDeploymentRecords(ctx.repoPath);
    const earlier = records
      .filter(
        (r) =>
          r.backend === this.metadata.name &&
          r.environment === record.environment &&
          String(r.deployId) !== record.deployId,
      )
      .filter((r) => String(r.deployedAt) < record.deployedAt);
    const previous = earlier[earlier.length - 1] as
      | (Record<string, unknown> & { artifactId?: string; details?: Record<string, unknown> })
      | undefined;
    if (!previous || !previous.artifactId) {
      return {
        success: false,
        errors: ['no previous deployment record found for backend+environment'],
      };
    }
    try {
      const previousArtifact = await readArtifact(ctx.repoPath, previous.artifactId);
      const target = String(record.details.target ?? '');
      const buildDir = String(previousArtifact.location);
      const src = `${join(ctx.repoPath, buildDir)}/`;
      const rsyncArgs = ['-az', '--delete', src, target];
      await this.run('rsync', rsyncArgs, { cwd: ctx.repoPath, timeoutMs: 300_000 });
      return { success: true, restoredArtifactId: previous.artifactId, errors: [] };
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
  }
}
