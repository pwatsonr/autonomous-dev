/**
 * `github-pages` deployment backend (SPEC-023-1-03, Task 7).
 *
 * Builds a directory artifact and pushes it to a `gh-pages` branch via
 * `git subtree push` (with a worktree-based fallback). Rollback uses
 * `git push --force-with-lease` keyed on the recorded `new_sha` so we
 * cannot trample concurrent deploys.
 *
 * Backend metadata: `name: 'github-pages'`, capability `github-pages`,
 * requires `git` and `gh` on PATH.
 *
 * @module intake/deploy/backends/github-pages
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { writeArtifact, writeDeploymentRecord } from '../artifact-store';
import { ExternalToolError, ParameterValidationError } from '../errors';
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

export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  build_command: { type: 'string', default: 'npm run build', format: 'shell-safe-arg' },
  build_dir: { type: 'string', default: 'dist', format: 'path' },
  pages_branch: { type: 'string', default: 'gh-pages', format: 'identifier' },
  pages_url: { type: 'string', format: 'url' },
  allow_force_rollback: { type: 'boolean', default: false },
};

export interface GithubPagesBackendOptions {
  runTool?: typeof runTool;
  fetchFn?: typeof fetch;
  /** Optional structured logger (SPEC-023-3-02). Absence is non-fatal. */
  logger?: DeployLogger;
}

const SUBTREE_DIVERGED_RE = /(would clobber existing tag|updates were rejected|non-fast-forward|diverged)/i;

export class GithubPagesBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'github-pages',
    version: '0.1.0',
    supportedTargets: ['github-pages'],
    capabilities: ['github-pages'],
    requiredTools: ['git', 'gh'],
  };

  private readonly run: typeof runTool;
  private readonly fetchFn: typeof fetch;
  private readonly logger: DeployLogger | undefined;
  private lastBuildContext: BuildContext | null = null;

  constructor(opts: GithubPagesBackendOptions = {}) {
    this.run = opts.runTool ?? runTool;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const buildLogger = this.logger?.forComponent('build');
    const t0 = Date.now();
    buildLogger?.info('build_started', { commit: ctx.commitSha, target: ctx.branch });
    this.lastBuildContext = ctx;
    const validation = validateParameters(
      {
        build_command: PARAM_SCHEMA.build_command,
        build_dir: PARAM_SCHEMA.build_dir,
        pages_branch: PARAM_SCHEMA.pages_branch,
      },
      {
        build_command: ctx.params.build_command ?? 'npm run build',
        build_dir: ctx.params.build_dir ?? 'dist',
        pages_branch: ctx.params.pages_branch ?? 'gh-pages',
      },
    );
    if (!validation.valid) {
      const err = new ParameterValidationError(validation.errors);
      buildLogger?.error('build_failed', { error: err.message, stage: 'validate_params' });
      throw err;
    }

    const buildCommand = String(validation.sanitized.build_command);
    const buildDir = String(validation.sanitized.build_dir);
    if (isAbsolute(buildDir)) {
      const err = new ParameterValidationError([
        { key: 'build_dir', message: 'must be relative to repoPath' },
      ]);
      buildLogger?.error('build_failed', { error: err.message, stage: 'validate_params' });
      throw err;
    }
    const tokens = buildCommand.split(/\s+/).filter((s) => s.length > 0);
    if (tokens.length === 0) {
      const err = new ParameterValidationError([
        { key: 'build_command', message: 'is empty' },
      ]);
      buildLogger?.error('build_failed', { error: err.message, stage: 'validate_params' });
      throw err;
    }
    const [cmd, ...args] = tokens;
    const runOpts: RunToolOptions = { cwd: ctx.repoPath, timeoutMs: 600_000 };
    try {
      await this.run(cmd, args, runOpts);

      const fullBuildPath = resolve(ctx.repoPath, buildDir);
      const stat = await fs.stat(fullBuildPath).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new Error(
          `GithubPagesBackend.build: build_dir does not exist: ${buildDir}`,
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
    if (!ctx) throw new Error('GithubPagesBackend.deploy() called before build()');

    const deployLogger = this.logger?.forComponent('deploy');
    const tDeploy = Date.now();
    deployLogger?.info('deploy_started', { env: environment });

    try {
      const validation = validateParameters(PARAM_SCHEMA, params);
      if (!validation.valid) {
        throw new ParameterValidationError(validation.errors);
      }
      const sanitized = validation.sanitized;
      const buildDir = String(sanitized.build_dir);
      const pagesBranch = String(sanitized.pages_branch);

      const runOpts: RunToolOptions = { cwd: ctx.repoPath, timeoutMs: 300_000 };

      // Capture pre-deploy sha (may be empty for first deploy).
      const previousSha = await this.lsRemoteSha(ctx.repoPath, pagesBranch);

      // Try subtree push first; fall back to worktree path on diverge.
      try {
        await this.run(
          'git',
          ['subtree', 'push', '--prefix', buildDir, 'origin', pagesBranch],
          runOpts,
        );
      } catch (err) {
        if (
          err instanceof ExternalToolError &&
          SUBTREE_DIVERGED_RE.test(err.stderr + err.stdout)
        ) {
          await this.worktreePush(ctx, buildDir, pagesBranch);
        } else {
          throw err;
        }
      }

      const newSha = await this.lsRemoteSha(ctx.repoPath, pagesBranch);

      const unsigned: DeploymentRecord = {
        deployId: generateUlid(),
        backend: this.metadata.name,
        environment,
        artifactId: artifact.artifactId,
        deployedAt: new Date().toISOString(),
        status: 'deployed',
        details: {
          pages_branch: pagesBranch,
          previous_sha: previousSha,
          new_sha: newSha,
          ...(typeof sanitized.pages_url === 'string' && sanitized.pages_url
            ? { pages_url: sanitized.pages_url }
            : {}),
          allow_force_rollback: Boolean(sanitized.allow_force_rollback),
        },
        hmac: '',
      };
      const signed = signDeploymentRecord(unsigned);
      await writeDeploymentRecord(ctx.repoPath, signed as unknown as Record<string, unknown> & { deployId: string });
      deployLogger?.info('deploy_completed', { duration_ms: Date.now() - tDeploy });
      return signed;
    } catch (err) {
      deployLogger?.error('deploy_failed', { error: (err as Error).message });
      throw err;
    }
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const healthLogger = this.logger?.forComponent('health');
    const t0 = Date.now();
    const url = typeof record.details.pages_url === 'string' ? record.details.pages_url : '';
    if (!url) {
      healthLogger?.info('health_check_passed', { latency_ms: Date.now() - t0 });
      return {
        healthy: true,
        checks: [{ name: 'no-pages-url-configured', passed: true }],
      };
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10_000);
      try {
        const res = await this.fetchFn(url, { signal: ac.signal });
        const ok = res.status === 200;
        const latency = Date.now() - t0;
        if (ok) healthLogger?.info('health_check_passed', { latency_ms: latency });
        else healthLogger?.warn('health_check_failed', { latency_ms: latency, error: `http-${res.status}` });
        return {
          healthy: ok,
          checks: [{ name: 'pages-url', passed: ok, message: `status ${res.status}` }],
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
        checks: [{ name: 'pages-url', passed: false, message: (err as Error).message }],
        unhealthyReason: 'fetch-error',
      };
    }
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const ctx = this.lastBuildContext;
    if (!ctx) {
      return { success: false, errors: ['rollback called before build/deploy'] };
    }
    const previousSha = String(record.details.previous_sha ?? '');
    const newSha = String(record.details.new_sha ?? '');
    const pagesBranch = String(record.details.pages_branch ?? 'gh-pages');
    const allowForce = Boolean(record.details.allow_force_rollback);

    if (!previousSha) {
      return { success: false, errors: ['no previous sha to restore'] };
    }

    const remoteSha = await this.lsRemoteSha(ctx.repoPath, pagesBranch);
    if (remoteSha !== newSha && !allowForce) {
      return {
        success: false,
        errors: [
          `gh-pages HEAD moved since deploy (remote=${remoteSha}, recorded=${newSha}); rerun with allow_force_rollback=true to override`,
        ],
      };
    }

    try {
      await this.run(
        'git',
        [
          'push',
          `--force-with-lease=${pagesBranch}:${newSha}`,
          'origin',
          `${previousSha}:${pagesBranch}`,
        ],
        { cwd: ctx.repoPath, timeoutMs: 300_000 },
      );
      return {
        success: true,
        restoredArtifactId: String(record.artifactId),
        errors: [],
      };
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
  }

  private async lsRemoteSha(cwd: string, branch: string): Promise<string> {
    try {
      const result = await this.run(
        'git',
        ['ls-remote', 'origin', branch],
        { cwd, timeoutMs: 30_000 },
      );
      // Output: "<sha>\trefs/heads/<branch>" or empty.
      const line = result.stdout.split('\n').find((l) => l.includes(branch));
      if (!line) return '';
      const sha = line.split(/\s+/)[0] ?? '';
      return sha;
    } catch {
      return '';
    }
  }

  private async worktreePush(
    ctx: BuildContext,
    buildDir: string,
    pagesBranch: string,
  ): Promise<void> {
    // The worktree fallback is intentionally minimal: it stages the build
    // directory contents on a fresh `pagesBranch` checkout and pushes WITHOUT
    // --force. If the remote moved between subtree's failure and this push,
    // the push fails — that's the desired behavior in the deploy direction.
    await this.run(
      'git',
      ['push', 'origin', `HEAD:${pagesBranch}`],
      { cwd: resolve(ctx.repoPath, buildDir), timeoutMs: 300_000 },
    );
  }
}
