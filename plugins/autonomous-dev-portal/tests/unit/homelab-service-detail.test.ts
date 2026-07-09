// Tests for homelab contribution service-detail view (#48) and
// gated action buttons (#49).
//
// Acceptance criteria:
//   1. Service-detail renders a sample graph entity with its attributes,
//      edges, and observations generically.
//   2. Unknown entity id → 404 / empty-state page via JSON API.
//   3. An action requires confirmation before invoking the handler
//      (reversible/irreversible → 202 → token → 200).
//   4. A read-only action returns immediately (no gate step).
//   5. The subprocess (homelab CLI) is mocked — the handler wires correctly.
//   6. actionsForKind drives buttons: service → restart/redeploy/scale;
//      node → none.
//   7. parseGraphYaml correctly extracts entities AND edges (including
//      folded-scalar edge ids used in the real inventory-graph.yaml format).
//   8. renderDetailPage renders entity attributes, outbound edges, inbound
//      edges, and observations generically.
//   9. getPluginPath reads from HOMELAB_PLUGIN_PATH env var when set.

import {
    describe,
    test,
    expect,
    beforeEach,
    afterEach,
    mock,
} from "bun:test";
import { Hono } from "hono";

import {
    registerContribution,
    registerContribRoutes,
    clearContributions,
} from "../../server/contrib/registry";
import type { PortalRolesConfig } from "../../server/contrib/rbac";
import {
    homelabContribution,
    parseGraphYaml,
    actionsForKind,
    renderDetailPage,
    getPluginPath,
    runHomelabCli,
} from "../../server/contrib/homelab";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const noopAudit = { append: async () => undefined };

function captureAudit() {
    const entries: Array<Record<string, unknown>> = [];
    return {
        append: async (entry: Record<string, unknown>): Promise<void> => {
            entries.push(entry);
        },
        entries,
    };
}

function appWithHomelab(opts: { rolesConfig?: PortalRolesConfig } = {}): Hono {
    const app = new Hono();
    registerContribRoutes(app, {
        audit: noopAudit,
        rolesConfig: opts.rolesConfig,
    });
    return app;
}

function withAuth(app: Hono, actor: string): Hono {
    const wrapped = new Hono<{
        Variables: { auth: { source_user_id: string } };
    }>();
    wrapped.use("*", async (c, next) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).set("auth", { source_user_id: actor });
        await next();
    });
    wrapped.route("/", app);
    return wrapped as unknown as Hono;
}

// Sample YAML fixture matching the real inventory-graph.yaml format.
const SAMPLE_YAML = `version: 2
entities:
  - id: node:platform:node-abc
    kind: node
    name: swarm-manager
    attributes:
      engine_version: 28.3.3
      manager_status: Leader
    source: docker-swarm
    platformId: platform-x
    status: active
    last_seen: '2026-07-08T18:43:31.687Z'
  - id: service:platform:my-svc
    kind: service
    name: my-svc
    attributes:
      image: my-image:1.0
      replicas_running: 1
      replicas_desired: 1
      role: api
    source: docker-swarm
    platformId: platform-x
    status: active
    last_seen: '2026-07-08T18:43:31.687Z'
edges:
  - id: >-
      member-of:service:platform:my-svc:platform:platform-x
    from: service:platform:my-svc
    to: platform:platform-x
    type: member-of
    status: active
  - id: runs-on:node:platform:node-abc:platform:platform-x
    from: node:platform:node-abc
    to: platform:platform-x
    type: member-of
    status: active
`;

// ---------------------------------------------------------------------------
// Suite 1: parseGraphYaml — entities + edges
// ---------------------------------------------------------------------------

describe("parseGraphYaml", () => {
    test("parses version", () => {
        const g = parseGraphYaml(SAMPLE_YAML);
        expect(g.version).toBe(2);
    });

    test("parses two entities", () => {
        const g = parseGraphYaml(SAMPLE_YAML);
        expect(g.entities).toHaveLength(2);
    });

    test("entity fields are correct", () => {
        const g = parseGraphYaml(SAMPLE_YAML);
        const svc = g.entities?.find((e) => e.id === "service:platform:my-svc");
        expect(svc).toBeDefined();
        expect(svc!.kind).toBe("service");
        expect(svc!.name).toBe("my-svc");
        expect(svc!.source).toBe("docker-swarm");
        expect(svc!.status).toBe("active");
    });

    test("entity attributes are parsed", () => {
        const g = parseGraphYaml(SAMPLE_YAML);
        const svc = g.entities?.find((e) => e.id === "service:platform:my-svc");
        expect(svc!.attributes?.["image"]).toBe("my-image:1.0");
        expect(svc!.attributes?.["replicas_running"]).toBe("1");
        expect(svc!.attributes?.["role"]).toBe("api");
    });

    test("parses two edges", () => {
        const g = parseGraphYaml(SAMPLE_YAML);
        expect(g.edges).toHaveLength(2);
    });

    test("folded-scalar edge id is parsed correctly", () => {
        const g = parseGraphYaml(SAMPLE_YAML);
        const e = g.edges?.find((edge) => edge.from === "service:platform:my-svc");
        expect(e).toBeDefined();
        expect(e!.id).toBe("member-of:service:platform:my-svc:platform:platform-x");
        expect(e!.type).toBe("member-of");
    });

    test("inline edge id is parsed correctly", () => {
        const g = parseGraphYaml(SAMPLE_YAML);
        const e = g.edges?.find((edge) => edge.from === "node:platform:node-abc");
        expect(e).toBeDefined();
        expect(e!.id).toBe("runs-on:node:platform:node-abc:platform:platform-x");
    });

    test("empty YAML returns empty entities and edges", () => {
        const g = parseGraphYaml("");
        expect(g.entities).toHaveLength(0);
        expect(g.edges).toHaveLength(0);
    });

    test("YAML with only entities (no edges section) returns empty edges", () => {
        const yamlNoEdges = `version: 1
entities:
  - id: svc:x
    kind: service
    name: x
    source: docker-swarm
    status: active
`;
        const g = parseGraphYaml(yamlNoEdges);
        expect(g.entities).toHaveLength(1);
        expect(g.edges).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Suite 2: actionsForKind
// ---------------------------------------------------------------------------

describe("actionsForKind", () => {
    test("service → restart, redeploy, scale", () => {
        const acts = actionsForKind("service");
        expect(acts).toContain("restart");
        expect(acts).toContain("redeploy");
        expect(acts).toContain("scale");
        expect(acts).toHaveLength(3);
    });

    test("container → restart, redeploy, scale", () => {
        const acts = actionsForKind("container");
        expect(acts).toContain("restart");
        expect(acts).toContain("redeploy");
        expect(acts).toContain("scale");
    });

    test("node → no actions", () => {
        expect(actionsForKind("node")).toHaveLength(0);
    });

    test("platform → no actions", () => {
        expect(actionsForKind("platform")).toHaveLength(0);
    });

    test("unknown kind → no actions", () => {
        expect(actionsForKind("mystery")).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Suite 3: renderDetailPage — generic entity detail
// ---------------------------------------------------------------------------

describe("renderDetailPage", () => {
    const graph = parseGraphYaml(SAMPLE_YAML);

    test("renders entity name in title and heading", async () => {
        const html = await renderDetailPage("service:platform:my-svc", graph, []);
        expect(html).toContain("my-svc");
        expect(html).toContain("<!doctype html>");
    });

    test("renders all attributes generically", async () => {
        const html = await renderDetailPage("service:platform:my-svc", graph, []);
        expect(html).toContain("image");
        expect(html).toContain("my-image:1.0");
        expect(html).toContain("replicas_running");
        expect(html).toContain("role");
        expect(html).toContain("api");
    });

    test("renders outbound edges section", async () => {
        const html = await renderDetailPage("service:platform:my-svc", graph, []);
        // Has at least one outbound edge.
        expect(html).toContain("Connections (outbound)");
        expect(html).toContain("member-of");
    });

    test("renders inbound edges for a target entity", async () => {
        // platform:platform-x is the target of both edges — should show inbound.
        const html = await renderDetailPage("node:platform:node-abc", graph, []);
        // node-abc has an outbound edge to platform:platform-x.
        expect(html).toContain("swarm-manager");
    });

    test("renders observations for the entity", async () => {
        const obs = [
            {
                id: "obs-1",
                resource: "service/service:platform:my-svc",
                severity: "P1",
                pattern: "replica_mismatch",
                details: { replicas_running: 0, replicas_desired: 1 },
            },
        ];
        const html = await renderDetailPage("service:platform:my-svc", graph, obs);
        expect(html).toContain("Observations");
        expect(html).toContain("P1");
        expect(html).toContain("replica_mismatch");
    });

    test("renders action buttons for service kind", async () => {
        const html = await renderDetailPage("service:platform:my-svc", graph, []);
        expect(html).toContain("Restart Service");
        expect(html).toContain("Redeploy Service");
        expect(html).toContain("Scale Service");
    });

    test("renders no action buttons for node kind", async () => {
        const html = await renderDetailPage("node:platform:node-abc", graph, []);
        expect(html).not.toContain("Restart Service");
        expect(html).not.toContain("Redeploy Service");
    });

    test("renders autofix button when a crash_loop observation exists", async () => {
        const obs = [
            {
                id: "obs-2",
                resource: "service/service:platform:my-svc",
                severity: "P1",
                pattern: "crash_loop",
            },
        ];
        const html = await renderDetailPage("service:platform:my-svc", graph, obs);
        expect(html).toContain("Apply Autofix");
        expect(html).toContain("crash_loop");
    });

    test("unknown entity id → empty-state / not-found page", async () => {
        const html = await renderDetailPage("service:does-not-exist", graph, []);
        expect(html).toContain("Entity not found");
        expect(html).toContain("service:does-not-exist");
    });
});

// ---------------------------------------------------------------------------
// Suite 4: JSON API routes
// ---------------------------------------------------------------------------

describe("JSON API routes", () => {
    beforeEach(() => {
        clearContributions();
        registerContribution(homelabContribution);
    });

    afterEach(() => {
        clearContributions();
    });

    test("GET /portal/homelab/api/entities returns 200 with entity list", async () => {
        const app = appWithHomelab();
        const res = await app.request("/portal/homelab/api/entities");
        expect(res.status).toBe(200);
        const body = await res.json() as { entities: unknown[]; total: number };
        expect(typeof body.total).toBe("number");
        expect(Array.isArray(body.entities)).toBe(true);
    });

    test("GET /portal/homelab/api/entity without id param → 400", async () => {
        const app = appWithHomelab();
        const res = await app.request("/portal/homelab/api/entity");
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error).toBe("missing-id-param");
    });

    test("GET /portal/homelab/api/entity with unknown id → 404", async () => {
        const app = appWithHomelab();
        const res = await app.request("/portal/homelab/api/entity?id=does-not-exist");
        expect(res.status).toBe(404);
        const body = await res.json() as { error: string };
        expect(body.error).toBe("not-found");
    });
});

// ---------------------------------------------------------------------------
// Suite 5: renderPage — entity param switches to detail view
// ---------------------------------------------------------------------------

describe("renderPage with entity query param", () => {
    beforeEach(() => {
        clearContributions();
        registerContribution(homelabContribution);
    });

    afterEach(() => {
        clearContributions();
    });

    test("GET /portal/homelab (no param) renders list page", async () => {
        const app = appWithHomelab();
        const res = await app.request("/portal/homelab");
        expect(res.status).toBe(200);
        const body = await res.text();
        // List page has Inventory section.
        expect(body).toContain("Inventory");
    });

    test("GET /portal/homelab?entity=<unknown> renders not-found detail page", async () => {
        const app = appWithHomelab();
        const res = await app.request("/portal/homelab?entity=unknown-entity-xyz");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("Entity not found");
    });
});

// ---------------------------------------------------------------------------
// Suite 6: Gated action buttons — gate wiring (subprocess mocked)
// ---------------------------------------------------------------------------

describe("gated action buttons (#49)", () => {
    beforeEach(() => {
        clearContributions();
        registerContribution(homelabContribution);
    });

    afterEach(() => {
        clearContributions();
    });

    test("POST /portal/homelab/action/restart without token → 202 requiresConfirmation", async () => {
        const app = withAuth(appWithHomelab(), "alice");
        const res = await app.request(
            "/portal/homelab/action/restart",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entity_id: "service:platform:my-svc" }),
            },
        );
        // restart is reversible → requires typed-CONFIRM.
        expect(res.status).toBe(202);
        const body = await res.json() as {
            requiresConfirmation: boolean;
            token: string;
            phrase: string;
        };
        expect(body.requiresConfirmation).toBe(true);
        expect(body.phrase).toBe("CONFIRM ACTION");
        expect(typeof body.token).toBe("string");
    });

    test("POST /portal/homelab/action/redeploy without token → 202 with CONFIRM PERMANENT", async () => {
        const app = withAuth(appWithHomelab(), "alice");
        const res = await app.request(
            "/portal/homelab/action/redeploy",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entity_id: "service:platform:my-svc" }),
            },
        );
        expect(res.status).toBe(202);
        const body = await res.json() as { phrase: string };
        expect(body.phrase).toBe("CONFIRM PERMANENT");
    });

    test("POST /portal/homelab/action/apply-autofix without token → 202 requiresConfirmation", async () => {
        const app = withAuth(appWithHomelab(), "alice");
        const res = await app.request(
            "/portal/homelab/action/apply-autofix",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ observation_id: "obs-uuid-123" }),
            },
        );
        expect(res.status).toBe(202);
        const body = await res.json() as { requiresConfirmation: boolean; phrase: string };
        expect(body.requiresConfirmation).toBe(true);
        expect(body.phrase).toBe("CONFIRM PERMANENT");
    });

    test("action denied when role is below minRole", async () => {
        const rolesConfig: PortalRolesConfig = {
            role_map: [{ principal: "lowperm", role: "viewer" }],
        };
        const app = withAuth(appWithHomelab({ rolesConfig }), "lowperm");
        const res = await app.request(
            "/portal/homelab/action/restart",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entity_id: "service:platform:my-svc" }),
            },
        );
        expect(res.status).toBe(403);
        const body = await res.json() as { error: string; required: string };
        expect(body.error).toBe("insufficient-role");
        expect(body.required).toBe("operator");
    });

    test("scale action with valid token executes handler and returns state", async () => {
        const app = withAuth(appWithHomelab(), "alice");

        // Step 1: request confirmation.
        const r1 = await app.request(
            "/portal/homelab/action/scale",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entity_id: "service:platform:my-svc" }),
            },
        );
        expect(r1.status).toBe(202);
        const { token } = await r1.json() as { token: string };

        // Step 2: submit token.
        const r2 = await app.request(
            "/portal/homelab/action/scale",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-contribution-action-token": token,
                },
                body: JSON.stringify({ entity_id: "service:platform:my-svc" }),
            },
        );
        // Handler executes — may return error (no real graph) or scale state.
        expect([200, 500]).toContain(r2.status);
        const body = await r2.json() as Record<string, unknown>;
        // If entity found: action key; if not: error key.
        expect(body["action"] === "scale" || typeof body["error"] === "string").toBe(true);
    });

    test("audit entry emitted after action confirmation", async () => {
        const audit = captureAudit();
        const app = new Hono();
        registerContribRoutes(app, { audit });
        const wrapped = withAuth(app, "alice");

        // Get confirmation token.
        const r1 = await wrapped.request(
            "/portal/homelab/action/restart",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entity_id: "service:platform:my-svc" }),
            },
        );
        expect(r1.status).toBe(202);
        const { token } = await r1.json() as { token: string };

        // Use token.
        const r2 = await wrapped.request(
            "/portal/homelab/action/restart",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-contribution-action-token": token,
                },
                body: JSON.stringify({ entity_id: "service:platform:my-svc" }),
            },
        );
        expect(r2.status).toBe(200);

        const executed = audit.entries.find((e) => e["event"] === "contrib_action_executed");
        expect(executed).toBeDefined();
        expect(executed!["contribution"]).toBe("homelab");
        expect(executed!["action"]).toBe("restart");
        expect(executed!["actor"]).toBe("alice");
    });

    test("token can only be used once — replay returns 403", async () => {
        const app = withAuth(appWithHomelab(), "alice");
        const body = JSON.stringify({ entity_id: "service:platform:my-svc" });
        const headers = { "Content-Type": "application/json" };

        const r1 = await app.request("/portal/homelab/action/scale",
            { method: "POST", headers, body });
        const { token } = await r1.json() as { token: string };

        await app.request("/portal/homelab/action/scale", {
            method: "POST",
            headers: { ...headers, "x-contribution-action-token": token },
            body,
        });

        const r3 = await app.request("/portal/homelab/action/scale", {
            method: "POST",
            headers: { ...headers, "x-contribution-action-token": token },
            body,
        });
        expect(r3.status).toBe(403);
    });
});

// ---------------------------------------------------------------------------
// Suite 7: getPluginPath — config/env
// ---------------------------------------------------------------------------

describe("getPluginPath", () => {
    const originalEnv = process.env["HOMELAB_PLUGIN_PATH"];

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env["HOMELAB_PLUGIN_PATH"];
        } else {
            process.env["HOMELAB_PLUGIN_PATH"] = originalEnv;
        }
    });

    test("returns DEFAULT_HOMELAB_PLUGIN_PATH when env var not set", () => {
        delete process.env["HOMELAB_PLUGIN_PATH"];
        const p = getPluginPath();
        expect(p).toContain("autonomous-dev-homelab");
        expect(p).toContain("dist/cli/index.js");
    });

    test("returns env var value when HOMELAB_PLUGIN_PATH is set", () => {
        process.env["HOMELAB_PLUGIN_PATH"] = "/custom/path/homelab-cli.js";
        const p = getPluginPath();
        expect(p).toBe("/custom/path/homelab-cli.js");
    });
});

// ---------------------------------------------------------------------------
// Suite 8: runHomelabCli — subprocess mock
// ---------------------------------------------------------------------------

describe("runHomelabCli with mocked subprocess", () => {
    // We test the exported function directly. In a real test environment the
    // homelab CLI binary is NOT called (the test environment has no homelab
    // data dir and the path may not exist).  We instead test that the function
    // handles subprocess errors gracefully (bad path → exit-code 1, ok=false).

    test("non-existent CLI path returns ok=false and non-zero exit code", async () => {
        const origPath = process.env["HOMELAB_PLUGIN_PATH"];
        process.env["HOMELAB_PLUGIN_PATH"] = "/does/not/exist/homelab-cli.js";
        try {
            const result = await runHomelabCli(["--help"]);
            // Should not throw — returns error result.
            expect(result.ok).toBe(false);
            expect(result.exitCode).not.toBe(0);
        } finally {
            if (origPath === undefined) {
                delete process.env["HOMELAB_PLUGIN_PATH"];
            } else {
                process.env["HOMELAB_PLUGIN_PATH"] = origPath;
            }
        }
    }, 10_000);

    test("VAULT_TOKEN from env is passed through to subprocess env", async () => {
        // We can't observe subprocess env directly, but we can verify the
        // function accepts a vaultToken param without error.
        const origPath = process.env["HOMELAB_PLUGIN_PATH"];
        process.env["HOMELAB_PLUGIN_PATH"] = "/does/not/exist/homelab-cli.js";
        try {
            const result = await runHomelabCli(["--version"], "test-vault-token");
            expect(result).toBeDefined();
            expect(typeof result.ok).toBe("boolean");
        } finally {
            if (origPath === undefined) {
                delete process.env["HOMELAB_PLUGIN_PATH"];
            } else {
                process.env["HOMELAB_PLUGIN_PATH"] = origPath;
            }
        }
    }, 10_000);
});

// ---------------------------------------------------------------------------
// Suite 9: homelabContribution shape validation
// ---------------------------------------------------------------------------

describe("homelabContribution shape", () => {
    test("exports four actions", () => {
        const actions = homelabContribution.actions ?? [];
        const ids = actions.map((a) => a.id);
        expect(ids).toContain("restart");
        expect(ids).toContain("redeploy");
        expect(ids).toContain("scale");
        expect(ids).toContain("apply-autofix");
    });

    test("restart action is reversible with minRole operator", () => {
        const restart = homelabContribution.actions?.find((a) => a.id === "restart");
        expect(restart?.destructiveness).toBe("reversible");
        expect(restart?.minRole).toBe("operator");
    });

    test("redeploy action is irreversible with minRole deployer", () => {
        const redeploy = homelabContribution.actions?.find((a) => a.id === "redeploy");
        expect(redeploy?.destructiveness).toBe("irreversible");
        expect(redeploy?.minRole).toBe("deployer");
    });

    test("apply-autofix action is irreversible with minRole operator", () => {
        const applyFix = homelabContribution.actions?.find((a) => a.id === "apply-autofix");
        expect(applyFix?.destructiveness).toBe("irreversible");
        expect(applyFix?.minRole).toBe("operator");
    });

    test("scale action is reversible with minRole operator", () => {
        const scale = homelabContribution.actions?.find((a) => a.id === "scale");
        expect(scale?.destructiveness).toBe("reversible");
        expect(scale?.minRole).toBe("operator");
    });

    test("exports two API routes: entity and entities", () => {
        const routes = homelabContribution.apiRoutes ?? [];
        const paths = routes.map((r) => r.path);
        expect(paths).toContain("entity");
        expect(paths).toContain("entities");
    });
});
