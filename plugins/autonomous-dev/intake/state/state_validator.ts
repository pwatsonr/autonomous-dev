/**
 * state.json reader/writer with v1.0 → v1.1 backward-compat.
 *
 * Implements SPEC-012-2-03 §Tasks 5 & 7. Accepts legacy v1.0 files
 * (no `source` / `adapter_metadata`) by defaulting `source = 'cli'` and
 * `adapter_metadata = {}`. Always writes v1.1 shape so the on-disk file
 * self-upgrades on first write after a daemon update.
 *
 * Forward-compat: this module deliberately does NOT enforce a strict
 * top-level schema for v1.0 fields beyond what's needed to dispatch to
 * the v1.0 vs v1.1 branch. Other modules own the meaning of those fields.
 *
 * @module state/state_validator
 */

import * as fs from 'fs';

import {
  type AdapterMetadata,
  type RequestSource,
  isRequestSource,
  parseAdapterMetadata,
} from '../types/request_source';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a state.json file fails to parse or fails schema validation.
 * Distinct from `ValidationError` (in `types/request_source.ts`) so callers
 * can differentiate state-file errors from per-request validation failures.
 */
export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateValidationError';
  }
}

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

/**
 * v1.0 state.json (legacy, read-only). Top-level shape is unconstrained
 * here — this module only reasons about the source-tracking fields.
 */
export interface StateJsonV10 {
  // Open shape: existing v1.0 callers may add arbitrary fields; we pass
  // them through unchanged. The interface intentionally has no required
  // fields beyond what the validator inspects.
  [key: string]: unknown;
}

/**
 * v1.1 state.json (always-write target). Adds the source-tracking fields
 * defined by SPEC-012-2-01 / SPEC-012-2-03.
 */
export interface StateJsonV11 extends StateJsonV10 {
  source: RequestSource;
  adapter_metadata: AdapterMetadata;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read and validate a state.json file.
 *
 * Behaviour:
 *  - File missing                          → throws (caller decides whether
 *                                             to treat as "no state yet")
 *  - JSON parse failure                    → throws {@link StateValidationError}
 *  - Top-level value is not an object      → throws {@link StateValidationError}
 *  - `source` field MISSING                → defaults `source = 'cli'`,
 *                                             `adapter_metadata = {}`,
 *                                             logs `state.v10_compat`
 *  - `source` PRESENT but not a {@link RequestSource} → throws {@link StateValidationError}
 *  - `source` valid + `adapter_metadata` missing      → defaults metadata to `{}`
 *  - `source` valid + `adapter_metadata` present      → validated via
 *                                             {@link parseAdapterMetadata}
 *
 * @throws {StateValidationError} on malformed JSON or invalid source.
 */
export function readStateJson(filePath: string): StateJsonV11 {
  const raw = fs.readFileSync(filePath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateValidationError(
      `malformed JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StateValidationError(
      `state.json must be an object: ${filePath}`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // v1.0 legacy: source is missing entirely → upgrade in-memory.
  if (!('source' in obj)) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'state.v10_compat',
        path: filePath,
      }),
    );
    return {
      ...obj,
      source: 'cli',
      adapter_metadata: {},
    } as StateJsonV11;
  }

  // v1.1: source present — validate strictly.
  const sourceValue = obj.source;
  if (!isRequestSource(sourceValue)) {
    throw new StateValidationError(
      `unknown source in ${filePath}: ${JSON.stringify(sourceValue)}`,
    );
  }

  const adapterMetadata: AdapterMetadata =
    'adapter_metadata' in obj
      ? parseAdapterMetadata(obj.adapter_metadata)
      : {};

  return {
    ...obj,
    source: sourceValue,
    adapter_metadata: adapterMetadata,
  } as StateJsonV11;
}

/**
 * Write a state.json file in v1.1 shape.
 *
 * Always serializes both `source` and `adapter_metadata` regardless of
 * whether they were defaulted by {@link readStateJson} or provided by the
 * caller. The on-disk file becomes self-upgrading on first write.
 *
 * Output is pretty-printed with 2-space indent + trailing newline to match
 * the existing intake convention for human-editable state files.
 */
export function writeStateJson(filePath: string, state: StateJsonV11): void {
  // Defensive: ensure source is valid before persisting. Without this, a
  // caller could round-trip a v1.0 state in memory, mutate `source` to
  // garbage, and silently corrupt the file.
  if (!isRequestSource(state.source)) {
    throw new StateValidationError(
      `cannot write state with invalid source: ${String(state.source)}`,
    );
  }
  const payload = {
    ...state,
    source: state.source,
    adapter_metadata: state.adapter_metadata ?? {},
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}
