// SPEC-036-2-04..06 §Route — Ops (`GET /ops`).
// PLAN-038 TASK-017 — swapped from loadOpsStub() to the real
// readOpsHealth() composition reader. MCP probe, deploy events, and
// standards changes feed are empty by default (daemon does not track
// these); plugin chain is read live from `plugins/<name>/.claude-plugin/
// plugin.json`; recent log tails `~/.autonomous-dev/portal/portal.log`.
//
// FR-026-31 — v3 ops view also reads autopilot state and cost caps from
// disk so the new tiles have live data.

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { readOpsHealth } from "../wiring/ops-readers";
import { readPortalSettings } from "../wiring/settings-reader";
import type { OpsHealth } from "../types/render";
import type { RenderProps } from "../types/render";

const MAX_LOG_RENDER = 200;

/** Trim the rendered log to the last `MAX_LOG_RENDER` entries. */
function trimRecentLog(h: OpsHealth): OpsHealth {
    if (!h.recentLog || h.recentLog.length <= MAX_LOG_RENDER) return h;
    return {
        ...h,
        recentLog: h.recentLog.slice(-MAX_LOG_RENDER),
    };
}

/**
 * FR-026-31 — Read autopilot status from `~/.claude/autopilot-state.json`.
 * Returns `undefined` when the file is absent or unparseable — the view
 * renders "unavailable" for undefined inputs rather than fabricating data.
 */
async function readAutopilotStatus(): Promise<string | undefined> {
    try {
        const path = join(homedir(), ".claude", "autopilot-state.json");
        const raw = await readFile(path, "utf-8");
        const parsed = JSON.parse(raw) as { status?: string };
        if (typeof parsed.status === "string") return parsed.status;
    } catch {
        // File absent or malformed — return undefined.
    }
    return undefined;
}

export const opsHandler = async (c: Context): Promise<Response> => {
    const raw = await readOpsHealth();
    const health = trimRecentLog(raw);
    const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";

    // FR-026-31 — read v3 tile data in parallel.
    const [autopilotStatus, settings] = await Promise.all([
        readAutopilotStatus().catch(() => undefined),
        readPortalSettings().catch(() => null),
    ]);

    // Cast to RenderProps["ops"] so renderPage is satisfied.  The view
    // receives the full object (including v3 extension fields) at runtime;
    // TypeScript widening is handled via the local OpsViewV3Props cast in
    // the view file itself.
    const props = {
        health,
        csrfToken,
        autopilotStatus,
        monthlyCostCapUsd: settings?.monthlyCostCap,
    } as unknown as RenderProps["ops"];

    return renderPage(c, "ops", props);
};
