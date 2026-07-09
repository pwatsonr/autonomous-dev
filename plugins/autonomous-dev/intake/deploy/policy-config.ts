/**
 * Deploy policy config loader — issues #668 + #669.
 *
 * Loads and validates a `PolicyDocument` from:
 * 1. The `policy` key inside `<repo>/.autonomous-dev/deploy.yaml` (integrated
 *    with the existing config), OR
 * 2. A standalone `<repo>/.autonomous-dev/policy.yaml` file.
 *
 * The policy document is OPTIONAL. When absent (or when the key is missing),
 * `getActivePolicy()` returns `EMPTY_POLICY` which allows all deploys. This
 * preserves full backward compatibility with pre-policy configs.
 *
 * Validation is performed against `schemas/deploy-policy-v1.json` using the
 * same Ajv pattern as `environment.ts`.
 *
 * Cross-reference: issues #668, #669.
 *
 * @module intake/deploy/policy-config
 */

import { promises as fs, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

import { ConfigValidationError } from './errors';
import { EMPTY_POLICY } from './policy-types';
import type { PolicyDocument } from './policy-types';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const AjvLib = require('ajv');
const AjvCtor: any = (AjvLib as any).default ?? AjvLib;
/* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

const POLICY_SCHEMA_PATH = resolve(
  __dirname,
  '..',
  '..',
  'schemas',
  'deploy-policy-v1.json',
);

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

let cachedPolicyValidator: AjvLikeValidator | null = null;

function getPolicyValidator(): AjvLikeValidator {
  if (cachedPolicyValidator) return cachedPolicyValidator;
  const schema = JSON.parse(readFileSync(POLICY_SCHEMA_PATH, 'utf8')) as Record<
    string,
    unknown
  >;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ajv: any = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema) as AjvLikeValidator;
  cachedPolicyValidator = validate;
  return validate;
}

// ---------------------------------------------------------------------------
// Conventional path helpers
// ---------------------------------------------------------------------------

/**
 * Conventional path for the standalone policy file under a repo.
 *
 * @param repoPath - Absolute repo root.
 * @returns Absolute path to `<repo>/.autonomous-dev/policy.yaml`.
 */
export function policyPathFor(repoPath: string): string {
  return join(repoPath, '.autonomous-dev', 'policy.yaml');
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate a parsed object against the policy JSON schema.
 *
 * @param parsed   - Object to validate.
 * @param filePath - Source file path (for error messages).
 * @returns The validated `PolicyDocument`.
 * @throws `ConfigValidationError` on validation failure.
 */
function validatePolicyDocument(parsed: unknown, filePath: string): PolicyDocument {
  const validate = getPolicyValidator();
  if (!validate(parsed)) {
    const errs = (validate.errors ?? []).map((e) => ({
      pointer: e.instancePath || '/',
      message: `${e.message ?? 'invalid'}${e.params ? ` (${JSON.stringify(e.params)})` : ''}`,
    }));
    throw new ConfigValidationError(
      `policy document failed schema validation: ${errs.map((x) => `${x.pointer} ${x.message}`).join('; ')}`,
      filePath,
      null,
      errs,
    );
  }
  return parsed as PolicyDocument;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a `PolicyDocument` from `<repoPath>/.autonomous-dev/policy.yaml`.
 *
 * Returns:
 *   - `null` when the file does not exist (caller falls back to `EMPTY_POLICY`).
 *   - `PolicyDocument` when the file exists and validates.
 *
 * Throws `ConfigValidationError` when the file exists but cannot be parsed or
 * fails schema validation.
 *
 * @param repoPath - Absolute repo root path.
 * @returns Validated `PolicyDocument` or `null` when absent.
 */
export async function loadPolicyFile(repoPath: string): Promise<PolicyDocument | null> {
  const path = policyPathFor(repoPath);
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
      `policy.yaml is not valid YAML${line !== null ? ` (line ${line})` : ''}: ${e.message}`,
      path,
      line,
      [],
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigValidationError(
      'policy.yaml top-level must be a mapping',
      path,
      null,
      [{ pointer: '', message: 'expected object at root' }],
    );
  }

  return validatePolicyDocument(parsed, path);
}

/**
 * Extract a `PolicyDocument` from an already-loaded deploy config object.
 *
 * Looks for a `policy` key at the top level of the config object. Returns
 * `null` when the key is absent (backward compatible: v1 configs don't have it).
 *
 * @param configObj - Parsed deploy config (may have an optional `policy` key).
 * @param configPath - Path to the source file (for error messages).
 * @returns `PolicyDocument` or `null` when `policy` key is absent.
 */
export function extractPolicyFromConfig(
  configObj: Record<string, unknown>,
  configPath: string,
): PolicyDocument | null {
  if (!Object.prototype.hasOwnProperty.call(configObj, 'policy')) return null;
  const raw = configObj['policy'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "deploy.yaml 'policy' key must be a mapping when present",
      configPath,
      null,
      [{ pointer: '/policy', message: 'expected object' }],
    );
  }
  return validatePolicyDocument(raw, configPath);
}

// ---------------------------------------------------------------------------
// Singleton active policy
// ---------------------------------------------------------------------------

let activePolicy: PolicyDocument = EMPTY_POLICY;

/**
 * Set the process-wide active policy.
 *
 * Called by daemon/orchestrator startup after loading the policy document.
 * Defaults to `EMPTY_POLICY` (allow-all) so existing code paths behave
 * identically when no policy is configured.
 *
 * @param doc - The policy document to make active (or `EMPTY_POLICY`).
 */
export function setActivePolicy(doc: PolicyDocument): void {
  activePolicy = doc;
}

/**
 * Retrieve the process-wide active `PolicyDocument`.
 *
 * Returns `EMPTY_POLICY` (allow-all) when no document has been configured.
 *
 * @returns The current active `PolicyDocument`.
 */
export function getActivePolicy(): PolicyDocument {
  return activePolicy;
}

/**
 * Reset the active policy to `EMPTY_POLICY`.
 *
 * TEST ONLY — call in `afterEach` to isolate singleton state between tests.
 */
export function resetActivePolicy(): void {
  activePolicy = EMPTY_POLICY;
}
