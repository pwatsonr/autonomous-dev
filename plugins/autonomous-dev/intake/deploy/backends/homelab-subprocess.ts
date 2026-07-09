/**
 * Homelab subprocess deploy backend (issue #662).
 *
 * A `PipelineBackend` implementation for targets whose `kind` is a homelab
 * variant (e.g. `'swarm-node'`, `'k3s-cluster'`, `'proxmox-vm'`, `'unraid'`).
 * Each stage shells out to the homelab plugin CLI so this core module stays
 * decoupled from homelab internals.
 *
 * ## CLI invocation
 *
 * All stages call the homelab plugin CLI at
 * `HOMELAB_PLUGIN_PATH` (env var) or the default path:
 * `/Users/pwatson/codebase/autonomous-dev-homelab/plugins/autonomous-dev-homelab/dist/cli/index.js`
 *
 * Subcommands dispatched per stage:
 *   - `build`:        `node <cli> deploy build   <service> [--tag <tag>] [--source-dir <dir>]`
 *   - `push`:         `node <cli> deploy push    <service> [--tag <tag>]`
 *   - `deploy`:       `node <cli> deploy apply   <service> --target <target-id> [--tag <tag>]`
 *   - `verifyHealth`: `node <cli> deploy health  <service> --target <target-id>`
 *   - `rollback`:     `node <cli> deploy rollback <service> --target <target-id>`
 *
 * ## supports() semantics (invariant #674)
 *
 * Matches on `target.kind` using the `HOMELAB_KINDS` open set — a set of
 * known homelab target kinds populated at module load. Plugins may extend
 * it via `registerHomelabKind()`. Never matches on `target.id`.
 *
 * ## VAULT_TOKEN
 *
 * When `VAULT_TOKEN` is set in `process.env`, it is forwarded to the child
 * process environment so the homelab CLI can authenticate to Vault.
 *
 * ## Registration
 *
 * This module auto-registers itself via `registerPipelineBackend()` at import
 * time so callers only need `import './backends/homelab-subprocess'` from an
 * activation hook. Re-import is idempotent (registry replaces on same id).
 *
 * Cross-reference: issues #662, #674.
 *
 * @module intake/deploy/backends/homelab-subprocess
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PipelineBackend, PipelineContext, DeployResult, HealthResult, RollbackResult } from '../backend-types';
import { registerPipelineBackend } from '../backend-types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Homelab kind registry (open set — invariant #674)
// ---------------------------------------------------------------------------

/**
 * Set of target `kind` strings handled by this backend.
 *
 * New homelab kinds (e.g., `'proxmox-lxc'`, `'talos-node'`) are added via
 * `registerHomelabKind()` — no change to `supports()` logic required.
 */
const HOMELAB_KINDS = new Set<string>([
  'swarm-node',
  'k3s-cluster',
  'proxmox-vm',
  'proxmox-lxc',
  'unraid',
  'homelab',
]);

/**
 * Register an additional target kind as a homelab kind.
 *
 * Idempotent. Called from plugin `activate()` hooks when a new homelab node
 * type is discovered that should be routed through this backend.
 *
 * @param kind - The `DeployTarget.kind` string to add.
 */
export function registerHomelabKind(kind: string): void {
  HOMELAB_KINDS.add(kind);
}

/**
 * Return all currently registered homelab kind strings.
 *
 * Primarily for introspection and tests.
 */
export function listHomelabKinds(): string[] {
  return [...HOMELAB_KINDS].sort();
}

// ---------------------------------------------------------------------------
// Default CLI path
// ---------------------------------------------------------------------------

/**
 * Default path to the homelab plugin CLI.
 *
 * Resolved from `HOMELAB_PLUGIN_PATH` env var; falls back to the canonical
 * local development path when the env var is not set.
 */
export const DEFAULT_HOMELAB_CLI_PATH =
  '/Users/pwatson/codebase/autonomous-dev-homelab/plugins/autonomous-dev-homelab/dist/cli/index.js';

/**
 * Resolve the effective homelab CLI path.
 *
 * Reads `HOMELAB_PLUGIN_PATH` from `process.env` at call time so tests can
 * override it without module re-import.
 *
 * @param env - Environment snapshot (defaults to `process.env`).
 * @returns Absolute path to the homelab CLI.
 */
export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['HOMELAB_PLUGIN_PATH'] ?? DEFAULT_HOMELAB_CLI_PATH;
}

// ---------------------------------------------------------------------------
// Subprocess invocation helper
// ---------------------------------------------------------------------------

/** Options for subprocess invocation — injectable for tests. */
export interface SpawnOptions {
  /** Override for `execFile` — injected in tests to avoid live spawns. */
  execFileFn?: typeof execFileAsync;
  /** Environment passed to the child process (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Internal result of a subprocess invocation.
 */
export interface SpawnResult {
  stdout: string;
  stderr: string;
}

/**
 * Invoke the homelab CLI subprocess.
 *
 * Builds the `node <cliPath> <args>` argv, forwards `VAULT_TOKEN` from the
 * environment, and returns combined `{ stdout, stderr }`.
 *
 * Throws on non-zero exit (the `execFile` rejection carries both streams in
 * the error message).
 *
 * @param cliPath - Absolute path to the homelab plugin CLI.
 * @param args    - CLI subcommand arguments.
 * @param opts    - Optional override for the exec function and environment.
 * @returns `SpawnResult` with trimmed stdout and stderr.
 */
export async function invokeHomelabCli(
  cliPath: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const execFn = opts.execFileFn ?? execFileAsync;
  const baseEnv = opts.env ?? process.env;

  // Forward VAULT_TOKEN when present.
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv };
  if (baseEnv['VAULT_TOKEN']) {
    childEnv['VAULT_TOKEN'] = baseEnv['VAULT_TOKEN'];
  }

  const { stdout, stderr } = await execFn('node', [cliPath, ...args], {
    env: childEnv,
    timeout: 300_000, // 5-minute timeout for deploy operations
    maxBuffer: 10 * 1024 * 1024, // 10 MiB
    shell: false,
    windowsHide: true,
  } as Parameters<typeof execFileAsync>[2]);

  return {
    stdout: String(stdout).trim(),
    stderr: String(stderr).trim(),
  };
}

// ---------------------------------------------------------------------------
// HomelabSubprocessBackend
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for `HomelabSubprocessBackend`.
 *
 * Provided so tests can mock the subprocess call without spawning real
 * processes and without touching `process.env`.
 */
export interface HomelabSubprocessBackendDeps {
  /** Override the CLI path lookup (skips env-var resolution). */
  cliPath?: string;
  /** Override the exec function (mock subprocess call). */
  execFileFn?: typeof execFileAsync;
  /** Override the environment passed to child processes. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Deploy backend for homelab-kind targets.
 *
 * Stages build / push / deploy / verifyHealth / rollback by shelling out to
 * the homelab plugin CLI. The CLI path and VAULT_TOKEN are resolved from the
 * process environment at call time (not at construction time) so a single
 * instance works across env reloads.
 *
 * ## Backend ID
 *
 * `'homelab-subprocess'` — unique stable identifier used by the registry.
 *
 * ## supports()
 *
 * Returns `true` when `target.kind` is a member of `HOMELAB_KINDS`.
 * Never inspects `target.id` (invariant #674).
 */
export class HomelabSubprocessBackend implements PipelineBackend {
  readonly id = 'homelab-subprocess';

  /** Whether this backend requires a registry push stage. */
  readonly requiresPush = false;

  private readonly deps: HomelabSubprocessBackendDeps;

  /**
   * Construct a `HomelabSubprocessBackend`.
   *
   * @param deps - Injectable overrides for testing (CLI path, exec function, env).
   */
  constructor(deps: HomelabSubprocessBackendDeps = {}) {
    this.deps = deps;
  }

  /**
   * Return true when the target's kind is a known homelab kind.
   *
   * Dispatch is on `target.kind` — NOT on `target.id`. Satisfies invariant #674.
   *
   * @param target - The deploy target to test.
   */
  supports(target: { kind: string }): boolean {
    return HOMELAB_KINDS.has(target.kind);
  }

  /**
   * Build the artifact by invoking `homelab deploy build <service>`.
   *
   * Writes the resolved built image tag to `ctx.meta['builtTag']` so the push
   * and deploy stages can read it.
   *
   * @param ctx - Pipeline context.
   */
  async build(ctx: PipelineContext): Promise<void> {
    const cliPath = this.deps.cliPath ?? resolveCliPath(this.deps.env);
    const args = this.buildBuildArgs(ctx);
    const result = await invokeHomelabCli(cliPath, args, {
      execFileFn: this.deps.execFileFn,
      env: this.deps.env,
    });
    // Store stdout as the built tag for downstream stages.
    if (result.stdout) {
      ctx.meta['builtTag'] = result.stdout;
    }
  }

  /**
   * Push the artifact by invoking `homelab deploy push <service>`.
   *
   * @param ctx - Pipeline context.
   */
  async push(ctx: PipelineContext): Promise<void> {
    const cliPath = this.deps.cliPath ?? resolveCliPath(this.deps.env);
    const args = this.buildPushArgs(ctx);
    await invokeHomelabCli(cliPath, args, {
      execFileFn: this.deps.execFileFn,
      env: this.deps.env,
    });
  }

  /**
   * Deploy the artifact by invoking `homelab deploy apply <service>`.
   *
   * @param ctx - Pipeline context.
   * @returns `DeployResult` describing the outcome.
   */
  async deploy(ctx: PipelineContext): Promise<DeployResult> {
    const cliPath = this.deps.cliPath ?? resolveCliPath(this.deps.env);
    const args = this.buildDeployArgs(ctx);
    try {
      const result = await invokeHomelabCli(cliPath, args, {
        execFileFn: this.deps.execFileFn,
        env: this.deps.env,
      });
      return {
        success: true,
        message: result.stdout || 'Deploy completed',
        details: { stdout: result.stdout, stderr: result.stderr },
      };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        success: false,
        message: msg,
        details: { error: msg },
      };
    }
  }

  /**
   * Verify deployment health by invoking `homelab deploy health <service>`.
   *
   * Treats non-zero exit as unhealthy.
   *
   * @param ctx - Pipeline context.
   * @returns `HealthResult`.
   */
  async verifyHealth(ctx: PipelineContext): Promise<HealthResult> {
    const cliPath = this.deps.cliPath ?? resolveCliPath(this.deps.env);
    const args = this.buildHealthArgs(ctx);
    try {
      const result = await invokeHomelabCli(cliPath, args, {
        execFileFn: this.deps.execFileFn,
        env: this.deps.env,
      });
      return {
        healthy: true,
        checks: [{ name: 'homelab-health-check', passed: true, message: result.stdout }],
      };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        healthy: false,
        reason: msg,
        checks: [{ name: 'homelab-health-check', passed: false, message: msg }],
      };
    }
  }

  /**
   * Roll back by invoking `homelab deploy rollback <service>`.
   *
   * @param ctx          - Pipeline context.
   * @param deployResult - Optional failed deploy result (informational).
   * @returns `RollbackResult`.
   */
  async rollback(ctx: PipelineContext, _deployResult?: DeployResult): Promise<RollbackResult> {
    const cliPath = this.deps.cliPath ?? resolveCliPath(this.deps.env);
    const args = this.buildRollbackArgs(ctx);
    try {
      const result = await invokeHomelabCli(cliPath, args, {
        execFileFn: this.deps.execFileFn,
        env: this.deps.env,
      });
      return {
        success: true,
        restoredVersion: result.stdout || undefined,
        errors: [],
      };
    } catch (err) {
      return {
        success: false,
        errors: [(err as Error).message],
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Argument builders (exported for test assertions)
  // ---------------------------------------------------------------------------

  /**
   * Build the argv for `homelab deploy build <service>`.
   *
   * @param ctx - Pipeline context.
   * @returns Array of CLI arguments.
   */
  buildBuildArgs(ctx: PipelineContext): string[] {
    const args: string[] = ['deploy', 'build', ctx.service];
    if (ctx.artifact.tag) {
      args.push('--tag', ctx.artifact.tag);
    }
    if (ctx.artifact.sourceDir) {
      args.push('--source-dir', ctx.artifact.sourceDir);
    }
    return args;
  }

  /**
   * Build the argv for `homelab deploy push <service>`.
   *
   * @param ctx - Pipeline context.
   * @returns Array of CLI arguments.
   */
  buildPushArgs(ctx: PipelineContext): string[] {
    const args: string[] = ['deploy', 'push', ctx.service];
    const tag = (ctx.meta['builtTag'] as string | undefined) ?? ctx.artifact.tag;
    if (tag) {
      args.push('--tag', tag);
    }
    return args;
  }

  /**
   * Build the argv for `homelab deploy apply <service> --target <id>`.
   *
   * @param ctx - Pipeline context.
   * @returns Array of CLI arguments.
   */
  buildDeployArgs(ctx: PipelineContext): string[] {
    const args: string[] = ['deploy', 'apply', ctx.service, '--target', ctx.target.id];
    const tag = (ctx.meta['builtTag'] as string | undefined) ?? ctx.artifact.tag;
    if (tag) {
      args.push('--tag', tag);
    }
    return args;
  }

  /**
   * Build the argv for `homelab deploy health <service> --target <id>`.
   *
   * @param ctx - Pipeline context.
   * @returns Array of CLI arguments.
   */
  buildHealthArgs(ctx: PipelineContext): string[] {
    return ['deploy', 'health', ctx.service, '--target', ctx.target.id];
  }

  /**
   * Build the argv for `homelab deploy rollback <service> --target <id>`.
   *
   * @param ctx - Pipeline context.
   * @returns Array of CLI arguments.
   */
  buildRollbackArgs(ctx: PipelineContext): string[] {
    return ['deploy', 'rollback', ctx.service, '--target', ctx.target.id];
  }
}

// ---------------------------------------------------------------------------
// Singleton instance + auto-registration
// ---------------------------------------------------------------------------

/**
 * Singleton `HomelabSubprocessBackend` instance registered with the pipeline
 * backend registry.
 *
 * Exported so tests can access it directly or replace it.
 */
export const homelabSubprocessBackend = new HomelabSubprocessBackend();

// Auto-register so callers only need to import this module.
registerPipelineBackend(homelabSubprocessBackend);
