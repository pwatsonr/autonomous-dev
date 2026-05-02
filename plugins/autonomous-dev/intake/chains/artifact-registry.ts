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
} from './types';

const VERSION_FILE_RE = /^(\d+\.\d+)\.json$/;
const ARTIFACT_DIR_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCAN_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Public so callers can pre-build an Ajv instance with shared config. */
export interface ArtifactRegistryOptions {
  ajv?: Ajv2020;
}

/**
 * Per-artifact-type cache entry: compiled AJV validator plus the version
 * (used by knownTypes() and as `schemaVersion` on persist records).
 */
interface CacheEntry {
  validator: ValidateFunction;
  schemaVersion: string;
}

export class ArtifactRegistry {
  private readonly ajv: Ajv2020;
  /** key = `${artifactType}@${schemaVersion}` */
  private readonly validators = new Map<string, CacheEntry>();

  constructor(opts: ArtifactRegistryOptions = {}) {
    this.ajv =
      opts.ajv ??
      new Ajv2020({
        allErrors: true,
        strict: true,
      });
    addFormats(this.ajv);
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
    // Replace cache atomically — clear first.
    this.validators.clear();

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
        this.validators.set(key, { validator, schemaVersion: version });
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
    const targetDir = path.join(
      requestRoot,
      '.autonomous-dev',
      'artifacts',
      artifactType,
    );
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
    const targetPath = path.join(targetDir, `${scanId}.json`);
    const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(payload, null, 2);
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
