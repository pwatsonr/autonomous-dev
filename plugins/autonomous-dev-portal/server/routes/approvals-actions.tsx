// SPEC-037-2-03 — Approvals action routes.
//
// Three POST endpoints back the Approvals page HTMX controls:
//
//   POST /api/approvals/:id/approve   → 200 text/html row fragment
//   POST /api/approvals/:id/reject    → 200 text/html row fragment
//   POST /api/approvals/bulk-approve  → 200 application/json
//
// Contract notes (per spec):
//   - CSRF is enforced upstream by the global middleware chain. This module
//     MUST NOT re-implement or bypass CSRF.
//   - Every successful mutation emits a structured audit entry AND
//     fire-and-forget broadcasts an SSE event so other connected clients
//     re-render the row in real time. Broadcast errors MUST NOT block the
//     response.
//   - Bulk supports partial success: failures in some ids do NOT roll back
//     successful approvals.
//   - Terminal-state guard returns 409 to make double-clicks safe.

import { Hono } from "hono";

import type { AuditAppender, SSEBroadcaster } from "./_action-deps";
import { noopActionLogger, noopBroadcaster, resolveActor } from "./_action-deps";
import type { ActionLogger } from "./_action-deps";
import { ApprovalsKpiStrip } from "../templates/fragments/approvals-kpi-strip";
import { GateRow } from "../templates/fragments/gate-row";
import type { ApprovalItem } from "../types/render";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BULK_MIN = 1;
const BULK_MAX = 50;

/** SPEC-037-4-05 — filter shape sent by the Approvals page bulk button. */
const FILTER_VALUES = new Set([
    "all",
    "reviewer-chain",
    "standards-violation",
    "cost-cap",
]);

/**
 * SPEC-037-4-05 §Bulk-approve filter integration. Optional service
 * surface — when provided, the bulk endpoint accepts an HTMX form POST
 * (`filter=<value>`) and responds with the rebuilt `.gate-list` plus an
 * `.kpi-strip` HTMX OOB swap. When omitted, the endpoint preserves the
 * PLAN-037-2 JSON contract.
 */
export interface BulkApproveByFilterService {
    /** Approve every open gate matching `filter` (`"all"` = every gate). */
    approveByFilter(
        filter: string,
        actor: string,
    ): Promise<{
        approvedIds: string[];
        remaining: ApprovalItem[];
        costCapDailyUsd: number;
    }>;
}

export type ApprovalState = "approved" | "rejected";

export interface ApprovalDecision {
    /** "approve" / "reject" produces the row fragment for HTMX outerHTML. */
    row: JSX.Element;
}

export type ApprovalDecisionResult =
    | { ok: true; decision: ApprovalDecision }
    | { ok: false; error: "not-found" }
    | { ok: false; error: "already-decided"; state: string }
    | { ok: false; error: "internal"; message?: string };

export interface ApprovalsStore {
    decide(
        id: string,
        state: ApprovalState,
        actor: string,
    ): Promise<ApprovalDecisionResult>;
}

export interface ApprovalsActionDeps {
    store: ApprovalsStore;
    audit: AuditAppender;
    bus?: SSEBroadcaster;
    logger?: ActionLogger;
    /** SPEC-037-4-05 — when present, enables the form-shaped
     *  `filter=<value>` bulk-approve path that returns an HTML fragment
     *  + `.kpi-strip` OOB swap. The JSON `{ids: [...]}` contract is
     *  preserved when this is omitted. */
    bulkApproveByFilter?: BulkApproveByFilterService;
}

interface BulkBody {
    ids?: unknown;
}

interface BulkFailure {
    id: string;
    reason: string;
}

interface BulkResponse {
    approved: string[];
    failed: BulkFailure[];
}

/**
 * Build the approvals action sub-router. Mount via
 * `app.route("/", buildApprovalsActionRoutes(deps))`.
 */
export function buildApprovalsActionRoutes(
    deps: ApprovalsActionDeps,
): Hono {
    const bus = deps.bus ?? noopBroadcaster();
    const logger = deps.logger ?? noopActionLogger();
    const router = new Hono();

    const decideHandler = (state: ApprovalState) =>
        async (c: import("hono").Context): Promise<Response> => {
            const id = c.req.param("id");
            if (typeof id !== "string" || !ID_RE.test(id)) {
                return c.json({ error: "invalid-id" }, 400);
            }
            const actor = resolveActor(c.get("auth"));
            const res = await deps.store.decide(id, state, actor);
            if (!res.ok) {
                if (res.error === "not-found") {
                    return c.json({ error: "not-found" }, 404);
                }
                if (res.error === "already-decided") {
                    return c.json(
                        { error: "already-decided", state: res.state },
                        409,
                    );
                }
                logger.error("approval_action_failed", {
                    id,
                    state,
                    actor,
                });
                return c.json({ error: "internal" }, 500);
            }
            await deps.audit.append({
                event: `approval_${state}`,
                id,
                actor,
            });
            // Fire-and-forget SSE update; never block the response.
            bus.publish("approval", { id, state });
            return c.html(res.decision.row);
        };

    router.post("/api/approvals/:id/approve", decideHandler("approved"));
    router.post("/api/approvals/:id/reject", decideHandler("rejected"));

    router.post("/api/approvals/bulk-approve", async (c) => {
        // SPEC-037-4-05 — when the Approvals page POSTs `filter=<value>`
        // via HTMX (form encoding), respond with the rebuilt gate-list
        // + .kpi-strip OOB swap. This branch is only active when the
        // route deps provide `bulkApproveByFilter`; PLAN-037-2's
        // JSON-shaped `{ids: [...]}` contract is otherwise preserved.
        const contentType = c.req.header("Content-Type") ?? "";
        const isForm =
            contentType.includes("application/x-www-form-urlencoded") ||
            contentType.includes("multipart/form-data");

        if (isForm) {
            // Handle form-encoded requests
            if (deps.bulkApproveByFilter !== undefined) {
            const form = await c.req.formData();
            const rawFilter = String(form.get("filter") ?? "all");
            const filter = FILTER_VALUES.has(rawFilter) ? rawFilter : "all";
            const actor = resolveActor(c.get("auth"));
            const { approvedIds, remaining, costCapDailyUsd } =
                await deps.bulkApproveByFilter.approveByFilter(filter, actor);
            // Audit + broadcast each successful approval so observers
            // see incremental updates (parity with the JSON path).
            for (const id of approvedIds) {
                await deps.audit.append({
                    event: "approval_approved",
                    id,
                    actor,
                    bulk: true,
                    filter,
                });
                bus.publish("approval", { id, state: "approved" });
            }
            // Empty result still returns 200 with an empty gate-list +
            // an .empty sibling so HTMX swaps don't leave stale DOM.
            const body = (
                <>
                    {remaining.length === 0 ? (
                        <>
                            <div class="gate-list"></div>
                            <div class="empty">No open gates</div>
                        </>
                    ) : (
                        <div class="gate-list">
                            {remaining.map((it) => (
                                <GateRow {...it} />
                            ))}
                        </div>
                    )}
                    <ApprovalsKpiStrip
                        items={remaining}
                        costCapDailyUsd={costCapDailyUsd}
                        oob="outerHTML:.kpi-strip"
                    />
                </>
            );
            return c.html(body);
            } else {
                // Form submission received but bulk filter feature is not available
                return c.json({ error: "bulk-filter-not-supported" }, 501);
            }
        }

        let body: BulkBody = {};
        try {
            body = (await c.req.json()) as BulkBody;
        } catch {
            return c.json({ error: "invalid-body" }, 400);
        }
        if (!Array.isArray(body.ids)) {
            return c.json({ error: "invalid-body" }, 400);
        }
        const ids = body.ids;
        if (ids.length < BULK_MIN || ids.length > BULK_MAX) {
            return c.json({ error: "invalid-bulk-size" }, 400);
        }
        for (const id of ids) {
            if (typeof id !== "string" || !ID_RE.test(id)) {
                return c.json({ error: "invalid-id" }, 400);
            }
        }
        const actor = resolveActor(c.get("auth"));
        const approved: string[] = [];
        const failed: BulkFailure[] = [];
        for (const id of ids) {
            // Cast safe — we validated each element above.
            const stringId = id as string;
            const res = await deps.store.decide(stringId, "approved", actor);
            if (res.ok) {
                approved.push(stringId);
                // Each successful element is audited and broadcast
                // individually so observers see incremental state updates.
                await deps.audit.append({
                    event: "approval_approved",
                    id: stringId,
                    actor,
                    bulk: true,
                });
                bus.publish("approval", { id: stringId, state: "approved" });
                continue;
            }
            if (res.error === "already-decided") {
                failed.push({ id: stringId, reason: `already-decided:${res.state}` });
                continue;
            }
            if (res.error === "not-found") {
                failed.push({ id: stringId, reason: "not-found" });
                continue;
            }
            logger.error("approval_bulk_item_failed", { id: stringId });
            failed.push({ id: stringId, reason: "internal" });
        }
        const out: BulkResponse = { approved, failed };
        return c.json(out);
    });

    return router;
}

/**
 * Minimal default ApprovalsStore for tests/stubs. Production wires the
 * daemon-backed store; this default operates over a Map so the route module
 * is exercisable without a daemon.
 */
export class InMemoryApprovalsStore implements ApprovalsStore {
    private readonly state: Map<string, ApprovalState | "pending"> = new Map();

    /** Seed an id in `pending` state. */
    seed(id: string): void {
        this.state.set(id, "pending");
    }

    /** Force an id into a terminal state (for already-decided tests). */
    forceState(id: string, state: ApprovalState): void {
        this.state.set(id, state);
    }

    async decide(
        id: string,
        next: ApprovalState,
        _actor: string,
    ): Promise<ApprovalDecisionResult> {
        const current = this.state.get(id);
        if (current === undefined) {
            return { ok: false, error: "not-found" };
        }
        if (current === "approved" || current === "rejected") {
            return {
                ok: false,
                error: "already-decided",
                state: current,
            };
        }
        this.state.set(id, next);
        const row = (
            <tr id={id} data-state={next}>
                <td>{id}</td>
                <td>
                    <span class={`chip ${next === "approved" ? "ok" : "err"}`}>
                        {next}
                    </span>
                </td>
            </tr>
        );
        return { ok: true, decision: { row } };
    }
}
