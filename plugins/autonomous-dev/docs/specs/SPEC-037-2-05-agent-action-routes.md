# SPEC-037-2-05: Agent Action Routes (promote / shadow / freeze / inspect)

## Metadata
- **Parent Plan**: PLAN-037-2-mount-missing-routes
- **Parent PRD**: PRD-018-portal-visual-redesign (Agents tab)
- **Tasks Covered**: PLAN-037-2 §Scope item 6
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: ELEVATED (mutates agent-factory state; shells to CLI)

## 1. Summary

Add four routes backing the Agents tab: three state-change POSTs (`promote`, `shadow`,
`freeze`) and one read-only `inspect` GET. The POST handlers shell out to the existing
`autonomous-dev agent <verb>` CLI via a typed wrapper; if the underlying CLI verb does
not exist (per PLAN-037-2 risk register), the route MUST stub to 501 with a structured
`agent_action_not_implemented` log entry rather than 404. The inspect GET returns a JSON
snapshot of the agent's current factory record.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                       |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | Register `POST /api/agents/:name/promote`, `POST /api/agents/:name/shadow`, `POST /api/agents/:name/freeze`, `GET /api/agents/:name/inspect` via `buildAgentActionRoutes(deps)`.                   |
| FR-2  | `:name` MUST match `/^[a-z][a-z0-9-]{0,63}$/`. Invalid → 400 `{error:"invalid-name"}`.                                                                                                            |
| FR-3  | Each POST route MUST call `deps.runAgentCli(verb, name)`. The wrapper executes `spawn("autonomous-dev", ["agent", verb, name])` with `timeout: 10_000`, captures stdout/stderr, returns `{ok, code, stdout, stderr}`. |
| FR-4  | If `runAgentCli` returns `{ok:false, code:127}` (command-not-found) OR `{ok:false, stderr:/unknown subcommand/}`, the route MUST return 501 `{error:"not-implemented", verb}` AND emit structured log `agent_action_not_implemented`. |
| FR-5  | On `{ok:true}`, return 200 `text/html` with the updated agent-row fragment for HTMX `outerHTML` swap.                                                                                              |
| FR-6  | On any other failure (non-zero exit, timeout, throw), return 500 with a generic error fragment and emit log `agent_action_failed` including the verb, name, exit code, and a stderr excerpt (first 512 chars, no secrets — pass through `SecretRedactor`). |
| FR-7  | Each successful mutation MUST append an audit entry `agent_promoted`, `agent_shadowed`, or `agent_frozen` including the name, actor, and exit code.                                                |
| FR-8  | `GET /api/agents/:name/inspect` MUST return `application/json` `{ name, state, trustLevel, lastPromotion, evals: {...} }`. On unknown agent, 404 `{error:"not-found"}`.                            |
| FR-9  | All four routes MUST require authentication; the three POSTs MUST honor upstream CSRF middleware. The GET is exempt from CSRF (safe method).                                                       |
| FR-10 | Concurrent action requests against the same `:name` MUST be serialized via a per-name in-process mutex so two clicks cannot interleave CLI invocations.                                            |

## 3. Acceptance Criteria

### AC-1: Promote happy path (FR-3, FR-5, FR-7)
```
POST /api/agents/coder/promote with valid CSRF
→ 200 + row fragment (chip "promoted")
→ runAgentCli called with ("promote","coder")
→ audit entry agent_promoted appended
```

### AC-2: Invalid name (FR-2)
```
POST /api/agents/..%2F..%2F/promote → 400 {"error":"invalid-name"}
```

### AC-3: CLI verb missing → 501 (FR-4)
```
Given runAgentCli stub returns {ok:false, code:127}
POST /api/agents/coder/shadow → 501 {"error":"not-implemented","verb":"shadow"}
→ log line agent_action_not_implemented emitted
```

### AC-4: CLI throws / timeout (FR-6)
```
runAgentCli timeout after 10s → 500 + generic error fragment + log agent_action_failed
```

### AC-5: Inspect happy path (FR-8)
```
GET /api/agents/coder/inspect → 200 application/json with {name,state,trustLevel,...}
```

### AC-6: Inspect unknown (FR-8)
```
GET /api/agents/does-not-exist/inspect → 404 {"error":"not-found"}
```

### AC-7: Concurrent serialization (FR-10)
```
Two parallel POST /api/agents/coder/promote requests
→ runAgentCli invoked TWICE but never concurrently for the same name
→ second response sees the state mutated by the first
```

### AC-8: CSRF rejection
```
POST without valid CSRF token → 403 upstream
```

## 4. Implementation

**File: `plugins/autonomous-dev-portal/server/routes/agents-actions.ts`** (new).

```ts
import { Hono } from "hono";
import { spawn } from "node:child_process";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const CLI_TIMEOUT_MS = 10_000;

export interface AgentCliResult {
    ok: boolean; code: number; stdout: string; stderr: string;
}
export interface AgentActionDeps {
    runAgentCli: (verb: "promote"|"shadow"|"freeze", name: string) => Promise<AgentCliResult>;
    readAgentRecord: (name: string) => Promise<AgentRecord | null>;
    renderRow: (rec: AgentRecord) => JSX.Element;
    audit: AuditLogger;
    logger: { warn: (e: string, f?: object) => void; error: (e: string, f?: object) => void };
}

export function buildAgentActionRoutes(deps: AgentActionDeps): Hono {
    const r = new Hono();
    const locks = new Map<string, Promise<void>>();
    const withLock = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const prev = locks.get(name) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((res) => { release = res; });
        locks.set(name, prev.then(() => next));
        await prev;
        try { return await fn(); } finally { release(); locks.delete(name); }
    };
    const handle = (verb: "promote"|"shadow"|"freeze") => async (c) => {
        const name = c.req.param("name");
        if (!NAME_RE.test(name)) return c.json({ error: "invalid-name" }, 400);
        return withLock(name, async () => {
            const res = await deps.runAgentCli(verb, name);
            if (!res.ok && (res.code === 127 || /unknown subcommand/i.test(res.stderr))) {
                deps.logger.warn("agent_action_not_implemented", { verb, name });
                return c.json({ error: "not-implemented", verb }, 501);
            }
            if (!res.ok) {
                deps.logger.error("agent_action_failed",
                    { verb, name, code: res.code, stderr: res.stderr.slice(0, 512) });
                return c.html(/* generic error fragment */, 500);
            }
            await deps.audit.append({ event: `agent_${verb === "promote"?"promoted":verb==="shadow"?"shadowed":"frozen"}`, name });
            const rec = await deps.readAgentRecord(name);
            return c.html(deps.renderRow(rec!));
        });
    };
    r.post("/api/agents/:name/promote", handle("promote"));
    r.post("/api/agents/:name/shadow",  handle("shadow"));
    r.post("/api/agents/:name/freeze",  handle("freeze"));
    r.get("/api/agents/:name/inspect", async (c) => {
        const name = c.req.param("name");
        if (!NAME_RE.test(name)) return c.json({ error: "invalid-name" }, 400);
        const rec = await deps.readAgentRecord(name);
        if (rec === null) return c.json({ error: "not-found" }, 404);
        return c.json(rec);
    });
    return r;
}
```

## 5. Tests

**Integration — `tests/integration/agents-actions.test.ts`:**

| Test ID | Scenario                  | Assert                                                       |
|---------|---------------------------|--------------------------------------------------------------|
| AG-01   | promote happy             | 200 + row + audit entry                                      |
| AG-02   | invalid name              | 400                                                          |
| AG-03   | CLI verb missing → 501    | 501 + WARN log                                               |
| AG-04   | CLI failure → 500         | 500 + ERROR log + audit NOT appended                         |
| AG-05   | inspect happy             | 200 JSON                                                     |
| AG-06   | inspect unknown           | 404                                                          |
| AG-07   | concurrent same-name      | CLI invocations serialized                                   |
| AG-08   | CSRF rejection            | 403                                                          |

## 6. Verification

```bash
curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  http://localhost:8787/api/agents/coder/promote
# Expect: 200 + row fragment OR 501 if CLI verb absent

curl -i -b session=... http://localhost:8787/api/agents/coder/inspect
# Expect: 200 application/json with agent record
```
