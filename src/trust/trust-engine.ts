/**
 * TrustEngine Facade (SPEC-009-1-4, Task 5).
 *
 * Orchestrates the TrustResolver, TrustChangeManager, gate matrix, and
 * audit trail into a single entry point for pipeline gate checks.
 *
 * The facade exposes three methods:
 *   - checkGate(): resolve level, apply pending changes, look up authority
 *   - requestTrustChange(): delegate to change manager
 *   - getEffectiveLevel(): resolve level without gate check
 *
 * Defense-in-depth: security_review gets a triple-layer guarantee:
 *   1. TRUST_GATE_MATRIX encodes "human" for all security_review cells.
 *   2. lookupGateAuthority() enforces "human" programmatically.
 *   3. checkGate() enforces "human" as a final catch-all.
 */

import type {
  PipelineGate,
  GateAuthority,
  GateCheckResult,
  TrustLevel,
  TrustLevelChangeRequest,
} from "./types";
import type { TrustResolutionContext } from "./trust-resolver";
import type { TrustResolver } from "./trust-resolver";
import type { TrustChangeManager } from "./trust-change-manager";
import type { TrustConfigLoader } from "./trust-config";
import type { AuditTrail } from "./trust-change-manager";
import * as gateMatrix from "./gate-matrix";

// ---------------------------------------------------------------------------
// TrustEngine
// ---------------------------------------------------------------------------

/**
 * Facade that combines trust resolution, gate matrix lookup, pending change
 * application, and audit trail emission into a single `checkGate()` call.
 *
 * All dependencies are constructor-injected -- no hard-coded singletons.
 */
export class TrustEngine {
  constructor(
    private readonly resolver: TrustResolver,
    private readonly changeManager: TrustChangeManager,
    private readonly configLoader: TrustConfigLoader,
    private readonly auditTrail: AuditTrail,
  ) {}

  /**
   * Check a pipeline gate for the given context.
   *
   * Algorithm (matches TDD Section 5 pseudocode):
   *   1. Load current trust config via configLoader.
   *   2. Resolve base trust level via resolver.
   *   3. Apply any pending change at this gate boundary via changeManager.
   *   4. Look up the gate authority from the matrix.
   *   5. Defense-in-depth: if security_review and authority !== "human",
   *      override to "human" and emit security_override_rejected audit event.
   *   6. Emit gate_decision audit event.
   *   7. Return the GateCheckResult.
   */
  checkGate(
    gate: PipelineGate,
    context: TrustResolutionContext,
  ): GateCheckResult {
    // Step 1: Load config
    const config = this.configLoader.load();

    // Step 2: Resolve base level
    const baseLevel = this.resolver.resolve(context, config);

    // Step 3: Apply pending change at gate boundary
    const effectiveLevel = this.changeManager.resolveAtGateBoundary(
      context.requestId,
      baseLevel,
    );

    // Track whether a pending change was applied
    const pendingChangeApplied = effectiveLevel !== baseLevel;

    // Step 4: Look up gate authority
    let authority: GateAuthority = gateMatrix.lookupGateAuthority(effectiveLevel, gate);

    // Step 5: Defense-in-depth -- security_review is always human
    let securityOverrideRejected = false;
    if (gate === "security_review" && authority !== "human") {
      this.auditTrail.append({
        event_type: "security_override_rejected",
        payload: {
          gate,
          attemptedAuthority: authority,
          effectiveLevel,
          requestId: context.requestId,
        },
      });
      authority = "human";
      securityOverrideRejected = true;
    }

    // Step 6: Emit gate_decision audit event
    this.auditTrail.append({
      event_type: "gate_decision",
      payload: {
        gate,
        authority,
        effectiveLevel,
        requestId: context.requestId,
        pendingChangeApplied,
        securityOverrideRejected,
      },
    });

    // Step 7: Return result
    return {
      gate,
      authority,
      effectiveLevel,
      pendingChangeApplied,
      securityOverrideRejected,
    };
  }

  /**
   * Request a trust level change. Delegates to the change manager.
   *
   * The change will be applied at the next gate boundary for the given
   * request ID (downgrades are immediate; upgrades require confirmation).
   */
  requestTrustChange(change: TrustLevelChangeRequest): void {
    this.changeManager.requestChange(change.requestId, change);
  }

  /**
   * Resolve the effective trust level for a context without performing
   * a gate check. Does not emit gate_decision audit events.
   *
   * This applies pending changes at the gate boundary, so it has the
   * same level-resolution semantics as checkGate minus the authority lookup.
   */
  getEffectiveLevel(context: TrustResolutionContext): TrustLevel {
    const config = this.configLoader.load();
    const baseLevel = this.resolver.resolve(context, config);
    return this.changeManager.resolveAtGateBoundary(
      context.requestId,
      baseLevel,
    );
  }
}
