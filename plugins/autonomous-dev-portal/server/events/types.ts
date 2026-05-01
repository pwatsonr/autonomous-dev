// SPEC-015-1-02 — Typed event protocol for the SSE bus.
//
// The portal does not pull in `zod` (lean dependency policy from
// PLAN-013-2). Schemas are expressed as plain TS interfaces; runtime
// validation is hand-rolled in ./schemas.ts. The shape of the validators
// (a `safeParse(input)` returning `{ success, data | error }`) mirrors
// zod intentionally so a future migration to zod is a drop-in change.

export const EVENT_PROTOCOL_VERSION = 1 as const;

export type EventType =
    | "state-change"
    | "cost-update"
    | "heartbeat"
    | "log-line"
    | "daemon-down";

export interface EventEnvelope {
    /** Schema version. Currently 1. */
    v: 1;
    /** Stable event id (ULID-like). Used for `id:` SSE field. */
    id: string;
    /** Monotonic, bus-wide sequence number. */
    seq: number;
    /** Server-side emit timestamp (ISO 8601). */
    ts: string;
    type: EventType;
}

export interface StateChangePayload {
    request_id: string;
    old_phase: string | null;
    new_phase: string;
    repository: string;
}

export interface CostUpdatePayload {
    request_id?: string;
    delta_usd: number;
    total_usd: number;
}

export interface HeartbeatPayload {
    server_ts: string;
    connection_age_s: number;
}

export interface LogLinePayload {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    source: "daemon" | "intake" | "portal";
}

export interface DaemonDownPayload {
    last_heartbeat_ts: string | null;
    stale_seconds: number;
}

export type StateChangeEvent = EventEnvelope & {
    type: "state-change";
    payload: StateChangePayload;
};
export type CostUpdateEvent = EventEnvelope & {
    type: "cost-update";
    payload: CostUpdatePayload;
};
export type HeartbeatEvent = EventEnvelope & {
    type: "heartbeat";
    payload: HeartbeatPayload;
};
export type LogLineEvent = EventEnvelope & {
    type: "log-line";
    payload: LogLinePayload;
};
export type DaemonDownEvent = EventEnvelope & {
    type: "daemon-down";
    payload: DaemonDownPayload;
};

export type PortalEvent =
    | StateChangeEvent
    | CostUpdateEvent
    | HeartbeatEvent
    | LogLineEvent
    | DaemonDownEvent;

/** Input to broadcast() — caller supplies type+payload only. */
export type BroadcastInput =
    | { type: "state-change"; payload: StateChangePayload }
    | { type: "cost-update"; payload: CostUpdatePayload }
    | { type: "heartbeat"; payload: HeartbeatPayload }
    | { type: "log-line"; payload: LogLinePayload }
    | { type: "daemon-down"; payload: DaemonDownPayload };

export interface SafeParseResult<T> {
    success: boolean;
    data?: T;
    error?: Error;
}
