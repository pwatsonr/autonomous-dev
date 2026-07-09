/**
 * Environment / node-to-node promotion (issue #663).
 *
 * ## What promotion is
 *
 * Promotion deploys an ALREADY-BUILT artifact (same image / same digest — no
 * rebuild) to a NEW target / environment.  The source deployment supplies both
 * the `artifactRef` and an optional checksum.  If the caller supplies a
 * `checksumExpected` and it does not match `artifactRef.checksum` the
 * operation is aborted with `PromotionChecksumError` before any mutation.
 *
 * ## Lineage
 *
 * Every completed promotion (dry-run excluded) appends a `PromotionRecord` to
 * the in-process lineage store, queryable via `getPromotionLineage()`.  The
 * store is a simple in-memory array; callers that need persistence (portal,
 * daemon) can read it and serialize externally.
 *
 * ## Policy + pipeline
 *
 * Policy for the DESTINATION target is evaluated by the existing
 * `runPipeline()` call (via `policy-check` stage).  The build stage is
 * SKIPPED by the pipeline because the artifact is pre-built (the backend
 * receives it via `artifact.meta.promotedFrom`).  Deploy, health-verify, and
 * rollback all run normally.
 *
 * ## Dry-run safety
 *
 * `dryRun: true` (the default) emits planned stage events and records the
 * would-be promotion in the result WITHOUT appending a lineage entry and
 * WITHOUT calling any backend method.
 *
 * ## Invariant #674
 *
 * Target resolution is always by id or by attributes (kind/env/tag/capability)
 * — never by hard-coded instance name.  The `fromTarget` and `toTarget` fields
 * are fully-resolved `DeployTarget` objects that the caller obtains from
 * `resolveTarget()`.
 *
 * Cross-reference: issues #663, #662, #668, #674.
 *
 * @module intake/deploy/promotion
 */

import { generateUlid } from './id';
import { runPipeline } from './pipeline-runner';
import type { PipelineRunResult, StageEvent } from './pipeline-runner';
import type { PipelineBackend } from './backend-types';
import type { DeployTarget } from './target-types';
import type { PolicyDocument } from './policy-types';

// ---------------------------------------------------------------------------
// Artifact reference
// ---------------------------------------------------------------------------

/**
 * Reference to a pre-built artifact being promoted.
 *
 * The `ref` string is whatever the deployment platform uses (docker image:tag,
 * OCI digest, S3 URI, git SHA, …). `checksum` is the SHA-256 hex digest of
 * the artifact's canonical representation as recorded by the build backend;
 * when present it is used for an integrity guard before any mutation.
 */
export interface ArtifactRef {
  /**
   * The artifact name / identifier — e.g. `'my-api:1.2.3'`,
   * `'sha256:abc…'`, or a ULID from the artifact store.
   */
  ref: string;

  /**
   * Optional SHA-256 hex checksum of the artifact.  When supplied, the
   * promote() function validates it before proceeding.
   */
  checksum?: string;

  /** Backend-specific metadata (e.g., registry URL, OCI digest, chart path). */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Promotion record (lineage)
// ---------------------------------------------------------------------------

/**
 * Immutable record of a completed promotion.
 *
 * Appended to the in-process lineage store after each successful (non-dry-run)
 * `promote()` call.  Queryable via `getPromotionLineage()`.
 */
export interface PromotionRecord {
  /** ULID — unique identifier for this promotion event. */
  promotionId: string;

  /** The service that was promoted. */
  service: string;

  /** The artifact that was re-deployed (no rebuild). */
  artifactRef: ArtifactRef;

  /** The pipeline-runner run-id from the promotion deploy. */
  pipelineRunId: string;

  /** Source target id (where the artifact came FROM). */
  fromTargetId: string;

  /** Destination target id (where the artifact was promoted TO). */
  toTargetId: string;

  /**
   * Identity of who triggered the promotion.
   * Defaults to `'system'` when not supplied by the caller.
   */
  promotedBy: string;

  /** ISO-8601 timestamp of when the promotion completed. */
  promotedAt: string;

  /** Overall pipeline status of the promotion run. */
  pipelineStatus: string;
}

// ---------------------------------------------------------------------------
// Promotion options
// ---------------------------------------------------------------------------

/**
 * Options for `promote()`.
 */
export interface PromoteOptions {
  /** Service name being promoted. */
  service: string;

  /**
   * The already-built artifact to re-deploy.  No build stage will run;
   * `artifactRef.ref` is passed as the image/artifact name to the pipeline.
   */
  artifactRef: ArtifactRef;

  /**
   * The source (FROM) target.  Present only for lineage — the artifact is NOT
   * re-fetched from this target; it must already be accessible from `toTarget`.
   */
  fromTarget: DeployTarget;

  /**
   * The destination (TO) target.  Policy for this target is enforced before
   * any mutation.
   */
  toTarget: DeployTarget;

  /**
   * Expected SHA-256 checksum for the artifact integrity guard.
   * When supplied, `promote()` aborts with `PromotionChecksumError` if
   * `artifactRef.checksum` does not match.  Omit when the caller has not
   * stored a checksum.
   */
  checksumExpected?: string;

  /**
   * Identity of who initiated this promotion.
   * Defaults to `'system'` when absent.
   */
  promotedBy?: string;

  /**
   * Policy document for the DESTINATION target.  Defaults to `EMPTY_POLICY`
   * (allow-all) when absent.
   */
  policy?: PolicyDocument;

  /**
   * Optional policy evaluation context.
   */
  policyContext?: {
    now?: number;
    currentCounts?: Record<string, number>;
    affectedTargets?: number;
    colocatedServices?: string[];
    [key: string]: unknown;
  };

  /**
   * When `true` (default-safe), emits planned stage events and returns
   * without running any backend method or appending a lineage record.
   */
  dryRun?: boolean;

  /**
   * Explicit apply flag required to run a real promotion.
   * When neither `dryRun` is `false` nor `confirm` is `true`, the call
   * errors with `PromotionConfirmRequiredError`.
   */
  confirm?: boolean;

  /**
   * Optional callback receiving structured stage events from the pipeline.
   */
  onStageEvent?: (event: StageEvent) => void;

  /**
   * Injected clock for the lineage timestamp (ISO-8601).
   * Defaults to `new Date().toISOString()`.  Injected so tests are deterministic.
   */
  _nowIso?: () => string;

  /**
   * TEST ONLY — override the backend dispatched by `runPipeline`.
   */
  _backendOverride?: PipelineBackend;
}

// ---------------------------------------------------------------------------
// Promote result
// ---------------------------------------------------------------------------

/**
 * Result of a `promote()` call.
 */
export interface PromoteResult {
  /** The promotion record (lineage entry).  `null` when `dryRun: true`. */
  record: PromotionRecord | null;

  /** Full pipeline run result from the promotion deploy. */
  pipelineResult: PipelineRunResult;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the caller supplies a `checksumExpected` that does not match
 * `artifactRef.checksum`.
 *
 * The promotion is aborted before any backend method is called.
 */
export class PromotionChecksumError extends Error {
  public readonly expected: string;
  public readonly actual: string | undefined;

  constructor(expected: string, actual: string | undefined) {
    super(
      `Artifact integrity check failed during promotion: ` +
        `expected checksum '${expected}' but artifact has '${actual ?? '(none)'}'. ` +
        `Promotion aborted — do not promote an artifact whose checksum cannot be verified.`,
    );
    this.name = 'PromotionChecksumError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown when `promote()` is called without an explicit `confirm: true` flag
 * (and `dryRun` is not `true`).
 *
 * Prevents accidental promotions — callers must opt in explicitly.
 */
export class PromotionConfirmRequiredError extends Error {
  constructor() {
    super(
      `promote(): refusing to execute a real promotion without { confirm: true }. ` +
        `Pass { dryRun: true } to preview, or { confirm: true } to apply.`,
    );
    this.name = 'PromotionConfirmRequiredError';
  }
}

// ---------------------------------------------------------------------------
// In-process lineage store
// ---------------------------------------------------------------------------

/**
 * Module-level in-process lineage store.
 *
 * Appended to by every successful (non-dry-run) `promote()` call.
 * Readable via `getPromotionLineage()`.  Call `resetPromotionLineage()` in
 * tests (`afterEach`) to isolate entries.
 */
const lineageStore: PromotionRecord[] = [];

/**
 * Return a copy of the current in-process promotion lineage.
 *
 * Returns all promotion records in chronological order.  An empty array is
 * returned when no promotions have been recorded.
 *
 * @returns Snapshot of all recorded `PromotionRecord` entries.
 */
export function getPromotionLineage(): PromotionRecord[] {
  return [...lineageStore];
}

/**
 * Query promotion lineage by service and/or target.
 *
 * All supplied filter fields are ANDed.  Omit a field to match any value.
 *
 * @param filter - Optional filter criteria.
 * @returns Matching records in chronological order.
 */
export function queryPromotionLineage(filter: {
  service?: string;
  fromTargetId?: string;
  toTargetId?: string;
}): PromotionRecord[] {
  return lineageStore.filter((r) => {
    if (filter.service !== undefined && r.service !== filter.service) return false;
    if (filter.fromTargetId !== undefined && r.fromTargetId !== filter.fromTargetId) return false;
    if (filter.toTargetId !== undefined && r.toTargetId !== filter.toTargetId) return false;
    return true;
  });
}

/**
 * TEST ONLY — clear all recorded promotion lineage entries.
 *
 * Call in `afterEach` to isolate test registrations.  Production code must
 * not call this.
 */
export function resetPromotionLineage(): void {
  lineageStore.length = 0;
}

// ---------------------------------------------------------------------------
// promote()
// ---------------------------------------------------------------------------

/**
 * Promote a pre-built artifact to a new target without rebuilding.
 *
 * ## Execution sequence
 *
 * 1. **Checksum guard** (before any mutation): if `checksumExpected` is
 *    supplied and does not equal `artifactRef.checksum`, throw
 *    `PromotionChecksumError`.
 * 2. **Confirm guard**: if neither `dryRun: true` nor `confirm: true` is set,
 *    throw `PromotionConfirmRequiredError`.
 * 3. **Policy + pipeline**: call `runPipeline()` targeting `toTarget`.  The
 *    artifact is passed through as-is (no build stage — the backend receives
 *    the pre-built ref).  Push, deploy, health-verify, and rollback stages run
 *    normally per the backend's contract.
 * 4. **Lineage**: on completion (non-dry-run), append a `PromotionRecord` to
 *    the in-process lineage store.
 *
 * @param opts - Promotion options.
 * @returns `PromoteResult` with the lineage record and full pipeline result.
 * @throws `PromotionChecksumError`        when checksum validation fails.
 * @throws `PromotionConfirmRequiredError`  when neither dry-run nor confirm.
 */
export async function promote(opts: PromoteOptions): Promise<PromoteResult> {
  // 1. Checksum guard (pure, before any I/O).
  if (opts.checksumExpected !== undefined) {
    const actual = opts.artifactRef.checksum;
    if (actual !== opts.checksumExpected) {
      throw new PromotionChecksumError(opts.checksumExpected, actual);
    }
  }

  const dryRun = opts.dryRun === true;

  // 2. Confirm guard (prevent accidental promotion).
  if (!dryRun && opts.confirm !== true) {
    throw new PromotionConfirmRequiredError();
  }

  const nowIso = opts._nowIso ?? (() => new Date().toISOString());

  // 3. Run the pipeline for the DESTINATION target.
  // The artifact is passed as-is — no build stage will run because the
  // artifact is already built.  The pipeline context carries the pre-built
  // ref in artifact.name so the backend can deploy it directly.
  // We tag the artifact meta with `promotedFrom` so the backend knows this
  // is a promotion, not a fresh build.
  const promotionMeta: Record<string, unknown> = {
    ...(opts.artifactRef.meta ?? {}),
    promotedFrom: opts.fromTarget.id,
    promotedRef: opts.artifactRef.ref,
    isPromotion: true,
  };

  const pipelineResult = await runPipeline({
    target: opts.toTarget,
    service: opts.service,
    artifact: {
      name: opts.artifactRef.ref,
      tag: opts.artifactRef.ref,
      meta: promotionMeta,
    },
    policy: opts.policy,
    policyContext: opts.policyContext,
    dryRun,
    onStageEvent: opts.onStageEvent,
    _backendOverride: opts._backendOverride,
  });

  // 4. Lineage record — only for real (non-dry-run) runs.
  let record: PromotionRecord | null = null;

  if (!dryRun) {
    record = {
      promotionId: generateUlid(),
      service: opts.service,
      artifactRef: opts.artifactRef,
      pipelineRunId: pipelineResult.runId,
      fromTargetId: opts.fromTarget.id,
      toTargetId: opts.toTarget.id,
      promotedBy: opts.promotedBy ?? 'system',
      promotedAt: nowIso(),
      pipelineStatus: pipelineResult.status,
    };
    lineageStore.push(record);
  }

  return { record, pipelineResult };
}
