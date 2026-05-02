/**
 * ArtifactRegistry — load + validate + persist artifact payloads
 * (SPEC-022-1-02, Task 4).
 *
 * Loads every `<schemaRoot>/<artifact-type>/<MAJOR.MINOR>.json` schema at
 * boot, pre-compiles each via AJV, and exposes:
 *   - validate(type, version, payload) → ChainValidationResult
 *   - persist(requestRoot, type, scanId, payload) → ArtifactRecord (atomic)
 *   - load(requestRoot, type, scanId) → unknown
 *   - knownTypes() → list
 *
 * Atomic write: temp file → fs.rename. Mirrors the two-phase commit pattern
 * used by `intake/core/state_artifact.ts` and `intake/core/handoff_manager.ts`.
 *
 * @module intake/chains/artifact-registry
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type {
  ArtifactRecord,
  ChainValidationError,
  ChainValidationResult,
  ConsumerPluginRef,
  ValidatedArtifact,
} from './types';
import {
  CapabilityError,
  SchemaValidationError,
} from './types';
import { ArtifactTooLargeError } from './errors';
import { getValidator, type SchemaResolver } from './schema-cache';

const VERSION_FILE_RE = /^(\d+\.\d+)\.json$/;
const ARTIFACT_DIR_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCAN_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Default artifact-size cap in MB (SPEC-022-2-02). Mirrors
 * `chains.max_artifact_size_mb` in `config_defaults.json`.
 */
export const DEFAULT_MAX_ARTIFACT_SIZE_MB = 10;

/** Public so callers can pre-build an Ajv instance with shared config. */
export interface ArtifactRegistryOptions {
  ajv?: Ajv2020;
  /**
   * SPEC-022-2-02: per-artifact size cap in megabytes. JSON-serialized byte
   * length is checked at `persist()` time. Defaults to
   * {@link DEFAULT_MAX_ARTIFACT_SIZE_MB}.
   */
  maxArtifactSizeMb?: number;
}

/**
 * Per-artifact-type cache entry: compiled AJV validator plus the version
 * (used by knownTypes() and as `schemaVersion` on persist records).
 *
 * `rawSchema` is retained so the strict-schema consumer pipeline
 * (SPEC-022-3-01) can hand the parsed schema body to the per-consumer
 * AJV instance with `removeAdditional: 'all'`. The non-strict `validator`
 * here mutates nothing and is what the legacy `validate()` API uses.
 */
interface CacheEntry {
  validator: ValidateFunction;
  schemaVersion: string;
  rawSchema: object;
}

export class ArtifactRegistry {
  private readonly ajv: Ajv2020;
  /** key = `${artifactType}@${schemaVersion}` */
  private readonly validators = new Map<string, CacheEntry>();
  /** SPEC-022-2-02: artifact-size cap in BYTES (mb * 1024 * 1024). */
  private readonly maxArtifactSizeBytes: number;

  constructor(opts: ArtifactRegistryOptions = {}) {
    this.ajv =
      opts.ajv ??
      new Ajv2020({
        allErrors: true,
        strict: true,
      });
    addFormats(this.ajv);
    const mb = opts.maxArtifactSizeMb ?? DEFAULT_MAX_ARTIFACT_SIZE_MB;
    this.maxArtifactSizeBytes = mb * 1024 * 1024;
  }

  /** Effective artifact-size cap in bytes. Visible for tests + telemetry. */
  getMaxArtifactSizeBytes(): number {
    return this.maxArtifactSizeBytes;
  }

  /**
   * Walk `<schemaRoot>/<artifact-type>/<MAJOR.MINOR>.json` and pre-compile
   * each schema. Idempotent: a second call REPLACES the cache (no
   * duplicates; new content wins).
   *
   * Schema files that fail to parse or compile are reported in `errors`;
   * loading continues for the rest.
   */
  async loadSchemas(
    schemaRoot: string,
  ): Promise<{ loaded: string[]; errors: string[] }> {
    // Replace cache atomically — clear first. AJV retains compiled schemas
    // keyed by `$id`, so we also need a fresh AJV instance to allow the
    // same schema files to be re-compiled on a second loadSchemas call
    // (per SPEC-022-1-05's idempotent-reload contract).
    this.validators.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as { ajv: Ajv2020 }).ajv = new Ajv2020({
      allErrors: true,
      strict: true,
    });
    addFormats(this.ajv);

    const loaded: string[] = [];
    const errors: string[] = [];

    let typeDirs: import('node:fs').Dirent[];
    try {
      typeDirs = await fs.readdir(schemaRoot, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        return { loaded, errors };
      }
      throw err;
    }

    for (const ent of typeDirs) {
      if (!ent.isDirectory()) continue;
      const artifactType = ent.name;
      if (!ARTIFACT_DIR_NAME_RE.test(artifactType)) continue;

      const typeDir = path.join(schemaRoot, ent.name);
      let files: string[];
      try {
        files = await fs.readdir(typeDir);
      } catch (err) {
        errors.push(`${ent.name}: ${(err as Error).message}`);
        continue;
      }
      for (const file of files) {
        const m = VERSION_FILE_RE.exec(file);
        if (!m) continue;
        const version = m[1];
        const fullPath = path.join(typeDir, file);
        let raw: string;
        try {
          raw = await fs.readFile(fullPath, 'utf-8');
        } catch (err) {
          errors.push(
            `${artifactType}/${file}: read failed: ${(err as Error).message}`,
          );
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          errors.push(
            `${artifactType}/${file}: parse failed: ${(err as Error).message}`,
          );
          continue;
        }
        let validator: ValidateFunction;
        try {
          validator = this.ajv.compile(parsed as object);
        } catch (err) {
          errors.push(
            `${artifactType}/${file}: compile failed: ${(err as Error).message}`,
          );
          continue;
        }
        const key = `${artifactType}@${version}`;
        this.validators.set(key, {
          validator,
          schemaVersion: version,
          rawSchema: parsed as object,
        });
        loaded.push(key);
      }
    }

    loaded.sort();
    return { loaded, errors };
  }

  /**
   * Validate a payload against `<artifactType>@<schemaVersion>`.
   *
   * Returns `{isValid: false, errors: [{pointer:'', message:'unknown artifact type or version'}]}`
   * when the (type, version) pair was not loaded.
   */
  validate(
    artifactType: string,
    schemaVersion: string,
    payload: unknown,
  ): ChainValidationResult {
    const key = `${artifactType}@${schemaVersion}`;
    const entry = this.validators.get(key);
    if (!entry) {
      return {
        isValid: false,
        errors: [
          {
            pointer: '',
            message: `unknown artifact type or version: ${key}`,
          },
        ],
      };
    }
    const valid = entry.validator(payload);
    if (valid) {
      return { isValid: true, errors: [] };
    }
    const errors: ChainValidationError[] = (entry.validator.errors ?? []).map(
      (e) => ({
        pointer: e.instancePath,
        message: e.message ?? 'validation failed',
        keyword: e.keyword,
      }),
    );
    return { isValid: false, errors };
  }

  /**
   * Atomic write to `<requestRoot>/.autonomous-dev/artifacts/<type>/<scanId>.json`.
   *
   * - Creates parent dirs (mode 0700) if missing.
   * - Writes to `<target>.tmp.<pid>.<ts>` first, then `fs.rename`.
   * - Mode 0600 on the final file.
   * - On any error after the temp write, the temp file is unlinked.
   *
   * Path-traversal defense: rejects `scanId` containing `/`, `..`, or NUL.
   */
  async persist(
    requestRoot: string,
    artifactType: string,
    scanId: string,
    payload: unknown,
  ): Promise<ArtifactRecord> {
    if (
      !SCAN_ID_RE.test(scanId) ||
      scanId.includes('..') ||
      scanId.includes('/') ||
      scanId.includes('\0')
    ) {
      throw new Error(`invalid scanId for persist: '${scanId}'`);
    }
    if (!ARTIFACT_DIR_NAME_RE.test(artifactType)) {
      throw new Error(`invalid artifactType for persist: '${artifactType}'`);
    }
    const data = JSON.stringify(payload, null, 2);
    // SPEC-022-2-02: enforce artifact-size cap on the JSON byte length.
    // Boundary inclusive: a payload of EXACTLY maxArtifactSizeBytes is OK;
    // strictly greater is rejected. Throws BEFORE any disk I/O so the
    // executor records a clean producer-side failure.
    const sizeBytes = Buffer.byteLength(data, 'utf-8');
    if (sizeBytes > this.maxArtifactSizeBytes) {
      throw new ArtifactTooLargeError(
        scanId,
        artifactType,
        sizeBytes,
        this.maxArtifactSizeBytes,
      );
    }
    const targetDir = path.join(
      requestRoot,
      '.autonomous-dev',
      'artifacts',
      artifactType,
    );
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
    const targetPath = path.join(targetDir, `${scanId}.json`);
    const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tempPath, data, { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      // Clean up the stray temp file before propagating.
      await fs.unlink(tempPath).catch(() => {
        /* best-effort */
      });
      throw err;
    }
    // Tighten mode in case the umask widened it.
    try {
      await fs.chmod(targetPath, 0o600);
    } catch {
      /* best-effort */
    }
    // Look up the producer's schemaVersion if known; informational only.
    const matching = Array.from(this.validators.entries()).find(
      ([k]) => k.split('@')[0] === artifactType,
    );
    const schemaVersion = matching?.[1].schemaVersion ?? '?';
    return { artifactType, schemaVersion, filePath: targetPath, payload };
  }

  /**
   * Read a previously-persisted artifact.
   *
   * Throws an Error containing 'artifact not found' on ENOENT.
   */
  async load(
    requestRoot: string,
    artifactType: string,
    scanId: string,
  ): Promise<unknown> {
    if (!ARTIFACT_DIR_NAME_RE.test(artifactType)) {
      throw new Error(`invalid artifactType for load: '${artifactType}'`);
    }
    if (
      !SCAN_ID_RE.test(scanId) ||
      scanId.includes('..') ||
      scanId.includes('/')
    ) {
      throw new Error(`invalid scanId for load: '${scanId}'`);
    }
    const filePath = path.join(
      requestRoot,
      '.autonomous-dev',
      'artifacts',
      artifactType,
      `${scanId}.json`,
    );
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error(`artifact not found: ${filePath}`);
      }
      throw err;
    }
    return JSON.parse(raw);
  }

  /**
   * SPEC-022-3-01: capability-scoped, strict-schema artifact read.
   *
   * Pipeline (out-of-order layers added by SPEC-022-3-02 are noted inline):
   *   1. Capability scope check — `consumerPlugin.consumes[]` MUST list
   *      `artifactType`. Runs BEFORE any I/O so a denied capability never
   *      touches disk or the schema cache.
   *   2. Load the on-disk artifact JSON (existing `load()` behavior).
   *      [SPEC-022-3-02 inserts HMAC + Ed25519 verify here.]
   *   3. Strict-schema validate against the CONSUMER's declared
   *      `schema_version`. The validator mutates the payload to strip
   *      additional properties, so a producer's extra fields are silently
   *      dropped.
   *      [SPEC-022-3-02 inserts sanitization here.]
   *   4. Return a `ValidatedArtifact` whose `schema_version` is the
   *      consumer's declared version (the contract), not the producer's.
   *
   * The on-disk file is NEVER mutated — strict validation runs on a deep
   * copy. The original JSON is preserved for audit + signature paths.
   *
   * Errors:
   *   - `CapabilityError` if the consumer did not declare this artifact_type.
   *   - `Error('artifact not found ...')` from {@link load} on ENOENT.
   *   - `SchemaNotFoundError` if no schema is registered for
   *     `(artifactType, consumerSchemaVersion)`.
   *   - `SchemaValidationError` if the payload violates the consumer's
   *     schema; AJV's `errors` array is attached.
   */
  async read(
    artifactType: string,
    artifactId: string,
    consumerPlugin: ConsumerPluginRef,
    requestRoot: string,
  ): Promise<ValidatedArtifact> {
    // 1. Capability scope check (FIRST, before any I/O).
    const consumesEntry = consumerPlugin.consumes.find(
      (c) => c.artifact_type === artifactType,
    );
    if (!consumesEntry) {
      throw new CapabilityError(consumerPlugin.pluginId, artifactType);
    }
    const consumerSchemaVersion = consumesEntry.schema_version;

    // 2. Load the raw artifact off disk. Reuses the legacy `load()` so
    //    error-handling (ENOENT → 'artifact not found') matches PLAN-022-1.
    const raw = (await this.load(requestRoot, artifactType, artifactId)) as
      | Record<string, unknown>
      | unknown;

    // The on-disk shape MAY include envelope fields (`producer_plugin_id`,
    // `produced_at`, `payload`, `_chain_hmac`, …) once SPEC-022-3-02 lands.
    // Today, persist() writes the bare payload, so we tolerate both shapes.
    const envelope = extractEnvelope(raw);

    // 3. Strict-schema validation against the CONSUMER's version.
    //    Deep-clone before validation so the on-disk payload cannot be
    //    mutated by `removeAdditional: 'all'`.
    const validator = getValidator(
      artifactType,
      consumerSchemaVersion,
      this.schemaResolver,
    );
    const cloned = deepClone(envelope.payload);
    const ok = validator(cloned);
    if (!ok) {
      throw new SchemaValidationError(
        artifactType,
        consumerSchemaVersion,
        validator.errors ?? [],
      );
    }

    return {
      artifact_type: artifactType,
      schema_version: consumerSchemaVersion,
      payload: cloned as Record<string, unknown>,
      producer_plugin_id: envelope.producer_plugin_id,
      produced_at: envelope.produced_at,
    };
  }

  /**
   * Resolver wired into the schema cache. Returns the parsed schema body
   * for `(artifactType, schemaVersion)` — or `null` when the pair was not
   * loaded by `loadSchemas()`. Bound to `this` so callers (and the cache)
   * can pass it as a plain function reference.
   */
  readonly schemaResolver: SchemaResolver = (artifactType, schemaVersion) => {
    const entry = this.validators.get(`${artifactType}@${schemaVersion}`);
    return entry ? entry.rawSchema : null;
  };

  /**
   * Sorted list of every loaded `(artifactType, schemaVersion)` pair.
   */
  knownTypes(): Array<{ artifactType: string; schemaVersion: string }> {
    const out: Array<{ artifactType: string; schemaVersion: string }> = [];
    for (const key of this.validators.keys()) {
      const [artifactType, schemaVersion] = key.split('@');
      out.push({ artifactType, schemaVersion });
    }
    out.sort((a, b) => {
      if (a.artifactType !== b.artifactType) {
        return a.artifactType.localeCompare(b.artifactType);
      }
      return a.schemaVersion.localeCompare(b.schemaVersion);
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// SPEC-022-3-01 helpers
// ---------------------------------------------------------------------------

/**
 * Internal envelope view used by `read()`. SPEC-022-3-02 will populate
 * `_chain_hmac` / `_chain_signature`; today's persist() writes the bare
 * payload so we tolerate both shapes. The contract is "either the file is
 * already an envelope (has a `payload` key) or it IS the payload."
 */
interface ArtifactEnvelopeView {
  payload: unknown;
  producer_plugin_id: string;
  produced_at: string;
}

const ENVELOPE_PROBE_KEYS = new Set([
  'artifact_type',
  'schema_version',
  'producer_plugin_id',
  'produced_at',
  'payload',
]);

function extractEnvelope(raw: unknown): ArtifactEnvelopeView {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // Heuristic: if the on-disk file declares an explicit envelope (via the
    // SPEC-022-3-02 wrapper), surface its inner payload. Otherwise treat
    // the whole object as the payload (PLAN-022-1 / pre-signing shape).
    const isEnvelope =
      'payload' in obj && ENVELOPE_PROBE_KEYS.has('payload') &&
      typeof obj.payload === 'object';
    if (isEnvelope) {
      return {
        payload: obj.payload,
        producer_plugin_id:
          typeof obj.producer_plugin_id === 'string'
            ? obj.producer_plugin_id
            : 'unknown',
        produced_at:
          typeof obj.produced_at === 'string'
            ? obj.produced_at
            : '',
      };
    }
    // Bare-payload shape: try to surface producer / produced_at if the
    // payload itself records them (security-findings / code-patches do).
    return {
      payload: obj,
      producer_plugin_id:
        typeof obj.produced_by === 'string' ? obj.produced_by : 'unknown',
      produced_at:
        typeof obj.produced_at === 'string' ? obj.produced_at : '',
    };
  }
  return { payload: raw, producer_plugin_id: 'unknown', produced_at: '' };
}

/**
 * Deep clone via `structuredClone` when available, falling back to
 * `JSON.parse(JSON.stringify(...))`. The strict-schema validator mutates
 * its input; consumers MUST receive a fresh object so the on-disk file
 * stays intact for audit + signature paths.
 */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
