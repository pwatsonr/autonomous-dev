/**
 * Hard-coded credential TTL (SPEC-024-2-04).
 *
 * Re-exported here so `active-tokens.ts` and other modules can import the
 * constant without inducing a circular dependency on `proxy.ts`. The
 * `proxy.ts` value re-exports from this module — both spellings remain
 * source-compatible with the SPEC-024-2-01 skeleton's tests.
 *
 * @module intake/cred-proxy/ttl
 */

/** 15 minutes (900 seconds). NOT configurable. TDD-024 §7.4. */
export const TTL_SECONDS = 900;
