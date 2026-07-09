// Tests for the portal contribution mechanism (#670, #671, #672).
//
// Acceptance criteria tested here:
//   1. Registering a contribution mounts page + api routes + nav entry.
//   2. An action requires a typed-CONFIRM token before the handler runs.
//   3. RBAC denies calls from a principal without the required role.
//   4. The homelab contribution exports a valid `PortalContribution` and
//      its renderPage resolves to an HTML string.
//
// Every test calls `clearContributions()` in `beforeEach` so module-level
// registry state never leaks between test cases.

import {
    describe,
    test,
    expect,
    beforeEach,
    afterEach,
} from "bun:test";
import { Hono } from "hono";

import {
    registerContribution,
    registerContribRoutes,
    navItems,
    clearContributions,
    loadContributionsFromConfig,
    getContribution,
} from "../../server/contrib/registry";
import type { PortalContribution } from "../../server/contrib/types";
import { resolveRole, hasRole } from "../../server/contrib/rbac";
import type { PortalRolesConfig } from "../../server/contrib/rbac";
import { homelabContribution } from "../../server/contrib/homelab";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal audit sink that captures entries for assertion. */
function captureAudit() {
    const entries: Array<Record<string, unknown>> = [];
    return {
        append: async (entry: Record<string, unknown>): Promise<void> => {
            entries.push(entry);
        },
        entries,
    };
}

/** No-op audit for tests that don't assert on audit events. */
const noopAudit = { append: async () => undefined };

/** Build a fresh Hono app with all currently-registered contributions. */
function appWithContribs(opts: {
    rolesConfig?: PortalRolesConfig;
} = {}): Hono {
    const app = new Hono();
    registerContribRoutes(app, {
        audit: noopAudit,
        rolesConfig: opts.rolesConfig,
    });
    return app;
}

/** Inject a fake auth object into a Hono context (used to simulate actors). */
function withAuth(app: Hono, actor: string): Hono {
    const wrapped = new Hono<{
        Variables: { auth: { source_user_id: string } };
    }>();
    wrapped.use("*", async (c, next) => {
        // Cast to `any` because the sub-app's Variables typing differs from
        // the route-under-test's Variables. Functionally identical at runtime.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c as any).set("auth", { source_user_id: actor });
        await next();
    });
    wrapped.route("/", app);
    return wrapped as unknown as Hono;
}

// ---------------------------------------------------------------------------
// Fixture contributions
// ---------------------------------------------------------------------------

const testPageContrib: PortalContribution = {
    id: "test-panel",
    nav: {
        href: "/portal/test-panel",
        label: "Test Panel",
        group: "system",
        iconName: "cpu",
    },
    async renderPage() {
        return "<html><body>Test Panel</body></html>";
    },
    apiRoutes: [
        {
            method: "GET",
            path: "status",
            async handler(c) {
                return c.json({ status: "ok" });
            },
        },
    ],
};

const testActionContrib: PortalContribution = {
    id: "test-actions",
    async renderPage() {
        return "<html><body>Actions</body></html>";
    },
    actions: [
        {
            id: "restart",
            label: "Restart Service",
            destructiveness: "reversible",
            minRole: "operator",
            async handler(ctx) {
                return { restarted: true, actor: ctx.actor, role: ctx.role };
            },
        },
        {
            id: "read-status",
            label: "Read Status",
            destructiveness: "read-only",
            minRole: "viewer",
            async handler() {
                return { status: "running" };
            },
        },
        {
            id: "destroy",
            label: "Destroy Data",
            destructiveness: "destructive",
            minRole: "admin",
            async handler() {
                return { destroyed: true };
            },
        },
    ],
};

// ---------------------------------------------------------------------------
// Suite 1: Registry
// ---------------------------------------------------------------------------

describe("contribution registry", () => {
    beforeEach(() => {
        clearContributions();
    });

    test("registerContribution stores a contribution by id", () => {
        registerContribution(testPageContrib);
        const got = getContribution("test-panel");
        expect(got).toBe(testPageContrib);
    });

    test("registerContribution is idempotent — second call replaces", () => {
        registerContribution(testPageContrib);
        const updated: PortalContribution = { ...testPageContrib, id: "test-panel" };
        registerContribution(updated);
        expect(getContribution("test-panel")).toBe(updated);
    });

    test("navItems() returns entries from registered contributions", () => {
        expect(navItems()).toHaveLength(0);
        registerContribution(testPageContrib);
        const items = navItems();
        expect(items).toHaveLength(1);
        expect(items[0]!.label).toBe("Test Panel");
        expect(items[0]!.href).toBe("/portal/test-panel");
    });

    test("navItems() omits contributions without a nav entry", () => {
        const noNav: PortalContribution = { id: "no-nav", async renderPage() { return ""; } };
        registerContribution(noNav);
        expect(navItems()).toHaveLength(0);
    });

    test("clearContributions() removes all entries", () => {
        registerContribution(testPageContrib);
        clearContributions();
        expect(getContribution("test-panel")).toBeUndefined();
        expect(navItems()).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Suite 2: Route mounting — page route
// ---------------------------------------------------------------------------

describe("registerContribRoutes — page route", () => {
    beforeEach(() => {
        clearContributions();
    });

    test("GET /portal/<id> returns 200 with contribution HTML", async () => {
        registerContribution(testPageContrib);
        const app = appWithContribs();
        const res = await app.request("/portal/test-panel");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("Test Panel");
    });

    test("unregistered contribution path returns 404 (Hono default)", async () => {
        const app = appWithContribs();
        const res = await app.request("/portal/does-not-exist");
        expect(res.status).toBe(404);
    });

    test("renderPage error returns 500 without crashing the app", async () => {
        const failContrib: PortalContribution = {
            id: "fail-panel",
            async renderPage() {
                throw new Error("render exploded");
            },
        };
        registerContribution(failContrib);
        const app = appWithContribs();
        const res = await app.request("/portal/fail-panel");
        expect(res.status).toBe(500);
        const body = await res.text();
        expect(body).toContain("Panel error");
    });

    test("renderPage returning a Response passes it through", async () => {
        const redirectContrib: PortalContribution = {
            id: "redirect-panel",
            async renderPage() {
                return new Response(null, { status: 302, headers: { Location: "/" } });
            },
        };
        registerContribution(redirectContrib);
        const app = appWithContribs();
        const res = await app.request("/portal/redirect-panel", { redirect: "manual" });
        expect(res.status).toBe(302);
    });
});

// ---------------------------------------------------------------------------
// Suite 3: Route mounting — api routes
// ---------------------------------------------------------------------------

describe("registerContribRoutes — api routes", () => {
    beforeEach(() => {
        clearContributions();
    });

    test("GET /portal/<id>/api/<path> routes to the contribution handler", async () => {
        registerContribution(testPageContrib);
        const app = appWithContribs();
        const res = await app.request("/portal/test-panel/api/status");
        expect(res.status).toBe(200);
        const body = await res.json() as { status: string };
        expect(body.status).toBe("ok");
    });

    test("POST api route is mounted correctly", async () => {
        const postContrib: PortalContribution = {
            id: "post-panel",
            apiRoutes: [
                {
                    method: "POST",
                    path: "data",
                    async handler(c) {
                        return c.json({ received: true }, 201);
                    },
                },
            ],
        };
        registerContribution(postContrib);
        const app = appWithContribs();
        const res = await app.request("/portal/post-panel/api/data", { method: "POST" });
        expect(res.status).toBe(201);
    });
});

// ---------------------------------------------------------------------------
// Suite 4: Action-through-gate (#671)
// ---------------------------------------------------------------------------

describe("action-through-gate (#671)", () => {
    beforeEach(() => {
        clearContributions();
    });

    test("read-only action executes immediately without confirmation", async () => {
        registerContribution(testActionContrib);
        const app = withAuth(appWithContribs(), "alice");
        const res = await app.request(
            "/portal/test-actions/action/read-status",
            { method: "POST" },
        );
        // read-only → 200 with result
        expect(res.status).toBe(200);
        const body = await res.json() as { status: string };
        expect(body.status).toBe("running");
    });

    test("reversible action without token returns 202 requiresConfirmation", async () => {
        registerContribution(testActionContrib);
        const app = withAuth(appWithContribs(), "alice");
        const res = await app.request(
            "/portal/test-actions/action/restart",
            { method: "POST" },
        );
        expect(res.status).toBe(202);
        const body = await res.json() as {
            requiresConfirmation: boolean;
            token: string;
            phrase: string;
        };
        expect(body.requiresConfirmation).toBe(true);
        expect(typeof body.token).toBe("string");
        expect(body.token.length).toBeGreaterThan(0);
        expect(body.phrase).toBe("CONFIRM ACTION");
    });

    test("reversible action with valid token executes the handler", async () => {
        registerContribution(testActionContrib);
        const app = withAuth(appWithContribs(), "alice");

        // Step 1: request confirmation.
        const r1 = await app.request(
            "/portal/test-actions/action/restart",
            { method: "POST" },
        );
        expect(r1.status).toBe(202);
        const { token } = await r1.json() as { token: string };

        // Step 2: submit token.
        const r2 = await app.request(
            "/portal/test-actions/action/restart",
            {
                method: "POST",
                headers: { "x-contribution-action-token": token },
            },
        );
        expect(r2.status).toBe(200);
        const body = await r2.json() as { restarted: boolean };
        expect(body.restarted).toBe(true);
    });

    test("token replay after first use returns 403 invalid", async () => {
        registerContribution(testActionContrib);
        const app = withAuth(appWithContribs(), "alice");

        // Get a token.
        const r1 = await app.request(
            "/portal/test-actions/action/restart",
            { method: "POST" },
        );
        const { token } = await r1.json() as { token: string };

        // Use the token once.
        await app.request(
            "/portal/test-actions/action/restart",
            { method: "POST", headers: { "x-contribution-action-token": token } },
        );

        // Use again → should be rejected.
        const r3 = await app.request(
            "/portal/test-actions/action/restart",
            { method: "POST", headers: { "x-contribution-action-token": token } },
        );
        expect(r3.status).toBe(403);
        const body = await r3.json() as { error: string };
        expect(body.error).toBe("invalid-or-expired-confirmation");
    });

    test("invalid token returns 403", async () => {
        registerContribution(testActionContrib);
        const app = withAuth(appWithContribs(), "alice");
        const res = await app.request(
            "/portal/test-actions/action/restart",
            { method: "POST", headers: { "x-contribution-action-token": "bad-token-xyz" } },
        );
        expect(res.status).toBe(403);
    });

    test("destructive action returns phrase CONFIRM DESTROY", async () => {
        registerContribution(testActionContrib);
        const app = withAuth(appWithContribs(), "alice");
        const res = await app.request(
            "/portal/test-actions/action/destroy",
            { method: "POST" },
        );
        expect(res.status).toBe(202);
        const body = await res.json() as { phrase: string };
        expect(body.phrase).toBe("CONFIRM DESTROY");
    });

    test("audit entry is emitted after action execution", async () => {
        registerContribution(testActionContrib);
        const audit = captureAudit();
        const app = new Hono();
        registerContribRoutes(app, { audit, rolesConfig: undefined });
        const wrapped = withAuth(app, "alice");

        // Execute read-only (no confirmation needed).
        await wrapped.request("/portal/test-actions/action/read-status", { method: "POST" });

        expect(audit.entries.length).toBeGreaterThan(0);
        const entry = audit.entries[0];
        expect(entry!["event"]).toBe("contrib_action_executed");
        expect(entry!["actor"]).toBe("alice");
    });
});

// ---------------------------------------------------------------------------
// Suite 5: RBAC (#672)
// ---------------------------------------------------------------------------

describe("RBAC role checks (#672)", () => {
    beforeEach(() => {
        clearContributions();
    });

    // Unit tests for resolveRole + hasRole.
    test("resolveRole returns default_role when no map entries match", () => {
        const config: PortalRolesConfig = { default_role: "viewer" };
        expect(resolveRole("alice", config)).toBe("viewer");
    });

    test("resolveRole returns admin when config is undefined (zero-config safety)", () => {
        expect(resolveRole("anyone", undefined)).toBe("admin");
    });

    test("resolveRole exact match wins over wildcard", () => {
        const config: PortalRolesConfig = {
            role_map: [
                { principal: "alice", role: "admin" },
                { principal: "*", role: "viewer" },
            ],
        };
        expect(resolveRole("alice", config)).toBe("admin");
        expect(resolveRole("bob", config)).toBe("viewer");
    });

    test("resolveRole wildcard is used when no exact match", () => {
        const config: PortalRolesConfig = {
            role_map: [{ principal: "*", role: "operator" }],
        };
        expect(resolveRole("anyone", config)).toBe("operator");
    });

    test("hasRole: viewer cannot satisfy operator requirement", () => {
        expect(hasRole("viewer", "operator")).toBe(false);
    });

    test("hasRole: admin satisfies all roles", () => {
        expect(hasRole("admin", "viewer")).toBe(true);
        expect(hasRole("admin", "operator")).toBe(true);
        expect(hasRole("admin", "deployer")).toBe(true);
        expect(hasRole("admin", "admin")).toBe(true);
    });

    test("hasRole: operator satisfies viewer but not deployer", () => {
        expect(hasRole("operator", "viewer")).toBe(true);
        expect(hasRole("operator", "operator")).toBe(true);
        expect(hasRole("operator", "deployer")).toBe(false);
    });

    // Integration: RBAC denial via the action-gate route.
    test("action denied with 403 when caller role is below minRole", async () => {
        registerContribution(testActionContrib);
        // alice is a viewer; restart requires operator.
        const rolesConfig: PortalRolesConfig = {
            role_map: [{ principal: "alice", role: "viewer" }],
        };
        const audit = captureAudit();
        const app = new Hono();
        registerContribRoutes(app, { audit, rolesConfig });
        const wrapped = withAuth(app, "alice");

        const res = await wrapped.request(
            "/portal/test-actions/action/restart",
            { method: "POST" },
        );
        expect(res.status).toBe(403);
        const body = await res.json() as { error: string; required: string };
        expect(body.error).toBe("insufficient-role");
        expect(body.required).toBe("operator");

        // Denial is audited.
        expect(audit.entries.length).toBeGreaterThan(0);
        expect(audit.entries[0]!["event"]).toBe("contrib_action_denied");
        expect(audit.entries[0]!["reason"]).toBe("insufficient-role");
    });

    test("action succeeds when caller role meets minRole", async () => {
        registerContribution(testActionContrib);
        const rolesConfig: PortalRolesConfig = {
            role_map: [{ principal: "alice", role: "operator" }],
        };
        const app = new Hono();
        registerContribRoutes(app, { audit: noopAudit, rolesConfig });
        const wrapped = withAuth(app, "alice");

        // read-only action → no gate, executes immediately.
        const res = await wrapped.request(
            "/portal/test-actions/action/read-status",
            { method: "POST" },
        );
        expect(res.status).toBe(200);
    });

    test("admin role in ActionContext matches resolved role", async () => {
        // Verify the resolved role is threaded into ActionContext.
        const contextCapture: Array<{ actor: string; role: string }> = [];
        const contrib: PortalContribution = {
            id: "ctx-capture",
            actions: [
                {
                    id: "do-it",
                    label: "Do it",
                    destructiveness: "read-only",
                    minRole: "viewer",
                    async handler(ctx) {
                        contextCapture.push({ actor: ctx.actor, role: ctx.role });
                        return { ok: true };
                    },
                },
            ],
        };
        registerContribution(contrib);
        const rolesConfig: PortalRolesConfig = {
            role_map: [{ principal: "carol", role: "deployer" }],
        };
        const app = new Hono();
        registerContribRoutes(app, { audit: noopAudit, rolesConfig });
        const wrapped = withAuth(app, "carol");

        await wrapped.request("/portal/ctx-capture/action/do-it", { method: "POST" });
        expect(contextCapture).toHaveLength(1);
        expect(contextCapture[0]!.actor).toBe("carol");
        expect(contextCapture[0]!.role).toBe("deployer");
    });
});

// ---------------------------------------------------------------------------
// Suite 6: Config-driven loader
// ---------------------------------------------------------------------------

describe("loadContributionsFromConfig", () => {
    beforeEach(() => {
        clearContributions();
    });

    test("missing module path is logged and skipped (portal does not crash)", async () => {
        const warns: string[] = [];
        const errors: string[] = [];
        await loadContributionsFromConfig(["/does/not/exist/contrib.js"], {
            warn: (e) => warns.push(e),
            error: (e) => errors.push(e),
        });
        // Should not throw; should log an error.
        expect(errors.length + warns.length).toBeGreaterThan(0);
        // No contributions registered.
        expect(getContribution("anything")).toBeUndefined();
    });

    test("empty path array succeeds silently", async () => {
        await loadContributionsFromConfig([]);
        // Registry stays empty.
        expect(navItems()).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Suite 7: Homelab contribution (#670 migration proof)
// ---------------------------------------------------------------------------

describe("homelab contribution", () => {
    beforeEach(() => {
        clearContributions();
    });

    test("exports a valid PortalContribution with id 'homelab'", () => {
        expect(homelabContribution.id).toBe("homelab");
        expect(typeof homelabContribution.renderPage).toBe("function");
    });

    test("has a nav entry in the system group", () => {
        expect(homelabContribution.nav).toBeDefined();
        expect(homelabContribution.nav!.group).toBe("system");
        expect(homelabContribution.nav!.href).toBe("/portal/homelab");
        expect(homelabContribution.nav!.label).toBe("Homelab");
    });

    test("renderPage returns an HTML string (no inventory needed)", async () => {
        // No homelab data directory — should return the empty-state HTML.
        const html = await homelabContribution.renderPage!(undefined as never);
        expect(typeof html).toBe("string");
        // Should contain the page structure.
        expect(html as string).toContain("Homelab");
        expect(html as string).toContain("<!doctype html>");
    });

    test("mounts via registry: GET /portal/homelab returns 200", async () => {
        registerContribution(homelabContribution);
        const app = appWithContribs();
        const res = await app.request("/portal/homelab");
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("Homelab");
    });

    test("navItems() includes homelab after registration", () => {
        registerContribution(homelabContribution);
        const items = navItems();
        expect(items.some((i) => i.href === "/portal/homelab")).toBe(true);
    });

    test("homelab is NOT hard-coded in NAV_ITEMS (mounted only via registry)", async () => {
        // Import NAV_ITEMS from the nav component.
        const { NAV_ITEMS } = await import("../../server/components/rail-nav");
        const hardCoded = NAV_ITEMS.some((i) => i.href === "/portal/homelab" || i.label === "Homelab");
        expect(hardCoded).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Suite 8: Multi-contribution isolation
// ---------------------------------------------------------------------------

describe("multi-contribution isolation", () => {
    beforeEach(() => {
        clearContributions();
    });

    test("two contributions mount independently at separate paths", async () => {
        const a: PortalContribution = {
            id: "contrib-a",
            async renderPage() { return "<html>A</html>"; },
        };
        const b: PortalContribution = {
            id: "contrib-b",
            async renderPage() { return "<html>B</html>"; },
        };
        registerContribution(a);
        registerContribution(b);
        const app = appWithContribs();

        const ra = await app.request("/portal/contrib-a");
        const rb = await app.request("/portal/contrib-b");

        expect(ra.status).toBe(200);
        expect(await ra.text()).toContain("A");
        expect(rb.status).toBe(200);
        expect(await rb.text()).toContain("B");
    });

    test("error in one contribution does not affect another", async () => {
        const good: PortalContribution = {
            id: "good-panel",
            async renderPage() { return "<html>Good</html>"; },
        };
        const bad: PortalContribution = {
            id: "bad-panel",
            async renderPage() { throw new Error("bad!"); },
        };
        registerContribution(good);
        registerContribution(bad);
        const app = appWithContribs();

        const rgood = await app.request("/portal/good-panel");
        const rbad = await app.request("/portal/bad-panel");

        expect(rgood.status).toBe(200);
        expect(rbad.status).toBe(500);
    });
});
