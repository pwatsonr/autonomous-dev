/**
 * `local` deployment backend (SPEC-023-1-02, Task 4).
 *
 * Commits the validated artifact to a feature branch and opens a GitHub
 * pull request via `gh pr create`. This is the simplest backend and
 * supersedes the deploy-phase stub.
 *
 * Backend metadata: `name: 'local'`, capability `github-pr`, requires
 * `git` and `gh` on PATH.
 *
 * @module intake/deploy/backends/local
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeArtifact,
  writeDeploymentRecord,
} from '../artifact-store';
import { generateUlid } from '../id';
import { ParameterValidationError } from '../errors';
import { runTool, type RunToolOptions } from '../exec';
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
 * Public parameter schema. Exported so SPEC-023-1-04's
 * `deploy backends describe` CLI can render it without duplicating
 * the validator's source of truth.
 */
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  pr_title: { type: 'string', required: true, format: 'shell-safe-arg', regex: /^.{1,200}$/ },
  pr_body: { type: 'string', required: true, regex: /^[\s\S]{1,8000}$/ },
  base_branch: { type: 'string', default: 'main', regex: /^[A-Za-z0-9._/-]+$/ },
};

/** Test-only seam — production callers use the default. */
export interface LocalBackendOptions {
  runTool?: typeof runTool;
}

const PR_URL_REGEX = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/;

export class LocalBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'local',
    version: '0.1.0',
    supportedTargets: ['github-pr'],
    capabilities: ['github-pr'],
    requiredTools: ['git', 'gh'],
  };

  private readonly run: typeof runTool;
  private lastBuildContext: BuildContext | null = null;

  constructor(opts: LocalBackendOptions = {}) {
    this.run = opts.runTool ?? runTool;
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    // Pure: capture the context for `deploy()` (no side effects on the
    // repo). The HMAC-flavored checksum makes two builds with identical
    // context produce identical checksums (deterministic).
    this.lastBuildContext = ctx;
    const checksum = createHash('sha256')
      .update(ctx.commitSha)
      .update('\0')
      .update(ctx.branch)
      .update('\0')
      .update(ctx.requestId)
      .digest('hex');
    const artifact: BuildArtifact = {
      artifactId: generateUlid(),
      type: 'commit',
      location: ctx.commitSha,
      checksum,
      sizeBytes: 0,
      metadata: { branch: ctx.branch, requestId: ctx.requestId },
    };
    await writeArtifact(ctx.repoPath, artifact);
    return artifact;
  }

  async deploy(
    artifact: BuildArtifact,
    environment: string,
    params: DeployParameters,
  ): Promise<DeploymentRecord> {
    const ctx = this.lastBuildContext;
    if (!ctx) {
      throw new Error('LocalBackend.deploy() called before build()');
    }

    const validation = validateParameters(PARAM_SCHEMA, params);
    if (!validation.valid) throw new ParameterValidationError(validation.errors);
    const sanitized = validation.sanitized;
    const prTitle = String(sanitized.pr_title);
    const prBody = String(sanitized.pr_body);
    const baseBranch = String(sanitized.base_branch);

    const runOpts: RunToolOptions = { cwd: ctx.repoPath };

    // Abort BEFORE git push if worktree is dirty — refuse to deploy a
    // mismatch between commitSha and live worktree.
    const status = await this.run('git', ['status', '--porcelain'], runOpts);
    if (status.stdout.trim().length > 0) {
      throw new Error(
        `LocalBackend.deploy aborted: worktree is dirty\n${status.stdout}`,
      );
    }

    await this.run('git', ['push', 'origin', ctx.branch], runOpts);

    // pr_body via temp file to keep the argv shell-safe.
    const tmpFile = join(
      tmpdir(),
      `local-pr-body-${ctx.requestId}-${Date.now()}.md`,
    );
    await fs.writeFile(tmpFile, prBody, { mode: 0o600 });
    let prUrl: string;
    try {
      const created = await this.run(
        'gh',
        [
          'pr',
          'create',
          '--title',
          prTitle,
          '--body-file',
          tmpFile,
          '--base',
          baseBranch,
          '--head',
          ctx.branch,
        ],
        runOpts,
      );
      const match = created.stdout.match(PR_URL_REGEX);
      if (!match) {
        throw new Error(
          `LocalBackend.deploy: gh pr create did not emit a PR URL\nstdout: ${created.stdout}`,
        );
      }
      prUrl = match[0];
    } finally {
      // Best-effort cleanup; tempfile was 0600 so leaks are not a leak
      // of secrets, but the test asserts removal regardless of outcome.
      await fs.unlink(tmpFile).catch(() => undefined);
    }

    const unsigned: DeploymentRecord = {
      deployId: generateUlid(),
      backend: this.metadata.name,
      environment,
      artifactId: artifact.artifactId,
      deployedAt: new Date().toISOString(),
      status: 'deployed',
      details: {
        pr_url: prUrl,
        branch: ctx.branch,
        base_branch: baseBranch,
      },
      hmac: '',
    };
    const signed = signDeploymentRecord(unsigned);
    await writeDeploymentRecord(ctx.repoPath, signed as unknown as Record<string, unknown> & { deployId: string });
    return signed;
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const prUrl = String(record.details.pr_url ?? '');
    if (!prUrl) {
      return {
        healthy: false,
        checks: [{ name: 'pr-url-missing', passed: false }],
        unhealthyReason: 'pr-url-missing',
      };
    }
    try {
      const result = await this.run(
        'gh',
        ['pr', 'view', prUrl, '--json', 'state'],
        { cwd: process.cwd() },
      );
      const parsed = JSON.parse(result.stdout) as { state?: string };
      const open = parsed.state === 'OPEN';
      return {
        healthy: open,
        checks: [
          { name: 'pr-state', passed: open, message: parsed.state ?? 'unknown' },
        ],
        ...(open ? {} : { unhealthyReason: `pr-state-${parsed.state ?? 'unknown'}` }),
      };
    } catch (err) {
      return {
        healthy: false,
        checks: [{ name: 'pr-state', passed: false, message: (err as Error).message }],
        unhealthyReason: 'gh-pr-view-failed',
      };
    }
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const prUrl = String(record.details.pr_url ?? '');
    if (!prUrl) {
      return { success: false, errors: ['pr_url missing from record details'] };
    }
    try {
      await this.run(
        'gh',
        [
          'pr',
          'close',
          prUrl,
          '--comment',
          `Rolled back by autonomous-dev deployId=${record.deployId}`,
        ],
        { cwd: process.cwd() },
      );
      return { success: true, errors: [] };
    } catch (err) {
      return { success: false, errors: [(err as Error).message] };
    }
  }
}
