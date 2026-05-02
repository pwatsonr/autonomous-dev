/**
 * `docker-local` deployment backend (SPEC-023-1-03, Task 6).
 *
 * Builds an OCI image, runs a container with port mapping, captures the
 * container ID in the deployment record. Rollback stops/removes the
 * current container and (optionally) re-deploys the previous image.
 *
 * Backend metadata: `name: 'docker-local'`, capability `localhost-docker`,
 * requires `docker` on PATH.
 *
 * @module intake/deploy/backends/docker-local
 */

import {
  listDeploymentRecords,
  readArtifact,
  writeArtifact,
  writeDeploymentRecord,
} from '../artifact-store';
import { ParameterValidationError } from '../errors';
import { generateUlid } from '../id';
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

export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  image_name: {
    type: 'string',
    required: true,
    regex: /^[a-z0-9_-]{1,64}$/,
  },
  dockerfile_path: { type: 'string', default: 'Dockerfile', format: 'path' },
  host_port: { type: 'number', required: true, range: [1024, 65535] },
  container_port: { type: 'number', required: true, range: [1, 65535] },
  health_path: { type: 'string', default: '/', format: 'path' },
  health_timeout_seconds: { type: 'number', default: 30, range: [1, 300] },
};

export interface DockerLocalBackendOptions {
  runTool?: typeof runTool;
  fetchFn?: typeof fetch;
  /** Test seam for `setTimeout` so health-check polling can use fake timers. */
  sleepFn?: (ms: number) => Promise<void>;
}

export class DockerLocalBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'docker-local',
    version: '0.1.0',
    supportedTargets: ['localhost-docker'],
    capabilities: ['localhost-docker'],
    requiredTools: ['docker'],
  };

  private readonly run: typeof runTool;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastBuildContext: BuildContext | null = null;

  constructor(opts: DockerLocalBackendOptions = {}) {
    this.run = opts.runTool ?? runTool;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      opts.sleepFn ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    this.lastBuildContext = ctx;
    const validation = validateParameters(
      {
        image_name: PARAM_SCHEMA.image_name,
        dockerfile_path: PARAM_SCHEMA.dockerfile_path,
      },
      {
        image_name: ctx.params.image_name,
        ...(ctx.params.dockerfile_path !== undefined
          ? { dockerfile_path: ctx.params.dockerfile_path }
          : {}),
      },
    );
    if (!validation.valid) throw new ParameterValidationError(validation.errors);
    const imageName = String(validation.sanitized.image_name);
    const dockerfilePath = String(validation.sanitized.dockerfile_path);

    const tag = `${imageName}:${ctx.commitSha.slice(0, 12)}`;
    const runOpts: RunToolOptions = {
      cwd: ctx.repoPath,
      timeoutMs: 1_200_000,
    };
    await this.run(
      'docker',
      ['build', '-t', tag, '-f', dockerfilePath, '.'],
      runOpts,
    );
    const inspect = await this.run(
      'docker',
      ['image', 'inspect', tag, '--format', '{{.Id}}'],
      { cwd: ctx.repoPath, timeoutMs: 30_000 },
    );
    const imageId = inspect.stdout.trim();

    const artifact: BuildArtifact = {
      artifactId: generateUlid(),
      type: 'docker-image',
      location: tag,
      // Docker-image artifacts use the image_id as the integrity anchor.
      // Length is not 64-hex (sha256:<hex>) so we hash it ourselves into
      // a stable lowercase-hex sha256 to satisfy the conformance suite.
      checksum: hashSha256(imageId),
      sizeBytes: 0,
      metadata: {
        image_id: imageId,
        image_tag: tag,
        commitSha: ctx.commitSha,
      },
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
      throw new Error('DockerLocalBackend.deploy() called before build()');
    }

    const extra = (params.extra_run_args as unknown) ?? [];
    if (!Array.isArray(extra) || !extra.every((v) => typeof v === 'string')) {
      throw new ParameterValidationError([
        { key: 'extra_run_args', message: 'must be a string[] when present' },
      ]);
    }
    // Validate each entry as shell-safe-arg; compose into the validator.
    for (let i = 0; i < extra.length; i++) {
      const v = extra[i] as string;
      const r = validateParameters(
        { v: { type: 'string', format: 'shell-safe-arg' } },
        { v },
      );
      if (!r.valid) {
        throw new ParameterValidationError([
          { key: `extra_run_args[${i}]`, message: r.errors[0]?.message ?? 'invalid' },
        ]);
      }
    }

    // Validate the rest of the schema (without extra_run_args).
    const { extra_run_args: _drop, ...rest } = params as Record<string, unknown>;
    const validation = validateParameters(PARAM_SCHEMA, rest);
    if (!validation.valid) throw new ParameterValidationError(validation.errors);
    const sanitized = validation.sanitized;
    const imageName = String(sanitized.image_name);
    const hostPort = Number(sanitized.host_port);
    const containerPort = Number(sanitized.container_port);

    const containerName = `${imageName}-${ctx.requestId}`;
    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      `${hostPort}:${containerPort}`,
      ...(extra as string[]),
      artifact.location,
    ];
    const result = await this.run('docker', args, {
      cwd: ctx.repoPath,
      timeoutMs: 60_000,
    });
    const containerId = result.stdout.trim();

    const unsigned: DeploymentRecord = {
      deployId: generateUlid(),
      backend: this.metadata.name,
      environment,
      artifactId: artifact.artifactId,
      deployedAt: new Date().toISOString(),
      status: 'deployed',
      details: {
        container_id: containerId,
        container_name: containerName,
        image_tag: artifact.location,
        host_port: hostPort,
        container_port: containerPort,
        health_path: String(sanitized.health_path),
        health_timeout_seconds: Number(sanitized.health_timeout_seconds),
      },
      hmac: '',
    };
    const signed = signDeploymentRecord(unsigned);
    await writeDeploymentRecord(ctx.repoPath, signed as unknown as Record<string, unknown> & { deployId: string });
    return signed;
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const hostPort = Number(record.details.host_port);
    const healthPath = String(record.details.health_path ?? '/');
    const timeoutSec = Number(record.details.health_timeout_seconds ?? 30);
    const containerId = String(record.details.container_id ?? '');
    const url = `http://127.0.0.1:${hostPort}${healthPath}`;

    const checks: HealthStatus['checks'] = [];

    // First: container running?
    let containerRunning = false;
    try {
      const inspect = await this.run(
        'docker',
        ['inspect', '--format', '{{.State.Status}}', containerId],
        { cwd: process.cwd(), timeoutMs: 10_000 },
      );
      containerRunning = inspect.stdout.trim() === 'running';
      checks.push({
        name: 'container-running',
        passed: containerRunning,
        message: inspect.stdout.trim(),
      });
    } catch (err) {
      checks.push({
        name: 'container-running',
        passed: false,
        message: (err as Error).message,
      });
    }

    // Then: poll health URL until 2xx or timeout.
    const deadline = Date.now() + timeoutSec * 1000;
    let probeOk = false;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5_000);
        try {
          const res = await this.fetchFn(url, { signal: ac.signal });
          lastStatus = res.status;
          if (res.status >= 200 && res.status < 300) {
            probeOk = true;
            break;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // swallow — retry until deadline
      }
      await this.sleep(1_000);
    }
    checks.push({
      name: 'http-probe',
      passed: probeOk,
      message: probeOk ? `status ${lastStatus}` : 'timeout',
    });

    if (probeOk && containerRunning) {
      return { healthy: true, checks };
    }
    return {
      healthy: false,
      checks,
      unhealthyReason: !probeOk ? 'health-timeout' : 'container-not-running',
    };
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const ctx = this.lastBuildContext;
    const errors: string[] = [];
    const containerId = String(record.details.container_id ?? '');
    const stopOpts: RunToolOptions = { cwd: process.cwd(), timeoutMs: 30_000 };

    if (containerId) {
      try {
        await this.run('docker', ['stop', containerId], stopOpts);
      } catch (err) {
        const msg = (err as Error).message;
        // Idempotent: ignore "no such container" / "already stopped".
        if (!/No such container|is not running/i.test(msg)) {
          errors.push(`stop: ${msg}`);
        }
      }
      try {
        await this.run('docker', ['rm', containerId], stopOpts);
      } catch (err) {
        const msg = (err as Error).message;
        if (!/No such container/i.test(msg)) {
          errors.push(`rm: ${msg}`);
        }
      }
    }

    // Try to redeploy the previous artifact for the same backend+env.
    let restoredArtifactId: string | undefined;
    if (ctx) {
      try {
        const records = await listDeploymentRecords(ctx.repoPath);
        const earlier = records
          .filter(
            (r) =>
              r.backend === this.metadata.name &&
              r.environment === record.environment &&
              String(r.deployId) !== record.deployId &&
              String(r.deployedAt) < record.deployedAt,
          );
        const previous = earlier[earlier.length - 1] as
          | (Record<string, unknown> & {
              artifactId?: string;
              details?: Record<string, unknown>;
            })
          | undefined;
        if (previous && previous.artifactId) {
          const previousArtifact = await readArtifact(
            ctx.repoPath,
            previous.artifactId,
          );
          const prevDetails = previous.details ?? {};
          const containerName = `${String(prevDetails.container_name ?? `restore-${ctx.requestId}`)}-rb`;
          const hostPort = Number(prevDetails.host_port ?? record.details.host_port);
          const containerPort = Number(prevDetails.container_port ?? record.details.container_port);
          await this.run(
            'docker',
            [
              'run',
              '-d',
              '--name',
              containerName,
              '-p',
              `${hostPort}:${containerPort}`,
              previousArtifact.location,
            ],
            { cwd: ctx.repoPath, timeoutMs: 60_000 },
          );
          restoredArtifactId = previous.artifactId;
        }
      } catch (err) {
        errors.push(`restore-previous: ${(err as Error).message}`);
      }
    }

    return {
      success: errors.length === 0,
      ...(restoredArtifactId ? { restoredArtifactId } : {}),
      errors,
    };
  }
}

function hashSha256(input: string): string {
  // Local helper to avoid a fresh import at top — keeps the module import
  // graph minimal. SHA-256 always emits 64 hex chars, which the
  // conformance suite asserts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}
