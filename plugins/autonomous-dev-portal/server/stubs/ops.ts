// SPEC-036-2-04 §FR-10 — Ops stub. Operator-realistic data:
//   3+ MCP entries, 5 plugin-chain categories, 10–15 recentLog entries
//   (mixed levels + ≥2 agent-dispatch lines), 5 deploy events, 3
//   standards changes. Heartbeat: 24h of 5-minute samples (288 buckets).
//
// SPEC-036-2-06 FR-2 — when `~/.autonomous-dev/logs/daemon.log` is
// readable on this host, we tail the last 50 INFO/WARN/ERROR entries
// off it; otherwise we fall back to the static fixture below. File-read
// errors degrade silently (no crash), per spec.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
    HeartbeatSample,
    LogEntry,
    OpsHealth,
} from "../types/render";

const MCP_SERVERS = [
    { name: "filesystem", status: "ok" as const, detail: "12ms" },
    { name: "github", status: "ok" as const, detail: "68ms" },
    { name: "linear", status: "ok" as const, detail: "102ms" },
    { name: "prometheus", status: "warn" as const, detail: "retry 1/3" },
    { name: "sentry", status: "ok" as const, detail: "88ms" },
    { name: "slack", status: "ok" as const, detail: "44ms" },
];

const PLUGIN_CHAIN = [
    {
        name: "CORE",
        accent: "core" as const,
        packages: ["autonomous-dev@2.4.0"],
    },
    {
        name: "REVIEWERS",
        packages: [
            "qa-edge-case@0.4.0",
            "ux-ui@0.3.1",
            "accessibility@0.5.0",
            "rule-set@0.6.2",
        ],
    },
    {
        name: "VARIANTS",
        packages: [
            "security-hardening@1.2.0",
            "frontend@0.9.4",
            "docs-only@1.0.1",
        ],
    },
    {
        name: "DEPLOY",
        packages: ["gcp@2.1.0", "aws@1.8.3", "k8s@1.4.0"],
    },
    {
        name: "ORG",
        accent: "org" as const,
        packages: ["acme-standards@1.5.0"],
    },
];

const FALLBACK_LOG: LogEntry[] = [
    {
        ts: "14:32:04Z",
        level: "INFO",
        message:
            "deploy REQ-20260408-e7c8 stage=health-check backend=github-pages ok",
    },
    {
        ts: "14:31:58Z",
        level: "INFO",
        message:
            "agent rule-set-reviewer@0.6.2 dispatched · 7 standards matched",
    },
    {
        ts: "14:31:54Z",
        level: "WARN",
        message:
            "standard SEC-014 violated · req=REQ-20260408-c91a · halt",
    },
    {
        ts: "14:31:52Z",
        level: "WARN",
        message:
            "notification batch deferred · DND active until 07:00",
    },
    {
        ts: "14:31:48Z",
        level: "INFO",
        message: "phase REQ-20260408-d044 plan → gate (cost-cap)",
    },
    {
        ts: "14:31:42Z",
        level: "INFO",
        message: "agent prd-author@1.0.0 dispatched turns_max=60",
    },
    {
        ts: "14:31:38Z",
        level: "ERROR",
        message: "mcp prometheus query timeout retry=1/3",
    },
    {
        ts: "14:31:34Z",
        level: "INFO",
        message: "mcp prometheus reconnect ok latency=88ms",
    },
    {
        ts: "14:31:30Z",
        level: "INFO",
        message:
            "deploy REQ-20260407-f1e2 backend=gcp env=prod success rev=v204",
    },
    {
        ts: "14:31:24Z",
        level: "INFO",
        message:
            "agent qa-edge-case-reviewer@0.4.0 finished · 2 blocking · runtime=42s",
    },
    {
        ts: "14:31:18Z",
        level: "DEBUG",
        message: "trace state=resolved",
    },
    {
        ts: "14:31:12Z",
        level: "INFO",
        message:
            "variant=security-hardening selected for REQ-20260408-b2d2",
    },
];

const DEPLOY_EVENTS = [
    {
        time: "14:31",
        backend: "gcp",
        env: "prod",
        status: "ok" as const,
        statusLabel: "ok",
    },
    {
        time: "14:14",
        backend: "github-pages",
        env: "docs",
        status: "ok" as const,
        statusLabel: "ok",
    },
    {
        time: "13:48",
        backend: "k8s",
        env: "staging",
        status: "ok" as const,
        statusLabel: "ok",
    },
    {
        time: "12:22",
        backend: "aws",
        env: "edge",
        status: "warn" as const,
        statusLabel: "degraded",
    },
    {
        time: "09:52",
        backend: "gcp",
        env: "prod",
        status: "err" as const,
        statusLabel: "rolled back",
    },
];

const STANDARDS_CHANGES = [
    {
        time: "2h ago",
        text: "SEC-014 promoted to blocking · org overlay",
    },
    {
        time: "4h ago",
        text: "New rule A11Y-001 registered · WCAG 1.4.3 contrast",
    },
    {
        time: "1d ago",
        text: "FMT-001 downgraded to advisory · repo-level override",
    },
];

/** Build 24h of 5-minute heartbeat samples (288 buckets). */
function buildHeartbeat(): HeartbeatSample[] {
    const out: HeartbeatSample[] = [];
    const now = Date.now();
    for (let i = 287; i >= 0; i--) {
        const ts = new Date(now - i * 5 * 60_000).toISOString();
        // Mostly healthy, with occasional slow buckets and a single miss
        // mid-window for visual interest.
        let status: HeartbeatSample["status"] = "ok";
        let latencyMs = 80 + (i % 7) * 6;
        if (i % 41 === 0) {
            status = "slow";
            latencyMs = 320;
        }
        if (i === 144) {
            status = "miss";
            latencyMs = 500;
        }
        out.push({ ts, latencyMs, status });
    }
    return out;
}

const LOG_LINE_RE = /^([0-9T:\-Z.]+)\s+(INFO|WARN|ERROR|ERR|DEBUG|TRACE)\s+(.*)$/;

/**
 * Parse the last 50 INFO/WARN/ERROR entries from the daemon log file.
 * Silent fallback: any read or parse failure yields `null` so the
 * caller substitutes the static fixture below.
 */
async function tailDaemonLog(): Promise<LogEntry[] | null> {
    try {
        const path = join(homedir(), ".autonomous-dev", "logs", "daemon.log");
        const raw = await readFile(path, "utf8");
        const lines = raw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        const parsed: LogEntry[] = [];
        for (let i = lines.length - 1; i >= 0 && parsed.length < 50; i--) {
            const line = lines[i];
            if (!line) continue;
            const m = LOG_LINE_RE.exec(line);
            if (!m) continue;
            const ts = m[1];
            const level = m[2];
            const message = m[3];
            if (!ts || !level || message === undefined) continue;
            const u = level.toUpperCase();
            if (u === "DEBUG" || u === "TRACE") continue;
            parsed.unshift({ ts, level, message });
        }
        if (parsed.length === 0) return null;
        return parsed;
    } catch {
        return null;
    }
}

const BASE: OpsHealth = {
    daemon: { status: "running", pid: 18472 },
    components: { http: "ok", templates: "ok", database: "ok" },
    mcpServers: MCP_SERVERS,
    pluginChain: PLUGIN_CHAIN,
    recentLog: FALLBACK_LOG,
    deployEvents: DEPLOY_EVENTS,
    standardsChanges: STANDARDS_CHANGES,
    standardsCount: 24,
    immutableCount: 6,
    heartbeat: buildHeartbeat(),
    circuitBreaker: {
        state: "closed",
        failureCount: 0,
        changedAt: null,
    },
    killSwitch: { engaged: false, armed: false },
    uptime: "4d 12h",
};

export async function loadOpsStub(): Promise<OpsHealth> {
    const tail = await tailDaemonLog();
    return tail ? { ...BASE, recentLog: tail } : BASE;
}
