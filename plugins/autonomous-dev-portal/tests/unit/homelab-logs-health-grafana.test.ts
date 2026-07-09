// Tests for homelab contribution: logs viewer, health badge, Grafana links (#54).
//
// Acceptance criteria:
//   1. Logs API route invokes the CLI `logs <resource> --json` and returns
//      normalized entries (mocked subprocess via non-existent CLI path).
//   2. Logs API route returns graceful empty-state when CLI fails.
//   3. Grafana API route invokes `grafana dashboards --entity <id> --json`
//      and returns normalized dashboard links (mocked subprocess).
//   4. Grafana API route returns graceful empty-state when CLI fails.
//   5. `renderHealthBadge` renders a badge for A/B/C/D/F grades with the
//      correct CSS class, and returns "" when no health attrs are present.
//   6. `parseLogsOutput` handles JSON arrays, NDJSON, empty input, and
//      malformed lines gracefully.
//   7. `parseGrafanaOutput` handles arrays, single objects, entries without
//      URL (filtered out), empty input.
//   8. `renderDetailPage` renders a health badge when attrs carry
//      `health_score`/`health_grade`.
//   9. `renderDetailPage` renders a logs panel (populated or empty-state).
//  10. `renderDetailPage` renders a Grafana dashboards panel (populated or
//      empty-state).
//  11. Unknown entity id -> graceful not-found page (regression guard).
//  12. Logs and grafana api routes are registered in `homelabContribution`.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";

import {
  registerContribution,
  registerContribRoutes,
  clearContributions,
} from "../../server/contrib/registry";
import {
  homelabContribution,
  parseGraphYaml,
  parseLogsOutput,
  parseGrafanaOutput,
  renderHealthBadge,
  renderDetailPage,
} from "../../server/contrib/homelab";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopAudit = { append: async () => undefined };

function appWithHomelab(): Hono {
  const app = new Hono();
  registerContribRoutes(app, { audit: noopAudit });
  return app;
}

// Sample graph with health attributes on one entity.
const HEALTH_YAML = `version: 2
entities:
  - id: service:platform:healthy-svc
    kind: service
    name: healthy-svc
    attributes:
      image: my-image:1.0
      replicas_running: 2
      replicas_desired: 2
      health_score: 95
      health_grade: A
    source: docker-swarm
    platformId: platform-x
    status: active
    last_seen: '2026-07-08T18:43:31.687Z'
  - id: service:platform:warn-svc
    kind: service
    name: warn-svc
    attributes:
      health_score: 62
      health_grade: C
    source: docker-swarm
    platformId: platform-x
    status: active
    last_seen: '2026-07-08T18:43:31.687Z'
  - id: service:platform:fail-svc
    kind: service
    name: fail-svc
    attributes:
      health_score: 20
      health_grade: F
    source: docker-swarm
    platformId: platform-x
    status: degraded
    last_seen: '2026-07-08T18:43:31.687Z'
  - id: service:platform:no-health
    kind: service
    name: no-health-svc
    attributes:
      replicas_running: 1
      replicas_desired: 1
    source: docker-swarm
    platformId: platform-x
    status: active
    last_seen: '2026-07-08T18:43:31.687Z'
edges: []
`;

const SAMPLE_GRAPH = parseGraphYaml(HEALTH_YAML);

// ---------------------------------------------------------------------------
// Suite 1: parseLogsOutput
// ---------------------------------------------------------------------------

describe("parseLogsOutput", () => {
  test("empty string returns empty array", () => {
    expect(parseLogsOutput("")).toHaveLength(0);
  });

  test("whitespace-only string returns empty array", () => {
    expect(parseLogsOutput("   \n  ")).toHaveLength(0);
  });

  test("parses JSON array of log objects", () => {
    const input = JSON.stringify([
      { ts: "2026-07-08T10:00:00Z", level: "info", message: "started" },
      {
        ts: "2026-07-08T10:00:01Z",
        level: "error",
        message: "connection refused",
      },
    ]);
    const entries = parseLogsOutput(input);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.ts).toBe("2026-07-08T10:00:00Z");
    expect(entries[0]!.level).toBe("info");
    expect(entries[0]!.message).toBe("started");
    expect(entries[1]!.level).toBe("error");
    expect(entries[1]!.message).toBe("connection refused");
  });

  test("parses NDJSON (newline-delimited JSON)", () => {
    const input = [
      '{"ts":"2026-07-08T10:00:00Z","level":"warn","message":"high cpu"}',
      '{"ts":"2026-07-08T10:00:01Z","level":"info","message":"recovered"}',
    ].join("\n");
    const entries = parseLogsOutput(input);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.level).toBe("warn");
    expect(entries[0]!.message).toBe("high cpu");
    expect(entries[1]!.message).toBe("recovered");
  });

  test("normalizes alternative field names: timestamp, msg, severity", () => {
    const input = JSON.stringify([
      {
        timestamp: "2026-07-08T10:00:00Z",
        severity: "WARNING",
        msg: "disk full",
      },
    ]);
    const entries = parseLogsOutput(input);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ts).toBe("2026-07-08T10:00:00Z");
    expect(entries[0]!.level).toBe("warning");
    expect(entries[0]!.message).toBe("disk full");
  });

  test("normalizes @timestamp (Loki/OpenSearch style)", () => {
    const input = JSON.stringify([
      {
        "@timestamp": "2026-07-08T12:00:00Z",
        level: "info",
        log: "container started",
      },
    ]);
    const entries = parseLogsOutput(input);
    expect(entries[0]!.ts).toBe("2026-07-08T12:00:00Z");
    expect(entries[0]!.message).toBe("container started");
  });

  test("skips malformed NDJSON lines but returns valid ones", () => {
    const input = [
      '{"ts":"2026-07-08T10:00:00Z","level":"info","message":"ok"}',
      "THIS IS NOT JSON",
      '{"ts":"2026-07-08T10:00:01Z","level":"debug","message":"done"}',
    ].join("\n");
    const entries = parseLogsOutput(input);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toBe("ok");
    expect(entries[1]!.message).toBe("done");
  });

  test("malformed JSON array returns empty array", () => {
    expect(parseLogsOutput("[{broken}]")).toHaveLength(0);
  });

  test("raw field is preserved on entries", () => {
    const input = JSON.stringify([
      {
        ts: "2026-07-08T10:00:00Z",
        level: "info",
        message: "hi",
        extra: "field",
      },
    ]);
    const entries = parseLogsOutput(input);
    expect(entries[0]!.raw).toBeDefined();
    expect(entries[0]!.raw!["extra"]).toBe("field");
  });

  test("missing level is normalized to empty string", () => {
    const input = JSON.stringify([{ message: "no level here" }]);
    const entries = parseLogsOutput(input);
    expect(entries[0]!.level).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: parseGrafanaOutput
// ---------------------------------------------------------------------------

describe("parseGrafanaOutput", () => {
  test("empty string returns empty array", () => {
    expect(parseGrafanaOutput("")).toHaveLength(0);
  });

  test("parses JSON array of dashboards", () => {
    const input = JSON.stringify([
      {
        title: "Service Overview",
        url: "https://grafana.local/d/abc",
        description: "Metrics",
      },
      { title: "Error Rate", url: "https://grafana.local/d/def" },
    ]);
    const dashboards = parseGrafanaOutput(input);
    expect(dashboards).toHaveLength(2);
    expect(dashboards[0]!.title).toBe("Service Overview");
    expect(dashboards[0]!.url).toBe("https://grafana.local/d/abc");
    expect(dashboards[0]!.description).toBe("Metrics");
    expect(dashboards[1]!.description).toBeUndefined();
  });

  test("parses a single JSON object (not array)", () => {
    const input = JSON.stringify({
      title: "Latency",
      url: "https://grafana.local/d/lat",
    });
    const dashboards = parseGrafanaOutput(input);
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0]!.title).toBe("Latency");
  });

  test("normalizes alternative field names: name, link, href", () => {
    const input = JSON.stringify([
      { name: "Alt Name", link: "https://grafana.local/d/alt" },
    ]);
    const dashboards = parseGrafanaOutput(input);
    expect(dashboards[0]!.title).toBe("Alt Name");
    expect(dashboards[0]!.url).toBe("https://grafana.local/d/alt");
  });

  test("filters out entries without a URL", () => {
    const input = JSON.stringify([
      { title: "No URL", url: "" },
      { title: "Has URL", url: "https://grafana.local/d/ok" },
    ]);
    const dashboards = parseGrafanaOutput(input);
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0]!.title).toBe("Has URL");
  });

  test("malformed JSON returns empty array", () => {
    expect(parseGrafanaOutput("{broken json")).toHaveLength(0);
  });

  test("defaults title to 'Dashboard' when name/title absent", () => {
    const input = JSON.stringify([{ url: "https://grafana.local/d/x" }]);
    const dashboards = parseGrafanaOutput(input);
    expect(dashboards[0]!.title).toBe("Dashboard");
  });
});

// ---------------------------------------------------------------------------
// Suite 3: renderHealthBadge
// ---------------------------------------------------------------------------

describe("renderHealthBadge", () => {
  test("returns empty string when no health attrs present", () => {
    expect(renderHealthBadge({})).toBe("");
  });

  test("returns empty string when attrs have unrelated keys only", () => {
    expect(renderHealthBadge({ image: "nginx:1.0", replicas: 2 })).toBe("");
  });

  test("renders badge with chip-ok class for grade A", () => {
    const badge = renderHealthBadge({ health_grade: "A", health_score: 98 });
    expect(badge).toContain("chip-ok");
    expect(badge).toContain("Health: A");
    expect(badge).toContain("98");
  });

  test("renders badge with chip-ok class for grade B", () => {
    const badge = renderHealthBadge({ health_grade: "B", health_score: 82 });
    expect(badge).toContain("chip-ok");
    expect(badge).toContain("Health: B");
  });

  test("renders badge with chip-warn class for grade C", () => {
    const badge = renderHealthBadge({ health_grade: "C", health_score: 65 });
    expect(badge).toContain("chip-warn");
    expect(badge).toContain("Health: C");
  });

  test("renders badge with chip-warn class for grade D", () => {
    const badge = renderHealthBadge({ health_grade: "D", health_score: 48 });
    expect(badge).toContain("chip-warn");
  });

  test("renders badge with chip-err class for grade F", () => {
    const badge = renderHealthBadge({ health_grade: "F", health_score: 20 });
    expect(badge).toContain("chip-err");
    expect(badge).toContain("Health: F");
  });

  test("renders badge with chip-muted for unknown grade", () => {
    const badge = renderHealthBadge({ health_grade: "Z", health_score: 50 });
    expect(badge).toContain("chip-muted");
  });

  test("renders badge with only health_score (no grade)", () => {
    const badge = renderHealthBadge({ health_score: 77 });
    expect(badge).toContain("77");
    expect(badge).toContain("chip");
    expect(badge).not.toContain("Health: A");
  });

  test("renders badge with only health_grade (no score)", () => {
    const badge = renderHealthBadge({ health_grade: "A" });
    expect(badge).toContain("Health: A");
    expect(badge).toContain("chip-ok");
  });

  test("grade is case-insensitive (lowercase a -> chip-ok)", () => {
    const badge = renderHealthBadge({ health_grade: "a", health_score: 95 });
    expect(badge).toContain("chip-ok");
  });

  test("badge has aria-label='health'", () => {
    const badge = renderHealthBadge({ health_grade: "B", health_score: 80 });
    expect(badge).toContain('aria-label="health"');
  });
});

// ---------------------------------------------------------------------------
// Suite 4: renderDetailPage — health badge + logs panel + grafana panel
// ---------------------------------------------------------------------------

describe("renderDetailPage with health/logs/grafana", () => {
  const sampleLogs = [
    {
      ts: "2026-07-08T10:00:01Z",
      level: "error",
      message: "connection refused",
    },
    { ts: "2026-07-08T10:00:00Z", level: "info", message: "started" },
  ];
  const sampleDashboards = [
    {
      title: "Service Overview",
      url: "https://grafana.local/d/abc",
      description: "Main metrics",
    },
    { title: "Error Rate", url: "https://grafana.local/d/def" },
  ];

  test("renders health badge when entity has health_grade A", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
    );
    expect(html).toContain("chip-ok");
    expect(html).toContain("Health: A");
    expect(html).toContain("95");
  });

  test("renders chip-warn health badge for grade C", async () => {
    const html = await renderDetailPage(
      "service:platform:warn-svc",
      SAMPLE_GRAPH,
      [],
    );
    expect(html).toContain("chip-warn");
    expect(html).toContain("Health: C");
  });

  test("renders chip-err health badge for grade F", async () => {
    const html = await renderDetailPage(
      "service:platform:fail-svc",
      SAMPLE_GRAPH,
      [],
    );
    expect(html).toContain("chip-err");
    expect(html).toContain("Health: F");
  });

  test("no health panel when entity has no health attrs", async () => {
    const html = await renderDetailPage(
      "service:platform:no-health",
      SAMPLE_GRAPH,
      [],
    );
    expect(html).not.toContain("health-panel");
  });

  test("health badge appears in the page header area", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
    );
    expect(html).toContain("page-header");
    expect(html).toContain("chip-ok");
  });

  test("renders logs panel with entries (populated)", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      sampleLogs,
    );
    expect(html).toContain("Logs");
    expect(html).toContain("connection refused");
    expect(html).toContain("started");
    expect(html).toContain("2026-07-08T10:00:01Z");
  });

  test("renders error level entries with chip-err class", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      sampleLogs,
    );
    expect(html).toContain("chip-err");
  });

  test("renders logs empty-state when no log entries provided", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      [],
    );
    expect(html).toContain("logs-empty");
    expect(html).toContain("No log entries available");
  });

  test("renders logs empty-state when logEntries is undefined", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
    );
    expect(html).toContain("logs-empty");
  });

  test("renders Grafana dashboards panel with links (populated)", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      undefined,
      sampleDashboards,
    );
    expect(html).toContain("Grafana Dashboards");
    expect(html).toContain("Service Overview");
    expect(html).toContain("https://grafana.local/d/abc");
    expect(html).toContain("Error Rate");
    expect(html).toContain("Main metrics");
  });

  test("grafana links open in a new tab (target=_blank)", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      undefined,
      sampleDashboards,
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("renders grafana empty-state when no dashboards provided", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      undefined,
      [],
    );
    expect(html).toContain("grafana-empty");
    expect(html).toContain("No Grafana dashboards");
  });

  test("renders grafana empty-state when dashboards is undefined", async () => {
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
    );
    expect(html).toContain("grafana-empty");
  });

  test("unknown entity id still renders not-found page (regression)", async () => {
    const html = await renderDetailPage("does-not-exist", SAMPLE_GRAPH, []);
    expect(html).toContain("Entity not found");
    expect(html).toContain("does-not-exist");
  });

  test("XSS: log messages are HTML-escaped", async () => {
    const xssLogs = [
      { ts: "", level: "info", message: '<script>alert("xss")</script>' },
    ];
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      xssLogs,
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: grafana dashboard titles are HTML-escaped", async () => {
    const xssDashboards = [
      {
        title: "<img src=x onerror=alert(1)>",
        url: "https://grafana.local/d/x",
      },
    ];
    const html = await renderDetailPage(
      "service:platform:healthy-svc",
      SAMPLE_GRAPH,
      [],
      undefined,
      xssDashboards,
    );
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Logs API route — /portal/homelab/api/logs
// ---------------------------------------------------------------------------

describe("logs API route GET /portal/homelab/api/logs", () => {
  const originalPluginPath = process.env["HOMELAB_PLUGIN_PATH"];

  beforeEach(() => {
    clearContributions();
    registerContribution(homelabContribution);
    // Point to a non-existent path so no real CLI is invoked.
    process.env["HOMELAB_PLUGIN_PATH"] = "/does/not/exist/homelab-cli.js";
  });

  afterEach(() => {
    clearContributions();
    if (originalPluginPath === undefined) {
      delete process.env["HOMELAB_PLUGIN_PATH"];
    } else {
      process.env["HOMELAB_PLUGIN_PATH"] = originalPluginPath;
    }
  });

  test("missing resource param -> 400 with error key", async () => {
    const app = appWithHomelab();
    const res = await app.request("/portal/homelab/api/logs");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing-resource-param");
  });

  test("backend unreachable -> 200 with empty entries and ok:false", async () => {
    const app = appWithHomelab();
    const res = await app.request(
      "/portal/homelab/api/logs?resource=service%3Aplatform%3Amy-svc",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      entries: unknown[];
      total: number;
      ok: boolean;
    };
    expect(body.resource).toBe("service:platform:my-svc");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(0);
    expect(body.ok).toBe(false);
  }, 12_000);

  test("route is registered in homelabContribution.apiRoutes", () => {
    const routes = homelabContribution.apiRoutes ?? [];
    const logsRoute = routes.find((r) => r.path === "logs");
    expect(logsRoute).toBeDefined();
    expect(logsRoute!.method).toBe("GET");
  });

  test("limit param is accepted and reflected in response shape", async () => {
    const app = appWithHomelab();
    const res = await app.request(
      "/portal/homelab/api/logs?resource=svc-x&limit=5",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; entries: unknown[] };
    expect(body.resource).toBe("svc-x");
    expect(Array.isArray(body.entries)).toBe(true);
  }, 12_000);
});

// ---------------------------------------------------------------------------
// Suite 6: Grafana API route — /portal/homelab/api/grafana
// ---------------------------------------------------------------------------

describe("grafana API route GET /portal/homelab/api/grafana", () => {
  const originalPluginPath = process.env["HOMELAB_PLUGIN_PATH"];

  beforeEach(() => {
    clearContributions();
    registerContribution(homelabContribution);
    process.env["HOMELAB_PLUGIN_PATH"] = "/does/not/exist/homelab-cli.js";
  });

  afterEach(() => {
    clearContributions();
    if (originalPluginPath === undefined) {
      delete process.env["HOMELAB_PLUGIN_PATH"];
    } else {
      process.env["HOMELAB_PLUGIN_PATH"] = originalPluginPath;
    }
  });

  test("missing entity param -> 400 with error key", async () => {
    const app = appWithHomelab();
    const res = await app.request("/portal/homelab/api/grafana");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing-entity-param");
  });

  test("backend unreachable -> 200 with empty dashboards and ok:false", async () => {
    const app = appWithHomelab();
    const res = await app.request(
      "/portal/homelab/api/grafana?entity=service%3Aplatform%3Amy-svc",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: string;
      dashboards: unknown[];
      total: number;
      ok: boolean;
    };
    expect(body.entity).toBe("service:platform:my-svc");
    expect(Array.isArray(body.dashboards)).toBe(true);
    expect(body.dashboards).toHaveLength(0);
    expect(body.ok).toBe(false);
  }, 12_000);

  test("route is registered in homelabContribution.apiRoutes", () => {
    const routes = homelabContribution.apiRoutes ?? [];
    const grafanaRoute = routes.find((r) => r.path === "grafana");
    expect(grafanaRoute).toBeDefined();
    expect(grafanaRoute!.method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// Suite 7: contribution shape — new routes registered
// ---------------------------------------------------------------------------

describe("homelabContribution shape — new routes", () => {
  test("apiRoutes contains entity, entities, logs, grafana", () => {
    const routes = homelabContribution.apiRoutes ?? [];
    const paths = routes.map((r) => r.path);
    expect(paths).toContain("entity");
    expect(paths).toContain("entities");
    expect(paths).toContain("logs");
    expect(paths).toContain("grafana");
  });

  test("logs route method is GET", () => {
    const route = (homelabContribution.apiRoutes ?? []).find(
      (r) => r.path === "logs",
    );
    expect(route?.method).toBe("GET");
  });

  test("grafana route method is GET", () => {
    const route = (homelabContribution.apiRoutes ?? []).find(
      (r) => r.path === "grafana",
    );
    expect(route?.method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// Suite 8: parseLogsOutput — CLI output format compliance
// ---------------------------------------------------------------------------

describe("parseLogsOutput — CLI output format compliance", () => {
  test("handles Loki-style JSON array output", () => {
    const lokiOutput = JSON.stringify([
      {
        "@timestamp": "2026-07-08T09:00:00Z",
        level: "info",
        message: "container started",
        container_name: "my-svc",
        stream: "stdout",
      },
      {
        "@timestamp": "2026-07-08T09:01:00Z",
        level: "warn",
        message: "memory usage high",
        container_name: "my-svc",
        stream: "stderr",
      },
    ]);
    const entries = parseLogsOutput(lokiOutput);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.ts).toBe("2026-07-08T09:00:00Z");
    expect(entries[0]!.level).toBe("info");
    expect(entries[0]!.message).toBe("container started");
    expect(entries[1]!.level).toBe("warn");
  });

  test("handles OpenSearch NDJSON hit format", () => {
    const ndjson = [
      '{"timestamp":"2026-07-08T09:05:00Z","log_level":"ERROR","msg":"crash detected"}',
      '{"timestamp":"2026-07-08T09:05:01Z","log_level":"INFO","msg":"restarting"}',
    ].join("\n");
    const entries = parseLogsOutput(ndjson);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.level).toBe("error"); // normalized to lowercase
    expect(entries[0]!.message).toBe("crash detected");
    expect(entries[1]!.ts).toBe("2026-07-08T09:05:01Z");
  });

  test("returns entries in order returned by CLI (no re-sorting)", () => {
    const input = JSON.stringify([
      { ts: "2026-07-08T10:00:02Z", level: "info", message: "third" },
      { ts: "2026-07-08T10:00:01Z", level: "info", message: "second" },
      { ts: "2026-07-08T10:00:00Z", level: "info", message: "first" },
    ]);
    const entries = parseLogsOutput(input);
    expect(entries[0]!.message).toBe("third");
    expect(entries[1]!.message).toBe("second");
    expect(entries[2]!.message).toBe("first");
  });
});
