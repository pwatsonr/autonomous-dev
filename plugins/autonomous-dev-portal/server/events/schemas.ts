// SPEC-015-1-02 — Hand-rolled validators for PortalEvent.
//
// Mirrors the zod `safeParse` interface so a future migration is a
// drop-in change. The validators are deliberately strict on envelope
// shape (every field present, types exact) but allow unknown extra
// fields on payloads — forward compatibility lets a daemon writing a
// new payload field deliver the rest cleanly.

import {
    EVENT_PROTOCOL_VERSION,
    type CostUpdatePayload,
    type DaemonDownPayload,
    type EventType,
    type HeartbeatPayload,
    type LogLinePayload,
    type PortalEvent,
    type SafeParseResult,
    type StateChangePayload,
} from "./types";

const REQ_ID_RE = /^REQ-\d{6}$/;
const ISO_DATETIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const VALID_EVENT_TYPES: ReadonlySet<EventType> = new Set([
    "state-change",
    "cost-update",
    "heartbeat",
    "log-line",
    "daemon-down",
]);
const VALID_LEVELS = new Set(["debug", "info", "warn", "error"]);
const VALID_SOURCES = new Set(["daemon", "intake", "portal"]);

function fail(msg: string): SafeParseResult<never> {
    return { success: false, error: new Error(msg) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateEnvelope(input: Record<string, unknown>): string | null {
    if (input["v"] !== EVENT_PROTOCOL_VERSION) {
        return `envelope.v must be ${String(EVENT_PROTOCOL_VERSION)}`;
    }
    if (typeof input["id"] !== "string" || (input["id"] as string).length === 0) {
        return "envelope.id must be a non-empty string";
    }
    if (
        typeof input["seq"] !== "number" ||
        !Number.isInteger(input["seq"]) ||
        (input["seq"] as number) < 0
    ) {
        return "envelope.seq must be a non-negative integer";
    }
    if (typeof input["ts"] !== "string" || !ISO_DATETIME_RE.test(input["ts"] as string)) {
        return "envelope.ts must be an ISO 8601 datetime string";
    }
    if (!VALID_EVENT_TYPES.has(input["type"] as EventType)) {
        return `envelope.type must be one of ${Array.from(VALID_EVENT_TYPES).join(",")}`;
    }
    return null;
}

function validateStateChangePayload(p: unknown): string | null {
    if (!isPlainObject(p)) return "payload must be an object";
    if (typeof p["request_id"] !== "string" || !REQ_ID_RE.test(p["request_id"])) {
        return "payload.request_id must match REQ-NNNNNN";
    }
    if (p["old_phase"] !== null && typeof p["old_phase"] !== "string") {
        return "payload.old_phase must be string|null";
    }
    if (typeof p["new_phase"] !== "string") {
        return "payload.new_phase must be a string";
    }
    if (typeof p["repository"] !== "string") {
        return "payload.repository must be a string";
    }
    return null;
}

function validateCostUpdatePayload(p: unknown): string | null {
    if (!isPlainObject(p)) return "payload must be an object";
    if (
        p["request_id"] !== undefined &&
        (typeof p["request_id"] !== "string" || !REQ_ID_RE.test(p["request_id"]))
    ) {
        return "payload.request_id (when present) must match REQ-NNNNNN";
    }
    if (typeof p["delta_usd"] !== "number" || !Number.isFinite(p["delta_usd"])) {
        return "payload.delta_usd must be a finite number";
    }
    if (typeof p["total_usd"] !== "number" || !Number.isFinite(p["total_usd"])) {
        return "payload.total_usd must be a finite number";
    }
    return null;
}

function validateHeartbeatPayload(p: unknown): string | null {
    if (!isPlainObject(p)) return "payload must be an object";
    if (
        typeof p["server_ts"] !== "string" ||
        !ISO_DATETIME_RE.test(p["server_ts"])
    ) {
        return "payload.server_ts must be ISO datetime";
    }
    if (
        typeof p["connection_age_s"] !== "number" ||
        !Number.isInteger(p["connection_age_s"]) ||
        p["connection_age_s"] < 0
    ) {
        return "payload.connection_age_s must be a non-negative integer";
    }
    return null;
}

function validateLogLinePayload(p: unknown): string | null {
    if (!isPlainObject(p)) return "payload must be an object";
    if (typeof p["level"] !== "string" || !VALID_LEVELS.has(p["level"])) {
        return "payload.level invalid";
    }
    if (typeof p["message"] !== "string") return "payload.message must be string";
    if (typeof p["source"] !== "string" || !VALID_SOURCES.has(p["source"])) {
        return "payload.source invalid";
    }
    return null;
}

function validateDaemonDownPayload(p: unknown): string | null {
    if (!isPlainObject(p)) return "payload must be an object";
    if (
        p["last_heartbeat_ts"] !== null &&
        (typeof p["last_heartbeat_ts"] !== "string" ||
            !ISO_DATETIME_RE.test(p["last_heartbeat_ts"]))
    ) {
        return "payload.last_heartbeat_ts must be ISO datetime or null";
    }
    if (
        typeof p["stale_seconds"] !== "number" ||
        !Number.isInteger(p["stale_seconds"]) ||
        p["stale_seconds"] < 0
    ) {
        return "payload.stale_seconds must be a non-negative integer";
    }
    return null;
}

/**
 * Validate a candidate PortalEvent. Returns a `safeParse`-shaped result.
 */
export function safeParseEvent(input: unknown): SafeParseResult<PortalEvent> {
    if (!isPlainObject(input)) return fail("event must be an object");
    const envelopeError = validateEnvelope(input);
    if (envelopeError) return fail(envelopeError);
    const type = input["type"] as EventType;
    const payload = input["payload"];

    let payloadError: string | null;
    switch (type) {
        case "state-change":
            payloadError = validateStateChangePayload(payload);
            break;
        case "cost-update":
            payloadError = validateCostUpdatePayload(payload);
            break;
        case "heartbeat":
            payloadError = validateHeartbeatPayload(payload);
            break;
        case "log-line":
            payloadError = validateLogLinePayload(payload);
            break;
        case "daemon-down":
            payloadError = validateDaemonDownPayload(payload);
            break;
        default:
            return fail(`unsupported event type ${String(type)}`);
    }
    if (payloadError) return fail(`${type}: ${payloadError}`);

    return { success: true, data: input as unknown as PortalEvent };
}

// Re-export typed validator helpers for tests.
export const validatePayload = {
    "state-change": validateStateChangePayload,
    "cost-update": validateCostUpdatePayload,
    heartbeat: validateHeartbeatPayload,
    "log-line": validateLogLinePayload,
    "daemon-down": validateDaemonDownPayload,
} as const satisfies Record<
    EventType,
    (p: unknown) => string | null
>;

// Re-export per-payload type aliases so consumers do not need to dive
// into the internal types module.
export type {
    StateChangePayload,
    CostUpdatePayload,
    HeartbeatPayload,
    LogLinePayload,
    DaemonDownPayload,
};
