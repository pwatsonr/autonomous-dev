// #429 — gate-decision history reader.
//
// Source of truth: the daemon/portal-shared gate-decisions directory
//   ${state_dir}/gate-decisions/<repo>__<id>.json
//
// This is the SAME directory the portal's `FileApprovalsStore.decide()`
// writes operator approve/reject decisions into, and that the daemon's
// gate loop polls. Each file is the durable record of one gate's decision
// state, so it is the honest, real source for historical gate decisions —
// no fabrication, no design-reference constants (#389 / #429 precedent).
//
// Two on-disk schema variants exist and are both parsed here:
//
//   A) daemon / gate-entry shape (see request-ledger-reader.ts):
//      { id, repo, phase, state: "pending"|"approved"|"rejected"
//        |"request-changes", waitedMin, gate_entered_at }
//
//   B) portal FileApprovalsStore shape (approvals-store.tsx):
//      { id, repo, state, request_id, decision, operator_id, decided_at }
//
//   C) gate-store.tsx GateMarker shape:
//      { repo, id, verb: "approve"|"reject", actor, decidedAt }
//
// A decision is "historical" once it is no longer `pending`. We normalize
// the verb/state/decision fields into a single { decision, decidedAt,
// decidedBy } record so the Approvals tabs and the 7-day stats card render
// from one shape.
//
// IMPORTANT (honesty): if no decided files exist yet (e.g. every gate on
// this machine is still pending, or decisions were applied daemon-side
// without writing a terminal state), this reader returns an EMPTY list and
// zeroed stats. The view then shows an honest empty/zero state — it never
// invents counts.
//
// Resilience (mirrors request-ledger-reader.ts):
//   - missing dir         → empty []
//   - corrupt JSON in one → skip that file, continue
//   - permission error    → empty []

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { normalizePhase } from "./request-ledger-reader";
import { gateDecisionsDir } from "./state-paths";

/**
 * Read + parse a single JSON file, returning null on ANY failure (missing
 * file, permission error, AND corrupt JSON). The shared
 * `atomic-json.readJsonOrNull` lets `JSON.parse` throw on malformed
 * content, which would abort the whole scan — this local helper honors the
 * "skip the bad file, continue" resilience contract (parity with
 * request-ledger-reader.ts).
 */
async function readJsonSafe<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** Normalized historical decision outcome. */
export type GateDecisionOutcome = "approved" | "rejected" | "request-changes";

/** One normalized historical gate decision. */
export interface GateHistoryEntry {
    /** Request id (e.g. REQ-000018). */
    id: string;
    /** Owning repo. */
    repo: string;
    /** Lowercased portal phase vocabulary (review/spec/deploy/...). */
    phase: string;
    /** Normalized outcome. */
    decision: GateDecisionOutcome;
    /** ISO-8601 timestamp the decision was recorded (best-effort). */
    decidedAt: string | undefined;
    /** Operator/actor that decided, when recorded. */
    decidedBy: string | undefined;
}

/** 7-day (configurable) gate-decision summary. */
export interface GateHistoryStats {
    /** Window size in days that produced these counts. */
    windowDays: number;
    /** Total decided gates in window. */
    total: number;
    approved: number;
    rejected: number;
    requestChanges: number;
    /** approved / total, 0..1 (0 when total === 0). */
    approveRate: number;
    /** rejected / total, 0..1 (0 when total === 0). */
    rejectRate: number;
}

/** Raw union of the on-disk gate-decision file shapes (A/B/C above). */
interface RawGateDecisionFile {
    id?: string;
    repo?: string;
    phase?: string;
    // shape A / B
    state?: string;
    // shape B
    request_id?: string;
    decision?: string;
    operator_id?: string;
    decided_at?: string;
    // shape C
    verb?: string;
    actor?: string;
    decidedAt?: string;
}

/**
 * Normalize the various verb/state/decision spellings into a single
 * outcome, or `null` when the file represents a still-pending gate (which
 * is NOT history).
 */
function normalizeOutcome(raw: RawGateDecisionFile): GateDecisionOutcome | null {
    // Collect every field that could carry the verb, lowest-ambiguity first.
    const candidates = [raw.state, raw.decision, raw.verb];
    for (const c of candidates) {
        if (typeof c !== "string") continue;
        const v = c.toLowerCase();
        if (v === "pending") return null; // explicitly not decided
        if (v === "approve" || v === "approved") return "approved";
        if (v === "reject" || v === "rejected") return "rejected";
        if (v === "request-changes" || v === "request_changes" || v === "changes") {
            return "request-changes";
        }
    }
    // No recognizable decided verb anywhere → treat as not-history.
    return null;
}

/** Pick the best available decision timestamp across the schema variants. */
function pickDecidedAt(raw: RawGateDecisionFile): string | undefined {
    if (typeof raw.decided_at === "string") return raw.decided_at;
    if (typeof raw.decidedAt === "string") return raw.decidedAt;
    return undefined;
}

/** Pick the best available actor field across the schema variants. */
function pickDecidedBy(raw: RawGateDecisionFile): string | undefined {
    if (typeof raw.operator_id === "string") return raw.operator_id;
    if (typeof raw.actor === "string") return raw.actor;
    return undefined;
}

export interface GateHistoryReaderOptions {
    /** Override the gate-decisions dir (default: state-paths). Tests inject a temp dir. */
    decisionsDir?: string;
    /** Clock injection for the time-window filter (default: Date.now). */
    now?: () => number;
}

/**
 * Read every decided gate decision within the trailing `days` window.
 *
 * Entries without a usable `decidedAt` are INCLUDED (we cannot prove they
 * fall outside the window, and dropping real decisions would understate
 * history). Entries with a timestamp older than the window are excluded.
 * Results are sorted newest-first by `decidedAt` (undefined timestamps
 * sort last).
 */
export async function readGateHistory(
    days = 7,
    opts: GateHistoryReaderOptions = {},
): Promise<GateHistoryEntry[]> {
    const dir = opts.decisionsDir ?? gateDecisionsDir();
    const now = opts.now ?? Date.now;
    const cutoffMs = now() - days * 24 * 60 * 60 * 1000;

    let files: string[];
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }

    const entries: GateHistoryEntry[] = [];
    await Promise.all(
        files.map(async (f) => {
            const raw = await readJsonSafe<RawGateDecisionFile>(join(dir, f));
            if (raw === null) return; // corrupt/unreadable → skip

            const outcome = normalizeOutcome(raw);
            if (outcome === null) return; // still pending / not a decision

            const id = typeof raw.id === "string" ? raw.id : raw.request_id;
            if (typeof id !== "string" || id.length === 0) return;

            const decidedAt = pickDecidedAt(raw);
            // Time-window filter: a parseable timestamp older than the cutoff
            // is excluded. An unparseable/missing timestamp is kept (see doc).
            if (decidedAt !== undefined) {
                const t = Date.parse(decidedAt);
                if (Number.isFinite(t) && t < cutoffMs) return;
            }

            entries.push({
                id,
                repo: typeof raw.repo === "string" ? raw.repo : "unknown",
                phase: normalizePhase(raw.phase),
                decision: outcome,
                decidedAt,
                decidedBy: pickDecidedBy(raw),
            });
        }),
    );

    entries.sort((a, b) => {
        const ta = a.decidedAt !== undefined ? Date.parse(a.decidedAt) : NaN;
        const tb = b.decidedAt !== undefined ? Date.parse(b.decidedAt) : NaN;
        const va = Number.isFinite(ta) ? ta : -Infinity;
        const vb = Number.isFinite(tb) ? tb : -Infinity;
        return vb - va; // newest first
    });

    return entries;
}

/** Compute the gate-stats summary from a list of historical entries. */
export function computeGateHistoryStats(
    entries: GateHistoryEntry[],
    windowDays = 7,
): GateHistoryStats {
    let approved = 0;
    let rejected = 0;
    let requestChanges = 0;
    for (const e of entries) {
        if (e.decision === "approved") approved += 1;
        else if (e.decision === "rejected") rejected += 1;
        else requestChanges += 1;
    }
    const total = entries.length;
    return {
        windowDays,
        total,
        approved,
        rejected,
        requestChanges,
        approveRate: total > 0 ? approved / total : 0,
        rejectRate: total > 0 ? rejected / total : 0,
    };
}

/** Convenience: read history and compute stats in one call. */
export async function readGateHistoryWithStats(
    days = 7,
    opts: GateHistoryReaderOptions = {},
): Promise<{ entries: GateHistoryEntry[]; stats: GateHistoryStats }> {
    const entries = await readGateHistory(days, opts);
    return { entries, stats: computeGateHistoryStats(entries, days) };
}
