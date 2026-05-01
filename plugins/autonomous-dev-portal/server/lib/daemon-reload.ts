// SPEC-015-2-03 §Daemon Reload Helper
//
// Two helpers used by the settings-save handler:
//   - requiresDaemonReload(changes): does a write to these keys force the
//     daemon to re-read its config? Cost caps, trust levels, circuit-breaker
//     and kill-switch settings all do; notification-only changes do not.
//   - signalDaemonReload(client, reason, operatorId): fire-and-forget
//     daemon-reload command. We do NOT wait for the reload to complete; the
//     caller polls healthCheck if it cares.
//
// `flattenKeys` is reused from form-parser so the audit-log key flattening
// and the daemon-reload trigger detection use exactly the same algorithm.

import { randomUUID } from "node:crypto";

import { flattenKeys } from "./form-parser";
import type { IntakeRouterClient } from "./intake-router-client";

/** Dotted key prefixes whose modification requires the daemon to reload. */
export const RELOAD_TRIGGER_PREFIXES: readonly string[] = Object.freeze([
    "costCaps.",
    "trustLevels.",
    "circuitBreaker.",
    "killSwitch.",
]);

/**
 * Returns true if any of the changed paths starts with one of the
 * reload-trigger prefixes. Empty / null / non-object input returns false.
 */
export function requiresDaemonReload(
    changes: Record<string, unknown> | null | undefined,
): boolean {
    if (changes === null || changes === undefined) return false;
    const flat = flattenKeys(changes);
    return flat.some((k) =>
        RELOAD_TRIGGER_PREFIXES.some((p) => k.startsWith(p)),
    );
}

export interface SignalReloadResult {
    ok: boolean;
    error?: string;
}

/**
 * Submit a `daemon-reload` command to the intake router. Fire-and-forget:
 * we do not poll the daemon's health afterwards. If the operator wants to
 * verify, they trigger a separate /health probe.
 */
export async function signalDaemonReload(
    client: IntakeRouterClient,
    reason: string,
    operatorId: string,
): Promise<SignalReloadResult> {
    const response = await client.submitCommand({
        command: "daemon-reload",
        requestId: randomUUID(),
        source: "portal",
        sourceUserId: operatorId,
        comment: reason,
    });
    if (!response.success) {
        return { ok: false, error: response.error };
    }
    return { ok: true };
}
