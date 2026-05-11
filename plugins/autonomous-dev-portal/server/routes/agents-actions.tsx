// SPEC-037-2-05 — Agent action routes.
//
// Four endpoints back the Agents tab:
//
//   POST /api/agents/:name/promote   → 200 row fragment / 501 / 500
//   POST /api/agents/:name/shadow    → 200 row fragment / 501 / 500
//   POST /api/agents/:name/freeze    → 200 row fragment / 501 / 500
//   GET  /api/agents/:name/inspect   → 200 JSON / 404
//
// Risk-register honor: if the underlying `autonomous-dev agent <verb>` CLI
// verb does not exist yet, the route returns 501 + a structured WARN log
// instead of 404. This makes the wiring gap visible to operators.
//
// Concurrency: a per-name in-process mutex serializes mutations against
// the same agent so two simultaneous clicks cannot interleave CLI
// invocations. Different agents proceed in parallel.

import { Hono } from "hono";

import type { ActionLogger, AuditAppender } from "./_action-deps";
import { noopActionLogger, resolveActor } from "./_action-deps";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const CLI_TIMEOUT_MS = 10_000;

export type AgentVerb = "promote" | "shadow" | "freeze";

export interface AgentCliResult {
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
}

export interface AgentInspectRecord {
    name: string;
    state: string;
    trustLevel?: string;
    lastPromotion?: string | null;
    evals?: Record<string, unknown>;
    [k: string]: unknown;
}

export interface AgentActionDeps {
    /**
     * Run the underlying CLI. Production wires this to a `Bun.spawn`-based
     * wrapper similar to `lib/daemon-halt.ts`. Tests inject a deterministic
     * stub.
     */
    runAgentCli: (
        verb: AgentVerb,
        name: string,
        /**
         * Optional verb-specific argument. Used by `promote` to pass the
         * target version. Other verbs ignore it.
         */
        arg?: string,
    ) => Promise<AgentCliResult>;
    /** Read an agent's current factory record. Returns null when unknown. */
    readAgentRecord: (name: string) => Promise<AgentInspectRecord | null>;
    /** Render the row fragment for a given record (after mutation). */
    renderRow: (record: AgentInspectRecord) => JSX.Element;
    audit: AuditAppender;
    logger?: ActionLogger;
    /** Override the CLI timeout in tests. */
    cliTimeoutMs?: number;
}

function pastTenseEvent(verb: AgentVerb): string {
    if (verb === "promote") return "agent_promoted";
    if (verb === "shadow") return "agent_shadowed";
    return "agent_frozen";
}

function genericErrorFragment(): JSX.Element {
    return (
        <div class="agent-row agent-error">
            <span class="chip err">ERROR</span>
            <span class="meta">
                Agent action failed. Check daemon logs and retry.
            </span>
        </div>
    );
}

function isUnknownSubcommand(stderr: string): boolean {
    return /unknown\s+(sub)?command/i.test(stderr);
}

/**
 * Per-name async mutex. Promises are chained so a second caller for the
 * same name awaits the prior promise's resolution before running its own
 * body. Different names never contend.
 */
function makeNameLock(): <T>(
    name: string,
    fn: () => Promise<T>,
) => Promise<T> {
    const locks = new Map<string, Promise<unknown>>();
    return async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        const prev = locks.get(name) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        // Track regardless of resolution outcome.
        locks.set(
            name,
            next.catch(() => undefined),
        );
        try {
            return (await next) as T;
        } finally {
            // Best-effort GC: only remove if no one else queued in the
            // meantime (i.e. the slot still points at this promise).
            if (locks.get(name) === next.catch(() => undefined)) {
                locks.delete(name);
            }
        }
    };
}

/** Build the agent action sub-router. */
export function buildAgentActionRoutes(
    deps: AgentActionDeps,
): Hono {
    const logger = deps.logger ?? noopActionLogger();
    const withLock = makeNameLock();
    const router = new Hono();

    const handle = (verb: AgentVerb) =>
        async (c: import("hono").Context): Promise<Response> => {
            const name = c.req.param("name");
            if (typeof name !== "string" || !NAME_RE.test(name)) {
                return c.json({ error: "invalid-name" }, 400);
            }
            // Extract optional version for `promote`; HTMX posts can
            // submit form-encoded or query-string `?version=X` — accept
            // both.
            let arg: string | undefined;
            if (verb === "promote") {
                const fromQuery = c.req.query("version");
                if (typeof fromQuery === "string" && fromQuery.length > 0) {
                    arg = fromQuery;
                } else {
                    try {
                        const body = await c.req.parseBody();
                        const v = body["version"];
                        if (typeof v === "string" && v.length > 0) arg = v;
                    } catch {
                        // body may be empty / non-form — leave arg undefined
                    }
                }
                if (arg === undefined) {
                    return c.json({ error: "version-required" }, 400);
                }
            }
            return await withLock(name, async () => {
                let res: AgentCliResult;
                try {
                    res = await deps.runAgentCli(verb, name, arg);
                } catch (err) {
                    logger.error("agent_action_failed", {
                        verb,
                        name,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return c.html(genericErrorFragment(), 500);
                }
                if (!res.ok && (res.code === 127 || isUnknownSubcommand(res.stderr))) {
                    logger.warn("agent_action_not_implemented", {
                        verb,
                        name,
                        code: res.code,
                    });
                    return c.json({ error: "not-implemented", verb }, 501);
                }
                if (!res.ok) {
                    logger.error("agent_action_failed", {
                        verb,
                        name,
                        code: res.code,
                        stderr: res.stderr.slice(0, 512),
                    });
                    return c.html(genericErrorFragment(), 500);
                }
                const actor = resolveActor(c.get("auth"));
                await deps.audit.append({
                    event: pastTenseEvent(verb),
                    name,
                    actor,
                    code: res.code,
                });
                const record = await deps.readAgentRecord(name);
                if (record === null) {
                    logger.warn("agent_record_missing_after_mutation", {
                        verb,
                        name,
                    });
                    return c.html(genericErrorFragment(), 500);
                }
                return c.html(deps.renderRow(record));
            });
        };

    router.post("/api/agents/:name/promote", handle("promote"));
    router.post("/api/agents/:name/shadow", handle("shadow"));
    router.post("/api/agents/:name/freeze", handle("freeze"));

    router.get("/api/agents/:name/inspect", async (c) => {
        const name = c.req.param("name");
        if (typeof name !== "string" || !NAME_RE.test(name)) {
            return c.json({ error: "invalid-name" }, 400);
        }
        const record = await deps.readAgentRecord(name);
        if (record === null) {
            return c.json({ error: "not-found" }, 404);
        }
        return c.json(record);
    });

    return router;
}

/** Exported for tests; do not use in production hot paths. */
export const __test__ = {
    NAME_RE,
    CLI_TIMEOUT_MS,
    isUnknownSubcommand,
};
