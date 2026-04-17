/**
 * Notification module barrel exports (SPEC-009-5-7, Task 20).
 */

export { NotificationFramework } from './notification-framework';
export { DeliveryManager } from './delivery-manager';
export { NotificationBatcher } from './batcher';
export type { Timer, TimerHandle } from './batcher';
export { DndFilter } from './dnd-filter';
export type { Clock } from './dnd-filter';
export { FatigueDetector } from './fatigue-detector';
export type { FatigueState, FatigueRecordResult } from './fatigue-detector';
export { SystemicFailureDetector } from './systemic-failure-detector';
export type {
  AuditTrail,
  FailureRecord,
  SystemicDetectionResult,
  SystemicPattern,
} from './systemic-failure-detector';
export { CliDeliveryAdapter } from './adapters/cli-adapter';
export { DiscordDeliveryAdapter } from './adapters/discord-adapter';
export { SlackDeliveryAdapter } from './adapters/slack-adapter';
export { FileDropDeliveryAdapter } from './adapters/file-drop-adapter';
export { loadNotificationConfig } from './notification-config';
export type { NotificationConfig } from './notification-config';
export * from './types';

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

import type { NotificationConfig } from './notification-config';
import type { AuditTrail } from './systemic-failure-detector';
import type { Timer } from './batcher';
import { DndFilter } from './dnd-filter';
import { FatigueDetector } from './fatigue-detector';
import { SystemicFailureDetector } from './systemic-failure-detector';
import { NotificationBatcher } from './batcher';
import { DeliveryManager } from './delivery-manager';
import { CliDeliveryAdapter } from './adapters/cli-adapter';
import { NotificationFramework } from './notification-framework';
import type { DeliveryAdapter, DeliveryMethod } from './types';

/**
 * Create a fully-wired NotificationFramework from config.
 *
 * Instantiates all dependencies and connects them:
 *   - DndFilter with DND config
 *   - FatigueDetector with fatigue config
 *   - SystemicFailureDetector with cross-request config
 *   - DeliveryManager with CLI adapter (default)
 *   - NotificationBatcher with batching config
 *   - NotificationFramework composing all of the above
 */
export function createNotificationFramework(
  config: NotificationConfig,
  auditTrail: AuditTrail,
  timer: Timer,
): NotificationFramework {
  const clock = { now: () => new Date() };

  const dndFilter = new DndFilter(config.dnd, clock);
  const fatigueDetector = new FatigueDetector(config.fatigue, clock);
  const systemicDetector = new SystemicFailureDetector(
    config.cross_request,
    auditTrail,
    clock,
  );

  // Build adapter map with at least CLI
  const adapters = new Map<DeliveryMethod, DeliveryAdapter>();
  adapters.set('cli', new CliDeliveryAdapter());

  const deliveryManager = new DeliveryManager(
    adapters,
    config.default_method,
    new Map(
      Object.entries(config.per_type_overrides) as Array<
        [string, DeliveryMethod]
      >,
    ) as Map<import('./types').NotificationEventType, DeliveryMethod>,
    () => {
      console.error(
        '[NotificationFramework] All delivery methods failed. Pipeline should be paused.',
      );
    },
  );

  const batcher = new NotificationBatcher(
    config.batching,
    deliveryManager,
    timer,
  );

  return new NotificationFramework(
    dndFilter,
    fatigueDetector,
    batcher,
    deliveryManager,
    systemicDetector,
    config,
    timer,
  );
}
