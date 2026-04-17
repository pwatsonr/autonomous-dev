export type NotificationEventType =
  | "escalation"
  | "gate_approval_needed"
  | "pipeline_completed"
  | "pipeline_failed"
  | "trust_level_changed"
  | "kill_switch_activated"
  | "systemic_issue";

export type NotificationUrgency = "immediate" | "soon" | "informational";

export type DeliveryMethod = "cli" | "discord" | "slack" | "file_drop";

export interface NotificationPayload {
  notification_id: string;           // UUID v4
  event_type: NotificationEventType;
  urgency: NotificationUrgency;
  timestamp: string;                 // ISO 8601
  request_id: string;
  repository: string;
  title: string;                     // Short summary (< 100 chars)
  body: string;                      // Detailed content
  metadata?: Record<string, unknown>;
}

export interface DeliveryAdapter {
  readonly method: DeliveryMethod;

  // Deliver a single notification. Returns formatted output.
  deliver(payload: NotificationPayload): DeliveryResult;

  // Deliver a batch of notifications. Returns formatted output.
  deliverBatch(payloads: NotificationPayload[]): DeliveryResult;
}

export interface DeliveryResult {
  success: boolean;
  method: DeliveryMethod;
  formattedOutput: string | object;  // String for CLI, object for JSON-based adapters
  error?: string;
}

export interface BatchingConfig {
  flushIntervalMinutes: number;      // Default: 60
  maxBufferSize: number;             // Default: 50
  exemptTypes: NotificationEventType[];  // Default: ["escalation", "error"]
}

export interface DndConfig {
  enabled: boolean;
  startTime: string;                 // HH:MM format (24h)
  endTime: string;                   // HH:MM format (24h)
  timezone: string;                  // IANA timezone (e.g., "America/New_York")
}

export interface FatigueConfig {
  enabled: boolean;
  thresholdPerHour: number;          // Default: 20
  cooldownMinutes: number;           // Default: 30
}

export interface CrossRequestConfig {
  enabled: boolean;
  windowMinutes: number;             // Default: 60
  threshold: number;                 // Default: 3
}
