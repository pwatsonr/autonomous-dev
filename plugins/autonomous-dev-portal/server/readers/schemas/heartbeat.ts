// SPEC-015-1-04 — Validator for heartbeat.json.

import type { Heartbeat } from "../types";

const ISO_DATETIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export interface ParseResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseHeartbeat(input: unknown): ParseResult<Heartbeat> {
    if (!isPlainObject(input)) return { ok: false, error: "heartbeat must be object" };
    if (input["version"] !== 1) return { ok: false, error: "heartbeat.version must be 1" };
    if (typeof input["ts"] !== "string" || !ISO_DATETIME_RE.test(input["ts"])) {
        return { ok: false, error: "heartbeat.ts must be ISO datetime" };
    }
    if (
        typeof input["pid"] !== "number" ||
        !Number.isInteger(input["pid"]) ||
        (input["pid"] as number) <= 0
    ) {
        return { ok: false, error: "heartbeat.pid must be a positive integer" };
    }
    if (
        typeof input["uptime_s"] !== "number" ||
        !Number.isInteger(input["uptime_s"]) ||
        (input["uptime_s"] as number) < 0
    ) {
        return { ok: false, error: "heartbeat.uptime_s must be non-negative integer" };
    }
    if (typeof input["daemon_version"] !== "string") {
        return { ok: false, error: "heartbeat.daemon_version must be string" };
    }
    const active = input["active_requests"] ?? 0;
    if (
        typeof active !== "number" ||
        !Number.isInteger(active) ||
        (active as number) < 0
    ) {
        return { ok: false, error: "heartbeat.active_requests must be non-negative integer" };
    }
    const value: Heartbeat = {
        version: 1,
        ts: input["ts"] as string,
        pid: input["pid"] as number,
        uptime_s: input["uptime_s"] as number,
        daemon_version: input["daemon_version"] as string,
        active_requests: active as number,
    };
    return { ok: true, value };
}
