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

import { createHmac, timingSafeEqual } from 'node:crypto';
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
  ArtifactTamperedError,
  ArtifactUnsignedError,
  CapabilityError,
  PrivilegedSignatureError,
  SchemaValidationError,
} from './types';
import { ArtifactTooLargeError } from './errors';
import { getValidator, type SchemaResolver } from './schema-cache';
import { canonicalJSON } from './canonical-json';
import { getChainHmacKey } from './chain-key';
import { sanitizeArtifact } from './sanitizer';
import { SignatureVerifier } from '../hooks/signature-verifier';

const VERSION_FILE_RE = /^(\d+\.\d+)\.json$/;
const ARTIFACT_DIR_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCAN_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Default artifact-size cap in MB (SPEC-022-2-02). Mirrors
 * `chains.max_artifact_size_mb` in `config_defaults.json`.
 */
export const DEFAULT_MAX_ARTIFACT_SIZE_MB = 10;

/**
 * SPEC-022-3-02: Ed25519 producer-signing pluggable interface. The signer
 * is invoked at `persist()` time when both producer and consumer are in
 * the privileged-chain allowlist. When omitted, no `_chain_signature`
 * field is written — non-privileged chains rely on HMAC alone.
 */
export interface ChainArtifactSigner {
  /**
   * Produce a base64 Ed25519 signature for `canonical` using the producer
   * plugin's private key. May throw if the plugin has no signing key
   * registered; callers should treat that as a privileged-chain
   * configuration failure.
   */
  sign(producerPluginId: string, canonical: string): string;
}

/**
 * SPEC-022-3-02: privileged-chain policy. Returns true iff BOTH endpoints
 * (producer + consumer plugin ids) are in `extensions.privileged_chains[]`
 * for the running chain. The registry uses this at persist (to decide
 * whether to add `_chain_signature`) and at read (to decide whether to
 * require + verify it).
 */
export interface ChainPrivilegedPolicy {
  isPrivileged(producerPluginId: string, consumerPluginId: string): boolean;
}

/**
 * SPEC-022-3-02: trusted-key lookup for Ed25519 verification. Maps a
 * plugin id to the producer's PEM-encoded public key (the same key
 * shipped under `~/.claude/trusted-keys/<plugin>.pub` in PLAN-019-3).
 */
export interface ChainTrustedKeyStore {
  lookup(producerPluginId: string): string | null;
}

/**
 * SPEC-022-3-02: producer-side context for `persist()`. Optional so
 * pre-PLAN-022-3 callers (and tests) keep working with the original
 * 4-arg signature; when supplied, drives envelope metadata + privileged-
 * chain signing.
 */
export interface ProducerContext {
  /** Identity of the producing plugin; written to envelope.producer_plugin_id. */
  pluginId: string;
  /** Consumer the artifact is destined for; gates privileged-chain signing. */
  consumerPluginId?: string;
  /** Override `produced_at` for deterministic tests. Defaults to ISO now. */
  producedAt?: string;
}

/** Public so callers can pre-build an Ajv instance with shared config. */
export interface ArtifactRegistryOptions {
  ajv?: Ajv2020;
  /**
   * SPEC-022-2-02: per-artifact size cap in megabytes. JSON-serialized byte
   * length is checked at `persist()` time. Defaults to
   * {@link DEFAULT_MAX_ARTIFACT_SIZE_MB}.
   */
  maxArtifactSizeMb?: number;
  /**
   * SPEC-022-3-02: override the chain HMAC key resolver. Defaults to
   * `getChainHmacKey()` (env → file → first-run generation). Tests
   * inject a fixed Buffer for determinism.
   */
  hmacKey?: Buffer;
  /** SPEC-022-3-02: optional Ed25519 signer (privileged chains). */
  signer?: ChainArtifactSigner;
  /** SPEC-022-3-02: optional privileged-chain policy. */
  privilegedPolicy?: ChainPrivilegedPolicy;
  /** SPEC-022-3-02: optional trusted-key store for Ed25519 verify. */
  trustedKeys?: ChainTrustedKeyStore;
  /**
   * SPEC-022-3-02: whether to enable HMAC sign/verify on persist+read.
   * Defaults to `true`. Set false to opt out for legacy callers that
   * persist non-envelope payloads. The new `read()` pipeline always
   * enforces signing when this is on.
   */
  hmacEnabled?: boolean;
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
  /** SPEC-022-3-02: HMAC key (lazily fetched on first persist/read). */
  private hmacKey: Buffer | null;
  private readonly hmacEnabled: boolean;
  private readonly signer?: ChainArtifactSigner;
  private readonly privilegedPolicy?: ChainPrivilegedPolicy;
  private readonly trustedKeys?: ChainTrustedKeyStore;

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
    this.hmacKey = opts.hmacKey ?? null;
    this.hmacEnabled = opts.hmacEnabled !== false;
    this.signer = opts.signer;
    this.privilegedPolicy = opts.privilegedPolicy;
    this.trustedKeys = opts.trustedKeys;
  }

  /** Lazy-load the chain HMAC key (env → file → first-run). */
  private getHmacKey(): Buffer {
    if (!this.hmacKey) {
      this.hmacKey = getChainHmacKey();
    }
    return this.hmacKey;
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
   *
   * SPEC-022-3-02: when HMAC is enabled (default) the on-disk shape is an
   * envelope `{artifact_type, schema_version, producer_plugin_id,
   * produced_at, payload, _chain_hmac, [_chain_signature]}`. The HMAC is
   * computed over the canonical JSON of all envelope fields EXCEPT itself
   * and `_chain_signature`. When privileged-chain policy applies AND a
   * signer is configured, an Ed25519 signature is added under
   * `_chain_signature`. The legacy `load()` continues to surface the
   * inner `payload` unchanged so executor + tests round-trip correctly.
   */
  async persist(
    requestRoot: string,
    artifactType: string,
    scanId: string,
    payload: unknown,
    producerCtx?: ProducerContext,
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
    // Resolve schema version from validator cache (informational only).
    const matching = Array.from(this.validators.entries()).find(
      ([k]) => k.split('@')[0] === artifactType,
    );
    const schemaVersion = matching?.[1].schemaVersion ?? '?';

    // SPEC-022-2-02: enforce artifact-size cap on the JSON byte length of
    // the user's PAYLOAD ONLY — the cap is meant to bound user-facing data,
    // not the HMAC/Ed25519 envelope metadata that PLAN-022-3 added on top.
    // Sizing the bare payload keeps the cap stable across signing changes
    // and matches the `chains.max_artifact_size_mb` operator-facing intent.
    // Boundary inclusive: a payload of EXACTLY maxArtifactSizeBytes is OK;
    // strictly greater is rejected. Throws BEFORE any disk I/O so the
    // executor records a clean producer-side failure.
    const payloadSerialized = JSON.stringify(payload, null, 2);
    const payloadBytes = Buffer.byteLength(payloadSerialized, 'utf-8');
    if (payloadBytes > this.maxArtifactSizeBytes) {
      throw new ArtifactTooLargeError(
        scanId,
        artifactType,
        payloadBytes,
        this.maxArtifactSizeBytes,
      );
    }

    // Build the on-disk shape. When HMAC is on (the default in PLAN-022-3),
    // we wrap the payload in a signed envelope. When off, we keep the
    // pre-PLAN-022-3 bare-payload shape for backward compatibility.
    let serialized: string;
    if (this.hmacEnabled) {
      const envelope = {
        artifact_type: artifactType,
        schema_version: schemaVersion,
        producer_plugin_id: producerCtx?.pluginId ?? 'unknown',
        produced_at: producerCtx?.producedAt ?? new Date().toISOString(),
        payload,
      };
      const canonical = canonicalJSON(envelope);
      const hmac = createHmac('sha256', this.getHmacKey())
        .update(canonical)
        .digest('base64');
      // Optional Ed25519 signature for privileged chains. The signer is
      // only invoked when policy says BOTH endpoints are privileged AND
      // a signer is configured; otherwise the field is omitted entirely
      // (NOT set to null — the read pipeline checks for presence).
      let signature: string | undefined;
      if (
        this.signer &&
        this.privilegedPolicy &&
        producerCtx?.consumerPluginId &&
        this.privilegedPolicy.isPrivileged(
          envelope.producer_plugin_id,
          producerCtx.consumerPluginId,
        )
      ) {
        signature = this.signer.sign(envelope.producer_plugin_id, canonical);
      }
      const final: Record<string, unknown> = {
        ...envelope,
        _chain_hmac: hmac,
      };
      if (signature) final._chain_signature = signature;
      serialized = JSON.stringify(final, null, 2);
    } else {
      serialized = payloadSerialized;
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
    await fs.writeFile(tempPath, serialized, { encoding: 'utf-8', mode: 0o600 });
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
    return { artifactType, schemaVersion, filePath: targetPath, payload };
  }

  /**
   * Read a previously-persisted artifact (legacy unsigned API).
   *
   * Throws an Error containing 'artifact not found' on ENOENT.
   *
   * SPEC-022-3-02: when the on-disk file is an envelope (`_chain_hmac`
   * present), this returns the INNER payload so executor + tests
   * round-trip with the producer's payload as before. The envelope-aware
   * `read()` API is the one consumers should use; `load()` is preserved
   * for the executor's internal seed-and-resume paths.
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
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)._chain_hmac === 'string' &&
      'payload' in (parsed as Record<string, unknown>)
    ) {
      return (parsed as Record<string, unknown>).payload;
    }
    return parsed;
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

    // 2. Load the raw artifact JSON directly (NOT through legacy load(),
    //    which strips the envelope wrapper). We need the full envelope
    //    bytes to verify the HMAC.
    const filePath = path.join(
      requestRoot,
      '.autonomous-dev',
      'artifacts',
      artifactType,
      `${artifactId}.json`,
    );
    let rawText: string;
    try {
      rawText = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error(`artifact not found: ${filePath}`);
      }
      throw err;
    }
    const onDisk = JSON.parse(rawText) as Record<string, unknown>;

    // 3. SPEC-022-3-02: HMAC + (privileged) Ed25519 verification.
    if (this.hmacEnabled) {
      this.verifyHmac(artifactType, artifactId, onDisk);
      this.verifyPrivilegedSignature(
        artifactType,
        artifactId,
        onDisk,
        consumerPlugin.pluginId,
      );
    }

    // 4. Extract the inner payload + envelope metadata.
    const envelope = extractEnvelope(onDisk);

    // 5. Strict-schema validation against the CONSUMER's version.
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

    // 6. SPEC-022-3-02: content-level sanitization. Runs AFTER schema
    //    validation so the walker only sees fields the consumer actually
    //    declared (additional properties already stripped).
    const cacheEntry = this.validators.get(
      `${artifactType}@${consumerSchemaVersion}`,
    );
    if (cacheEntry) {
      sanitizeArtifact(artifactType, cloned, cacheEntry.rawSchema, requestRoot);
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
   * SPEC-022-3-02: verify the chain HMAC over the artifact envelope.
   * Throws `ArtifactUnsignedError` when no HMAC is present and
   * `ArtifactTamperedError` when the recomputed HMAC does not match.
   */
  private verifyHmac(
    artifactType: string,
    artifactId: string,
    onDisk: Record<string, unknown>,
  ): void {
    const storedHmac = onDisk._chain_hmac;
    if (typeof storedHmac !== 'string' || storedHmac.length === 0) {
      throw new ArtifactUnsignedError(artifactType, artifactId);
    }
    // Strip `_chain_hmac` and `_chain_signature` before computing — the
    // signing input excludes both auxiliary fields by construction.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _chain_hmac, _chain_signature, ...envelope } = onDisk;
    const canonical = canonicalJSON(envelope);
    const expected = createHmac('sha256', this.getHmacKey())
      .update(canonical)
      .digest('base64');
    const a = Buffer.from(storedHmac, 'base64');
    const b = Buffer.from(expected, 'base64');
    // `timingSafeEqual` requires equal-length inputs; mismatched length
    // is itself a tamper signal (truncated/extended HMAC).
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ArtifactTamperedError(artifactType, artifactId);
    }
  }

  /**
   * SPEC-022-3-02: verify the producer's Ed25519 signature when both
   * endpoints are in the privileged-chain allowlist. No-op when the
   * privileged policy is undefined (non-privileged chain) OR when the
   * registry was not configured with a `trustedKeys` lookup.
   */
  private verifyPrivilegedSignature(
    artifactType: string,
    artifactId: string,
    onDisk: Record<string, unknown>,
    consumerPluginId: string,
  ): void {
    if (!this.privilegedPolicy) return;
    const producerPluginId =
      typeof onDisk.producer_plugin_id === 'string'
        ? onDisk.producer_plugin_id
        : 'unknown';
    if (!this.privilegedPolicy.isPrivileged(producerPluginId, consumerPluginId)) {
      return; // non-privileged: signature is ignored even if present.
    }
    const sig = onDisk._chain_signature;
    if (typeof sig !== 'string' || sig.length === 0) {
      throw new PrivilegedSignatureError(artifactType, artifactId, 'missing');
    }
    const pem = this.trustedKeys?.lookup(producerPluginId);
    if (!pem) {
      throw new PrivilegedSignatureError(
        artifactType,
        artifactId,
        'unknown_producer',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _chain_hmac, _chain_signature, ...envelope } = onDisk;
    const canonical = canonicalJSON(envelope);
    const ok = SignatureVerifier.verifyArtifact(canonical, sig, pem);
    if (!ok) {
      throw new PrivilegedSignatureError(artifactType, artifactId, 'invalid');
    }
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
