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
 * Per-change marker files for portal-originated configuration edits
 * (PRD-025 FR-025-05 / #353). The portal writes a marker here instead of
 * mutating the user config directly; the daemon's reconcile step validates
 * and applies it (mirrors the gate-decision / request-action poll model), so
 * every config change is daemon-mediated, validated, and audited.
 */
export function configChangesDir(): string {
    return join(stateDirRoot(), "config-changes");
}

export function configChangePath(id: string): string {
    return join(configChangesDir(), `${id}.json`);
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

// PLAN-038 TASK-008 — new paths for the Track-C readers.
//
// O.Q. #2 resolution: there is NO daemon-written `requests-ledger.json`
// (v1.0/v1.1 of TDD-037 assumed there was; it does not exist). The
// request-ledger reader aggregates from `requestActionsDir()` and
// `gateDecisionsDir()` above. No new function needed for that.
//
// O.Q. #3 resolution: the daemon's CLI bridge writes `agent-states.json`
// at the state-dir root (plugins/autonomous-dev/bin/agent-cli.ts:61).
// Its real shape is thin — `{v, frozen[], shadowed[], updatedAt}`.

/**
 * Lifecycle state for plugin agents. Written by the `autonomous-dev agent`
 * CLI bridge; read by the portal's Agents surface (TASK-010).
 */
export function agentStatesPath(): string {
    return join(stateDirRoot(), "agent-states.json");
}

/**
 * Canonical kit-parity fixture root. CI screenshot regression points
 * `AUTONOMOUS_DEV_STATE_DIR` here to reproduce the kit-screenshot KPIs
 * from real reader code paths (no demo-mode flag, no stub bypass).
 *
 * Resolved relative to the package root (`plugins/autonomous-dev-portal/`)
 * via `import.meta.dir` so the path is stable regardless of `process.cwd()`.
 */
export function kitParityFixtureRoot(): string {
    // `import.meta.dir` resolves to `server/wiring/`; `../../server/fixtures`
    // walks back to `server/fixtures/`. The `kit-parity` subdir is committed
    // to source.
    return join(import.meta.dir, "..", "fixtures", "kit-parity");
}
