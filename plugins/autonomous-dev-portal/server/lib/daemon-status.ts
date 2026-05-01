// SPEC-013-3-03 §DaemonStatus Reader (used by /health in SPEC-013-3-01).
//
// Reads `~/.autonomous-dev/heartbeat.json` and classifies the daemon
// freshness based on `last_seen`:
//   fresh: now - last_seen <  60_000 ms
//   stale: 60_000 <= delta < 300_000 ms
//   dead : everything else (missing file, malformed JSON, missing/future
//          last_seen, or > 300_000 ms ago)
//
// Per SPEC-013-3-04 the heartbeat directory is overridable via the
// `AUTONOMOUS_DEV_STATE_DIR` env var so tests can write into a tmpdir
// without polluting the real user home.
//
// MUST NOT throw — any I/O or parse error is mapped to status "dead".
// MUST use fs/promises (no sync I/O on the request path).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonStatus {
    status: "fresh" | "stale" | "dead";
    last_seen: string | null;
    pid: number | null;
    active_requests: number;
    kill_switch_active: boolean;
}

const FRESH_THRESHOLD_MS = 60_000;
const STALE_THRESHOLD_MS = 300_000;

const DEAD: DaemonStatus = {
    status: "dead",
    last_seen: null,
    pid: null,
    active_requests: 0,
    kill_switch_active: false,
};

/**
 * Resolve the directory holding `heartbeat.json`. Defaults to
 * `~/.autonomous-dev` but is overridable via `AUTONOMOUS_DEV_STATE_DIR`
 * for test isolation (see SPEC-013-3-04).
 *
 * Resolved on every call (not cached) so tests that mutate the env var
 * during their setup do not have to clear a module-level cache.
 */
function resolveStateDir(): string {
    const override = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    if (override !== undefined && override.length > 0) {
        return override;
    }
    return join(homedir(), ".autonomous-dev");
}

function classify(lastSeenMs: number, now: number): DaemonStatus["status"] {
    const delta = now - lastSeenMs;
    if (delta < 0) return "dead"; // future-dated heartbeat → reject
    if (delta < FRESH_THRESHOLD_MS) return "fresh";
    if (delta < STALE_THRESHOLD_MS) return "stale";
    return "dead";
}

export async function readDaemonStatus(): Promise<DaemonStatus> {
    const path = join(resolveStateDir(), "heartbeat.json");
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        // Missing file, permission denied, etc → dead.
        return { ...DEAD };
    }
    if (raw.trim().length === 0) {
        return { ...DEAD };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ...DEAD };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ...DEAD };
    }
    const obj = parsed as Record<string, unknown>;

    const lastSeen = obj["last_seen"];
    if (typeof lastSeen !== "string" || lastSeen.length === 0) {
        return { ...DEAD };
    }
    const lastSeenMs = Date.parse(lastSeen);
    if (Number.isNaN(lastSeenMs)) {
        return { ...DEAD };
    }
    const now = Date.now();
    const status = classify(lastSeenMs, now);

    const pidVal = obj["pid"];
    const pid = typeof pidVal === "number" && Number.isInteger(pidVal) ? pidVal : null;

    const activeVal = obj["active_requests"];
    const activeRequests =
        typeof activeVal === "number" && Number.isInteger(activeVal) && activeVal >= 0
            ? activeVal
            : 0;

    const ksVal = obj["kill_switch_active"];
    const killSwitchActive = ksVal === true;

    return {
        status,
        last_seen: lastSeen,
        pid,
        active_requests: activeRequests,
        kill_switch_active: killSwitchActive,
    };
}
