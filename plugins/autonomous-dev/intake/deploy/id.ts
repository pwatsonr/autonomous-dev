/**
 * Minimal ULID-shaped identifier helper for deploy artifacts and records
 * (SPEC-023-1-02). 26-char Crockford-base32, monotonic-ish via a
 * timestamp prefix and 80 bits of randomness.
 *
 * Not a full ULID implementation (no monotonic counter for sub-ms calls),
 * but conforms to the ULID grammar `[0-9A-HJKMNP-TV-Z]{26}` so downstream
 * regex assertions are stable.
 *
 * @module intake/deploy/id
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32 (no I, L, O, U) — matches the ULID grammar. */
export function generateUlid(now: number = Date.now()): string {
  const time = encodeTime(now, 10);
  const rand = encodeRandom(16);
  return time + rand;
}

function encodeTime(ms: number, len: number): string {
  let n = ms;
  let out = '';
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  // Use 5 random bits per char; 16 chars → 80 bits → 10 random bytes.
  const buf = randomBytes(Math.ceil((len * 5) / 8));
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < len) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 0x1f];
    }
  }
  return out.padEnd(len, '0');
}

/** ULID grammar — used by the conformance suite. */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
