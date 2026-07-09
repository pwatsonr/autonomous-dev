// #670 — Homelab panel contribution.
//
// Migrates the homelab panel onto the portal contribution mechanism.
// Previously planned as an interim hard-coded route; instead this is the
// FIRST contribution, proving the mechanism works end-to-end.
//
// Reads `~/.autonomous-dev-homelab/inventory-graph.yaml` and the
// `observations/` directory (same sources as the homelab plugin's portal
// panel intent) to render a live inventory + observation summary.
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

import type { PortalContribution } from "../types";

// ---------------------------------------------------------------------------
// Inventory graph reader
// ---------------------------------------------------------------------------

interface InventoryEntity {
    id: string;
    kind: string;
    name: string;
    attributes?: Record<string, unknown>;
    source?: string;
    status?: string;
    last_seen?: string;
}

interface InventoryGraph {
    version?: number;
    entities?: InventoryEntity[];
}

async function readInventoryGraph(): Promise<InventoryGraph> {
    const p = join(homedir(), ".autonomous-dev-homelab", "inventory-graph.yaml");
    try {
        const raw = await readFile(p, "utf8");
        return parseSimpleYaml(raw);
    } catch {
        return { entities: [] };
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
// Minimal YAML parser (enough for the inventory graph's flat entity list)
// ---------------------------------------------------------------------------

/**
 * Minimal structural YAML parser for the inventory-graph.yaml format.
 * Only supports the specific subset used by the homelab inventory writer:
 *   - Top-level scalar keys (version, entities list)
 *   - The entities array items with their known fields
 *
 * Uses a regex-based line scanner; not a general YAML parser. We avoid
 * adding a yaml dependency per the constraint (no new packages).
 */
function parseSimpleYaml(raw: string): InventoryGraph {
    const result: InventoryGraph = {};
    const lines = raw.split("\n");

    // Extract version.
    const versionLine = lines.find((l) => /^version:/.test(l));
    if (versionLine) {
        const m = versionLine.match(/^version:\s*(\d+)/);
        if (m?.[1] !== undefined) result.version = parseInt(m[1], 10);
    }

    // Extract entities array — each entity starts with `  - id:` at 2-space indent.
    const entities: InventoryEntity[] = [];
    let current: Partial<InventoryEntity> | null = null;
    let inAttributes = false;
    const attrs: Record<string, unknown> = {};

    for (const line of lines) {
        // New entity block.
        if (/^  - id:/.test(line)) {
            if (current !== null) {
                if (inAttributes) current.attributes = { ...attrs };
                entities.push(current as InventoryEntity);
            }
            current = { id: extractScalar(line, "id") };
            inAttributes = false;
            Object.keys(attrs).forEach((k) => delete attrs[k]);
            continue;
        }
        if (current === null) continue;

        // Attributes block.
        if (/^    attributes:/.test(line)) {
            inAttributes = true;
            continue;
        }
        if (inAttributes && /^      [a-zA-Z_]/.test(line)) {
            const m = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
            if (m?.[1] !== undefined && m[2] !== undefined) attrs[m[1]] = unquote(m[2].trim());
            continue;
        }
        if (inAttributes && !/^      /.test(line) && /^    [a-zA-Z]/.test(line)) {
            current.attributes = { ...attrs };
            Object.keys(attrs).forEach((k) => delete attrs[k]);
            inAttributes = false;
        }

        // Top-level entity fields.
        const fieldMatch = line.match(/^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
        if (fieldMatch?.[1] !== undefined && fieldMatch[2] !== undefined) {
            const [, key, val] = fieldMatch;
            const v = unquote((val ?? "").trim());
            if (key === "kind") current.kind = String(v);
            else if (key === "name") current.name = String(v);
            else if (key === "source") current.source = String(v);
            else if (key === "status") current.status = String(v);
            else if (key === "last_seen") current.last_seen = String(v);
        }
    }

    if (current !== null) {
        if (inAttributes) current.attributes = { ...attrs };
        entities.push(current as InventoryEntity);
    }

    result.entities = entities.filter((e) => e.id && e.kind && e.name);
    return result;
}

function extractScalar(line: string, key: string): string {
    const m = line.match(new RegExp(`${key}:\\s*(.*)`));
    return m?.[1] !== undefined ? unquote(m[1].trim()) : "";
}

function unquote(s: string): string {
    if ((s.startsWith("'") && s.endsWith("'")) ||
        (s.startsWith('"') && s.endsWith('"'))) {
        return s.slice(1, -1);
    }
    return s;
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderEntityRow(e: InventoryEntity): string {
    const statusClass = e.status === "active" ? "ok" : "warn";
    const attrs = e.attributes ?? {};
    // Extract meaningful attributes per kind.
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

    return `
      <tr class="hl-entity-row" data-kind="${escapeHtml(e.kind)}">
        <td><span class="chip chip-${escapeHtml(e.kind)}">${escapeHtml(e.kind)}</span></td>
        <td class="mono">${escapeHtml(e.name)}</td>
        <td>${escapeHtml(e.source ?? "")}</td>
        <td><span class="dot dot-${statusClass}" title="${escapeHtml(e.status ?? "")}"></span> ${escapeHtml(e.status ?? "")}</td>
        <td class="meta">${escapeHtml(detail)}</td>
      </tr>`;
}

function renderObservationRow(o: Observation, idx: number): string {
    const sev = o.severity ?? "info";
    const sevClass = sev === "critical" || sev === "high" ? "err" :
        sev === "medium" || sev === "warning" ? "warn" : "ok";
    return `
      <tr class="hl-obs-row">
        <td class="mono">${escapeHtml(String(idx + 1))}</td>
        <td><span class="chip chip-${escapeHtml(sevClass)}">${escapeHtml(sev)}</span></td>
        <td>${escapeHtml(o.service ?? o.id ?? "")}</td>
        <td>${escapeHtml(o.summary ?? "")}</td>
      </tr>`;
}

async function renderHomelabPage(): Promise<string> {
    const [graph, observations] = await Promise.all([
        readInventoryGraph(),
        readObservations(),
    ]);

    const entities = graph.entities ?? [];
    const nodes = entities.filter((e) => e.kind === "node");
    const services = entities.filter((e) => e.kind === "service");
    const other = entities.filter((e) => e.kind !== "node" && e.kind !== "service");

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
  <aside class="rail">
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
  </aside>
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
      ${hasEntities ? `
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
      </div>` : `<p class="empty-state">No inventory data found. Run a homelab discovery sweep to populate.</p>`}
    </section>

    <section class="panel" aria-label="Observations">
      <div class="panel-header">
        <h2 class="panel-title">Recent Observations</h2>
        <span class="kpi-chip">${observations.length} observations</span>
      </div>
      ${hasObs ? `
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
      </div>` : `<p class="empty-state">No observations recorded yet.</p>`}
    </section>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Contribution export
// ---------------------------------------------------------------------------

/**
 * The homelab portal contribution.
 *
 * Mounts at `/portal/homelab` with a "Homelab" nav entry in the "system"
 * group. The page renders live inventory from
 * `~/.autonomous-dev-homelab/inventory-graph.yaml` and recent observations.
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
    async renderPage() {
        return renderHomelabPage();
    },
};

// Standard export name the config-driven loader looks for.
export const contribution = homelabContribution;
