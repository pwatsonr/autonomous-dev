// SPEC-015-1-03 — Validator for daemon state.json.
//
// Mirrors the daemon source-of-truth schema (intake/types/request.ts
// from PLAN-012). Unknown fields are preserved (forward compat). When
// the daemon adds a new field, this validator does NOT need to change.

import {
    REQUEST_PHASES,
    type RequestPhase,
    type RequestPriority,
    type RequestSource,
    type RequestState,
} from "../types";

const REQ_ID_RE = /^REQ-\d{6}$/;
const ISO_DATETIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const VALID_SOURCES: ReadonlySet<RequestSource> = new Set([
    "cli",
    "claude-app",
    "discord",
    "slack",
    "production-intelligence",
    "portal",
]);
const VALID_PRIORITIES: ReadonlySet<RequestPriority> = new Set([
    "low",
    "normal",
    "high",
    "urgent",
]);
const VALID_PHASES: ReadonlySet<RequestPhase> = new Set(REQUEST_PHASES);

export interface ParseResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkString(field: string, v: unknown): string | null {
    if (typeof v !== "string") return `${field} must be a string`;
    return null;
}

export function parseRequestState(input: unknown): ParseResult<RequestState> {
    if (!isPlainObject(input)) {
        return { ok: false, error: "state.json must be a JSON object" };
    }

    const errors: string[] = [];

    if (typeof input["request_id"] !== "string" || !REQ_ID_RE.test(input["request_id"])) {
        errors.push("request_id must match REQ-NNNNNN");
    }
    if (
        typeof input["phase"] !== "string" ||
        !VALID_PHASES.has(input["phase"] as RequestPhase)
    ) {
        errors.push(
            `phase must be one of ${Array.from(VALID_PHASES).join("|")}, got ${String(input["phase"])}`,
        );
    }
    for (const f of ["created_at", "updated_at"]) {
        const v = input[f];
        if (typeof v !== "string" || !ISO_DATETIME_RE.test(v)) {
            errors.push(`${f} must be an ISO 8601 datetime`);
        }
    }
    for (const f of ["repository", "title"]) {
        const e = checkString(f, input[f]);
        if (e) errors.push(e);
    }

    // Optional fields with default values, applied without mutating
    // unknown extras.
    const source = input["source"];
    if (source !== undefined && (typeof source !== "string" || !VALID_SOURCES.has(source as RequestSource))) {
        errors.push(`source must be one of ${Array.from(VALID_SOURCES).join("|")}`);
    }
    const priority = input["priority"];
    if (
        priority !== undefined &&
        (typeof priority !== "string" || !VALID_PRIORITIES.has(priority as RequestPriority))
    ) {
        errors.push(`priority must be one of ${Array.from(VALID_PRIORITIES).join("|")}`);
    }

    const branch = input["branch"];
    if (branch !== undefined && branch !== null && typeof branch !== "string") {
        errors.push("branch must be string|null");
    }
    const session_id = input["session_id"];
    if (session_id !== undefined && session_id !== null && typeof session_id !== "string") {
        errors.push("session_id must be string|null");
    }
    const error = input["error"];
    if (error !== undefined && error !== null && typeof error !== "string") {
        errors.push("error must be string|null");
    }
    const cost_usd = input["cost_usd"];
    if (
        cost_usd !== undefined &&
        cost_usd !== null &&
        (typeof cost_usd !== "number" || !Number.isFinite(cost_usd) || cost_usd < 0)
    ) {
        errors.push("cost_usd must be a non-negative number");
    }
    const paused = input["paused_at_phase"];
    if (
        paused !== undefined &&
        paused !== null &&
        (typeof paused !== "string" || !VALID_PHASES.has(paused as RequestPhase))
    ) {
        errors.push(`paused_at_phase must be a valid phase or null`);
    }

    if (errors.length > 0) {
        return { ok: false, error: errors.join("; ") };
    }

    const value: RequestState = {
        ...input,
        request_id: input["request_id"] as string,
        phase: input["phase"] as RequestPhase,
        created_at: input["created_at"] as string,
        updated_at: input["updated_at"] as string,
        repository: input["repository"] as string,
        title: input["title"] as string,
        source: (source as RequestSource | undefined) ?? "cli",
        priority: (priority as RequestPriority | undefined) ?? "normal",
    };
    return { ok: true, value };
}

export function isValidRequestId(id: string): boolean {
    return REQ_ID_RE.test(id);
}
