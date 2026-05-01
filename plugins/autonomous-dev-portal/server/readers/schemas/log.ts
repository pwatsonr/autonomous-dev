// SPEC-015-1-04 — Validator for structured log lines (JSONL).
//
// Plain-text legacy lines are NOT validated here; LogReader synthesizes
// them with `source: 'unknown'` and the original text in `raw`.

import type { LogLine, LogLevel } from "../types";

const VALID_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const VALID_SOURCES = new Set(["daemon", "intake", "portal"]);
const ISO_DATETIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const REQ_ID_RE = /^REQ-\d{6}$/;

export interface ParseResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseStructuredLogLine(input: unknown): ParseResult<LogLine> {
    if (!isPlainObject(input)) return { ok: false, error: "log line must be object" };
    if (typeof input["ts"] !== "string" || !ISO_DATETIME_RE.test(input["ts"])) {
        return { ok: false, error: "log.ts must be ISO datetime" };
    }
    if (typeof input["level"] !== "string" || !VALID_LEVELS.has(input["level"] as LogLevel)) {
        return { ok: false, error: "log.level invalid" };
    }
    if (typeof input["message"] !== "string") {
        return { ok: false, error: "log.message must be string" };
    }
    const source = input["source"] ?? "daemon";
    if (typeof source !== "string" || !VALID_SOURCES.has(source)) {
        return { ok: false, error: "log.source invalid" };
    }
    const reqId = input["request_id"];
    if (
        reqId !== undefined &&
        reqId !== null &&
        (typeof reqId !== "string" || !REQ_ID_RE.test(reqId))
    ) {
        return { ok: false, error: "log.request_id must be REQ-NNNNNN or null" };
    }
    const context = input["context"];
    if (context !== undefined && !isPlainObject(context)) {
        return { ok: false, error: "log.context must be object" };
    }
    const value: LogLine = {
        ts: input["ts"] as string,
        level: input["level"] as LogLevel,
        message: input["message"] as string,
        source: source as LogLine["source"],
    };
    if (reqId !== undefined) value.request_id = reqId as string | null;
    if (context !== undefined) value.context = context as Record<string, unknown>;
    return { ok: true, value };
}
