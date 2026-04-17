/**
 * Trust subsystem barrel exports (SPEC-009-1-4, Task 7).
 *
 * Re-exports all public types, classes, and functions from the trust
 * subsystem. Provides a `createTrustEngine` factory for convenience wiring.
 *
 * Usage:
 *   import { TrustEngine, createTrustEngine } from './trust';
 */

// ---------------------------------------------------------------------------
// Imports (for factory function)
// ---------------------------------------------------------------------------

import { TrustEngine } from "./trust-engine";
import { TrustResolver } from "./trust-resolver";
import { TrustChangeManager } from "./trust-change-manager";
import { TrustConfigLoader } from "./trust-config";
import type { AuditTrail } from "./trust-change-manager";
import type { ConfigProvider } from "./trust-config";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { TrustEngine } from "./trust-engine";
export { TrustResolver } from "./trust-resolver";
export type { TrustResolutionContext } from "./trust-resolver";
export { TrustChangeManager } from "./trust-change-manager";
export type { AuditTrail } from "./trust-change-manager";
export { TrustConfigLoader, DEFAULT_TRUST_CONFIG } from "./trust-config";
export type { ConfigProvider } from "./trust-config";
export { lookupGateAuthority, TRUST_GATE_MATRIX } from "./gate-matrix";
export * from "./types";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-wired TrustEngine with all dependencies injected.
 *
 * This is the recommended way to instantiate a TrustEngine for production
 * use. All sub-components (resolver, change manager, config loader) are
 * created internally with the provided ConfigProvider and AuditTrail.
 *
 * @param configProvider  Abstraction over the raw config source.
 * @param auditTrail      Audit trail for recording trust decisions.
 * @returns A fully-wired TrustEngine instance.
 */
export function createTrustEngine(
  configProvider: ConfigProvider,
  auditTrail: AuditTrail,
): TrustEngine {
  const configLoader = new TrustConfigLoader(configProvider);
  const resolver = new TrustResolver();
  const changeManager = new TrustChangeManager(auditTrail);
  return new TrustEngine(resolver, changeManager, configLoader, auditTrail);
}
