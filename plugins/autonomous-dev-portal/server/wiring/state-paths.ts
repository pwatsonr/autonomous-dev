// PLAN-037-2 §wire-action-routes — canonical filesystem layout for the
// portal's backing-store files.
//
// All paths honor `AUTONOMOUS_DEV_STATE_DIR` so tests can redirect into a
// per-test temp directory without monkey-patching `os.homedir()`. The
// production default is `~/.autonomous-dev/...` (matches daemon-status.ts
// and the existing daemon heartbeat layout).

import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the state directory root, honoring the env override. */
export function stateDirRoot(): string {
    const override = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    if (override !== undefined && override.length > 0) return override;
    return join(homedir(), ".autonomous-dev");
}

/**
 * The daemon's pending-approval queue lives at:
 *   ${state_dir}/approvals-queue.json
 * The portal mutates this file under an atomic write; the daemon picks up
 * the new state on its next iteration.
 */
export function approvalsQueuePath(): string {
    return join(stateDirRoot(), "approvals-queue.json");
}

/**
 * Per-id marker files for gate decisions. The daemon's gate-loop scans
 * this directory on each iteration and applies any present decisions.
 */
export function gateDecisionsDir(): string {
    return join(stateDirRoot(), "gate-decisions");
}

export function gateDecisionPath(repo: string, id: string): string {
    // The daemon de-duplicates against the basename, so embedding the repo
    // disambiguates the same request-id appearing in two repositories.
    return join(gateDecisionsDir(), `${repo}__${id}.json`);
}

/**
 * Per-id marker files for generic request actions (retry / skip / cancel /
 * escalate). Same daemon-poll model as gate decisions.
 */
export function requestActionsDir(): string {
    return join(stateDirRoot(), "request-actions");
}

export function requestActionPath(id: string): string {
    return join(requestActionsDir(), `${id}.json`);
}

/**
 * The portal's audit-log file (HMAC-chained NDJSON). Distinct from the
 * daemon's audit log so a portal compromise cannot rewrite daemon history.
 */
export function portalAuditPath(): string {
    return join(stateDirRoot(), "portal-audit.log");
}

/**
 * The user-facing settings file that both the portal and daemon read.
 * `~/.claude/autonomous-dev.json` per CLAUDE convention.
 */
export function userConfigPath(): string {
    const override = process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    if (override !== undefined && override.length > 0) return override;
    return join(homedir(), ".claude", "autonomous-dev.json");
}
