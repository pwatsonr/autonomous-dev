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
    if (typeof input["timestamp"] !== "string" || !ISO_DATETIME_RE.test(input["timestamp"])) {
        return { ok: false, error: "heartbeat.timestamp must be ISO datetime" };
    }
    if (
        typeof input["pid"] !== "number" ||
        !Number.isInteger(input["pid"]) ||
        (input["pid"] as number) <= 0
    ) {
        return { ok: false, error: "heartbeat.pid must be a positive integer" };
    }
    if (
        typeof input["iteration_count"] !== "number" ||
        !Number.isInteger(input["iteration_count"]) ||
        (input["iteration_count"] as number) < 0
    ) {
        return { ok: false, error: "heartbeat.iteration_count must be non-negative integer" };
    }
    const activeRequestId = input["active_request_id"];
    if (activeRequestId !== null && typeof activeRequestId !== "string") {
        return { ok: false, error: "heartbeat.active_request_id must be string or null" };
    }
    const value: Heartbeat = {
        timestamp: input["timestamp"] as string,
        pid: input["pid"] as number,
        iteration_count: input["iteration_count"] as number,
        active_request_id: activeRequestId as string | null,
    };
    return { ok: true, value };
}
