// PRD-025 FR-025-05 / #353 — config-change marker store.
//
// The portal MUST NOT mutate the user config file directly (FR-925). Instead
// it writes a per-change marker into `${state_dir}/config-changes/`; the
// daemon's reconcile step validates and applies it (see
// `consume_config_changes` in bin/supervisor-loop.sh), mirroring the
// gate-decision / request-action poll model. Every config change is therefore
// daemon-mediated, validated, and audited.
//
// Consistency note: because application is deferred to the daemon's next
// reconcile pass, a change is not reflected in the live config (or
// `readCurrent()`) until the daemon applies it. With the daemon stopped,
// markers accumulate and apply on next start. This is the intended trade-off
// of routing through the daemon rather than writing config behind its back.

import { randomUUID } from "node:crypto";

import { atomicWriteJson } from "./atomic-json";
import { configChangePath } from "./state-paths";
import type { UserConfigFile } from "./settings-store";

/** A portal-originated configuration change awaiting daemon application. */
export interface ConfigChangeMarker {
    /** UUID for this change (also the marker filename stem). */
    id: string;
    /** Always "portal" — the daemon asserts provenance on apply. */
    source: "portal";
    /** Operator who initiated the change (for the audit trail). */
    actor: string;
    /** ISO-8601 timestamp the marker was written. */
    ts: string;
    /** Short human-readable description of the change. */
    summary: string;
    /** The full proposed user-config document the daemon should apply. */
    proposed: UserConfigFile;
}

/**
 * Write a config-change marker for the daemon to validate + apply.
 *
 * @returns the marker id (UUID) on success.
 * @throws if the marker file cannot be written (caller surfaces the error).
 */
export async function writeConfigChangeMarker(opts: {
    proposed: UserConfigFile;
    actor: string;
    summary: string;
}): Promise<string> {
    const id = randomUUID();
    const marker: ConfigChangeMarker = {
        id,
        source: "portal",
        actor: opts.actor,
        ts: new Date().toISOString(),
        summary: opts.summary,
        proposed: opts.proposed,
    };
    await atomicWriteJson(configChangePath(id), marker);
    return id;
}

export interface AppliedConfigChange {
    id: string;
    actor: string;
    ts: string;
    summary: string;
}

/**
 * #396: list daemon-applied config changes (newest first) for the audit
 * page. These applications happen DAEMON-side, so they never enter the
 * portal's HMAC-chained audit log — the page renders them as a clearly
 * separate section sourced from `config-changes/applied/`.
 */
export async function readAppliedConfigChanges(
    limit = 20,
): Promise<AppliedConfigChange[]> {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { configChangesDir } = await import("./state-paths");
    const dir = join(configChangesDir(), "applied");
    let files: string[];
    try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }
    const out: AppliedConfigChange[] = [];
    for (const f of files) {
        try {
            const m = JSON.parse(await readFile(join(dir, f), "utf-8")) as
                Partial<AppliedConfigChange>;
            if (typeof m.id === "string" && typeof m.ts === "string") {
                out.push({
                    id: m.id,
                    actor: typeof m.actor === "string" ? m.actor : "unknown",
                    ts: m.ts,
                    summary: typeof m.summary === "string" ? m.summary : "",
                });
            }
        } catch {
            /* skip unreadable marker */
        }
    }
    out.sort((a, b) => b.ts.localeCompare(a.ts));
    return out.slice(0, limit);
}
