// SPEC-015-2-05 §State Factory — Write a syntactically valid state.json to
// disk. Schema follows the daemon contract (TDD-001 / SPEC-015-1-03 schemas)
// so the StateReader can ingest the fixture without modification.
//
// Test-only utility — uses Node's fs/promises directly rather than going
// through a real reader/writer.

import { promises as fs } from "node:fs";
import { join } from "node:path";

export type FixtureStatus =
    | "pending-approval"
    | "queued"
    | "approved"
    | "rejected"
    | "changes-requested"
    | "cancelled"
    | "completed";

export interface StateOverrides {
    status?: FixtureStatus;
    /** Cost in USD; defaults to 0. */
    cost?: number;
    /** Simulated created_at = now − ageHours. Defaults to 0 (just now). */
    ageHours?: number;
    /** ISO-8601; sets state.escalated_at directly. */
    escalatedAt?: string;
    /** Phase history entries (free-form metadata; tests assert specific shapes). */
    phaseHistory?: Array<Record<string, unknown>>;
    /** Override the repository slug (default: 'test-repo'). */
    repository?: string;
    /** Override the human description / title. */
    description?: string;
}

export interface CreatedStateFixture {
    /** Absolute path to the written state.json. */
    path: string;
    /** Object that was serialised. Useful for assertions. */
    state: Record<string, unknown>;
}

/**
 * Write a state.json under
 * `<repoRoot>/.autonomous-dev/requests/<requestId>/state.json` and return the
 * absolute path.
 */
export async function createState(
    repoRoot: string,
    requestId: string,
    overrides: StateOverrides = {},
): Promise<CreatedStateFixture> {
    const ageHours = overrides.ageHours ?? 0;
    const createdAt = new Date(
        Date.now() - ageHours * 3_600_000,
    ).toISOString();
    const status = overrides.status ?? "pending-approval";
    const repository = overrides.repository ?? "test-repo";
    const description =
        overrides.description ?? `Test request ${requestId}`;

    const state: Record<string, unknown> = {
        schema_version: 1,
        request_id: requestId,
        status,
        priority: "normal",
        description,
        repository,
        source: { kind: "cli" },
        adapter_metadata: {},
        created_at: createdAt,
        updated_at: createdAt,
        phase_history: overrides.phaseHistory ?? [],
        current_phase_metadata: {},
        cost_accrued_usd: overrides.cost ?? 0,
        turn_count: 0,
        escalation_count: 0,
        blocked_by: [],
        error: null,
        last_checkpoint: null,
    };
    if (overrides.escalatedAt !== undefined) {
        state["escalated_at"] = overrides.escalatedAt;
    }

    const dir = join(
        repoRoot,
        ".autonomous-dev",
        "requests",
        requestId,
    );
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, "state.json");
    await fs.writeFile(path, JSON.stringify(state, null, 2), "utf8");
    return { path, state };
}

/** Convenience: read a state.json fixture back. Returns null on ENOENT. */
export async function readState(
    repoRoot: string,
    requestId: string,
): Promise<Record<string, unknown> | null> {
    const path = join(
        repoRoot,
        ".autonomous-dev",
        "requests",
        requestId,
        "state.json",
    );
    try {
        const raw = await fs.readFile(path, "utf8");
        return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
        const e = err as { code?: string };
        if (e.code === "ENOENT") return null;
        throw err;
    }
}
