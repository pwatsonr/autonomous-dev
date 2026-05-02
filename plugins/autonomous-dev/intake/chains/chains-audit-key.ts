/**
 * `CHAINS_AUDIT_HMAC_KEY` resolution + caching (SPEC-022-3-03).
 *
 * Mirrors the resolver pattern of:
 *   - `intake/audit/key-store.ts`     (PLAN-019-4 hook-audit key)
 *   - `intake/chains/chain-key.ts`    (SPEC-022-3-02 chain HMAC key)
 *
 * but writes to a SEPARATE key file (`~/.autonomous-dev/chains-audit-hmac.key`)
 * so operators can rotate the chain-forensics key independently of the
 * artifact-signing key and the hook-audit key.
 *
 * Resolution order (cached after first call):
 *   1. `process.env.CHAINS_AUDIT_HMAC_KEY` (base64-encoded 32 bytes).
 *   2. `~/.autonomous-dev/chains-audit-hmac.key` (base64 on disk, 0600).
 *   3. Generate a fresh 32-byte key via `crypto.randomBytes`, persist
 *      with mode 0600, emit a CRITICAL warning so operators notice.
 *
 * @module intake/chains/chains-audit-key
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CHAINS_AUDIT_KEY_BYTES = 32;

export function defaultChainsAuditKeyPath(home: string = homedir()): string {
  return join(home, '.autonomous-dev', 'chains-audit-hmac.key');
}

export interface ResolveChainsAuditKeyOptions {
  envVar?: string;
  keyPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: { warn: (msg: string) => void };
}

interface CachedKey {
  key: Buffer;
  source: 'env' | 'file' | 'generated';
}

let cached: CachedKey | null = null;

export function getChainsAuditHmacKey(
  opts: ResolveChainsAuditKeyOptions = {},
): Buffer {
  if (cached) return cached.key;
  const envVar = opts.envVar ?? 'CHAINS_AUDIT_HMAC_KEY';
  const env = opts.env ?? process.env;
  const path = opts.keyPath ?? defaultChainsAuditKeyPath();
  const logger = opts.logger ?? { warn: (m: string) => console.warn(m) };

  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) {
    const key = Buffer.from(fromEnv.trim(), 'base64');
    cached = { key, source: 'env' };
    return key;
  }

  if (existsSync(path)) {
    const b64 = readFileSync(path, 'utf8').trim();
    const key = Buffer.from(b64, 'base64');
    cached = { key, source: 'file' };
    return key;
  }

  const key = randomBytes(CHAINS_AUDIT_KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  logger.warn(
    'CRITICAL: CHAINS_AUDIT_HMAC_KEY generated; existing chain-audit entries will be unverifiable. Set CHAINS_AUDIT_HMAC_KEY env var to suppress this warning and pin the key.',
  );
  cached = { key, source: 'generated' };
  return key;
}

export function resetChainsAuditKeyCacheForTest(): void {
  cached = null;
}

export function getChainsAuditKeySourceForTest():
  | 'env'
  | 'file'
  | 'generated'
  | null {
  return cached ? cached.source : null;
}
