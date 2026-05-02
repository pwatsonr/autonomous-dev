/**
 * HMAC-SHA256 signing + verification for `DeploymentRecord`
 * (SPEC-023-1-01, Task 3).
 *
 * Cross-reference: TDD-023 §8.
 *
 * Mirrors PLAN-019-4's audit-key bootstrap (`intake/audit/key-store.ts`)
 * and PLAN-022-3's chain-key resolver (`intake/chains/chain-key.ts`):
 * env var → file → auto-generate. The deploy key is INDEPENDENT of the
 * audit and chain keys so operators can rotate them on different cadences.
 *
 * The HMAC is taken over the canonical JSON of every record field except
 * `hmac` itself. We delegate canonicalization to the existing
 * `intake/chains/canonical-json.ts` so the chain and deploy surfaces
 * agree byte-for-byte on serialization rules.
 *
 * @module intake/deploy/record-signer
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { canonicalJSON } from '../chains/canonical-json';
import { InsecureKeyPermissionsError } from './errors';
import type { DeploymentRecord } from './types';

/** Number of bytes in a fresh deploy HMAC key. */
export const DEPLOY_KEY_BYTES = 32;

/** Default location for the persisted hex-encoded deploy key. */
export function defaultDeployKeyPath(home: string = homedir()): string {
  return join(home, '.autonomous-dev', 'deploy-key');
}

export interface LoadDeployKeyOptions {
  /** Override env var name (testing). Default: `DEPLOY_HMAC_KEY`. */
  envVar?: string;
  /** Override on-disk key path (testing). */
  keyPath?: string;
  /** Override `process.env` lookup (testing). */
  env?: NodeJS.ProcessEnv;
  /** Override the warning sink. Defaults to `console.warn`. */
  logger?: { warn: (msg: string) => void };
}

/**
 * Resolve the deploy HMAC key. See module-level doc for resolution order.
 *
 * Synchronous because callers (signer/verifier) are themselves
 * synchronous and a one-shot file read is preferable to threading async
 * keys through every deploy call site.
 *
 * Throws `InsecureKeyPermissionsError` when the key file exists with
 * permissions looser than 0o600 (operator probably copied it during
 * setup; refuse to use it rather than silently leak).
 */
export function loadDeployKey(opts: LoadDeployKeyOptions = {}): Buffer {
  const envVar = opts.envVar ?? 'DEPLOY_HMAC_KEY';
  const env = opts.env ?? process.env;
  const path = opts.keyPath ?? defaultDeployKeyPath();
  const logger = opts.logger ?? { warn: (m: string) => console.warn(m) };

  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) {
    return Buffer.from(fromEnv.trim(), 'hex');
  }

  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      throw new InsecureKeyPermissionsError(path, mode);
    }
    const hex = readFileSync(path, 'utf8').trim();
    return Buffer.from(hex, 'hex');
  }

  // Auto-generate. Match the audit-key bootstrap's "warn loudly" stance:
  // existing signed records under a previous (lost) key become
  // unverifiable. Operators are expected to set DEPLOY_HMAC_KEY in
  // production and pin it.
  const key = randomBytes(DEPLOY_KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key.toString('hex'), { mode: 0o600 });
  logger.warn(
    `CRITICAL: DEPLOY_HMAC_KEY auto-generated at ${path}; existing deployment records will be unverifiable. Set DEPLOY_HMAC_KEY env var to pin a key.`,
  );
  return key;
}

/**
 * Canonical JSON of every record field except `hmac`. Public so tests
 * can pin known input → known output and detect formatter drift.
 */
export function canonicalJson(record: Omit<DeploymentRecord, 'hmac'>): string {
  return canonicalJSON({
    deployId: record.deployId,
    backend: record.backend,
    environment: record.environment,
    artifactId: record.artifactId,
    deployedAt: record.deployedAt,
    status: record.status,
    details: record.details,
  });
}

/**
 * Sign `record` with HMAC-SHA256. Returns a NEW record (does not mutate
 * the input) with `hmac` set to a 64-char lowercase hex string.
 */
export function signDeploymentRecord(
  record: DeploymentRecord,
  key?: Buffer,
): DeploymentRecord {
  const k = key ?? loadDeployKey();
  const body = canonicalJson(record);
  const hmac = createHmac('sha256', k).update(body).digest('hex');
  return { ...record, hmac };
}

/**
 * Verify the HMAC of a signed record. Returns `{valid: true}` on match.
 * Returns `{valid: false, error}` on mismatch, on missing/non-hex `hmac`,
 * or on canonicalization failure (e.g., NaN sneaked into `details`).
 *
 * Uses `timingSafeEqual` to keep the comparison constant-time. Both
 * sides MUST be hex-decoded before comparison so length mismatches
 * (which would otherwise leak via the `length` check) are funneled into
 * the same false branch.
 */
export function verifyDeploymentRecord(
  record: DeploymentRecord,
  key?: Buffer,
): { valid: boolean; error?: Error } {
  if (typeof record.hmac !== 'string' || record.hmac.length !== 64) {
    return {
      valid: false,
      error: new Error('record hmac is missing or wrong length'),
    };
  }
  if (!/^[0-9a-f]{64}$/.test(record.hmac)) {
    return {
      valid: false,
      error: new Error('record hmac is not lowercase hex'),
    };
  }
  const k = key ?? loadDeployKey();
  let body: string;
  try {
    body = canonicalJson(record);
  } catch (err) {
    return { valid: false, error: err as Error };
  }
  const expected = createHmac('sha256', k).update(body).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(record.hmac, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      valid: false,
      error: new Error('hmac mismatch: record has been tampered with or signed with a different key'),
    };
  }
  return { valid: true };
}
