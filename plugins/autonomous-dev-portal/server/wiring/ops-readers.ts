// PLAN-038 TASK-017 — Ops composition reader.
//
// Reads real daemon-status + plugin manifest + heartbeat to populate the
// Ops surface. Subsystems the daemon does NOT expose (MCP probe, deploy
// events, standards-changes feed) render as empty / "not tracked" — the
// view tolerates undefined arrays.
//
// Sub-readers (this module owns them so the composition stays in one file):
//   - readDaemonInfo()    daemon-status (existing) + uptime label
//   - readPluginChain()   scans plugin manifests (`.claude-plugin/plugin.json`)
//   - readRecentLog()     tails `~/.autonomous-dev/portal/portal.log`

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
    LogEntry,
    OpsHealth,
    PluginChainCategory,
} from "../types/render";

import { readDaemonStatus } from "../lib/daemon-status";
import { stateDirRoot } from "./state-paths";

interface PluginManifestFile {
    name?: string;
    version?: string;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/**
 * Scan the workspace's `plugins/<name>/.claude-plugin/plugin.json` files
 * and return the (name, version) pairs grouped as a single "CORE" category.
 *
 * Real plugin-chain rendering (with reviewers / variants / deploy / org
 * tiers) requires plugin metadata not yet exposed by the daemon; out of
 * scope for TASK-017. Single CORE column is the honest empty-state.
 */
async function readPluginChain(): Promise<PluginChainCategory[]> {
    // Resolve workspace plugins/ from this file's dir: server/wiring → ../../../
    const pluginsRoot = join(import.meta.dir, "..", "..", "..");
    let pluginDirs: string[];
    try {
        pluginDirs = await readdir(pluginsRoot);
    } catch {
        return [];
    }
    const corePackages: string[] = [];
    for (const dir of pluginDirs) {
        if (!dir.startsWith("autonomous-dev")) continue;
        const manifest = await readJsonOrNull<PluginManifestFile>(
            join(pluginsRoot, dir, ".claude-plugin", "plugin.json"),
        );
        if (manifest === null) continue;
        const name = manifest.name ?? dir;
        const version = manifest.version ?? "0.0.0";
        corePackages.push(`${name}@${version}`);
    }
    corePackages.sort();
    if (corePackages.length === 0) return [];
    return [{ name: "CORE", accent: "core", packages: corePackages }];
}

/**
 * Read the last N lines of the portal log and project them into
 * LogEntry[]. Logs that don't parse are dropped silently.
 */
async function readRecentLog(maxLines = 50): Promise<LogEntry[]> {
    const path = join(stateDirRoot(), "portal", "portal.log");
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch {
        return [];
    }
    const lines = raw.trim().split("\n").slice(-maxLines);
    const entries: LogEntry[] = [];
    for (const line of lines) {
        // Try NDJSON first.
        try {
            const parsed = JSON.parse(line) as {
                ts?: string;
                level?: string;
                msg?: string;
                message?: string;
            };
            if (typeof parsed.ts === "string" && typeof parsed.level === "string") {
                entries.push({
                    ts: parsed.ts,
                    level: parsed.level.toUpperCase(),
                    message: parsed.msg ?? parsed.message ?? "",
                });
                continue;
            }
        } catch {
            // Plain text — surface as INFO.
        }
        entries.push({ ts: new Date().toISOString(), level: "INFO", message: line });
    }
    return entries;
}

export async function readOpsHealth(): Promise<OpsHealth> {
    const [daemon, pluginChain, recentLog] = await Promise.all([
        readDaemonStatus().catch(() => null),
        readPluginChain().catch(() => []),
        readRecentLog().catch(() => []),
    ]);

    // DaemonStatus has `status` ("fresh"/"stale"/"dead"), pid, last_seen.
    // It does NOT track a start-time, so true uptime can't be derived
    // (the kit screenshot's "4d 12h" is therefore aspirational on a
    // real install). We render "—" when the daemon is dead, otherwise
    // a generic "alive" marker.
    const daemonStatus = daemon?.status ?? "dead";
    const daemonPid = daemon?.pid ?? null;
    const uptime =
        daemonStatus === "dead" || daemonStatus === undefined ? "—" : "alive";

    return {
        daemon: { status: daemonStatus, pid: daemonPid },
        components: {},
        // Per O.Q. resolution: MCP probe, deploy events, standards changes
        // are not tracked by the daemon. View renders empty-state sections.
        mcpServers: [],
        pluginChain,
        recentLog,
        deployEvents: [],
        standardsChanges: [],
        standardsCount: 0,
        immutableCount: 0,
        heartbeat: [],
        uptime,
    };
}
