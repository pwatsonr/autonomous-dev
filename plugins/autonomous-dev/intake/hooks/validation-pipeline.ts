/**
 * ValidationPipeline — schema-driven gate for every hook input/output payload
 * (SPEC-019-2-01, Tasks 1-2).
 *
 * Owns a single AJV instance configured per TDD-019 §9 (draft 2020-12 dialect,
 * `removeAdditional: 'all'`, defaults applied, formats validated). At
 * construction time `loadSchemas()` walks the on-disk schema tree
 * (`<root>/<hook-point>/<version>/{input,output}.json`) and pre-compiles every
 * validator, keying the cache by `${point}:${version}:${direction}`.
 *
 * Public surface:
 *   - `validateHookInput(point, version, payload)` — pre-execution gate.
 *   - `validateHookOutput(point, version, payload)` — post-execution sanitizer.
 *   - `getStats()` / `resetStats()` — telemetry passthrough (SPEC-019-2-03).
 *
 * Two helper error classes — `SchemaLoadError` and `SchemaNotFoundError` —
 * are exported so callers can `instanceof`-discriminate startup vs runtime
 * misconfiguration.
 *
 * @module intake/hooks/validation-pipeline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

// AJV draft-2020-12 entry point. The package ships its 2020 build at this
// subpath; the default import is the legacy draft-07 build. See AJV §6.
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import semver from 'semver';

import type {
  ValidationError,
  ValidationLogger,
  ValidationPipelineOptions,
  ValidationResult,
  SchemaCacheKey,
} from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by `loadSchemas()` when a schema file is malformed or unrecognized. */
export class SchemaLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaLoadError';
  }
}

/** Thrown by `validate*` when no validator is registered for the requested point/direction. */
export class SchemaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class ValidationPipeline {
  /** AJV instance owned by this pipeline. Per-instance for test isolation. */
  protected readonly ajv: Ajv2020;
  /** Compiled-validator cache keyed by `${point}:${version}:${direction}`. */
  private readonly cache: Map<SchemaCacheKey, ValidateFunction> = new Map();
  /** Index of available versions per `${point}:${direction}` for fallback. */
  private readonly versionIndex: Map<string, string[]> = new Map();
  /** Resolved logger (defaults to console subset). */
  private readonly logger: ValidationLogger;
  /** Schema root passed in by caller. */
  protected readonly schemasRoot: string;

  constructor(options: ValidationPipelineOptions) {
    this.schemasRoot = options.schemasRoot;
    this.logger = options.logger ?? {
      // eslint-disable-next-line no-console
      info: (m: string) => console.info(m),
      // eslint-disable-next-line no-console
      warn: (m: string) => console.warn(m),
      // eslint-disable-next-line no-console
      error: (m: string) => console.error(m),
    };

    // AJV options exactly match TDD-019 §9 reference implementation.
    // ajv@8 ships its constructor as a CJS-default export; the typing
    // surfaces it as both default and namespace. Casting via `any` keeps
    // both ESM and CJS interop working without a module-resolution flip.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvCtor: any = (Ajv2020 as any).default ?? Ajv2020;
    this.ajv = new AjvCtor({
      strict: true,
      allErrors: false,
      coerceTypes: true,
      removeAdditional: 'all',
      useDefaults: true,
      validateFormats: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addFormatsFn: any = (addFormats as any).default ?? addFormats;
    addFormatsFn(this.ajv);
  }

  /**
   * Walk `schemasRoot` and pre-compile every `<point>/<version>/{input,output}.json`.
   *
   * Throws `SchemaLoadError` (with the offending file path) on any malformed
   * JSON, missing `$schema`, or AJV compilation failure. Daemon must fail
   * loud at startup so operators can fix the schema registry.
   */
  async loadSchemas(): Promise<void> {
    let validatorCount = 0;
    const points = new Set<string>();

    if (!fs.existsSync(this.schemasRoot)) {
      // Empty registry is permitted (e.g., test harness). loadSchemas() is a no-op.
      this.logger.info(
        `ValidationPipeline: schemas root ${this.schemasRoot} does not exist; loaded 0 validators`,
      );
      return;
    }

    const pointDirs = await fs.promises.readdir(this.schemasRoot, { withFileTypes: true });
    for (const pointDirent of pointDirs) {
      if (!pointDirent.isDirectory()) continue;
      const point = pointDirent.name;
      const pointPath = path.join(this.schemasRoot, point);
      const versionDirs = await fs.promises.readdir(pointPath, { withFileTypes: true });

      for (const versionDirent of versionDirs) {
        if (!versionDirent.isDirectory()) continue;
        const version = versionDirent.name;
        const versionPath = path.join(pointPath, version);

        for (const direction of ['input', 'output'] as const) {
          const file = path.join(versionPath, `${direction}.json`);
          if (!fs.existsSync(file)) continue;
          await this.compileSchemaFile(file, point, version, direction);
          validatorCount += 1;
          points.add(point);
        }
      }
    }

    this.logger.info(
      `ValidationPipeline: loaded ${validatorCount} validators across ${points.size} hook points`,
    );
  }

  /**
   * Validate a hook's INPUT payload before invocation.
   *
   * On exact-version cache hit: validator runs, no warning.
   * On miss: falls back per `resolveFallback`; warning appended.
   * On no-validator-at-any-version: throws `SchemaNotFoundError`.
   */
  async validateHookInput<T = unknown>(
    point: string,
    version: string,
    input: unknown,
  ): Promise<ValidationResult<T>> {
    return this.validate<T>('input', point, version, input);
  }

  /** Validate a hook's OUTPUT payload after invocation. Mirrors `validateHookInput`. */
  async validateHookOutput<T = unknown>(
    point: string,
    version: string,
    output: unknown,
  ): Promise<ValidationResult<T>> {
    return this.validate<T>('output', point, version, output);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers (protected so SPEC-019-2-02/03 subclasses can override)
  // ---------------------------------------------------------------------------

  protected async validate<T>(
    direction: 'input' | 'output',
    point: string,
    version: string,
    payload: unknown,
  ): Promise<ValidationResult<T>> {
    const start = performance.now();
    const warnings: string[] = [];

    const exactKey = this.cacheKey(point, version, direction);
    let validator = this.cache.get(exactKey);
    let resolvedVersion = version;

    if (!validator) {
      const fallback = this.resolveFallback(point, version, direction);
      if (!fallback) {
        throw new SchemaNotFoundError(
          `No validator registered for hook point '${point}' direction '${direction}'. ` +
            `Searched: ${path.join(this.schemasRoot, point)}/`,
        );
      }
      validator = fallback.validator;
      resolvedVersion = fallback.version;
      const warnMsg =
        `Schema version '${version}' not found for hook point '${point}' direction '${direction}'. ` +
        `Falling back to '${resolvedVersion}'.`;
      this.logger.warn(warnMsg);
      warnings.push(warnMsg);
    }

    // Deep copy so the caller's payload is never mutated by removeAdditional /
    // useDefaults / coerceTypes side effects.
    const sanitized = this.deepCopy(payload) as T;
    const isValid = validator(sanitized) as boolean;
    const rawErrors = validator.errors ?? [];
    const errors: ValidationError[] = rawErrors.map((e) => ({
      instancePath: e.instancePath,
      message: e.message ?? '',
      params: e.params as Record<string, unknown> | undefined,
    }));

    // Hook point for error redaction (SPEC-019-2-02 overrides this method).
    const finalErrors = this.postProcessErrors(errors, sanitized, validator);

    const validationTime = Math.round((performance.now() - start) * 1000) / 1000;

    const result: ValidationResult<T> = {
      isValid,
      sanitizedOutput: sanitized,
      errors: finalErrors,
      warnings,
      validationTime,
      hookPoint: point,
      schemaVersion: resolvedVersion,
      direction,
    };

    this.recordStats(point, resolvedVersion, isValid, validationTime);
    return result;
  }

  /**
   * Hook for SPEC-019-2-02 to apply x-redact-on-failure scrubbing. Default
   * implementation is a passthrough.
   */
  protected postProcessErrors(
    errors: ValidationError[],
    _payload: unknown,
    _validator: ValidateFunction,
  ): ValidationError[] {
    return errors;
  }

  /**
   * Hook for SPEC-019-2-03 to record stats. Default is a no-op so the
   * skeleton class is usable without the stats subsystem.
   */
  protected recordStats(
    _point: string,
    _version: string,
    _isValid: boolean,
    _durationMs: number,
  ): void {
    // SPEC-019-2-03 overrides.
  }

  /**
   * Pick the best available version for a missed cache lookup.
   *
   * Algorithm (per SPEC-019-2-01 §"Schema-Version Negotiation"):
   *   1. Highest version `<= requested`, OR
   *   2. Lowest available if requested is older than every available.
   *
   * Returns `null` when no versions are registered for `(point, direction)`.
   */
  private resolveFallback(
    point: string,
    requested: string,
    direction: 'input' | 'output',
  ): { validator: ValidateFunction; version: string } | null {
    const indexKey = `${point}:${direction}`;
    const versions = this.versionIndex.get(indexKey);
    if (!versions || versions.length === 0) return null;

    // versionIndex stores ascending-sorted semver. Walk descending and pick
    // the first <= requested; if none, pick the lowest (versions[0]).
    let chosen: string | undefined;
    const reqValid = semver.valid(requested);
    if (reqValid) {
      for (let i = versions.length - 1; i >= 0; i -= 1) {
        if (semver.lte(versions[i], reqValid)) {
          chosen = versions[i];
          break;
        }
      }
    }
    if (!chosen) chosen = versions[0];

    const validator = this.cache.get(this.cacheKey(point, chosen, direction));
    if (!validator) return null;
    return { validator, version: chosen };
  }

  private async compileSchemaFile(
    file: string,
    point: string,
    version: string,
    direction: 'input' | 'output',
  ): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf-8');
    } catch (err) {
      throw new SchemaLoadError(
        `Failed to read schema file ${file}: ${(err as Error).message}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new SchemaLoadError(
        `Malformed JSON in schema file ${file}: ${(err as Error).message}`,
      );
    }

    if (parsed.$schema !== REQUIRED_DIALECT) {
      throw new SchemaLoadError(
        `Schema file ${file} missing or wrong $schema (expected '${REQUIRED_DIALECT}', got '${String(parsed.$schema)}')`,
      );
    }

    let compiled: ValidateFunction;
    try {
      compiled = this.ajv.compile(parsed);
    } catch (err) {
      throw new SchemaLoadError(
        `AJV compilation failed for schema file ${file}: ${(err as Error).message}`,
      );
    }

    const key = this.cacheKey(point, version, direction);
    this.cache.set(key, compiled);

    const indexKey = `${point}:${direction}`;
    const list = this.versionIndex.get(indexKey) ?? [];
    if (!list.includes(version)) list.push(version);
    list.sort(semver.compare);
    this.versionIndex.set(indexKey, list);
  }

  private cacheKey(point: string, version: string, direction: 'input' | 'output'): SchemaCacheKey {
    return `${point}:${version}:${direction}` as SchemaCacheKey;
  }

  private deepCopy<U>(value: U): U {
    // structuredClone is available in Node >= 17. Fallback to JSON for the
    // unlikely case of an older runtime.
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as U;
  }
}
