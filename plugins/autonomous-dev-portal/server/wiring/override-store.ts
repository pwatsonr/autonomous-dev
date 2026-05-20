// PLAN-042 Phase D — operator override store.
//
// Writes ${req_dir}/verification-override.json with
// { request_id, reason, operator, timestamp } so the daemon's spawn-session
// can recognize the override on its next iteration and preserve the agent's
// original envelope rather than overwriting to status=fail.
//
// The req_dir is resolved against project worktrees under
// `${AUTONOMOUS_DEV_STATE_DIR or ~/.autonomous-dev}/requests/<id>` first
// (where the daemon's per-request scratch lives in the e2e flows used by
// the autonomous-dev pipeline). If that is not present, we fall back to
// scanning known project worktrees for `.autonomous-dev/requests/<id>`.
//
// The route handler is fs-agnostic — it takes a `writeOverride` callback —
// so unit tests can stub the disk write without monkey-patching node:fs.

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
    OverrideInput,
    OverrideResult,
} from "../routes/override";
import {
    requestActionsDir,
    stateDirRoot,
} from "./state-paths";

/**
 * Atomically write a JSON file with mode 0600. We use a tmp+rename so a
 * concurrent reader never sees a torn write.
 */
async function writeJsonAtomic(
    path: string,
    payload: Record<string, unknown>,
): Promise<void> {
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), {
        mode: 0o600,
    });
    const { rename } = await import("node:fs/promises");
    await rename(tmp, path);
}

async function dirExists(p: string): Promise<boolean> {
    try {
        const st = await stat(p);
        return st.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Find the request directory for a given REQ id.
 *
 * Search order:
 *   1. `${stateDirRoot()}/requests/<id>` — daemon's central store.
 *   2. `${stateDirRoot()}/worktrees/*\/.autonomous-dev/requests/<id>` —
 *      one level of project worktrees managed under the state root.
 *
 * Returns the path on first hit, or null if none found.
 */
export async function resolveRequestDir(id: string): Promise<string | null> {
    const root = stateDirRoot();
    const central = join(root, "requests", id);
    if (await dirExists(central)) return central;

    const worktreesRoot = join(root, "worktrees");
    if (await dirExists(worktreesRoot)) {
        let projects: string[] = [];
        try {
            projects = await readdir(worktreesRoot);
        } catch {
            projects = [];
        }
        for (const p of projects) {
            const candidate = join(
                worktreesRoot,
                p,
                ".autonomous-dev",
                "requests",
                id,
            );
            if (await dirExists(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * Production override-writer. Resolves the request directory, writes the
 * override file, and also appends a `verification_override` block to the
 * portal's request-action ledger so the request-detail page can render
 * the override state without re-reading the daemon scratch directly.
 */
export async function writeOverrideToDisk(
    input: OverrideInput,
): Promise<OverrideResult> {
    const reqDir = await resolveRequestDir(input.id);
    if (reqDir === null) {
        return { ok: false, reason: "not-found" };
    }

    const overridePath = join(reqDir, "verification-override.json");
    const payload = {
        request_id: input.id,
        reason: input.reason,
        operator: input.operator,
        timestamp: new Date().toISOString(),
    };

    try {
        await writeJsonAtomic(overridePath, payload);
    } catch (err) {
        return {
            ok: false,
            reason: "internal",
            message: err instanceof Error ? err.message : String(err),
        };
    }

    // Mirror the override into the portal's request-action ledger so the
    // request-detail page picks up the new state on its next read. Best-
    // effort: a failure here does not roll back the override write.
    try {
        const actionsDir = requestActionsDir();
        await mkdir(actionsDir, { recursive: true });
        const actionPath = join(actionsDir, `${input.id}.json`);
        let existing: Record<string, unknown> = {};
        try {
            const { readFile } = await import("node:fs/promises");
            const raw = await readFile(actionPath, "utf-8");
            existing = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            existing = {};
        }
        const merged: Record<string, unknown> = {
            ...existing,
            id: input.id,
            repo: input.repo,
            last_action: "verification_override",
            verification_override: {
                enabled: true,
                reason: input.reason,
                set_by: input.operator,
                set_at: payload.timestamp,
            },
        };
        await writeJsonAtomic(actionPath, merged);
    } catch {
        // Audit-log entry still writes via the route's AuditAppender; the
        // request-action mirror is just a UI convenience.
    }

    return { ok: true };
}
