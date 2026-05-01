// SPEC-015-1-03 — Validator for events.jsonl phase-transition lines.
//
// Other event types (cost, log) are silently filtered by the
// EventsReader so this module covers phase events only.

import { REQUEST_PHASES, type PhaseEvent, type RequestPhase } from "../types";

const REQ_ID_RE = /^REQ-\d{6}$/;
const ISO_DATETIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const VALID_PHASES: ReadonlySet<RequestPhase> = new Set(REQUEST_PHASES);
const VALID_TRIGGERS = new Set(["daemon", "operator", "auto"]);

export interface ParseResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parsePhaseEvent(input: unknown): ParseResult<PhaseEvent> {
    if (!isPlainObject(input)) {
        return { ok: false, error: "phase event must be an object" };
    }
    if (input["type"] !== "phase_transition") {
        return { ok: false, error: "not a phase_transition event" };
    }
    if (typeof input["ts"] !== "string" || !ISO_DATETIME_RE.test(input["ts"])) {
        return { ok: false, error: "ts must be ISO 8601 datetime" };
    }
    if (
        typeof input["request_id"] !== "string" ||
        !REQ_ID_RE.test(input["request_id"])
    ) {
        return { ok: false, error: "request_id must match REQ-NNNNNN" };
    }
    const from = input["from_phase"];
    if (
        from !== null &&
        (typeof from !== "string" || !VALID_PHASES.has(from as RequestPhase))
    ) {
        return { ok: false, error: "from_phase must be valid phase or null" };
    }
    if (
        typeof input["to_phase"] !== "string" ||
        !VALID_PHASES.has(input["to_phase"] as RequestPhase)
    ) {
        return { ok: false, error: "to_phase must be a valid phase" };
    }
    const trigger = input["trigger"];
    if (trigger !== undefined && (typeof trigger !== "string" || !VALID_TRIGGERS.has(trigger))) {
        return { ok: false, error: "trigger invalid" };
    }
    const duration = input["duration_ms"];
    if (
        duration !== undefined &&
        (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
    ) {
        return { ok: false, error: "duration_ms must be non-negative" };
    }
    const value: PhaseEvent = {
        ts: input["ts"] as string,
        type: "phase_transition",
        request_id: input["request_id"] as string,
        from_phase: from as RequestPhase | null,
        to_phase: input["to_phase"] as RequestPhase,
    };
    if (trigger !== undefined) value.trigger = trigger as PhaseEvent["trigger"];
    if (duration !== undefined) value.duration_ms = duration as number;
    return { ok: true, value };
}
