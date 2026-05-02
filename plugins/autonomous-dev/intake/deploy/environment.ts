/**
 * Deploy `EnvironmentResolver` (SPEC-023-2-01).
 *
 * Loads `<repo>/.autonomous-dev/deploy.yaml`, validates it against
 * `schemas/deploy-config-v1.json`, and resolves a `ResolvedEnvironment`
 * for downstream consumers (BackendSelector, approval state machine,
 * cost-cap pre-check, `deploy plan`).
 *
 * Cross-reference: TDD-023 §9 (config shape).
 *
 * Strict TypeScript, no `any`.
 *
 * @module intake/deploy/environment
 */

import { promises as fs, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

import { ConfigValidationError, UnknownEnvironmentError } from './errors';
import type {
  ApprovalLevel,
  DeployConfig,
  EnvironmentConfig,
  ResolvedEnvironment,
} from './types-config';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
// Ajv is shipped with two import paths; mirror the pattern used by
// `intake/hooks/validation-pipeline.ts`.
const AjvLib = require('ajv');
const AjvCtor: any = (AjvLib as any).default ?? AjvLib;
/* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

const SCHEMA_PATH = resolve(__dirname, '..', '..', 'schemas', 'deploy-config-v1.json');

let cachedValidator: ((value: unknown) => boolean) | null = null;
interface AjvLikeError {
  instancePath: string;
  message?: string;
  keyword: string;
  params?: Record<string, unknown>;
}
interface AjvLikeValidator {
  (value: unknown): boolean;
  errors?: AjvLikeError[] | null;
}

function getValidator(): AjvLikeValidator {
  if (cachedValidator) return cachedValidator as AjvLikeValidator;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ajv: any = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema) as AjvLikeValidator;
  cachedValidator = validate;
  return validate;
}

/**
 * Conventional config path under a repo: `<repo>/.autonomous-dev/deploy.yaml`.
 * Exposed for tests + the `deploy plan` CLI summary.
 */
export function configPathFor(repoPath: string): string {
  return join(repoPath, '.autonomous-dev', 'deploy.yaml');
}

/**
 * Load and validate `<repoPath>/.autonomous-dev/deploy.yaml`.
 *
 * Returns:
 *   - `null` when the file does not exist (caller falls back to defaults).
 *   - `DeployConfig` when the file exists AND parses AND validates.
 *
 * Throws `ConfigValidationError` when the file exists but YAML parsing or
 * schema validation fails. The error references the offending JSON
 * Pointer (and line number when js-yaml surfaces one).
 */
export async function loadConfig(repoPath: string): Promise<DeployConfig | null> {
  const path = configPathFor(repoPath);
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = yaml.safeLoad(text);
  } catch (err) {
    const e = err as Error & { mark?: { line?: number } };
    const line = e.mark && typeof e.mark.line === 'number' ? e.mark.line + 1 : null;
    throw new ConfigValidationError(
      `deploy.yaml is not valid YAML${line !== null ? ` (line ${line})` : ''}: ${e.message}`,
      path,
      line,
      [],
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigValidationError(
      'deploy.yaml top-level must be a mapping',
      path,
      null,
      [{ pointer: '', message: 'expected object at root' }],
    );
  }

  const validate = getValidator();
  if (!validate(parsed)) {
    const errs = (validate.errors ?? []).map((e) => ({
      pointer: e.instancePath || '/',
      message: `${e.message ?? 'invalid'}${e.params ? ` (${JSON.stringify(e.params)})` : ''}`,
    }));
    throw new ConfigValidationError(
      `deploy.yaml failed schema validation: ${errs.map((x) => `${x.pointer} ${x.message}`).join('; ')}`,
      path,
      null,
      errs,
    );
  }
  return parsed as DeployConfig;
}

/**
 * Resolve a `ResolvedEnvironment` for `envName`.
 *
 * - `config === null` (file absent) -> safe fallback: backend=`local`,
 *   approval=`none`, costCapUsd=0, source=`fallback`.
 * - Otherwise, walk env block; merge parameters (repo defaults <- env);
 *   pick env.backend OR config.default_backend OR `"local"`.
 *
 * Throws `UnknownEnvironmentError` if the env is missing from a non-null
 * config, listing the available env names so operators get a useful message.
 */
export function resolveEnvironment(
  config: DeployConfig | null,
  envName: string,
  options?: { fallbackBackend?: string; configPath?: string | null },
): ResolvedEnvironment {
  if (config === null) {
    return {
      envName,
      backend: options?.fallbackBackend ?? 'local',
      parameters: {},
      approval: 'none',
      costCapUsd: 0,
      autoPromoteFrom: null,
      source: 'fallback',
      configPath: null,
    };
  }

  const env: EnvironmentConfig | undefined = config.environments[envName];
  if (!env) {
    const available = Object.keys(config.environments).sort();
    throw new UnknownEnvironmentError(envName, available);
  }

  const repoParams: Record<string, unknown> = config.parameters ?? {};
  const envParams: Record<string, unknown> = env.parameters ?? {};
  const merged: Record<string, unknown> = { ...repoParams, ...envParams };

  const backend = env.backend || config.default_backend || 'local';

  return {
    envName,
    backend,
    parameters: merged,
    approval: env.approval as ApprovalLevel,
    costCapUsd: env.cost_cap_usd,
    autoPromoteFrom: env.auto_promote_from ?? null,
    source: 'deploy.yaml',
    configPath: options?.configPath ?? null,
  };
}

// Re-export config types so callers can import from one place.
export type { ApprovalLevel, DeployConfig, EnvironmentConfig, ResolvedEnvironment };
