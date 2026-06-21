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
    CircuitBreakerState,
    KillSwitchState,
    LogEntry,
    OpsHealth,
    PluginChainCategory,
} from "../types/render";

import { readDaemonStatus } from "../lib/daemon-status";
import { stateDirRoot } from "./state-paths";
import { nowMs, nowIso } from "../lib/clock";

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
        entries.push({ ts: nowIso(), level: "INFO", message: line });
    }
    return entries;
}

/** crash-state.json shape (#356 / FR-935 — written by the daemon). */
interface CrashStateFile {
    consecutive_crashes?: number;
    circuit_breaker_tripped?: boolean;
    updated_at?: string;
}

/**
 * Read circuit-breaker state from `crash-state.json` (#356 / FR-935). Returns
 * undefined when the file is absent/unreadable so the view shows the empty
 * state rather than a fabricated "closed".
 */
async function readCircuitBreaker(): Promise<CircuitBreakerState | undefined> {
    try {
        const raw = await readFile(join(stateDirRoot(), "crash-state.json"), "utf-8");
        const parsed = JSON.parse(raw) as CrashStateFile;
        if (typeof parsed.circuit_breaker_tripped !== "boolean") return undefined;
        return {
            state: parsed.circuit_breaker_tripped ? "open" : "closed",
            failureCount:
                typeof parsed.consecutive_crashes === "number"
                    ? parsed.consecutive_crashes
                    : 0,
            changedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
        };
    } catch {
        return undefined;
    }
}

export async function readOpsHealth(): Promise<OpsHealth> {
    const [daemon, pluginChain, recentLog, circuitBreaker] = await Promise.all([
        readDaemonStatus().catch(() => null),
        readPluginChain().catch(() => []),
        readRecentLog().catch(() => []),
        readCircuitBreaker().catch(() => undefined),
    ]);

    // DaemonStatus now carries start_time-derived uptime (#356); we surface the
    // honest "how long ago the last heartbeat was" here plus the daemon's
    // control-plane circuit-breaker + kill-switch state (FR-935/938).
    const daemonStatus = daemon?.status ?? "dead";
    const daemonPid = daemon?.pid ?? null;
    const lastHeartbeat = relativeAgo(daemon?.last_seen ?? null);

    // Kill switch: the daemon exposes a single engaged flag (kill-switch.flag);
    // there is no separate "armed" state, so engaged ⇒ armed.
    const killSwitch: KillSwitchState | undefined =
        daemon === null
            ? undefined
            : { engaged: daemon.kill_switch_active, armed: daemon.kill_switch_active };

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
        lastHeartbeat,
        circuitBreaker,
        killSwitch,
    };
}

/** "3s ago" / "2m ago" / "5h ago" / "3d ago", or "—" when unknown. */
function relativeAgo(iso: string | null): string {
    if (iso === null) return "—";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    const s = Math.max(0, Math.floor((nowMs() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
