/**
 * YAML loader for standards artifacts (SPEC-021-1-02).
 *
 * Reads `standards.yaml` from disk using `js-yaml` in safe-load mode
 * (FAILSAFE_SCHEMA — rejects every custom tag including `!!python/object`
 * and `!!js/function` RCE payloads), parses to a `StandardsArtifact`, and
 * validates it against `schemas/standards-v1.json` via Ajv (draft 2020-12).
 *
 * Returns `{ artifact, errors[] }`. Errors are typed by `LoaderErrorRecord`
 * so callers (CLI, resolver, tests) can switch on `error.type` without
 * losing structured information. The function never throws on expected
 * failure paths — callers almost always need to inspect both the artifact
 * (when partial) and the error list.
 *
 * Defenses:
 *   - 1MB file-size cap via `stat()` BEFORE `readFile()` (DoS / billion-laughs).
 *   - FAILSAFE_SCHEMA rejects every YAML custom tag.
 *   - Ajv compiled once at module scope and reused.
 *
 * @module intake/standards/loader
 */

import { promises as fs } from 'node:fs';

import * as yaml from 'js-yaml';
// AJV draft 2020-12 entry — the default export targets draft-07.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import type { StandardsArtifact } from './types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const standardsSchema = require('../../schemas/standards-v1.json');

/** Maximum file size accepted by `loadStandardsFile` (1MB, TDD-021 §16). */
export const MAX_FILE_BYTES = 1_048_576;

/** Discriminated error record returned by `loadStandardsFile`. */
export type LoaderErrorRecord =
  | { type: 'io_error'; message: string }
  | { type: 'size_exceeded'; message: string; bytes: number }
  | { type: 'parse_error'; message: string }
  | { type: 'schema_error'; path: string; message: string };

/** Loader output: artifact (null on failure) + structured errors. */
export interface LoaderResult {
  artifact: StandardsArtifact | null;
  errors: LoaderErrorRecord[];
}

// ---------------------------------------------------------------------------
// Lazy, module-scoped Ajv compile cache.
// ---------------------------------------------------------------------------

let cachedValidator:
  | ((data: unknown) => boolean)
  | null = null;
let cachedAjvErrors: () => Array<{ instancePath: string; message?: string }> =
  () => [];

function getValidator(): (data: unknown) => boolean {
  if (cachedValidator) return cachedValidator;
  // ajv@8 ships its constructor as a CJS-default export; mirror the
  // pattern used by intake/hooks/validation-pipeline.ts for interop.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor: any = (Ajv2020 as any).default ?? Ajv2020;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addFormatsFn: any = (addFormats as any).default ?? addFormats;
  const ajv = new AjvCtor({
    allErrors: true,
    strict: false,
  });
  addFormatsFn(ajv);
  const validate = ajv.compile(standardsSchema);
  cachedValidator = (data: unknown) => validate(data) as boolean;
  cachedAjvErrors = () => (validate.errors ?? []) as Array<{
    instancePath: string;
    message?: string;
  }>;
  return cachedValidator;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read, parse, and validate a standards.yaml file.
 *
 * On success, returns `{ artifact, errors: [] }`. On any failure (I/O, size,
 * YAML parse, schema), returns `{ artifact: null, errors: [...] }` with one
 * or more `LoaderErrorRecord` describing every problem found.
 */
export async function loadStandardsFile(filePath: string): Promise<LoaderResult> {
  // 1. Stat to enforce size cap before reading the contents into memory.
  let bytes: number;
  try {
    const st = await fs.stat(filePath);
    bytes = st.size;
  } catch (err) {
    return {
      artifact: null,
      errors: [{ type: 'io_error', message: (err as Error).message }],
    };
  }
  if (bytes > MAX_FILE_BYTES) {
    return {
      artifact: null,
      errors: [
        {
          type: 'size_exceeded',
          message: `File size ${bytes} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`,
          bytes,
        },
      ],
    };
  }

  // 2. Read the (size-capped) contents.
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return {
      artifact: null,
      errors: [{ type: 'io_error', message: (err as Error).message }],
    };
  }

  // 3. Parse with FAILSAFE_SCHEMA — rejects every custom tag including
  //    `!!python/object` (PyYAML RCE port) and `!!js/function`.
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch (err) {
    return {
      artifact: null,
      errors: [{ type: 'parse_error', message: (err as Error).message }],
    };
  }

  // 4. Validate against standards-v1.json.
  const validate = getValidator();
  const ok = validate(parsed);
  if (!ok) {
    const errors = cachedAjvErrors().map<LoaderErrorRecord>((e) => ({
      type: 'schema_error',
      path: e.instancePath || '/',
      message: e.message ?? 'schema violation',
    }));
    return { artifact: null, errors };
  }

  return { artifact: parsed as StandardsArtifact, errors: [] };
}

/**
 * Test-only: drop the cached Ajv validator so subsequent calls recompile.
 * Production callers never need this; tests use it to assert compile-once
 * semantics or force recompilation under different ajv options.
 */
export function __resetValidatorCacheForTests(): void {
  cachedValidator = null;
  cachedAjvErrors = () => [];
}
