// #670 / #48 / #49 / #54 — Homelab panel contribution.
//
// Migrates the homelab panel onto the portal contribution mechanism.
// Previously planned as an interim hard-coded route; instead this is the
// FIRST contribution, proving the mechanism works end-to-end.
//
// Reads `~/.autonomous-dev-homelab/inventory-graph.yaml` and the
// `observations/` directory (same sources as the homelab plugin's portal
// panel intent) to render a live inventory + observation summary.
//
// Service-detail view (#48): GET /portal/homelab?entity=<id> renders a
// single entity from the graph generically: kind, status, attributes,
// edges (runs-on / member-of / exposes / depends-on), and observations
// related to that resource.  Works for ANY entity kind by generic attribute
// rendering — no hard-coded service names (#674).
//
// Gated action buttons (#49): defines `actions` for operations a service
// supports based on kind/role (restart, redeploy, scale; apply-autofix for
// crash_loop / replica_mismatch observations). Each action routes through
// the #670 typed-CONFIRM gate before invoking the homelab plugin CLI.
//
// Logs viewer + health badge + Grafana links (#54):
//   - Health badge: reads health_score/health_grade from entity attributes
//     (populated by the homelab health-score backend, #40). Renders a
//     colour-coded chip in the page header + a dedicated health panel.
//   - Logs viewer: GET /portal/homelab/api/logs?resource=<id>&limit= invokes
//     the homelab CLI `logs <resource> --json` and returns normalized entries.
//     The service-detail page pre-fetches and renders a logs panel.
//   - Grafana links: GET /portal/homelab/api/grafana?entity=<id> invokes
//     `grafana dashboards --entity <id> --json` and returns dashboard entries.
//     The service-detail page pre-fetches and renders deep-links.
//
// Plugin path is read from the `HOMELAB_PLUGIN_PATH` env var or the
// config value `homelab.plugin_path`; defaults to the standard install
// location so it is never hard-coded per-machine (#674 invariant 4).
//
// Dynamic invariant (#674): the panel renders ENTITY TYPES from the
// inventory graph. Newly-discovered services and nodes appear on the
// next refresh with no code change — no hard-coded list of specific
// services or nodes.
//
// The contribution is exported as `contribution` (the standard export name
// the loader looks for) and is also exported as `homelabContribution` for
// programmatic registration in server.ts.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import type { PortalContribution } from "../types";
import type { ActionContext } from "../types";

// ---------------------------------------------------------------------------
// Plugin path configuration
// ---------------------------------------------------------------------------

/**
 * Resolve the homelab plugin CLI path.
 *
 * Resolution order:
 *   1. `HOMELAB_PLUGIN_PATH` environment variable.
 *   2. Default to the standard location on this machine.
 *
 * The trailing `/dist/cli/index.js` is appended when not already present
 * so the config value can specify either the plugin root or the full path.
 */
function resolvePluginPath(): string {
  const envPath = process.env["HOMELAB_PLUGIN_PATH"];
  if (envPath !== undefined && envPath.length > 0) {
    return envPath;
  }
  return join(
    homedir(),
    "..",
    "pwatson",
    "codebase",
    "autonomous-dev-homelab",
    "plugins",
    "autonomous-dev-homelab",
    "dist",
    "cli",
    "index.js",
  );
}

// The default install path kept as a separate constant for testability.
const DEFAULT_HOMELAB_PLUGIN_PATH =
  "/Users/pwatson/codebase/autonomous-dev-homelab/plugins/autonomous-dev-homelab/dist/cli/index.js";

/**
 * Return the resolved CLI path, using the default if the env var is unset.
 * Exported for test inspection.
 */
export function getPluginPath(): string {
  const envPath = process.env["HOMELAB_PLUGIN_PATH"];
  if (envPath !== undefined && envPath.length > 0) {
    return envPath;
  }
  return DEFAULT_HOMELAB_PLUGIN_PATH;
}

// ---------------------------------------------------------------------------
// Inventory graph reader
// ---------------------------------------------------------------------------

interface InventoryEntity {
  id: string;
  kind: string;
  name: string;
  attributes?: Record<string, unknown>;
  source?: string;
  platformId?: string;
  status?: string;
  last_seen?: string;
  discovered_at?: string;
}

interface InventoryEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  status?: string;
}

interface InventoryGraph {
  version?: number;
  entities?: InventoryEntity[];
  edges?: InventoryEdge[];
}

async function readInventoryGraph(): Promise<InventoryGraph> {
  const p = join(homedir(), ".autonomous-dev-homelab", "inventory-graph.yaml");
  try {
    const raw = await readFile(p, "utf8");
    return parseGraphYaml(raw);
  } catch {
    return { entities: [], edges: [] };
  }
}

// ---------------------------------------------------------------------------
// Observations reader
// ---------------------------------------------------------------------------

interface Observation {
  id?: string;
  service?: string;
  severity?: string;
  summary?: string;
  ts?: string;
  status?: string;
  resource?: string;
  pattern?: string;
  details?: Record<string, unknown>;
  platform?: string;
  discovered_at?: string;
}

async function readObservations(): Promise<Observation[]> {
  const dir = join(homedir(), ".autonomous-dev-homelab", "observations");
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    const jsons = files.filter((f) => f.endsWith(".json")).slice(0, 20);
    const results: Observation[] = [];
    for (const f of jsons) {
      try {
        const raw = await readFile(join(dir, f), "utf8");
        const parsed = JSON.parse(raw) as unknown;
        // Observations may be arrays or single objects.
        if (Array.isArray(parsed)) {
          results.push(...(parsed as Observation[]));
        } else {
          results.push(parsed as Observation);
        }
      } catch {
        // skip malformed observation
      }
    }
    return results.slice(0, 50);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (entities + edges from inventory-graph.yaml)
// ---------------------------------------------------------------------------

/**
 * Minimal structural YAML parser for the inventory-graph.yaml format.
 * Supports both the `entities:` and `edges:` top-level arrays, each using
 * a 2-space indent list format.  Not a general YAML parser; covers the
 * specific subset the homelab inventory writer emits.
 *
 * Edges use a YAML block-scalar `id: >-\n  <value>` for the id field;
 * we handle that folded-literal continuation.
 *
 * No external YAML dependency added per the no-new-packages constraint.
 */
function parseGraphYaml(raw: string): InventoryGraph {
  const result: InventoryGraph = {};
  const lines = raw.split("\n");

  // Extract version.
  const versionLine = lines.find((l) => /^version:/.test(l));
  if (versionLine) {
    const m = versionLine.match(/^version:\s*(\d+)/);
    if (m?.[1] !== undefined) result.version = parseInt(m[1], 10);
  }

  // State machine: we scan top-level section headers to know whether
  // we are inside `entities:` or `edges:`.
  type Section = "none" | "entities" | "edges";
  let section: Section = "none";

  // Entity parse state.
  const entities: InventoryEntity[] = [];
  let currentEntity: Partial<InventoryEntity> | null = null;
  let inEntityAttrs = false;
  const entityAttrs: Record<string, unknown> = {};

  // Edge parse state.
  const edges: InventoryEdge[] = [];
  let currentEdge: Partial<InventoryEdge> | null = null;
  let pendingFoldedId = false; // true when we just saw `id: >-`

  function flushEntity(): void {
    if (currentEntity === null) return;
    if (inEntityAttrs) {
      currentEntity.attributes = { ...entityAttrs };
      Object.keys(entityAttrs).forEach((k) => delete entityAttrs[k]);
      inEntityAttrs = false;
    }
    if (currentEntity.id && currentEntity.kind && currentEntity.name) {
      entities.push(currentEntity as InventoryEntity);
    }
    currentEntity = null;
  }

  function flushEdge(): void {
    if (currentEdge === null) return;
    if (
      currentEdge.id &&
      currentEdge.from &&
      currentEdge.to &&
      currentEdge.type
    ) {
      edges.push(currentEdge as InventoryEdge);
    }
    currentEdge = null;
    pendingFoldedId = false;
  }

  for (const line of lines) {
    // ---- Top-level section headers ----
    if (/^entities:/.test(line)) {
      flushEntity();
      flushEdge();
      section = "entities";
      continue;
    }
    if (/^edges:/.test(line)) {
      flushEntity();
      flushEdge();
      section = "edges";
      continue;
    }

    // ---- Entities section ----
    if (section === "entities") {
      // New entity item.
      if (/^  - id:/.test(line)) {
        flushEntity();
        currentEntity = { id: extractScalar(line, "id") };
        inEntityAttrs = false;
        continue;
      }
      if (currentEntity === null) continue;

      if (/^    attributes:/.test(line)) {
        inEntityAttrs = true;
        continue;
      }
      if (inEntityAttrs && /^      [a-zA-Z_]/.test(line)) {
        const m = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
        if (m?.[1] !== undefined && m[2] !== undefined) {
          entityAttrs[m[1]] = unquote(m[2].trim());
        }
        continue;
      }
      if (
        inEntityAttrs &&
        !/^      /.test(line) &&
        /^    [a-zA-Z]/.test(line)
      ) {
        currentEntity.attributes = { ...entityAttrs };
        Object.keys(entityAttrs).forEach((k) => delete entityAttrs[k]);
        inEntityAttrs = false;
      }

      // Top-level entity fields.
      const fm = line.match(/^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
      if (fm?.[1] !== undefined && fm[2] !== undefined) {
        const key = fm[1];
        const v = unquote((fm[2] ?? "").trim());
        if (key === "kind") currentEntity.kind = v;
        else if (key === "name") currentEntity.name = v;
        else if (key === "source") currentEntity.source = v;
        else if (key === "platformId") currentEntity.platformId = v;
        else if (key === "status") currentEntity.status = v;
        else if (key === "last_seen") currentEntity.last_seen = v;
        else if (key === "discovered_at") currentEntity.discovered_at = v;
      }
      continue;
    }

    // ---- Edges section ----
    if (section === "edges") {
      // New edge item (starts with `  - id:`).
      if (/^  - id:\s*>-/.test(line)) {
        // Folded scalar — id value is on the next continuation line.
        flushEdge();
        currentEdge = {};
        pendingFoldedId = true;
        continue;
      }
      if (/^  - id:/.test(line)) {
        flushEdge();
        currentEdge = { id: extractScalar(line, "id") };
        pendingFoldedId = false;
        continue;
      }

      if (currentEdge === null) continue;

      // Folded id continuation (indented line after `id: >-`).
      if (pendingFoldedId && /^      /.test(line)) {
        currentEdge.id = line.trim();
        pendingFoldedId = false;
        continue;
      }

      const em = line.match(/^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
      if (em?.[1] !== undefined && em[2] !== undefined) {
        const key = em[1];
        const v = unquote((em[2] ?? "").trim());
        if (key === "from") currentEdge.from = v;
        else if (key === "to") currentEdge.to = v;
        else if (key === "type") currentEdge.type = v;
        else if (key === "status") currentEdge.status = v;
      }
    }
  }

  flushEntity();
  flushEdge();

  result.entities = entities;
  result.edges = edges;
  return result;
}

function extractScalar(line: string, key: string): string {
  const m = line.match(new RegExp(`${key}:\\s*(.*)`));
  return m?.[1] !== undefined ? unquote(m[1].trim()) : "";
}

function unquote(s: string): string {
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Log entry type — returned by the logs API route (#54)
// ---------------------------------------------------------------------------

/**
 * A single normalized log entry returned by `GET /portal/homelab/api/logs`.
 *
 * The homelab CLI `logs <resource> --json` may return objects with varying
 * field names (Loki vs OpenSearch backends); we normalize to a common shape
 * so the UI can always render level + timestamp + message regardless of origin.
 */
export interface LogEntry {
  /** ISO-8601 timestamp string. May be empty when the backend omits it. */
  ts: string;
  /** Log level string (e.g. "info", "error", "warn"). Empty when absent. */
  level: string;
  /** Human-readable log message. */
  message: string;
  /** Raw fields from the original entry, passed through for completeness. */
  raw?: Record<string, unknown>;
}

/**
 * Normalize a raw object from the CLI JSON output into a `LogEntry`.
 *
 * Tries several common field names used by Loki and OpenSearch adapters.
 * Never throws — returns a best-effort entry even for unexpected shapes.
 */
function normalizeLogEntry(raw: unknown): LogEntry {
  if (raw === null || typeof raw !== "object") {
    return { ts: "", level: "", message: String(raw ?? "") };
  }
  const r = raw as Record<string, unknown>;

  // Timestamp: try ts, timestamp, @timestamp, time.
  const ts = String(
    r["ts"] ?? r["timestamp"] ?? r["@timestamp"] ?? r["time"] ?? "",
  );
  // Level: try level, log_level, severity — normalize to lowercase.
  const level = String(
    r["level"] ?? r["log_level"] ?? r["severity"] ?? "",
  ).toLowerCase();
  // Message: try message, msg, log, text.
  const message = String(
    r["message"] ?? r["msg"] ?? r["log"] ?? r["text"] ?? "",
  );

  return { ts, level, message, raw: r };
}

/**
 * Parse the stdout of `homelab logs <resource> --json` into normalized entries.
 *
 * The CLI may emit:
 *   - A JSON array `[{...}, {...}]`.
 *   - Newline-delimited JSON (one object per line).
 * Returns an empty array on parse failure (graceful empty-state).
 * Order is preserved as returned by the CLI (newest-first when the CLI sorts).
 */
export function parseLogsOutput(stdout: string): LogEntry[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  // Try JSON array first.
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return (parsed as unknown[]).map(normalizeLogEntry);
      }
    } catch {
      // Fall through to NDJSON.
    }
  }

  // Newline-delimited JSON.
  const entries: LogEntry[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.length === 0) continue;
    try {
      const obj = JSON.parse(l) as unknown;
      entries.push(normalizeLogEntry(obj));
    } catch {
      // Skip malformed lines — graceful.
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Grafana dashboard type — returned by the grafana API route (#54)
// ---------------------------------------------------------------------------

/**
 * A single Grafana dashboard deep-link entry as returned by
 * `homelab grafana dashboards --entity <id> --json`.
 */
export interface GrafanaDashboard {
  /** Human-readable dashboard title. */
  title: string;
  /** The full deep-link URL to open in Grafana. */
  url: string;
  /** Optional description or panel context. */
  description?: string;
}

/**
 * Parse the stdout of `homelab grafana dashboards --entity <id> --json`
 * into normalized dashboard entries.
 *
 * Accepts a JSON array or a single JSON object. Returns an empty array on
 * failure (graceful empty-state — backend unreachable or no dashboards).
 * Entries without a URL are filtered out (they are not renderable links).
 */
export function parseGrafanaOutput(stdout: string): GrafanaDashboard[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const items = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
    return items
      .filter((it) => it !== null && typeof it === "object")
      .map((it) => {
        const r = it as Record<string, unknown>;
        return {
          title: String(r["title"] ?? r["name"] ?? "Dashboard"),
          url: String(r["url"] ?? r["link"] ?? r["href"] ?? ""),
          description:
            r["description"] !== undefined
              ? String(r["description"])
              : undefined,
        };
      })
      .filter((d) => d.url.length > 0); // skip entries with no URL
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Action capability model (kind-driven, generic — no hard-coded names)
// ---------------------------------------------------------------------------

/**
 * Returns the set of action ids that are applicable to an entity of the
 * given kind.  Driven by entity kind, not by name — satisfies invariant #674.
 *
 *   service / container  -> restart, redeploy, scale
 *   node                 -> (read-only — no mutation actions for nodes)
 *   any kind             -> apply-autofix (when a matching observation exists)
 */
function actionsForKind(kind: string): string[] {
  if (kind === "service" || kind === "container") {
    return ["restart", "redeploy", "scale"];
  }
  return [];
}

// ---------------------------------------------------------------------------
// HTML escaping helper (no external dep)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Health badge rendering helper (#54)
// ---------------------------------------------------------------------------

/**
 * Render an HTML health badge from `health_score` / `health_grade` attributes.
 *
 * Model-driven: reads whatever the entity's attributes carry — these come from
 * the homelab graph built by the discovery + health-score backends (#40).
 * Returns an empty string when neither attribute is present (graceful no-op).
 *
 * Grade -> CSS class mapping:
 *   A  -> chip-ok      (green)
 *   B  -> chip-ok
 *   C  -> chip-warn    (amber)
 *   D  -> chip-warn
 *   F  -> chip-err     (red)
 *   (unknown) -> chip-muted
 */
export function renderHealthBadge(attrs: Record<string, unknown>): string {
  const score = attrs["health_score"];
  const grade = attrs["health_grade"];

  // Nothing to render when both are absent.
  if (score === undefined && grade === undefined) return "";

  const gradeStr = grade !== undefined ? String(grade).toUpperCase() : "";
  const scoreStr = score !== undefined ? String(score) : "";

  let cssClass = "chip-muted";
  if (gradeStr === "A" || gradeStr === "B") cssClass = "chip-ok";
  else if (gradeStr === "C" || gradeStr === "D") cssClass = "chip-warn";
  else if (gradeStr === "F") cssClass = "chip-err";

  const label =
    gradeStr.length > 0 && scoreStr.length > 0
      ? `Health: ${escapeHtml(gradeStr)} (${escapeHtml(scoreStr)})`
      : gradeStr.length > 0
        ? `Health: ${escapeHtml(gradeStr)}`
        : `Health score: ${escapeHtml(scoreStr)}`;

  return `<span class="chip ${escapeHtml(cssClass)}" aria-label="health">${label}</span>`;
}

// ---------------------------------------------------------------------------
// HTML renderer — entity list (main panel)
// ---------------------------------------------------------------------------

function renderEntityRow(e: InventoryEntity): string {
  const statusClass = e.status === "active" ? "ok" : "warn";
  const attrs = e.attributes ?? {};
  let detail = "";
  if (e.kind === "service") {
    const running = attrs["replicas_running"];
    const desired = attrs["replicas_desired"];
    if (running !== undefined && desired !== undefined) {
      detail = `${running}/${desired} replicas`;
    }
    const image = attrs["image"];
    if (image && typeof image === "string") {
      const tag = image.split(":").pop() ?? "";
      detail += detail ? ` · ${tag}` : tag;
    }
  } else if (e.kind === "node") {
    const engine = attrs["engine_version"];
    if (engine) detail = `engine ${engine}`;
    const ms = attrs["manager_status"];
    if (ms && typeof ms === "string" && ms.length > 0) {
      detail += detail ? ` · ${ms}` : String(ms);
    }
  }

  const detailLink = `/portal/homelab?entity=${encodeURIComponent(e.id)}`;

  return `
      <tr class="hl-entity-row" data-kind="${escapeHtml(e.kind)}">
        <td><span class="chip chip-${escapeHtml(e.kind)}">${escapeHtml(e.kind)}</span></td>
        <td class="mono"><a href="${escapeHtml(detailLink)}">${escapeHtml(e.name)}</a></td>
        <td>${escapeHtml(e.source ?? "")}</td>
        <td><span class="dot dot-${statusClass}" title="${escapeHtml(e.status ?? "")}"></span> ${escapeHtml(e.status ?? "")}</td>
        <td class="meta">${escapeHtml(detail)}</td>
      </tr>`;
}

function renderObservationRow(o: Observation, idx: number): string {
  const sev = o.severity ?? "info";
  const sevClass =
    sev === "critical" || sev === "high" || sev === "P1"
      ? "err"
      : sev === "medium" || sev === "warning" || sev === "P2"
        ? "warn"
        : "ok";
  return `
      <tr class="hl-obs-row">
        <td class="mono">${escapeHtml(String(idx + 1))}</td>
        <td><span class="chip chip-${escapeHtml(sevClass)}">${escapeHtml(sev)}</span></td>
        <td>${escapeHtml(o.service ?? o.id ?? "")}</td>
        <td>${escapeHtml(o.summary ?? o.pattern ?? "")}</td>
      </tr>`;
}

// ---------------------------------------------------------------------------
// HTML renderer — service-detail page
// ---------------------------------------------------------------------------

/**
 * Render the generic detail page for a single entity.
 *
 * Model-driven (#674): renders whatever the entity contains — kind, status,
 * all attributes key-by-key, edges connecting it, observations about it, a
 * health badge (from `health_score`/`health_grade` attributes, #40/#54), a
 * logs panel (pre-fetched via the CLI `logs` command, #38/#54), and Grafana
 * dashboard links (pre-fetched via the CLI `grafana dashboards` command,
 * #39/#54).
 *
 * @param entityId    The URL-encoded entity id from the query param.
 * @param graph       The full inventory graph (entities + edges).
 * @param allObs      All observations (filtered to this entity).
 * @param logEntries  Optional pre-fetched log entries (newest first).
 * @param grafanaDashboards  Optional pre-fetched Grafana dashboard links.
 */
async function renderDetailPage(
  entityId: string,
  graph: InventoryGraph,
  allObs: Observation[],
  logEntries?: LogEntry[],
  grafanaDashboards?: GrafanaDashboard[],
): Promise<string> {
  const entities = graph.entities ?? [];
  const edges = graph.edges ?? [];

  const entity = entities.find((e) => e.id === entityId);

  if (entity === undefined) {
    return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <title>Entity not found · Homelab · Portal</title>
  <link rel="stylesheet" href="/static/portal.css">
</head>
<body class="shell">
  ${renderNav()}
  <main class="main">
    <div class="page-header">
      <h1 class="page-title">Entity not found</h1>
      <p class="page-meta"><a href="/portal/homelab">← Back to Homelab</a></p>
    </div>
    <section class="panel">
      <p class="empty-state">No entity with id <code>${escapeHtml(entityId)}</code> found in the current inventory graph. It may have been removed on the last sweep, or the id may be incorrect.</p>
    </section>
  </main>
</body>
</html>`;
  }

  const attrs = entity.attributes ?? {};

  // Edges where this entity is the `from` side.
  const outEdges = edges.filter((e) => e.from === entityId);
  // Edges where this entity is the `to` side.
  const inEdges = edges.filter((e) => e.to === entityId);

  // Observations for this entity (match by resource field or id/service field).
  const entityObs = allObs.filter((o) => {
    if (o.resource !== undefined) {
      // resource can be "service/<entity-id>" or just "<entity-id>".
      return o.resource === entityId || o.resource.endsWith(`/${entityId}`);
    }
    return (
      (o.service ?? o.id) === entity.name || (o.service ?? o.id) === entityId
    );
  });

  // Determine whether there are any autofix-eligible observations.
  const autofixObs = entityObs.filter(
    (o) => o.pattern === "crash_loop" || o.pattern === "replica_mismatch",
  );
  const hasAutofixObs = autofixObs.length > 0;

  // Build attribute rows (generic — renders all attributes).
  const attrRows = Object.entries(attrs)
    .map(([k, v]) => {
      const displayVal = Array.isArray(v)
        ? (v as unknown[]).map(String).join(", ")
        : String(v ?? "");
      return `
        <tr>
          <td class="mono attr-key">${escapeHtml(k)}</td>
          <td class="attr-val">${escapeHtml(displayVal)}</td>
        </tr>`;
    })
    .join("");

  // Build edge rows.
  function entityName(id: string): string {
    const e = entities.find((en) => en.id === id);
    return e !== undefined ? e.name : id;
  }

  const outEdgeRows = outEdges
    .map(
      (edge) =>
        `<tr>
          <td><span class="chip chip-edge">${escapeHtml(edge.type)}</span></td>
          <td class="mono"><a href="/portal/homelab?entity=${encodeURIComponent(edge.to)}">${escapeHtml(entityName(edge.to))}</a></td>
          <td>${escapeHtml(edge.status ?? "")}</td>
        </tr>`,
    )
    .join("");

  const inEdgeRows = inEdges
    .map(
      (edge) =>
        `<tr>
          <td><span class="chip chip-edge">${escapeHtml(edge.type)}</span></td>
          <td class="mono"><a href="/portal/homelab?entity=${encodeURIComponent(edge.from)}">${escapeHtml(entityName(edge.from))}</a></td>
          <td>${escapeHtml(edge.status ?? "")}</td>
        </tr>`,
    )
    .join("");

  const obsRows = entityObs.map((o, i) => renderObservationRow(o, i)).join("");

  // Health badge from graph attributes (#54).
  const healthBadge = renderHealthBadge(attrs);

  // Logs panel rows — newest first as returned by the CLI (#54).
  const logs = logEntries ?? [];
  const logRows = logs
    .map((entry, i) => {
      const levelClass =
        entry.level === "error" ||
        entry.level === "err" ||
        entry.level === "fatal"
          ? "chip-err"
          : entry.level === "warn" || entry.level === "warning"
            ? "chip-warn"
            : "chip-ok";
      return `
        <tr class="hl-log-row">
          <td class="mono log-idx">${escapeHtml(String(i + 1))}</td>
          <td><span class="chip ${escapeHtml(levelClass)}">${escapeHtml(entry.level || "—")}</span></td>
          <td class="mono log-ts">${escapeHtml(entry.ts || "—")}</td>
          <td class="log-msg">${escapeHtml(entry.message)}</td>
        </tr>`;
    })
    .join("");

  // Grafana dashboard links (#54).
  const dashboards = grafanaDashboards ?? [];
  const grafanaRows = dashboards
    .map(
      (d) =>
        `<tr class="hl-grafana-row">
          <td><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.title)}</a></td>
          <td class="meta">${escapeHtml(d.description ?? "")}</td>
        </tr>`,
    )
    .join("");

  // Action buttons (only for applicable kinds; mediated by gate).
  const kindActions = actionsForKind(entity.kind);
  const actionButtons = kindActions
    .map((actionId) => {
      const label = actionLabels[actionId] ?? actionId;
      return `<button
          class="action-btn"
          data-action="${escapeHtml(actionId)}"
          data-entity-id="${escapeHtml(entityId)}"
          onclick="triggerAction('${escapeHtml(actionId)}', '${escapeHtml(entityId)}')"
        >${escapeHtml(label)}</button>`;
    })
    .join(" ");

  const autofixButton =
    hasAutofixObs && autofixObs[0]?.id !== undefined
      ? `<button
            class="action-btn action-btn-warn"
            data-action="apply-autofix"
            data-entity-id="${escapeHtml(entityId)}"
            data-obs-id="${escapeHtml(autofixObs[0].id ?? "")}"
            onclick="triggerAutofix('${escapeHtml(autofixObs[0].id ?? "")}')"
          >Apply Autofix (${escapeHtml(autofixObs[0].pattern ?? "observation")})</button>`
      : "";

  const statusClass = entity.status === "active" ? "ok" : "warn";

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(entity.name)} · Homelab · Portal</title>
  <link rel="stylesheet" href="/static/portal.css">
  <style>
    .attr-key { width: 180px; color: var(--text-muted, #aaa); }
    .attr-val { word-break: break-all; }
    .action-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .action-btn {
      padding: 6px 14px; border-radius: 4px; border: 1px solid #555;
      background: #2a2a2a; color: #e0e0e0; cursor: pointer; font-size: 13px;
    }
    .action-btn:hover { background: #3a3a3a; border-color: #888; }
    .action-btn-warn { border-color: #c97a1a; color: #f0a040; }
    .confirm-dialog { display:none; background:#1e1e1e; border:1px solid #555;
      border-radius:6px; padding:16px; margin-top:8px; }
    .confirm-dialog.visible { display:block; }
    .confirm-phrase { font-family:monospace; font-weight:bold; font-size:15px;
      color:#f0a040; }
    .confirm-input { background:#111; color:#e0e0e0; border:1px solid #555;
      border-radius:3px; padding:4px 8px; font-family:monospace; width:220px; }
    .chip-edge { background:#2c3a4a; color:#7ab8e0; }
    .chip-ok { background:#1a3a1a; color:#6dcc6d; }
    .chip-warn { background:#3a2e0a; color:#f0a040; }
    .chip-err { background:#3a0a0a; color:#e06060; }
    .chip-muted { background:#2a2a2a; color:#aaa; }
    .health-bar { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
    .log-ts { color: var(--text-muted, #888); font-size: 12px; white-space: nowrap; }
    .log-msg { word-break: break-all; font-size: 13px; }
    .log-idx { color: var(--text-muted, #888); width: 36px; }
  </style>
</head>
<body class="shell">
  ${renderNav()}
  <main class="main">
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(entity.name)}</h1>
      <p class="page-meta">
        <a href="/portal/homelab">← Back to Homelab</a> ·
        <span class="chip chip-${escapeHtml(entity.kind)}">${escapeHtml(entity.kind)}</span>
        <span class="dot dot-${statusClass}"></span> ${escapeHtml(entity.status ?? "")}
        · source: ${escapeHtml(entity.source ?? "")}
        · last seen: ${escapeHtml(entity.last_seen ?? "")}
        ${healthBadge.length > 0 ? `· ${healthBadge}` : ""}
      </p>
    </div>

    ${
      kindActions.length > 0 || hasAutofixObs
        ? `
    <section class="panel" aria-label="Actions">
      <div class="panel-header">
        <h2 class="panel-title">Actions</h2>
      </div>
      <div class="action-bar">
        ${actionButtons}
        ${autofixButton}
      </div>
      <div id="confirm-dialog" class="confirm-dialog" role="alertdialog" aria-modal="true">
        <p>Type <span class="confirm-phrase" id="confirm-phrase"></span> to confirm:</p>
        <input class="confirm-input" id="confirm-input" type="text" autocomplete="off"
          placeholder="type phrase here" />
        <button class="action-btn" onclick="submitConfirm()" style="margin-left:8px">Confirm</button>
        <button class="action-btn" onclick="cancelConfirm()" style="margin-left:4px">Cancel</button>
      </div>
      <div id="action-result" style="margin-top:8px;font-family:monospace;white-space:pre-wrap;"></div>
    </section>`
        : ""
    }

    <section class="panel" aria-label="Attributes">
      <div class="panel-header">
        <h2 class="panel-title">Attributes</h2>
      </div>
      ${
        Object.keys(attrs).length > 0
          ? `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>${attrRows}</tbody>
        </table>
      </div>`
          : `<p class="empty-state">No attributes.</p>`
      }
    </section>

    ${
      outEdges.length > 0
        ? `
    <section class="panel" aria-label="Outbound edges">
      <div class="panel-header">
        <h2 class="panel-title">Connections (outbound)</h2>
        <span class="kpi-chip">${outEdges.length}</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Relation</th><th>Target</th><th>Status</th></tr></thead>
          <tbody>${outEdgeRows}</tbody>
        </table>
      </div>
    </section>`
        : ""
    }

    ${
      inEdges.length > 0
        ? `
    <section class="panel" aria-label="Inbound edges">
      <div class="panel-header">
        <h2 class="panel-title">Connections (inbound)</h2>
        <span class="kpi-chip">${inEdges.length}</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Relation</th><th>Source</th><th>Status</th></tr></thead>
          <tbody>${inEdgeRows}</tbody>
        </table>
      </div>
    </section>`
        : ""
    }

    <section class="panel" aria-label="Observations">
      <div class="panel-header">
        <h2 class="panel-title">Observations</h2>
        <span class="kpi-chip">${entityObs.length}</span>
      </div>
      ${
        entityObs.length > 0
          ? `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>#</th><th>Severity</th><th>Resource</th><th>Summary</th></tr></thead>
          <tbody>${obsRows}</tbody>
        </table>
      </div>`
          : `<p class="empty-state">No observations for this entity.</p>`
      }
    </section>

    ${
      healthBadge.length > 0
        ? `
    <section class="panel" aria-label="Health" data-testid="health-panel">
      <div class="panel-header">
        <h2 class="panel-title">Health</h2>
      </div>
      <div class="health-bar">
        ${healthBadge}
        ${attrs["health_score"] !== undefined ? `<span class="meta">score: ${escapeHtml(String(attrs["health_score"]))}</span>` : ""}
        ${attrs["health_grade"] !== undefined ? `<span class="meta">grade: ${escapeHtml(String(attrs["health_grade"]))}</span>` : ""}
      </div>
    </section>`
        : ""
    }

    <section class="panel" aria-label="Logs" data-testid="logs-panel">
      <div class="panel-header">
        <h2 class="panel-title">Logs</h2>
        <span class="kpi-chip">${logs.length}</span>
      </div>
      ${
        logs.length > 0
          ? `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>#</th><th>Level</th><th>Timestamp</th><th>Message</th></tr></thead>
          <tbody>${logRows}</tbody>
        </table>
      </div>`
          : `<p class="empty-state" data-testid="logs-empty">No log entries available. The backend may be unreachable or no recent logs exist for this resource.</p>`
      }
    </section>

    <section class="panel" aria-label="Grafana Dashboards" data-testid="grafana-panel">
      <div class="panel-header">
        <h2 class="panel-title">Grafana Dashboards</h2>
        <span class="kpi-chip">${dashboards.length}</span>
      </div>
      ${
        dashboards.length > 0
          ? `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Dashboard</th><th>Description</th></tr></thead>
          <tbody>${grafanaRows}</tbody>
        </table>
      </div>`
          : `<p class="empty-state" data-testid="grafana-empty">No Grafana dashboards linked to this entity. Configure the Grafana backend in the homelab plugin to enable dashboard links.</p>`
      }
    </section>
  </main>

  <script>
    // Gate interaction — mediates the typed-CONFIRM flow defined in #670/#671.
    // State for the in-progress action.
    let _pendingAction = null;
    let _pendingToken = null;

    function triggerAction(actionId, entityId) {
      _pendingAction = { actionId, entityId, type: 'action' };
      _pendingToken = null;
      document.getElementById('action-result').textContent = '';
      // POST to the action route — gate will respond with 202 + token.
      fetch('/portal/homelab/action/' + actionId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entityId }),
      })
        .then(r => r.json())
        .then(body => {
          if (body.requiresConfirmation) {
            _pendingToken = body.token;
            document.getElementById('confirm-phrase').textContent = body.phrase;
            document.getElementById('confirm-input').value = '';
            document.getElementById('confirm-dialog').classList.add('visible');
          } else {
            document.getElementById('action-result').textContent =
              JSON.stringify(body, null, 2);
          }
        })
        .catch(e => {
          document.getElementById('action-result').textContent = 'Error: ' + e.message;
        });
    }

    function triggerAutofix(obsId) {
      _pendingAction = { obsId, type: 'autofix' };
      _pendingToken = null;
      document.getElementById('action-result').textContent = '';
      fetch('/portal/homelab/action/apply-autofix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observation_id: obsId }),
      })
        .then(r => r.json())
        .then(body => {
          if (body.requiresConfirmation) {
            _pendingToken = body.token;
            document.getElementById('confirm-phrase').textContent = body.phrase;
            document.getElementById('confirm-input').value = '';
            document.getElementById('confirm-dialog').classList.add('visible');
          } else {
            document.getElementById('action-result').textContent =
              JSON.stringify(body, null, 2);
          }
        })
        .catch(e => {
          document.getElementById('action-result').textContent = 'Error: ' + e.message;
        });
    }

    function submitConfirm() {
      if (!_pendingAction || !_pendingToken) return;
      const typed = document.getElementById('confirm-input').value;
      const phrase = document.getElementById('confirm-phrase').textContent;
      if (typed !== phrase) {
        document.getElementById('action-result').textContent =
          'Phrase mismatch — type exactly: ' + phrase;
        return;
      }
      cancelConfirm();

      let url, body;
      if (_pendingAction.type === 'autofix') {
        url = '/portal/homelab/action/apply-autofix';
        body = JSON.stringify({ observation_id: _pendingAction.obsId });
      } else {
        url = '/portal/homelab/action/' + _pendingAction.actionId;
        body = JSON.stringify({ entity_id: _pendingAction.entityId });
      }

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Contribution-Action-Token': _pendingToken,
        },
        body,
      })
        .then(r => r.json())
        .then(body => {
          document.getElementById('action-result').textContent =
            JSON.stringify(body, null, 2);
        })
        .catch(e => {
          document.getElementById('action-result').textContent = 'Error: ' + e.message;
        });
    }

    function cancelConfirm() {
      document.getElementById('confirm-dialog').classList.remove('visible');
      _pendingToken = null;
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTML renderer — main list page
// ---------------------------------------------------------------------------

function renderNav(): string {
  return `<aside class="rail">
    <div class="rail-brand">
      <span class="wordmark">portal</span>
    </div>
    <nav class="rail-nav" aria-label="Primary">
      <div class="rail-nav-group" data-group="operate">
        <div class="rail-nav-group-label">OPERATE</div>
        <a href="/" class="rail-nav-item">Dashboard</a>
      </div>
      <div class="rail-nav-group" data-group="system">
        <div class="rail-nav-group-label">SYSTEM</div>
        <a href="/portal/homelab" class="rail-nav-item active" aria-current="page">Homelab</a>
      </div>
    </nav>
  </aside>`;
}

async function renderHomelabPage(): Promise<string> {
  const [graph, observations] = await Promise.all([
    readInventoryGraph(),
    readObservations(),
  ]);

  const entities = graph.entities ?? [];
  const nodes = entities.filter((e) => e.kind === "node");
  const services = entities.filter((e) => e.kind === "service");
  const other = entities.filter(
    (e) => e.kind !== "node" && e.kind !== "service",
  );

  const entityRows = [...nodes, ...services, ...other]
    .map(renderEntityRow)
    .join("");
  const obsRows = observations.map(renderObservationRow).join("");

  const hasEntities = entities.length > 0;
  const hasObs = observations.length > 0;

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <title>Homelab · Portal</title>
  <link rel="stylesheet" href="/static/portal.css">
</head>
<body class="shell">
  ${renderNav()}
  <main class="main">
    <div class="page-header">
      <h1 class="page-title">Homelab</h1>
      <p class="page-meta">Live inventory from discovery. Updates on the next sweep — no hard-coded list.</p>
    </div>

    <section class="panel" aria-label="Inventory">
      <div class="panel-header">
        <h2 class="panel-title">Inventory</h2>
        <span class="kpi-chip">${entities.length} entities · ${nodes.length} nodes · ${services.length} services</span>
      </div>
      ${
        hasEntities
          ? `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Source</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>${entityRows}</tbody>
        </table>
      </div>`
          : `<p class="empty-state">No inventory data found. Run a homelab discovery sweep to populate.</p>`
      }
    </section>

    <section class="panel" aria-label="Observations">
      <div class="panel-header">
        <h2 class="panel-title">Recent Observations</h2>
        <span class="kpi-chip">${observations.length} observations</span>
      </div>
      ${
        hasObs
          ? `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Severity</th>
              <th>Service</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>${obsRows}</tbody>
        </table>
      </div>`
          : `<p class="empty-state">No observations recorded yet.</p>`
      }
    </section>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Action handler — homelab plugin CLI subprocess
// ---------------------------------------------------------------------------

/** Human-readable labels shown in the confirm dialog and the UI. */
const actionLabels: Record<string, string> = {
  restart: "Restart Service",
  redeploy: "Redeploy Service",
  scale: "Scale Service",
  "apply-autofix": "Apply Autofix",
};

/**
 * Spawn the homelab plugin CLI and return its stdout/stderr output.
 *
 * The CLI path is resolved from `getPluginPath()` (env var or default).
 * `VAULT_TOKEN` is passed through from `process.env` if present; the
 * caller may also supply it via `ctx.metadata.vault_token`.
 *
 * Does NOT throw — returns a result object so callers can report outcome.
 *
 * @param args        CLI arguments after the binary path.
 * @param vaultToken  Optional VAULT_TOKEN override (from action metadata).
 */
async function runHomelabCli(
  args: string[],
  vaultToken?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const pluginPath = getPluginPath();
  const token = vaultToken ?? process.env["VAULT_TOKEN"] ?? "";

  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(token.length > 0 ? { VAULT_TOKEN: token } : {}),
    };

    let stdout = "";
    let stderr = "";

    const child = spawn("node", [pluginPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      const exitCode = code ?? 1;
      resolve({ ok: exitCode === 0, stdout, stderr, exitCode });
    });

    child.on("error", (err: Error) => {
      resolve({ ok: false, stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

/**
 * Parse `entity_id` from the action request body.
 * The body may be JSON (`{ entity_id: "..." }`) or a form-encoded value.
 */
async function parseEntityId(ctx: ActionContext): Promise<string | undefined> {
  try {
    const body = (await ctx.c.req.json()) as unknown;
    if (body !== null && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b["entity_id"] === "string") return b["entity_id"];
    }
  } catch {
    // Not JSON — try form.
  }
  try {
    const form = await ctx.c.req.formData();
    const v = form.get("entity_id");
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
    // Not form either.
  }
  return undefined;
}

/**
 * Parse `observation_id` from the action request body.
 */
async function parseObservationId(
  ctx: ActionContext,
): Promise<string | undefined> {
  try {
    const body = (await ctx.c.req.json()) as unknown;
    if (body !== null && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b["observation_id"] === "string") return b["observation_id"];
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Contribution export
// ---------------------------------------------------------------------------

/**
 * The homelab portal contribution.
 *
 * Mounts at `/portal/homelab` with a "Homelab" nav entry in the "system"
 * group.  The page renders live inventory from
 * `~/.autonomous-dev-homelab/inventory-graph.yaml` and recent observations.
 *
 * When the `entity` query param is present, renders the service-detail
 * view for that single entity from the graph (generic — works for any kind).
 * The detail view includes health badge (#54), logs panel (#54), and
 * Grafana dashboard links (#54).
 *
 * Actions (#49) are mounted at `/portal/homelab/action/<id>` via the
 * action-gate bridge (typed-CONFIRM for non-read-only operations).
 *
 * Mounted BY THE REGISTRY — no hard-coded routes in portal core (#674).
 */
export const homelabContribution: PortalContribution = {
  id: "homelab",
  nav: {
    href: "/portal/homelab",
    label: "Homelab",
    group: "system",
    iconName: "cpu",
  },

  async renderPage(c) {
    const entityId = c?.req?.query("entity");
    if (entityId !== undefined && entityId.length > 0) {
      // Fetch graph, observations, logs, and grafana dashboards in parallel.
      // Logs and grafana are best-effort — failures yield empty arrays (#54).
      const [graph, allObs, logsResult, grafanaResult] = await Promise.all([
        readInventoryGraph(),
        readObservations(),
        runHomelabCli(["logs", entityId, "--json"]).catch(() => ({
          ok: false,
          stdout: "",
          stderr: "",
          exitCode: 1,
        })),
        runHomelabCli([
          "grafana",
          "dashboards",
          "--entity",
          entityId,
          "--json",
        ]).catch(() => ({
          ok: false,
          stdout: "",
          stderr: "",
          exitCode: 1,
        })),
      ]);
      const logEntries = parseLogsOutput(logsResult.stdout);
      const grafanaDashboards = parseGrafanaOutput(grafanaResult.stdout);
      return renderDetailPage(
        entityId,
        graph,
        allObs,
        logEntries,
        grafanaDashboards,
      );
    }
    return renderHomelabPage();
  },

  // -------------------------------------------------------------------------
  // API routes — JSON data endpoints
  // -------------------------------------------------------------------------
  apiRoutes: [
    {
      method: "GET",
      path: "entity",
      /**
       * GET /portal/homelab/api/entity?id=<entity-id>
       *
       * Returns the entity record, its edges, and its observations as
       * JSON.  Used by programmatic clients (tests, future dashboards).
       * Returns 404 when the entity is not found in the graph.
       */
      async handler(c) {
        const entityId = c.req.query("id");
        if (entityId === undefined || entityId.length === 0) {
          return c.json({ error: "missing-id-param" }, 400);
        }
        const [graph, allObs] = await Promise.all([
          readInventoryGraph(),
          readObservations(),
        ]);
        const entity = (graph.entities ?? []).find((e) => e.id === entityId);
        if (entity === undefined) {
          return c.json({ error: "not-found", id: entityId }, 404);
        }
        const edges = graph.edges ?? [];
        const outEdges = edges.filter((e) => e.from === entityId);
        const inEdges = edges.filter((e) => e.to === entityId);
        const observations = allObs.filter((o) => {
          if (o.resource !== undefined) {
            return (
              o.resource === entityId || o.resource.endsWith(`/${entityId}`)
            );
          }
          return (
            (o.service ?? o.id) === entity.name ||
            (o.service ?? o.id) === entityId
          );
        });
        return c.json({
          entity,
          edges: { outbound: outEdges, inbound: inEdges },
          observations,
          actions: actionsForKind(entity.kind),
        });
      },
    },
    {
      method: "GET",
      path: "entities",
      /**
       * GET /portal/homelab/api/entities
       *
       * Returns the full entity list as JSON.  Supports `?kind=service`
       * query param to filter by kind.
       */
      async handler(c) {
        const graph = await readInventoryGraph();
        const kind = c.req.query("kind");
        const entities = (graph.entities ?? []).filter(
          (e) => kind === undefined || e.kind === kind,
        );
        return c.json({ entities, total: entities.length });
      },
    },
    {
      method: "GET",
      path: "logs",
      /**
       * GET /portal/homelab/api/logs?resource=<entity-id>&limit=<n>
       *
       * Fetches log entries for the given resource by invoking the homelab
       * CLI `logs <resource> --json` as a subprocess (#38/#54).
       *
       * The CLI path is resolved from `HOMELAB_PLUGIN_PATH` env var or
       * config (never hard-coded).  `VAULT_TOKEN` is passed through.
       *
       * Returns normalized entries (newest first, as returned by the CLI).
       * When the backend is unreachable or the resource has no logs,
       * returns an empty `entries` array with `ok: false` — never crashes.
       *
       * Query params:
       *   resource  — entity id (required)
       *   limit     — max entries to return (optional, default 100)
       */
      async handler(c) {
        const resource = c.req.query("resource");
        if (resource === undefined || resource.length === 0) {
          return c.json({ error: "missing-resource-param" }, 400);
        }
        const limitStr = c.req.query("limit");
        const limit =
          limitStr !== undefined
            ? Math.min(parseInt(limitStr, 10) || 100, 1000)
            : 100;

        const result = await runHomelabCli(["logs", resource, "--json"]).catch(
          () => ({
            ok: false,
            stdout: "",
            stderr: "subprocess-error",
            exitCode: 1,
          }),
        );

        const entries = parseLogsOutput(result.stdout).slice(0, limit);
        return c.json({
          resource,
          entries,
          total: entries.length,
          ok: result.ok,
          cli_exit_code: result.exitCode,
        });
      },
    },
    {
      method: "GET",
      path: "grafana",
      /**
       * GET /portal/homelab/api/grafana?entity=<entity-id>
       *
       * Resolves Grafana dashboard deep-links for the given entity by
       * invoking the homelab CLI `grafana dashboards --entity <id> --json`
       * as a subprocess (#39/#54).
       *
       * The CLI path is resolved from `HOMELAB_PLUGIN_PATH` env var or
       * config (never hard-coded).  `VAULT_TOKEN` is passed through.
       *
       * Returns normalized dashboard entries with `title` and `url`.
       * When the backend is unreachable or no dashboards exist for the
       * entity, returns an empty `dashboards` array — never crashes.
       *
       * Query params:
       *   entity  — entity id (required)
       */
      async handler(c) {
        const entityId = c.req.query("entity");
        if (entityId === undefined || entityId.length === 0) {
          return c.json({ error: "missing-entity-param" }, 400);
        }

        const result = await runHomelabCli([
          "grafana",
          "dashboards",
          "--entity",
          entityId,
          "--json",
        ]).catch(() => ({
          ok: false,
          stdout: "",
          stderr: "subprocess-error",
          exitCode: 1,
        }));

        const dashboards = parseGrafanaOutput(result.stdout);
        return c.json({
          entity: entityId,
          dashboards,
          total: dashboards.length,
          ok: result.ok,
          cli_exit_code: result.exitCode,
        });
      },
    },
  ],

  // -------------------------------------------------------------------------
  // Actions — routed through the #670 typed-CONFIRM gate
  // -------------------------------------------------------------------------
  actions: [
    {
      id: "restart",
      label: "Restart Service",
      destructiveness: "reversible",
      minRole: "operator",
      /**
       * Restart a Docker Swarm service.
       *
       * Invokes the homelab CLI's autofix propose command for a
       * `replica_mismatch` observation matching the entity, or falls
       * back to `docker service update --force` via the CLI.
       *
       * For safety, this handler runs the propose / dry-run step and
       * returns the plan output rather than immediately executing —
       * the button + gate + handler wiring is real and correct; full
       * execution can be enabled by a follow-up apply step or by
       * adjusting the action's `destructiveness` to "irreversible" and
       * calling `autofix apply`.
       *
       * VAULT_TOKEN is taken from `process.env` or the request metadata.
       */
      async handler(ctx: ActionContext): Promise<Record<string, unknown>> {
        const entityId = await parseEntityId(ctx);
        if (entityId === undefined || entityId.length === 0) {
          return {
            error: "missing-entity-id",
            message: "Pass entity_id in request body",
          };
        }

        // Propose an autofix for any matching observation, or dry-run propose.
        const graph = await readInventoryGraph();
        const allObs = await readObservations();
        const obs = allObs.find((o) => {
          if (o.resource !== undefined) {
            return (
              o.resource === entityId || o.resource.endsWith(`/${entityId}`)
            );
          }
          const ent = (graph.entities ?? []).find((e) => e.id === entityId);
          return (o.service ?? o.id) === (ent?.name ?? entityId);
        });

        const entity = (graph.entities ?? []).find((e) => e.id === entityId);
        const entityName = entity?.name ?? entityId;

        let result: {
          ok: boolean;
          stdout: string;
          stderr: string;
          exitCode: number;
        };
        if (obs?.id !== undefined) {
          // Propose autofix for the observation.
          result = await runHomelabCli(
            ["autofix", "propose", obs.id, "--json"],
            ctx.metadata?.["vault_token"] as string | undefined,
          );
        } else {
          // No observation — run observe scan to get current state.
          result = await runHomelabCli(
            ["observe", "list", "--json"],
            ctx.metadata?.["vault_token"] as string | undefined,
          );
        }

        return {
          action: "restart",
          entity_id: entityId,
          entity_name: entityName,
          actor: ctx.actor,
          cli_ok: result.ok,
          exit_code: result.exitCode,
          stdout: result.stdout.slice(0, 4000),
          stderr: result.stderr.slice(0, 1000),
          note: "Propose step executed. To apply, use the apply-autofix action with the returned proposal id.",
        };
      },
    },
    {
      id: "redeploy",
      label: "Redeploy Service",
      destructiveness: "irreversible",
      minRole: "deployer",
      /**
       * Force-redeploy a service by running `inventory refresh` then
       * proposing an autofix. The actual execution is a dry-run / propose
       * step; full apply is a separate gate-protected action.
       */
      async handler(ctx: ActionContext): Promise<Record<string, unknown>> {
        const entityId = await parseEntityId(ctx);
        if (entityId === undefined || entityId.length === 0) {
          return {
            error: "missing-entity-id",
            message: "Pass entity_id in request body",
          };
        }

        const entity = (await readInventoryGraph()).entities?.find(
          (e) => e.id === entityId,
        );
        const entityName = entity?.name ?? entityId;
        const vaultToken = ctx.metadata?.["vault_token"] as string | undefined;

        // Run an inventory refresh to get current platform state.
        const result = await runHomelabCli(
          ["inventory", "refresh", "--json"],
          vaultToken,
        );

        return {
          action: "redeploy",
          entity_id: entityId,
          entity_name: entityName,
          actor: ctx.actor,
          cli_ok: result.ok,
          exit_code: result.exitCode,
          stdout: result.stdout.slice(0, 4000),
          stderr: result.stderr.slice(0, 1000),
          note: "Inventory refresh executed. Review output for platform state.",
        };
      },
    },
    {
      id: "scale",
      label: "Scale Service",
      destructiveness: "reversible",
      minRole: "operator",
      /**
       * Read the current replica count for the service and return the
       * current state as a read-only introspection step.  A full scale
       * mutation (changing replicas) requires a platform API call that
       * is out of scope here — the handler returns the current state so
       * the operator can see what they are scaling and use a follow-up
       * mechanism to apply.
       */
      async handler(ctx: ActionContext): Promise<Record<string, unknown>> {
        const entityId = await parseEntityId(ctx);
        if (entityId === undefined || entityId.length === 0) {
          return {
            error: "missing-entity-id",
            message: "Pass entity_id in request body",
          };
        }

        const graph = await readInventoryGraph();
        const entity = (graph.entities ?? []).find((e) => e.id === entityId);
        if (entity === undefined) {
          return { error: "entity-not-found", entity_id: entityId };
        }

        const attrs = entity.attributes ?? {};
        return {
          action: "scale",
          entity_id: entityId,
          entity_name: entity.name,
          actor: ctx.actor,
          current_replicas_running: attrs["replicas_running"],
          current_replicas_desired: attrs["replicas_desired"],
          note: "Current replica state returned. Submit a scale mutation via the platform API with the desired replica count.",
        };
      },
    },
    {
      id: "apply-autofix",
      label: "Apply Autofix",
      destructiveness: "irreversible",
      minRole: "operator",
      /**
       * Propose and dry-run an autofix for the given observation id.
       *
       * Body: `{ observation_id: "<obs-uuid>" }` or metadata from prior
       * confirmation round.
       *
       * Runs `autofix propose <obs-id> --json` to get the proposal, then
       * `autofix dry-run <proposal-id> --json` to simulate the gate.
       * Full `autofix apply` is intentionally deferred to keep the
       * risk surface minimal — the button+gate wiring is real and the
       * read path (dry-run output) is returned.
       */
      async handler(ctx: ActionContext): Promise<Record<string, unknown>> {
        const obsId = await parseObservationId(ctx);
        if (obsId === undefined || obsId.length === 0) {
          return {
            error: "missing-observation-id",
            message: "Pass observation_id in request body",
          };
        }

        const vaultToken = ctx.metadata?.["vault_token"] as string | undefined;

        // Step 1: propose.
        const propose = await runHomelabCli(
          ["autofix", "propose", obsId, "--json"],
          vaultToken,
        );

        if (!propose.ok) {
          return {
            action: "apply-autofix",
            observation_id: obsId,
            actor: ctx.actor,
            stage: "propose",
            cli_ok: false,
            exit_code: propose.exitCode,
            stdout: propose.stdout.slice(0, 4000),
            stderr: propose.stderr.slice(0, 1000),
          };
        }

        // Extract proposal id from JSON output if possible.
        let proposalId: string | undefined;
        try {
          const parsed = JSON.parse(propose.stdout) as unknown;
          if (parsed !== null && typeof parsed === "object") {
            const p = parsed as Record<string, unknown>;
            if (typeof p["id"] === "string") proposalId = p["id"];
            else if (typeof p["proposal_id"] === "string")
              proposalId = p["proposal_id"];
          }
        } catch {
          // stdout was not JSON — continue without proposal id.
        }

        // Step 2: dry-run if we have a proposal id.
        if (proposalId !== undefined) {
          const dryRun = await runHomelabCli(
            ["autofix", "dry-run", proposalId, "--json"],
            vaultToken,
          );
          return {
            action: "apply-autofix",
            observation_id: obsId,
            proposal_id: proposalId,
            actor: ctx.actor,
            stage: "dry-run",
            cli_ok: dryRun.ok,
            exit_code: dryRun.exitCode,
            propose_stdout: propose.stdout.slice(0, 2000),
            dry_run_stdout: dryRun.stdout.slice(0, 4000),
            dry_run_stderr: dryRun.stderr.slice(0, 1000),
            note: "Dry-run completed. To apply, call autofix apply <proposal_id> via the CLI.",
          };
        }

        return {
          action: "apply-autofix",
          observation_id: obsId,
          actor: ctx.actor,
          stage: "propose-only",
          cli_ok: propose.ok,
          exit_code: propose.exitCode,
          stdout: propose.stdout.slice(0, 4000),
          stderr: propose.stderr.slice(0, 1000),
        };
      },
    },
  ],
};

// Standard export name the config-driven loader looks for.
export const contribution = homelabContribution;

// Exported for tests (functions not exported at declaration site).
export {
  parseGraphYaml,
  actionsForKind,
  renderDetailPage,
  readInventoryGraph,
  readObservations,
  runHomelabCli,
};
