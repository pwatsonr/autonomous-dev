/**
 * Deterministic JSON serialization (SPEC-022-3-02).
 *
 * Producers and consumers MUST agree byte-for-byte on the canonical form
 * of an artifact envelope before it is fed to HMAC or Ed25519 signing.
 * Without that agreement, two correctly-implemented sides on different
 * machines disagree on the signature and verification fails.
 *
 * Algorithm (RFC 8785 / "JCS"-style; the existing `scripts/ci/canonical-json.js`
 * follows the same shape):
 *   - Object keys sorted lexicographically at every nesting level.
 *   - No whitespace.
 *   - Strings JSON-escaped per RFC 8259 (delegates to `JSON.stringify(str)`).
 *   - Numbers serialized via `JSON.stringify` (NaN/Infinity rejected).
 *   - Arrays preserve insertion order.
 *   - `null`, `true`, `false` serialize to their JSON literals.
 *   - `undefined`, functions, symbols → `TypeError` (caller bug).
 *   - BigInt → `TypeError` (no JSON literal form; callers should pre-coerce).
 *
 * @module intake/chains/canonical-json
 */

/**
 * Canonicalize `value` to a deterministic JSON string.
 *
 * Throws `TypeError` if `value` (or any nested value) cannot be represented
 * in JSON or would produce a non-deterministic encoding.
 */
export function canonicalJSON(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(
        `canonicalJSON: non-finite number is not JSON-serializable: ${value as number}`,
      );
    }
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') {
    throw new TypeError('canonicalJSON: BigInt is not JSON-serializable');
  }
  if (t === 'undefined') {
    throw new TypeError('canonicalJSON: undefined is not JSON-serializable');
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalJSON: ${t} is not JSON-serializable`);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => encode(v));
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) {
        // RFC 8259 has no representation for undefined; refuse rather than
        // silently emit a JSON-undefined-like form.
        throw new TypeError(
          `canonicalJSON: undefined value at key '${k}' is not JSON-serializable`,
        );
      }
      parts.push(`${JSON.stringify(k)}:${encode(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`canonicalJSON: unsupported value type ${t}`);
}
