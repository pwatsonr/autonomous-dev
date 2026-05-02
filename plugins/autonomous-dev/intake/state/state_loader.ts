/**
 * state-loader: validate + auto-migrate v1.0 state.json on read
 * (SPEC-018-1-04, Task 7).
 *
 * Every downstream consumer trusts {@link loadState} to deliver a validated
 * v1.1 RequestState in memory. The implementation:
 *
 *   1. Reads the file (synchronous; matches existing intake patterns).
 *   2. Detects v1.0 via {@link isLegacyState}.
 *   3. If v1.0:
 *        - Migrates via {@link migrateStateV1_0ToV1_1}.
 *        - Persists the upgraded file via an atomic temp+rename.
 *        - Leaves a `.v1.0.backup` next to the original (idempotent: never
 *          overwrites an existing backup).
 *   4. If already v1.1: fast-path with validation only — no write, no backup.
 *   5. Validates the v1.1 invariants.
 *   6. Returns the in-memory v1.1 object.
 *
 * Validation note: SPEC-018-1-04 specifies AJV against
 * `schemas/state-v1.1.json`. AJV is not currently a dependency of the
 * autonomous-dev plugin, so this loader implements the schema's invariants
 * in pure TypeScript here. Both validators MUST stay in lockstep with the
 * JSON schema document; the integration test reads the schema file and
 * cross-checks key invariants. When AJV is added (e.g., as part of a
 * portal-side dependency landing), `validateV1_1` should be replaced by
 * `ajv.compile(schemaV1_1)` — the public API of `loadState` is unchanged.
 *
 * Atomic write note: SPEC-018-1-04 references `atomicWriteJson` from a
 * TDD-012 utility. The intake layer's two-phase commit (in
 * `intake/core/handoff_manager.ts`) couples file writes with SQLite
 * transactions and is overkill for upgrade-on-read. This loader uses the
 * same temp+fsync+rename pattern as `writeTempStateSync` (described in
 * `handoff_manager.ts` §330) but without the SQLite phase, since the
 * upgrade is purely a file-level transformation.
 *
 * @module intake/state/state_loader
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type RequestState,
  type RequestStateV1_1,
  isLegacyState,
  migrateStateV1_0ToV1_1,
} from '../types/request-state';
import { isValidRequestType } from '../types/request-type';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link loadState} when a state.json file fails v1.1 validation
 * or has an unrecognized `schema_version`.
 *
 * `errors` carries the per-rule failure list (shape modelled after AJV's
 * `Validator.errors`) so future migration to AJV preserves the public
 * contract.
 */
export class StateValidationError extends Error {
  public readonly errors: ValidationFailure[];

  constructor(errors: ValidationFailure[], message: string) {
    super(message);
    this.name = 'StateValidationError';
    this.errors = errors;
  }
}

/** Single validation failure record (subset of AJV's ErrorObject shape). */
export interface ValidationFailure {
  /** JSON Pointer–style path into the input (e.g. `/type_config/maxRetries`). */
  instancePath: string;
  /** Rule that failed (`required`, `enum`, `type`, `const`, ...). */
  keyword: string;
  /** Human-readable message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Pure validator (mirrors schemas/state-v1.1.json)
// ---------------------------------------------------------------------------

const TYPE_CONFIG_REQUIRED: readonly string[] = [
  'skippedPhases',
  'enhancedPhases',
  'expeditedReviews',
  'additionalGates',
  'maxRetries',
  'phaseTimeouts',
];

const ROOT_REQUIRED: readonly string[] = [
  'schema_version',
  'id',
  'status',
  'phase_overrides',
  'type_config',
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate a candidate v1.1 state object against `schemas/state-v1.1.json`.
 *
 * Returns the failure list (empty on success). The shape mirrors AJV's
 * `errors` so the loader can transition to AJV without changing callers.
 */
export function validateV1_1(state: unknown): ValidationFailure[] {
  const errors: ValidationFailure[] = [];

  if (!isPlainObject(state)) {
    return [{
      instancePath: '',
      keyword: 'type',
      message: 'must be object',
    }];
  }

  for (const k of ROOT_REQUIRED) {
    if (!(k in state)) {
      errors.push({
        instancePath: '',
        keyword: 'required',
        message: `must have required property '${k}'`,
      });
    }
  }

  if ('schema_version' in state && state.schema_version !== 1.1) {
    errors.push({
      instancePath: '/schema_version',
      keyword: 'const',
      message: 'must be equal to constant',
    });
  }

  if ('id' in state && (typeof state.id !== 'string' || state.id.length === 0)) {
    errors.push({
      instancePath: '/id',
      keyword: 'minLength',
      message: 'must be non-empty string',
    });
  }

  if ('status' in state && (typeof state.status !== 'string' || state.status.length === 0)) {
    errors.push({
      instancePath: '/status',
      keyword: 'minLength',
      message: 'must be non-empty string',
    });
  }

  if ('request_type' in state && state.request_type !== undefined) {
    if (typeof state.request_type !== 'string' || !isValidRequestType(state.request_type)) {
      errors.push({
        instancePath: '/request_type',
        keyword: 'enum',
        message: 'must be one of feature, bug, infra, refactor, hotfix',
      });
    }
  }

  if ('phase_overrides' in state && !isStringArray(state.phase_overrides)) {
    errors.push({
      instancePath: '/phase_overrides',
      keyword: 'type',
      message: 'must be string[]',
    });
  }

  if ('type_config' in state) {
    const tc = state.type_config;
    if (!isPlainObject(tc)) {
      errors.push({
        instancePath: '/type_config',
        keyword: 'type',
        message: 'must be object',
      });
    } else {
      for (const k of TYPE_CONFIG_REQUIRED) {
        if (!(k in tc)) {
          errors.push({
            instancePath: '/type_config',
            keyword: 'required',
            message: `must have required property '${k}'`,
          });
        }
      }
      // additionalProperties: false inside type_config.
      for (const key of Object.keys(tc)) {
        if (!TYPE_CONFIG_REQUIRED.includes(key)) {
          errors.push({
            instancePath: `/type_config/${key}`,
            keyword: 'additionalProperties',
            message: `must NOT have additional property '${key}'`,
          });
        }
      }
      if ('maxRetries' in tc) {
        const mr = tc.maxRetries;
        if (typeof mr !== 'number' || !Number.isInteger(mr) || mr < 0) {
          errors.push({
            instancePath: '/type_config/maxRetries',
            keyword: 'minimum',
            message: 'must be integer >= 0',
          });
        }
      }
      if ('expeditedReviews' in tc && typeof tc.expeditedReviews !== 'boolean') {
        errors.push({
          instancePath: '/type_config/expeditedReviews',
          keyword: 'type',
          message: 'must be boolean',
        });
      }
      for (const arrKey of ['skippedPhases', 'enhancedPhases', 'additionalGates']) {
        if (arrKey in tc && !isStringArray(tc[arrKey])) {
          errors.push({
            instancePath: `/type_config/${arrKey}`,
            keyword: 'type',
            message: 'must be string[]',
          });
        }
      }
      if ('phaseTimeouts' in tc) {
        const pt = tc.phaseTimeouts;
        if (!isPlainObject(pt)) {
          errors.push({
            instancePath: '/type_config/phaseTimeouts',
            keyword: 'type',
            message: 'must be object',
          });
        } else {
          for (const [k, v] of Object.entries(pt)) {
            if (typeof v !== 'number' || v < 0) {
              errors.push({
                instancePath: `/type_config/phaseTimeouts/${k}`,
                keyword: 'minimum',
                message: 'must be number >= 0',
              });
            }
          }
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Atomic write (temp + rename)
// ---------------------------------------------------------------------------

/**
 * Pretty-printed JSON write via `tempfile + rename`. Matches the file-level
 * atomicity guarantees of `writeTempStateSync` in
 * `intake/core/handoff_manager.ts` (minus SQLite coupling).
 */
function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `${base}.tmp.${process.pid}.${Date.now()}`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf-8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync is a best-effort durability hint; some filesystems (e.g.
      // tmpfs in test envs) reject it. Atomicity comes from rename, not
      // fsync, so this fallback is safe.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads a state.json file, auto-migrates v1.0 → v1.1 if needed, validates,
 * and (on migration) persists the upgraded file via atomic temp+rename.
 *
 * Always returns a validated {@link RequestStateV1_1} in memory.
 *
 * Behavior:
 *   - File not found / unreadable: bubbles up the underlying `fs` error.
 *   - Malformed JSON:              bubbles up the underlying `JSON.parse` error.
 *   - schema_version === 1.0 + no own `request_type`:
 *       → migrate, write upgraded file atomically, create `.v1.0.backup`
 *         (only if no backup exists already — idempotent).
 *   - schema_version === 1.1:
 *       → fast-path: validate only, no write, no backup.
 *   - any other schema_version:
 *       → throws {@link StateValidationError} with a message naming the path.
 *   - upgraded object fails v1.1 validation:
 *       → throws {@link StateValidationError} with `errors` populated.
 */
export function loadState(filePath: string): RequestStateV1_1 {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RequestState;

  let upgraded: RequestStateV1_1;
  let didMigrate = false;

  if (isLegacyState(raw)) {
    upgraded = migrateStateV1_0ToV1_1(raw);
    didMigrate = true;
  } else if (isPlainObject(raw) && raw.schema_version === 1.1) {
    upgraded = raw as unknown as RequestStateV1_1;
  } else {
    const sv = isPlainObject(raw) ? raw.schema_version : undefined;
    throw new StateValidationError(
      [{
        instancePath: '/schema_version',
        keyword: 'const',
        message: `Unrecognized schema_version: ${String(sv)}`,
      }],
      `Unrecognized state schema_version at ${filePath}`,
    );
  }

  const errors = validateV1_1(upgraded);
  if (errors.length > 0) {
    throw new StateValidationError(
      errors,
      `State file failed v1.1 validation at ${filePath}`,
    );
  }

  if (didMigrate) {
    const backupPath = `${filePath}.v1.0.backup`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(filePath, backupPath);
    }
    atomicWriteJson(filePath, upgraded);
  }

  return upgraded;
}
