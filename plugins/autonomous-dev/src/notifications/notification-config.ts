/**
 * Notification config parsing and validation (SPEC-009-5-7, Task 19).
 *
 * Loads the `notifications:` YAML section and validates all fields.
 * Invalid values fall back to documented defaults.
 */

import type {
  BatchingConfig,
  CrossRequestConfig,
  DeliveryMethod,
  DndConfig,
  FatigueConfig,
  NotificationEventType,
} from './types';

// ---------------------------------------------------------------------------
// NotificationConfig interface
// ---------------------------------------------------------------------------

export interface NotificationConfig {
  default_method: DeliveryMethod;
  per_type_overrides: Partial<Record<NotificationEventType, DeliveryMethod>>;
  batching: BatchingConfig;
  dnd: DndConfig;
  fatigue: FatigueConfig;
  cross_request: CrossRequestConfig;
  daily_digest_time: string;
  daily_digest_timezone: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const VALID_DELIVERY_METHODS: ReadonlySet<string> = new Set([
  'cli',
  'discord',
  'slack',
  'file_drop',
]);

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  default_method: 'cli',
  per_type_overrides: {},
  batching: {
    flushIntervalMinutes: 60,
    maxBufferSize: 50,
    exemptTypes: ['escalation'],
  },
  dnd: {
    enabled: false,
    startTime: '22:00',
    endTime: '07:00',
    timezone: 'UTC',
  },
  fatigue: {
    enabled: false,
    thresholdPerHour: 20,
    cooldownMinutes: 30,
  },
  cross_request: {
    enabled: false,
    windowMinutes: 60,
    threshold: 3,
  },
  daily_digest_time: '09:00',
  daily_digest_timezone: 'UTC',
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Parse and validate a notification config section (typically from YAML).
 *
 * All fields fall back to documented defaults when missing or invalid.
 */
export function loadNotificationConfig(
  raw: Record<string, unknown> | undefined | null,
): NotificationConfig {
  if (!raw || typeof raw !== 'object') {
    return deepClone(DEFAULT_NOTIFICATION_CONFIG);
  }

  const config = deepClone(DEFAULT_NOTIFICATION_CONFIG);

  // default_method
  if (
    typeof raw.default_method === 'string' &&
    VALID_DELIVERY_METHODS.has(raw.default_method)
  ) {
    config.default_method = raw.default_method as DeliveryMethod;
  } else if (raw.default_method !== undefined) {
    console.warn(
      `[notification-config] Invalid default_method: "${raw.default_method}". Using default: "cli".`,
    );
  }

  // per_type_overrides
  const overrides = raw.per_type_overrides as Record<string, string> | undefined;
  if (overrides && typeof overrides === 'object') {
    for (const [eventType, method] of Object.entries(overrides)) {
      if (VALID_DELIVERY_METHODS.has(method)) {
        config.per_type_overrides[eventType as NotificationEventType] =
          method as DeliveryMethod;
      }
    }
  }

  // batching
  const batching = raw.batching as Record<string, unknown> | undefined;
  if (batching && typeof batching === 'object') {
    if (
      typeof batching.flushIntervalMinutes === 'number' &&
      batching.flushIntervalMinutes > 0
    ) {
      config.batching.flushIntervalMinutes = batching.flushIntervalMinutes;
    }
    if (
      typeof batching.maxBufferSize === 'number' &&
      batching.maxBufferSize > 0
    ) {
      config.batching.maxBufferSize = batching.maxBufferSize;
    }
    if (Array.isArray(batching.exemptTypes)) {
      config.batching.exemptTypes =
        batching.exemptTypes as NotificationEventType[];
    }
  }

  // dnd
  const dnd = raw.dnd as Record<string, unknown> | undefined;
  if (dnd && typeof dnd === 'object') {
    if (typeof dnd.enabled === 'boolean') {
      config.dnd.enabled = dnd.enabled;
    }
    if (typeof dnd.startTime === 'string' && isValidHHMM(dnd.startTime)) {
      config.dnd.startTime = dnd.startTime;
    }
    if (typeof dnd.endTime === 'string' && isValidHHMM(dnd.endTime)) {
      config.dnd.endTime = dnd.endTime;
    }
    if (typeof dnd.timezone === 'string' && dnd.timezone.length > 0) {
      config.dnd.timezone = dnd.timezone;
    }
  }

  // fatigue
  const fatigue = raw.fatigue as Record<string, unknown> | undefined;
  if (fatigue && typeof fatigue === 'object') {
    if (typeof fatigue.enabled === 'boolean') {
      config.fatigue.enabled = fatigue.enabled;
    }
    if (
      typeof fatigue.thresholdPerHour === 'number' &&
      fatigue.thresholdPerHour > 0
    ) {
      config.fatigue.thresholdPerHour = fatigue.thresholdPerHour;
    }
    if (
      typeof fatigue.cooldownMinutes === 'number' &&
      fatigue.cooldownMinutes > 0
    ) {
      config.fatigue.cooldownMinutes = fatigue.cooldownMinutes;
    }
  }

  // cross_request
  const crossRequest = raw.cross_request as Record<string, unknown> | undefined;
  if (crossRequest && typeof crossRequest === 'object') {
    if (typeof crossRequest.enabled === 'boolean') {
      config.cross_request.enabled = crossRequest.enabled;
    }
    if (
      typeof crossRequest.windowMinutes === 'number' &&
      crossRequest.windowMinutes > 0
    ) {
      config.cross_request.windowMinutes = crossRequest.windowMinutes;
    }
    if (
      typeof crossRequest.threshold === 'number' &&
      crossRequest.threshold > 0
    ) {
      config.cross_request.threshold = crossRequest.threshold;
    }
  }

  // daily_digest_time
  if (
    typeof raw.daily_digest_time === 'string' &&
    isValidHHMM(raw.daily_digest_time)
  ) {
    config.daily_digest_time = raw.daily_digest_time;
  }

  // daily_digest_timezone
  if (
    typeof raw.daily_digest_timezone === 'string' &&
    raw.daily_digest_timezone.length > 0
  ) {
    config.daily_digest_timezone = raw.daily_digest_timezone;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidHHMM(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
