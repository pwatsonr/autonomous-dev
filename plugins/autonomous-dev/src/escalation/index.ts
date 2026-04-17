/**
 * Escalation subsystem barrel exports (SPEC-009-2-4, Task 8).
 *
 * Re-exports all public types, classes, and functions from the escalation
 * subsystem. Provides a `createEscalationEngine` factory for convenience
 * wiring.
 *
 * Usage:
 *   import { EscalationEngine, createEscalationEngine } from './escalation';
 */

// ---------------------------------------------------------------------------
// Imports (for factory function)
// ---------------------------------------------------------------------------

import { EscalationEngine } from "./escalation-engine";
import { EscalationClassifier } from "./classifier";
import { EscalationFormatter, EscalationIdGenerator } from "./formatter";
import { RoutingEngine } from "./routing-engine";
import { EscalationChainManager } from "./chain-manager";
import { EscalationConfigLoader } from "./escalation-config";
import type {
  AuditTrail,
  ConfigProvider,
  DeliveryAdapter,
  Timer,
} from "./types";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { EscalationEngine, resolvePipelineBehavior } from "./escalation-engine";
export { EscalationClassifier } from "./classifier";
export type { FailureContext, ClassificationResult } from "./classifier";
export { EscalationFormatter, EscalationIdGenerator } from "./formatter";
export { redactSecrets, sanitizePath, generateSummary } from "./formatter";
export { RoutingEngine } from "./routing-engine";
export { EscalationChainManager } from "./chain-manager";
export type { TimeoutBehaviorResult } from "./chain-manager";
export { EscalationConfigLoader } from "./escalation-config";
export * from "./types";
export * from "./response-types";
export { ResponseParser } from "./response-parser";
export { ResponseValidator } from "./response-validator";
export type { EscalationStore, StoredEscalation, KillSwitchQuery } from "./response-validator";
export { ActionResolver } from "./action-resolver";
export { PipelineResumptionCoordinator } from "./pipeline-resumption";
export type { PipelineExecutor, ResumeResult } from "./pipeline-resumption";
export { ReEscalationManager } from "./re-escalation-manager";
export type { GuidanceAttempt, ReEscalationChain } from "./re-escalation-manager";
export { HumanResponseHandler } from "./human-response-handler";
export type { HandleResult } from "./human-response-handler";
export {
  getGateApprovalTemplate,
  getCustomTemplate,
} from "./gate-approval-templates";
export type {
  GateTemplateType,
  GateTemplateConfig,
} from "./gate-approval-templates";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-wired EscalationEngine with all dependencies injected.
 *
 * This is the recommended way to instantiate an EscalationEngine for
 * production use. All sub-components (classifier, formatter, routing engine,
 * chain manager, config loader) are created internally.
 *
 * @param configProvider   Abstraction over the raw config source.
 * @param deliveryAdapter  Sends escalation messages to human targets.
 * @param auditTrail       Records escalation events for compliance.
 * @param timer            Injectable timer for timeout management.
 * @param statePath        Path to the state directory for counter persistence.
 * @returns A fully-wired EscalationEngine instance.
 */
export function createEscalationEngine(
  configProvider: ConfigProvider,
  deliveryAdapter: DeliveryAdapter,
  auditTrail: AuditTrail,
  timer: Timer,
  statePath: string,
): EscalationEngine {
  // Load and validate config
  const configLoader = new EscalationConfigLoader(configProvider);
  const config = configLoader.load();

  // Create sub-components
  const classifier = new EscalationClassifier();
  const idGenerator = new EscalationIdGenerator(statePath);
  const formatter = new EscalationFormatter(idGenerator, config.verbosity);
  const routingEngine = new RoutingEngine(config);
  const chainManager = new EscalationChainManager(timer, deliveryAdapter, auditTrail);

  return new EscalationEngine(
    classifier,
    formatter,
    routingEngine,
    chainManager,
    auditTrail,
  );
}
