// SPEC-015-1-04 — Validators for cost-ledger.json.

import type { CostEntry, CostLedger } from "../types";

const REQ_ID_RE = /^REQ-\d{6}$/;
const ISO_DATETIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_REASONS = new Set([
    "session_completion",
    "session_failure",
    "manual_adjustment",
]);

export interface ParseResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseCostEntry(input: unknown): ParseResult<CostEntry> {
    if (!isPlainObject(input)) return { ok: false, error: "entry must be object" };
    if (typeof input["ts"] !== "string" || !ISO_DATETIME_RE.test(input["ts"])) {
        return { ok: false, error: "entry.ts must be ISO datetime" };
    }
    const reqId = input["request_id"];
    if (reqId !== null && (typeof reqId !== "string" || !REQ_ID_RE.test(reqId))) {
        return { ok: false, error: "entry.request_id must be REQ-NNNNNN or null" };
    }
    const phase = input["phase"];
    if (phase !== null && typeof phase !== "string") {
        return { ok: false, error: "entry.phase must be string or null" };
    }
    if (typeof input["delta_usd"] !== "number" || !Number.isFinite(input["delta_usd"])) {
        return { ok: false, error: "entry.delta_usd must be a finite number" };
    }
    const reason = input["reason"] ?? "session_completion";
    if (typeof reason !== "string" || !VALID_REASONS.has(reason)) {
        return { ok: false, error: "entry.reason invalid" };
    }
    const sessionId = input["session_id"];
    if (
        sessionId !== undefined &&
        sessionId !== null &&
        typeof sessionId !== "string"
    ) {
        return { ok: false, error: "entry.session_id must be string|null" };
    }
    const value: CostEntry = {
        ts: input["ts"] as string,
        request_id: reqId as string | null,
        phase: phase as string | null,
        delta_usd: input["delta_usd"] as number,
        reason: reason as CostEntry["reason"],
    };
    if (sessionId !== undefined) value.session_id = sessionId as string | null;
    return { ok: true, value };
}

export function parseCostLedger(input: unknown): ParseResult<CostLedger> {
    if (!isPlainObject(input)) return { ok: false, error: "ledger must be object" };
    if (input["version"] !== 1) {
        return { ok: false, error: "ledger.version must be 1" };
    }
    if (
        typeof input["total_usd"] !== "number" ||
        !Number.isFinite(input["total_usd"]) ||
        (input["total_usd"] as number) < 0
    ) {
        return { ok: false, error: "ledger.total_usd must be a non-negative number" };
    }
    const daily = input["daily_usd"];
    if (!isPlainObject(daily)) return { ok: false, error: "ledger.daily_usd must be object" };
    for (const [k, v] of Object.entries(daily)) {
        if (!ISO_DATE_RE.test(k)) {
            return { ok: false, error: `ledger.daily_usd key '${k}' must be YYYY-MM-DD` };
        }
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            return { ok: false, error: `ledger.daily_usd['${k}'] must be a non-negative number` };
        }
    }
    const perRequest = input["per_request"];
    if (!isPlainObject(perRequest)) {
        return { ok: false, error: "ledger.per_request must be object" };
    }
    for (const [k, v] of Object.entries(perRequest)) {
        if (!REQ_ID_RE.test(k)) {
            return { ok: false, error: `ledger.per_request key '${k}' must be REQ-NNNNNN` };
        }
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            return { ok: false, error: `ledger.per_request['${k}'] must be non-negative` };
        }
    }
    const entries = input["entries"];
    if (!Array.isArray(entries)) {
        return { ok: false, error: "ledger.entries must be an array" };
    }
    const parsedEntries: CostEntry[] = [];
    for (let i = 0; i < entries.length; i += 1) {
        const r = parseCostEntry(entries[i]);
        if (!r.ok || !r.value) {
            return { ok: false, error: `ledger.entries[${String(i)}]: ${r.error ?? "unknown"}` };
        }
        parsedEntries.push(r.value);
    }
    if (
        typeof input["last_updated"] !== "string" ||
        !ISO_DATETIME_RE.test(input["last_updated"])
    ) {
        return { ok: false, error: "ledger.last_updated must be ISO datetime" };
    }
    const value: CostLedger = {
        version: 1,
        total_usd: input["total_usd"] as number,
        daily_usd: daily as Record<string, number>,
        per_request: perRequest as Record<string, number>,
        entries: parsedEntries,
        last_updated: input["last_updated"] as string,
    };
    return { ok: true, value };
}
