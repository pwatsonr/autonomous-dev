// #673 — Deploy-target selection UI portal contribution.
//
// Provides a model-driven panel that enumerates ALL registered deploy targets
// (cloud + homelab) from the shared core `DeployTargetRegistry`. A newly-
// registered target appears on the next request with zero code change
// (invariant #674 — model-driven portal).
//
// Routes mounted by the contribution registry:
//   GET  /portal/deploy-targets                 → HTML page with target table
//   GET  /portal/deploy-targets/api/targets     → JSON list of all targets
//   POST /portal/deploy-targets/api/select-target → resolve & return target
//
// The POST select-target route calls `resolveTarget({ targetId, registry })`
// from the core target resolver — this is the real `--target` override path
// the core resolver honors (source: 'explicit-id').
//
// Dynamic invariant (#674): the panel enumerates entity TYPES from the
// registry. Newly-registered targets appear with no code change.

import type { PortalContribution, ContributionApiRoute } from "../types";
import type { DeployTargetRegistry } from "../../../../autonomous-dev/intake/deploy/target-registry";
import { getDeployTargetRegistry } from "../../../../autonomous-dev/intake/deploy/target-registry";
import {
  resolveTarget,
  UnknownTargetError,
} from "../../../../autonomous-dev/intake/deploy/target-resolver";

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
// HTML renderer — target table row
// ---------------------------------------------------------------------------

/**
 * Render a single target row. Availability and trust are read from
 * the `DeployTarget` fields and the `tags` map (tags may carry
 * `availability` / `unavailable_reason` / `trust_reason`).
 *
 * A target is selectable only when it has no availability=unavailable tag
 * AND its trust field is not "untrusted". Unavailable or untrusted targets
 * are rendered with their reason but the Select button is disabled.
 */
function renderTargetRow(
  t: import("../../../../autonomous-dev/intake/deploy/target-types").DeployTarget,
): string {
  const availability = t.tags["availability"] ?? "available";
  const unavailableReason = t.tags["unavailable_reason"] ?? "";
  const trustReason = t.tags["trust_reason"] ?? "";

  const isUnavailable = availability === "unavailable";
  const isUntrusted = t.trust === "untrusted";
  const isSelectable = !isUnavailable && !isUntrusted;

  const availClass = isUnavailable ? "dt-unavailable" : "dt-available";
  const trustClass = isUntrusted ? "dt-untrusted" : "dt-trusted";

  const capabilities = t.capabilities.join(", ");
  const tags = Object.entries(t.tags)
    .filter(
      ([k]) =>
        k !== "availability" &&
        k !== "unavailable_reason" &&
        k !== "trust_reason",
    )
    .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
    .join(", ");

  const reasonCell = [
    isUnavailable && unavailableReason
      ? `<span class="dt-reason">${escapeHtml(unavailableReason)}</span>`
      : "",
    isUntrusted && trustReason
      ? `<span class="dt-reason">${escapeHtml(trustReason)}</span>`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const selectButton = isSelectable
    ? `<button
              class="dt-select-btn"
              data-target-id="${escapeHtml(t.id)}"
              data-selectable="true"
              onclick="selectTarget('${escapeHtml(t.id)}')"
            >Select</button>`
    : `<button
              class="dt-select-btn dt-select-disabled"
              data-target-id="${escapeHtml(t.id)}"
              data-selectable="false"
              disabled
              title="${isUnavailable ? "Target unavailable" : "Target untrusted"}"
            >Select</button>`;

  return `
        <tr class="dt-row" data-target-id="${escapeHtml(t.id)}" data-selectable="${isSelectable ? "true" : "false"}">
          <td class="mono">${escapeHtml(t.id)}</td>
          <td>${escapeHtml(t.name)}</td>
          <td><span class="chip chip-kind">${escapeHtml(t.kind)}</span></td>
          <td>${escapeHtml(t.provider)}</td>
          <td>${escapeHtml(t.env ?? "")}</td>
          <td class="${escapeHtml(availClass)}">${escapeHtml(availability)}${reasonCell}</td>
          <td class="${escapeHtml(trustClass)}">${escapeHtml(t.trust ?? "internal")}${isUntrusted && trustReason ? ` <span class="dt-reason">(${escapeHtml(trustReason)})</span>` : ""}</td>
          <td class="meta">${escapeHtml(capabilities)}</td>
          <td class="meta">${escapeHtml(tags)}</td>
          <td>${escapeHtml(t.source)}</td>
          <td>${selectButton}</td>
        </tr>`;
}

// ---------------------------------------------------------------------------
// HTML renderer — full page
// ---------------------------------------------------------------------------

/**
 * Render the deploy-target selection page.
 *
 * Model-driven (#674): enumerates from the registry on every render.
 * Empty state is shown when no targets are registered.
 *
 * @param targets  The current list of targets from the registry.
 */
function renderDeployTargetsPage(
  targets: import("../../../../autonomous-dev/intake/deploy/target-types").DeployTarget[],
): string {
  const isEmpty = targets.length === 0;
  const rows = targets.map(renderTargetRow).join("");

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <title>Deploy Targets · Portal</title>
  <link rel="stylesheet" href="/static/portal.css">
  <style>
    .dt-available { color: var(--green, #6dcc6d); }
    .dt-unavailable { color: var(--red, #e06060); }
    .dt-trusted { color: var(--green, #6dcc6d); }
    .dt-untrusted { color: var(--amber, #f0a040); }
    .dt-reason { font-size: 0.82em; color: var(--text-muted, #aaa); margin-left: 4px; }
    .dt-select-btn {
      padding: 4px 10px; border-radius: 4px; border: 1px solid #555;
      background: #2a2a2a; color: #e0e0e0; cursor: pointer; font-size: 12px;
    }
    .dt-select-btn:hover:not([disabled]) { background: #3a3a3a; border-color: #888; }
    .dt-select-disabled { opacity: 0.45; cursor: not-allowed; }
    .chip-kind { background: #2c3a4a; color: #7ab8e0; }
    #dt-result { font-family: monospace; white-space: pre-wrap; margin-top: 8px; }
  </style>
</head>
<body class="shell">
  <aside class="rail">
    <div class="rail-brand"><span class="wordmark">portal</span></div>
    <nav class="rail-nav" aria-label="Primary">
      <div class="rail-nav-group" data-group="operate">
        <div class="rail-nav-group-label">OPERATE</div>
        <a href="/" class="rail-nav-item">Dashboard</a>
        <a href="/portal/deploy-targets" class="rail-nav-item active" aria-current="page">Deploy Targets</a>
      </div>
    </nav>
  </aside>
  <main class="main">
    <div class="page-header">
      <h1 class="page-title">Deploy Targets</h1>
      <p class="page-meta">
        All registered targets — cloud and homelab. Enumerated live from the
        target registry (model-driven, invariant #674). A newly-registered
        target appears on the next request with no code change.
      </p>
    </div>

    <section class="panel" aria-label="Targets" data-testid="deploy-targets-panel">
      <div class="panel-header">
        <h2 class="panel-title">Registered Targets</h2>
        <span class="kpi-chip">${targets.length} target${targets.length !== 1 ? "s" : ""}</span>
      </div>
      ${
        isEmpty
          ? `<p class="empty-state" data-testid="no-targets">No deploy targets registered. Register targets via the plugin activation API or deploy.yaml config.</p>`
          : `
      <div class="table-wrap">
        <table class="data-table" data-testid="targets-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Kind</th>
              <th>Provider</th>
              <th>Env</th>
              <th>Availability</th>
              <th>Trust</th>
              <th>Capabilities</th>
              <th>Tags</th>
              <th>Source</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div id="dt-result"></div>`
      }
    </section>
  </main>

  <script>
    function selectTarget(targetId) {
      fetch('/portal/deploy-targets/api/select-target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: targetId }),
      })
        .then(function(r) { return r.json(); })
        .then(function(body) {
          var el = document.getElementById('dt-result');
          if (body.ok) {
            el.textContent = 'Selected: ' + body.target.id + ' (source: ' + body.source + ')';
          } else {
            el.textContent = 'Error: ' + (body.error || JSON.stringify(body));
          }
        })
        .catch(function(e) {
          document.getElementById('dt-result').textContent = 'Request failed: ' + e.message;
        });
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Factory function (allows injecting a custom registry for tests)
// ---------------------------------------------------------------------------

export interface DeployTargetsContributionOptions {
  /**
   * The `DeployTargetRegistry` to enumerate from. Defaults to the
   * process-wide singleton (via `getDeployTargetRegistry()`).
   */
  registry?: DeployTargetRegistry;
}

/**
 * Build a `PortalContribution` for the deploy-target selection panel.
 *
 * Inject a custom `registry` in tests; omit it (or pass `undefined`) in
 * production to use the shared singleton from `getDeployTargetRegistry()`.
 *
 * @param opts  Optional overrides (registry injection for tests).
 * @returns     A fully-wired `PortalContribution` instance.
 */
export function makeDeployTargetsContribution(
  opts: DeployTargetsContributionOptions = {},
): PortalContribution {
  function getRegistry(): DeployTargetRegistry {
    return opts.registry ?? getDeployTargetRegistry();
  }

  const apiRoutes: ContributionApiRoute[] = [
    {
      method: "GET",
      path: "targets",
      /**
       * GET /portal/deploy-targets/api/targets
       *
       * Return all registered targets as JSON.
       * Enumerates from the shared registry on every call (dynamic).
       */
      async handler(c) {
        const registry = getRegistry();
        const targets = await registry.list();
        return c.json({ targets, total: targets.length });
      },
    },
    {
      method: "POST",
      path: "select-target",
      /**
       * POST /portal/deploy-targets/api/select-target
       *
       * Body: `{ target_id: "<id>" }`
       *
       * Resolves the target via the core `resolveTarget({ targetId, registry })`.
       * This is the real `--target` override path the core resolver honors.
       * Returns the `ResolvedTarget` (target + source) on success.
       *
       * Errors:
       *   400  — missing or invalid body
       *   404  — unknown target id (with available list)
       *   500  — unexpected resolver error
       */
      async handler(c) {
        let targetId: string | undefined;
        try {
          const body = (await c.req.json()) as unknown;
          if (body !== null && typeof body === "object") {
            const b = body as Record<string, unknown>;
            if (
              typeof b["target_id"] === "string" &&
              b["target_id"].length > 0
            ) {
              targetId = b["target_id"];
            }
          }
        } catch {
          return c.json({ ok: false, error: "invalid-json-body" }, 400);
        }

        if (targetId === undefined || targetId.length === 0) {
          return c.json({ ok: false, error: "missing-target-id" }, 400);
        }

        try {
          const registry = getRegistry();
          const resolved = await resolveTarget({ targetId, registry });
          return c.json({
            ok: true,
            target: resolved.target,
            source: resolved.source,
          });
        } catch (err) {
          if (err instanceof UnknownTargetError) {
            return c.json(
              {
                ok: false,
                error: `unknown target '${targetId}'`,
                available: err.available,
              },
              404,
            );
          }
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ ok: false, error: msg }, 500);
        }
      },
    },
  ];

  return {
    id: "deploy-targets",
    nav: {
      href: "/portal/deploy-targets",
      label: "Deploy Targets",
      group: "operate",
      iconName: "target",
    },

    /**
     * Render the deploy-target selection page.
     *
     * Enumerates all targets from the shared registry on every render.
     * Empty state is shown when no targets are registered.
     */
    async renderPage() {
      const registry = getRegistry();
      const targets = await registry.list();
      return renderDeployTargetsPage(targets);
    },

    apiRoutes,
  };
}

// ---------------------------------------------------------------------------
// Default export — uses the shared singleton registry
// ---------------------------------------------------------------------------

/**
 * The default deploy-targets contribution for production use.
 *
 * Uses `getDeployTargetRegistry()` on each request, so it always reflects
 * the current state of the singleton (populated by config bootstrap +
 * plugin `registerProvider()` calls).
 *
 * Register via `registerContribution(deployTargetsContribution)` in server.ts
 * or list the module path in portal config's `contributions` array.
 */
export const deployTargetsContribution = makeDeployTargetsContribution();

// Standard export name the config-driven loader looks for.
export const contribution = deployTargetsContribution;
