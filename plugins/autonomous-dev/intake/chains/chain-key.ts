/**
 * `CHAIN_HMAC_KEY` resolution + caching (SPEC-022-3-02).
 *
 * Resolution order (cached after first call):
 *   1. `process.env.CHAIN_HMAC_KEY` (base64-encoded 32 bytes).
 *   2. `~/.autonomous-dev/chain-hmac.key` (base64 on disk, mode 0600).
 *   3. Generate a fresh 32-byte key via `crypto.randomBytes`, persist it
 *      with mode 0600, and emit a CRITICAL warning so operators notice
 *      that any pre-existing artifacts will fail verification under the
 *      new key.
 *
 * Mirrors PLAN-019-4's `resolveAuditKey()` shape (see
 * `intake/audit/key-store.ts`) but writes to a SEPARATE key file because
 * the chain-signing surface is logically distinct from the hook-audit
 * surface — operators may rotate them independently.
 *
 * The cached key is exposed as a `Buffer` because Node's `createHmac`
 * accepts a `Buffer` directly; callers should never log it.
 *
 * @module intake/chains/chain-key
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Number of bytes in the chain HMAC key. SHA-256 block-size ÷ 2. */
export const CHAIN_KEY_BYTES = 32;

/** Default key-file location (matches `~/.autonomous-dev/...`). */
export function defaultChainKeyPath(home: string = homedir()): string {
  return join(home, '.autonomous-dev', 'chain-hmac.key');
}

export interface ResolveChainKeyOptions {
  /** Override env var name (testing). Default: `CHAIN_HMAC_KEY`. */
  envVar?: string;
  /** Override on-disk key path (testing). */
  keyPath?: string;
  /** Override `process.env` lookup (testing). */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the CRITICAL warning sink. Defaults to `console.warn`.
   * Tests inject a spy to assert the warning fired without polluting test
   * output.
   */
  logger?: { warn: (msg: string) => void };
}

interface CachedKey {
  key: Buffer;
  source: 'env' | 'file' | 'generated';
}

/** Process-wide cache. Cleared by `resetChainKeyCacheForTest()`. */
let cached: CachedKey | null = null;

/**
 * Synchronously resolve the chain HMAC key. Synchronous because the
 * production caller (the registry's persist/read path) is async-heavy
 * already and a single one-shot synchronous file read is preferable to
 * threading an async key through every code site.
 */
export function getChainHmacKey(opts: ResolveChainKeyOptions = {}): Buffer {
  if (cached) return cached.key;
  const envVar = opts.envVar ?? 'CHAIN_HMAC_KEY';
  const env = opts.env ?? process.env;
  const path = opts.keyPath ?? defaultChainKeyPath();
  const logger = opts.logger ?? { warn: (m: string) => console.warn(m) };

  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) {
    const key = Buffer.from(fromEnv.trim(), 'base64');
    cached = { key, source: 'env' };
    return key;
  }

  if (existsSync(path)) {
    const hex = readFileSync(path, 'utf8').trim();
    const key = Buffer.from(hex, 'base64');
    cached = { key, source: 'file' };
    return key;
  }

  // First-run generation. Loud warning because losing the previous key
  // means existing artifacts become unverifiable.
  const key = randomBytes(CHAIN_KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  logger.warn(
    'CRITICAL: CHAIN_HMAC_KEY generated; existing chain artifacts will be unverifiable. Set CHAIN_HMAC_KEY env var to suppress this warning and pin the key.',
  );
  cached = { key, source: 'generated' };
  return key;
}

/** Test-only: drop the cached key and resolution-source breadcrumb. */
export function resetChainKeyCacheForTest(): void {
  cached = null;
}

/** Test-only: returns the source the key came from (env/file/generated). */
export function getChainKeySourceForTest(): 'env' | 'file' | 'generated' | null {
  return cached ? cached.source : null;
}
