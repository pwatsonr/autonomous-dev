/**
 * Audit-key bootstrap (SPEC-019-4-04, key-store.ts).
 *
 * Resolves the HMAC key used by `AuditWriter` from one of three sources,
 * in priority order:
 *
 *   1. `AUDIT_HMAC_KEY` env var (hex-encoded 32 bytes).
 *   2. `~/.autonomous-dev/audit-key` (hex on disk, mode 0600).
 *   3. Generate a fresh 32-byte random key and persist it (mode 0600).
 *      The caller MUST treat `rotated: true` as a CRITICAL operator-visible
 *      event and write an `audit_key_rotated` entry with `prev_hmac:
 *      GENESIS` as the first audit emission of the daemon's session.
 *
 * Cross-reference: SPEC-019-4-04 Key Bootstrap; TDD-019 §14.
 *
 * @module intake/audit/key-store
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Number of bytes in a fresh HMAC key. SHA-256 block-size ÷ 2. */
export const AUDIT_KEY_BYTES = 32;

/** Default location for the persisted hex-encoded key. */
export function defaultKeyPath(home: string = homedir()): string {
  return join(home, '.autonomous-dev', 'audit-key');
}

export interface ResolveKeyOptions {
  /** Override the env var name (testing). Default: `AUDIT_HMAC_KEY`. */
  envVar?: string;
  /** Override the on-disk key path (testing). Default: `~/.autonomous-dev/audit-key`. */
  keyPath?: string;
  /** Override `process.env` lookup (testing). */
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedKey {
  /** Raw 32-byte key buffer. */
  key: Buffer;
  /** True iff the key was newly generated on this call (operator must alert). */
  rotated: boolean;
  /** Source the key came from. Useful for log breadcrumbs. */
  source: 'env' | 'file' | 'generated';
}

/**
 * Resolve the audit HMAC key. See module-level doc for the resolution order.
 *
 * The function is async because it touches the filesystem; tests should
 * point `keyPath` at an isolated tempdir.
 */
export async function resolveAuditKey(opts: ResolveKeyOptions = {}): Promise<ResolvedKey> {
  const envVar = opts.envVar ?? 'AUDIT_HMAC_KEY';
  const env = opts.env ?? process.env;
  const path = opts.keyPath ?? defaultKeyPath();

  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) {
    return { key: Buffer.from(fromEnv.trim(), 'hex'), rotated: false, source: 'env' };
  }

  try {
    const hex = await fs.readFile(path, 'utf8');
    return { key: Buffer.from(hex.trim(), 'hex'), rotated: false, source: 'file' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // First run OR operator deleted the key → generate + persist + warn.
    const key = randomBytes(AUDIT_KEY_BYTES);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, key.toString('hex'), { mode: 0o600 });
    return { key, rotated: true, source: 'generated' };
  }
}
