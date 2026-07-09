// #670 — Contribution registry + loader.
//
// The registry holds all `PortalContribution` instances known to the portal.
// Two registration paths:
//
//   1. Programmatic: `registerContribution(contrib)` — called by server.ts
//      for built-in contributions (e.g. the homelab panel migrated from the
//      hard-coded route).
//
//   2. Config-driven: `loadContributionsFromConfig(paths)` — called at
//      startup with the `contributions` array from portal config. Each entry
//      is a module path (absolute or `~/…`-expanded); the module MUST export
//      a `contribution` named export of type `PortalContribution`. Missing or
//      broken modules are logged and skipped; the portal never crashes due to
//      a bad contribution path (fail-safe per #670 AC).
//
// After loading, `registerContribRoutes(app, deps)` is the single call
// `registerRoutes()` makes to mount every contribution's page route, api
// routes, and action routes. `navItems()` returns the union of all
// contributed nav entries.
//
// Dynamic invariant (#674): the registry is the single source of truth for
// contributed panels. Adding a new contribution requires zero core edits —
// just a module path in portal config (or a `registerContribution()` call
// at startup).

import { Hono } from "hono";
import { homedir } from "node:os";

import type { PortalContribution } from "./types";
import type { ContributionNavEntry } from "./types";
import { buildActionRoutes, type ActionGateDeps } from "./action-gate";

// ---------------------------------------------------------------------------
// Module-level registry
// ---------------------------------------------------------------------------

const contributions = new Map<string, PortalContribution>();

/**
 * Register a contribution programmatically. Idempotent: registering the same
 * `id` twice replaces the earlier entry. This supports test-time reconfiguration.
 *
 * @param contrib The contribution to register.
 */
export function registerContribution(contrib: PortalContribution): void {
    contributions.set(contrib.id, contrib);
}

/**
 * Retrieve a contribution by id. Returns `undefined` when not found.
 */
export function getContribution(id: string): PortalContribution | undefined {
    return contributions.get(id);
}

/**
 * List all registered contributions.
 */
export function listContributions(): PortalContribution[] {
    return Array.from(contributions.values());
}

/**
 * Clear all registered contributions. Used in tests to avoid cross-suite
 * leakage.
 */
export function clearContributions(): void {
    contributions.clear();
}

// ---------------------------------------------------------------------------
// Config-driven loader
// ---------------------------------------------------------------------------

/** Logger interface for the loader (matches `ActionLogger` shape). */
export interface LoaderLogger {
    info?(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, fields?: Record<string, unknown>): void;
}

function noopLoaderLogger(): LoaderLogger {
    return {
        warn: () => undefined,
        error: () => undefined,
    };
}

/**
 * Expand a leading `~/` to the user's home directory. Paths that are
 * already absolute are returned unchanged.
 */
function expandHome(p: string): string {
    if (p.startsWith("~/") || p === "~") {
        return p.replace(/^~/, homedir());
    }
    return p;
}

/**
 * Load contributions from the portal config's `contributions` array.
 *
 * Each entry is a module path. The module must have a `contribution`
 * named export of type `PortalContribution`. Failures are logged and
 * skipped; the portal never crashes due to a missing/broken module.
 *
 * @param paths   Array of module paths from portal config.
 * @param logger  Optional logger (defaults to noop).
 */
export async function loadContributionsFromConfig(
    paths: string[],
    logger: LoaderLogger = noopLoaderLogger(),
): Promise<void> {
    for (const rawPath of paths) {
        const resolvedPath = expandHome(rawPath);
        try {
            // Dynamic import allows the module to be any valid ES module path.
            // The cast is safe — we validate the shape below.
            const mod = (await import(resolvedPath)) as Record<string, unknown>;
            const contrib = mod["contribution"];
            if (contrib === undefined || contrib === null) {
                logger.warn("contrib_load_no_export", {
                    path: resolvedPath,
                    detail: "module has no 'contribution' export",
                });
                continue;
            }
            if (typeof contrib !== "object") {
                logger.warn("contrib_load_invalid_export", {
                    path: resolvedPath,
                    detail: "'contribution' export is not an object",
                });
                continue;
            }
            const c = contrib as PortalContribution;
            if (typeof c.id !== "string" || c.id.length === 0) {
                logger.warn("contrib_load_invalid_id", {
                    path: resolvedPath,
                    detail: "'contribution.id' must be a non-empty string",
                });
                continue;
            }
            registerContribution(c);
            logger.info?.("contrib_loaded", { id: c.id, path: resolvedPath });
        } catch (err) {
            // Missing module, syntax error, etc. Log and continue.
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("contrib_load_failed", { path: resolvedPath, error: msg });
        }
    }
}

// ---------------------------------------------------------------------------
// Nav items accessor
// ---------------------------------------------------------------------------

/**
 * Return the union of nav entries from all registered contributions.
 * Entries with no `nav` field are omitted.
 *
 * The order matches registration order (Map insertion order).
 */
export function navItems(): ContributionNavEntry[] {
    const out: ContributionNavEntry[] = [];
    for (const contrib of contributions.values()) {
        if (contrib.nav !== undefined) {
            out.push(contrib.nav);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

export interface RegisterContribRoutesOptions extends ActionGateDeps {
    /** Logger for page-render errors. */
    logger?: import("./action-gate").ActionGateDeps["logger"];
}

/**
 * Mount all registered contribution routes onto the Hono app.
 *
 * For each contribution:
 *   - `GET /portal/<id>` → `contribution.renderPage(c)` (isolated try/catch)
 *   - `<method> /portal/<id>/api/<path>` for each `apiRoute`
 *   - `POST /portal/<id>/action/<actionId>` for each `action`
 *
 * Call this once from `registerRoutes()` after all contributions are loaded.
 */
export function registerContribRoutes(
    app: Hono,
    deps: RegisterContribRoutesOptions,
): void {
    for (const contrib of contributions.values()) {
        // --- Page route ---
        if (contrib.renderPage !== undefined) {
            const renderPage = contrib.renderPage.bind(contrib);
            app.get(`/portal/${contrib.id}`, async (c) => {
                try {
                    const result = await renderPage(c);
                    if (result instanceof Response) return result;
                    return c.html(result, 200);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    deps.logger?.error("contrib_render_error", {
                        id: contrib.id,
                        error: msg,
                    });
                    return c.html(
                        `<!doctype html><html><body><h1>Panel error</h1><p>${escapeHtml(msg)}</p></body></html>`,
                        500,
                    );
                }
            });
        }

        // --- API routes ---
        for (const apiRoute of contrib.apiRoutes ?? []) {
            const path = `/portal/${contrib.id}/api/${apiRoute.path.replace(/^\//, "")}`;
            const handler = apiRoute.handler.bind(apiRoute);
            switch (apiRoute.method) {
                case "GET":
                    app.get(path, handler);
                    break;
                case "POST":
                    app.post(path, handler);
                    break;
                case "PUT":
                    app.put(path, handler);
                    break;
                case "DELETE":
                    app.delete(path, handler);
                    break;
                case "PATCH":
                    app.patch(path, handler);
                    break;
            }
        }

        // --- Action routes ---
        if ((contrib.actions ?? []).length > 0) {
            const actionRouter = buildActionRoutes(contrib, deps);
            app.route("/", actionRouter);
        }
    }
}

// ---------------------------------------------------------------------------
// HTML escaping helper (no external dep)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
