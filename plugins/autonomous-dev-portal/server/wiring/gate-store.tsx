// PLAN-037-2 — marker-file backing store for gate decisions + generic
// request actions.
//
// No daemon-RPC channel exists. The portal writes a per-id marker file
// under `${state_dir}/gate-decisions/` or `${state_dir}/request-actions/`,
// and the daemon's gate-loop picks them up on its next iteration. This
// mirrors the approval-store pattern used by `intake/deploy/approval-
// store.ts` for the deploy phase.
//
// Concurrency: the marker file is the unit of state. If two POSTs arrive
// for the same request id in the same millisecond, the atomic rename
// guarantees one wins; the second sees the file present and returns
// `{reason: "terminal"}`.

import type { JSX } from "hono/jsx";
import { join } from "node:path";

import { Chip } from "../components/primitives";
import type {
    GateAndRequestActionDeps,
    GateDecisionInput,
    GateDecisionResult,
    RequestActionResult,
} from "../routes/gate-and-request-actions";
import type { ConfirmationStore } from "../routes/confirmation-routes";

import { atomicWriteJson, readJsonOrNull } from "./atomic-json";
import {
    gateDecisionPath,
    gateDecisionsDir,
    requestActionPath,
    requestActionsDir,
} from "./state-paths";

interface GateMarker {
    repo: string;
    id: string;
    verb: string;
    actor: string;
    decidedAt: string;
}

interface RequestActionMarker {
    id: string;
    action: string;
    actor: string;
    queuedAt: string;
}

function gateBannerFragment(input: GateDecisionInput, decidedAt: string): JSX.Element {
    const tone = input.verb === "approve" ? "ok" : "warn";
    return (
        <div class="gate-decision-banner" data-verb={input.verb}>
            <Chip variant="status" tone={tone}>
                {input.verb}
            </Chip>
            <span class="meta mono">
                {input.repo} / {input.id} — {decidedAt} by {input.actor}
            </span>
        </div>
    );
}

function requestActionFragment(id: string, action: string): JSX.Element {
    return (
        <div class="request-action-queued" data-action={action}>
            <Chip variant="status" tone="info">
                queued
            </Chip>
            <span class="meta mono">
                {id} · {action}
            </span>
        </div>
    );
}

async function applyGateDecision(
    input: GateDecisionInput,
): Promise<GateDecisionResult> {
    const path = gateDecisionPath(input.repo, input.id);
    const existing = await readJsonOrNull<GateMarker>(path);
    if (existing !== null) {
        return {
            ok: false,
            reason: "terminal",
            state: existing.verb,
        };
    }
    const decidedAt = new Date().toISOString();
    const marker: GateMarker = {
        repo: input.repo,
        id: input.id,
        verb: input.verb,
        actor: input.actor,
        decidedAt,
    };
    try {
        await atomicWriteJson(path, marker);
    } catch (err) {
        return {
            ok: false,
            reason: "internal",
            message: err instanceof Error ? err.message : String(err),
        };
    }
    return { ok: true, fragment: gateBannerFragment(input, decidedAt) };
}

async function applyRequestAction(
    id: string,
    action: string,
    actor: string,
): Promise<RequestActionResult> {
    const path = requestActionPath(id);
    const marker: RequestActionMarker = {
        id,
        action,
        actor,
        queuedAt: new Date().toISOString(),
    };
    try {
        await atomicWriteJson(path, marker);
    } catch (err) {
        return {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
        };
    }
    return { ok: true, fragment: requestActionFragment(id, action) };
}

/**
 * Build the gate+request action deps. The caller (wire.ts) supplies the
 * shared ConfirmationStore so the typed-CONFIRM record set by the
 * `/api/security/confirmation/validate` endpoint is consumed by the
 * destructive route's `requireConfirmation()` middleware.
 */
export function buildGateAndRequestDeps(
    confirmationStore: ConfirmationStore,
): GateAndRequestActionDeps {
    return {
        applyGateDecision,
        applyRequestAction,
        confirmationStore,
        // The audit appender is injected by the central wiring module so
        // every action surface writes through the same logger.
        audit: {
            async append() {
                /* overwritten in wire.ts */
            },
        },
    };
}

/** Exported so the wiring tests can clean up between cases. */
export const __test__ = {
    gateDecisionsDir,
    requestActionsDir,
    gateDecisionPath: (repo: string, id: string): string =>
        join(gateDecisionsDir(), `${repo}__${id}.json`),
};
