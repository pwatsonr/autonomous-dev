import type {
  DeliveryAdapter,
  DeliveryMethod,
  DeliveryResult,
  NotificationEventType,
  NotificationPayload,
} from './types';

/**
 * Fallback chain order after the configured method:
 *   configured -> cli -> file_drop -> pipeline pause
 *
 * Per-type overrides allow routing specific event types to specific adapters
 * (e.g., escalations to Slack, pipeline completions to Discord). If the
 * per-type adapter fails, the same fallback chain applies.
 */
const FALLBACK_CHAIN: readonly DeliveryMethod[] = ['cli', 'file_drop'] as const;

/**
 * Orchestrates notification delivery with a fallback chain.
 *
 * Delivery order:
 *   1. Per-type override (if configured), else default method
 *   2. CLI fallback (unless CLI was the configured method)
 *   3. file_drop fallback (unless file_drop was the configured method)
 *   4. If all fail, invoke `onAllFailed` callback to pause the pipeline (NFR-10)
 */
export class DeliveryManager {
  constructor(
    private adapters: Map<DeliveryMethod, DeliveryAdapter>,
    private defaultMethod: DeliveryMethod,
    private perTypeOverrides: Map<NotificationEventType, DeliveryMethod>,
    private onAllFailed: () => void,
  ) {}

  /**
   * Deliver a single notification through the fallback chain.
   */
  deliver(payload: NotificationPayload): DeliveryResult {
    const method = this.perTypeOverrides.get(payload.event_type) ?? this.defaultMethod;
    return this.deliverWithFallback(method, (adapter) => adapter.deliver(payload));
  }

  /**
   * Deliver a batch of notifications through the fallback chain.
   */
  deliverBatch(payloads: NotificationPayload[]): DeliveryResult {
    if (payloads.length === 0) {
      return {
        success: true,
        method: this.defaultMethod,
        formattedOutput: '',
      };
    }

    // Use the first payload's event type to determine the configured method
    const method = this.perTypeOverrides.get(payloads[0].event_type) ?? this.defaultMethod;
    return this.deliverWithFallback(method, (adapter) => adapter.deliverBatch(payloads));
  }

  /**
   * Attempt delivery via the configured method, then walk the fallback chain.
   */
  private deliverWithFallback(
    configuredMethod: DeliveryMethod,
    attempt: (adapter: DeliveryAdapter) => DeliveryResult,
  ): DeliveryResult {
    // Step 1: Try configured method
    const configuredAdapter = this.adapters.get(configuredMethod);
    if (configuredAdapter) {
      const result = attempt(configuredAdapter);
      if (result.success) return result;
    }

    // Step 2-3: Walk the fallback chain, skipping the configured method
    for (const fallbackMethod of FALLBACK_CHAIN) {
      if (fallbackMethod === configuredMethod) continue;

      const fallbackAdapter = this.adapters.get(fallbackMethod);
      if (fallbackAdapter) {
        const result = attempt(fallbackAdapter);
        if (result.success) return result;
      }
    }

    // Step 4: All delivery methods failed -- signal pipeline to pause (NFR-10)
    this.onAllFailed();
    return {
      success: false,
      method: configuredMethod,
      formattedOutput: '',
      error: 'All delivery methods failed',
    };
  }
}
