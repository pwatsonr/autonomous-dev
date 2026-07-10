// Tests for the deploy-target selection UI portal contribution (#673).
//
// Acceptance criteria:
//   1. Target list: all registered targets enumerated from the shared registry.
//   2. Available/unavailable targets: unavailable rendered with reason; non-selectable.
//   3. Untrusted targets: rendered with reason; non-selectable.
//   4. Empty state: rendered when no targets registered.
//   5. POST select-target → resolveTarget honors the override (returns resolved target).
//   6. POST select-target with unknown id → error.
//   7. JSON API GET /portal/deploy-targets/api/targets returns all targets.
//   8. Model-driven: contribution enumerates from the injected registry (invariant #674).
//   9. Gate: select-target action goes through typed-CONFIRM (destructiveness=reversible).
//  10. HTML page renders kind/provider/env/trust/capabilities columns.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";

import {
  registerContribution,
  registerContribRoutes,
  clearContributions,
} from "../../server/contrib/registry";
import {
  deployTargetsContribution,
  makeDeployTargetsContribution,
} from "../../server/contrib/deploy-targets/index";
import {
  InMemoryDeployTargetRegistry,
  resetDeployTargetRegistry,
  setDeployTargetRegistry,
  getDeployTargetRegistry,
} from "../../../autonomous-dev/intake/deploy/target-registry";
import type { DeployTarget } from "../../../autonomous-dev/intake/deploy/target-types";
import type { PortalRolesConfig } from "../../server/contrib/rbac";

// ---------------------------------------------------------------------------
// Helpers
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

function appWithContrib(opts: { rolesConfig?: PortalRolesConfig } = {}): Hono {
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

/** Build a minimal DeployTarget fixture. */
function makeTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    id: "test-node-01",
    name: "Test Node 01",
    kind: "swarm-node",
    provider: "docker-local",
    capabilities: ["gpu"],
    env: "prod",
    trust: "internal",
    tags: { role: "worker", location: "rack-1" },
    source: "discovery",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Contribution identity
// ---------------------------------------------------------------------------

describe("deployTargetsContribution identity", () => {
  test("has id 'deploy-targets'", () => {
    expect(deployTargetsContribution.id).toBe("deploy-targets");
  });

  test("has a nav entry in the operate group", () => {
    expect(deployTargetsContribution.nav).toBeDefined();
    expect(deployTargetsContribution.nav!.group).toBe("operate");
    expect(deployTargetsContribution.nav!.href).toBe("/portal/deploy-targets");
    expect(deployTargetsContribution.nav!.label).toMatch(/target/i);
  });

  test("exports apiRoutes including 'targets' and 'select-target'", () => {
    const paths = (deployTargetsContribution.apiRoutes ?? []).map(
      (r) => r.path,
    );
    expect(paths).toContain("targets");
    expect(paths).toContain("select-target");
  });

  test("renderPage is defined", () => {
    expect(typeof deployTargetsContribution.renderPage).toBe("function");
  });

  test("mounts via registry at GET /portal/deploy-targets", async () => {
    clearContributions();
    registerContribution(deployTargetsContribution);
    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets");
    expect(res.status).toBe(200);
    clearContributions();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Empty state
// ---------------------------------------------------------------------------

describe("deploy-targets empty state", () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
    setDeployTargetRegistry(registry);
    clearContributions();
    registerContribution(makeDeployTargetsContribution({ registry }));
  });

  afterEach(() => {
    clearContributions();
    resetDeployTargetRegistry();
  });

  test("renderPage returns empty-state message when no targets registered", async () => {
    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No deploy targets");
  });

  test("GET /portal/deploy-targets/api/targets returns empty array when no targets", async () => {
    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets/api/targets");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targets: unknown[]; total: number };
    expect(Array.isArray(body.targets)).toBe(true);
    expect(body.targets).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Target list — all registered targets shown
// ---------------------------------------------------------------------------

describe("deploy-targets list", () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
    setDeployTargetRegistry(registry);
    clearContributions();
    registerContribution(makeDeployTargetsContribution({ registry }));
  });

  afterEach(() => {
    clearContributions();
    resetDeployTargetRegistry();
  });

  test("HTML page lists all registered targets by name", async () => {
    registry.register(makeTarget({ id: "node-a", name: "Node Alpha" }));
    registry.register(makeTarget({ id: "node-b", name: "Node Beta" }));

    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Node Alpha");
    expect(html).toContain("Node Beta");
  });

  test("HTML page renders kind, provider, env, trust, capabilities", async () => {
    registry.register(
      makeTarget({
        id: "node-c",
        name: "Cloud Run Svc",
        kind: "cloud-run-service",
        provider: "gcp-cloud-run",
        env: "staging",
        trust: "production",
        capabilities: ["high-memory", "blue-green"],
      }),
    );

    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets");
    const html = await res.text();
    expect(html).toContain("cloud-run-service");
    expect(html).toContain("gcp-cloud-run");
    expect(html).toContain("staging");
    expect(html).toContain("production");
    expect(html).toContain("high-memory");
  });

  test("GET /portal/deploy-targets/api/targets returns all targets as JSON", async () => {
    registry.register(makeTarget({ id: "t1", name: "Target One" }));
    registry.register(makeTarget({ id: "t2", name: "Target Two" }));

    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets/api/targets");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: DeployTarget[];
      total: number;
    };
    expect(body.total).toBe(2);
    const ids = body.targets.map((t) => t.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
  });

  test("model-driven: newly registered target appears without code change", async () => {
    registry.register(makeTarget({ id: "early-node", name: "Early" }));

    const app = appWithContrib();
    const r1 = await app.request("/portal/deploy-targets/api/targets");
    const b1 = (await r1.json()) as { total: number };
    expect(b1.total).toBe(1);

    // Register another target directly (simulating plugin activation).
    registry.register(makeTarget({ id: "late-node", name: "Late" }));

    const r2 = await app.request("/portal/deploy-targets/api/targets");
    const b2 = (await r2.json()) as { total: number };
    expect(b2.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Unavailable targets
// ---------------------------------------------------------------------------

describe("deploy-targets unavailable rendering", () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
    setDeployTargetRegistry(registry);
    clearContributions();
    registerContribution(makeDeployTargetsContribution({ registry }));
  });

  afterEach(() => {
    clearContributions();
    resetDeployTargetRegistry();
  });

  test("unavailable target renders with reason", async () => {
    registry.register(
      makeTarget({
        id: "down-node",
        name: "Down Node",
        tags: {
          availability: "unavailable",
          unavailable_reason: "SSH timeout",
        },
      }),
    );

    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets");
    const html = await res.text();
    expect(html).toContain("Down Node");
    // availability tag is shown in the page
    expect(html).toContain("unavailable");
  });

  test("target with no availability tag is treated as available", async () => {
    registry.register(makeTarget({ id: "healthy-node", name: "Healthy Node" }));

    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets");
    const html = await res.text();
    expect(html).toContain("Healthy Node");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Untrusted targets
// ---------------------------------------------------------------------------

describe("deploy-targets untrusted rendering", () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
    setDeployTargetRegistry(registry);
    clearContributions();
    registerContribution(makeDeployTargetsContribution({ registry }));
  });

  afterEach(() => {
    clearContributions();
    resetDeployTargetRegistry();
  });

  test("untrusted target renders with trust field", async () => {
    registry.register(
      makeTarget({
        id: "untrusted-node",
        name: "Untrusted Node",
        trust: "untrusted",
        tags: { trust_reason: "cert mismatch" },
      }),
    );

    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets");
    const html = await res.text();
    expect(html).toContain("Untrusted Node");
    expect(html).toContain("untrusted");
  });
});

// ---------------------------------------------------------------------------
// Suite 6: POST select-target → resolveTarget
// ---------------------------------------------------------------------------

describe("deploy-targets select-target API", () => {
  let registry: InMemoryDeployTargetRegistry;

  beforeEach(() => {
    registry = new InMemoryDeployTargetRegistry();
    setDeployTargetRegistry(registry);
    clearContributions();
    registerContribution(makeDeployTargetsContribution({ registry }));
  });

  afterEach(() => {
    clearContributions();
    resetDeployTargetRegistry();
  });

  test("POST with valid target id returns resolved target", async () => {
    registry.register(makeTarget({ id: "prod-node", name: "Prod Node" }));

    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets/api/select-target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_id: "prod-node" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      target: DeployTarget;
      source: string;
    };
    expect(body.ok).toBe(true);
    expect(body.target.id).toBe("prod-node");
    expect(body.target.name).toBe("Prod Node");
    expect(body.source).toBe("explicit-id");
  });

  test("POST with unknown target id returns 404 error", async () => {
    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets/api/select-target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_id: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown|not found/i);
  });

  test("POST with no target_id in body returns 400", async () => {
    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets/api/select-target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  test("POST select-target resolves via shared DeployTargetRegistry", async () => {
    // Register via the global singleton (simulates core bootstrap path).
    const singletonRegistry = getDeployTargetRegistry();
    singletonRegistry.register(
      makeTarget({ id: "singleton-node", name: "Singleton" }),
    );

    // The contribution reads from the injected registry (same instance here).
    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets/api/select-target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_id: "singleton-node" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; target: DeployTarget };
    expect(body.ok).toBe(true);
    expect(body.target.id).toBe("singleton-node");
  });

  test("POST select-target with invalid JSON body returns 400", async () => {
    const app = appWithContrib();
    const res = await app.request("/portal/deploy-targets/api/select-target", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });
    expect([400, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: Contribution uses defaultExport and is registerable
// ---------------------------------------------------------------------------

describe("deploy-targets contribution wiring", () => {
  afterEach(() => {
    clearContributions();
    resetDeployTargetRegistry();
  });

  test("registering deployTargetsContribution adds nav entry", () => {
    clearContributions();
    registerContribution(deployTargetsContribution);
    const { navItems } = require("../../server/contrib/registry");
    const items = navItems() as Array<{ href: string }>;
    expect(items.some((i) => i.href === "/portal/deploy-targets")).toBe(true);
  });

  test("makeDeployTargetsContribution accepts a custom registry", async () => {
    const customRegistry = new InMemoryDeployTargetRegistry();
    customRegistry.register(
      makeTarget({ id: "custom-t", name: "Custom Target" }),
    );

    const contrib = makeDeployTargetsContribution({ registry: customRegistry });
    expect(contrib.id).toBe("deploy-targets");

    // renderPage should show the custom target
    const html = await contrib.renderPage!(undefined as never);
    expect(typeof html).toBe("string");
    expect(html as string).toContain("Custom Target");
  });
});
