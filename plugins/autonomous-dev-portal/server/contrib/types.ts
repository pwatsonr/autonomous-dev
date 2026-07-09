// #670 — Portal contribution API.
//
// A `PortalContribution` is the contract a plugin provides to contribute
// a panel (nav entry + rendered page) and/or action routes into the portal.
// Core mounts everything via the registry — no closed enum edit is required
// for a new contributed panel.
//
// Design invariants (invariant #674):
//   - Contributions are loaded at startup from portal config; no hard-coded
//     list of specific panels lives in core.
//   - `renderPage` receives the Hono `Context` and returns HTML (or a full
//     `Response`). The contribution owns its own data-fetching; core only
//     mounts the route and injects the nav entry.
//   - If `renderPage` throws, core returns a safe 500 fragment — the portal
//     stays up (fail-safe isolation per #670 AC).
//   - `apiRoutes` and `actions` are namespaced under `/portal/<id>/…` so
//     contributions never collide.

import type { Context } from "hono";

// ---------------------------------------------------------------------------
// RBAC role model (#672)
// ---------------------------------------------------------------------------

/**
 * Four-tier role model. Each tier is a strict superset of the one below it.
 * Role checks use `ROLE_ORDER` to compare numerically.
 *
 *   viewer   — read-only observation (GET pages, data APIs)
 *   operator — reversible mutations (restart, scale)
 *   deployer — potentially-irreversible deploys
 *   admin    — all privileged operations (destructive, config)
 */
export type PortalRole = "viewer" | "operator" | "deployer" | "admin";

/** Numeric rank for ROLE_ORDER comparison; higher = more privileged. */
export const ROLE_ORDER: Record<PortalRole, number> = {
    viewer: 0,
    operator: 1,
    deployer: 2,
    admin: 3,
};

// ---------------------------------------------------------------------------
// Action descriptor (#671 / #672)
// ---------------------------------------------------------------------------

/**
 * Classifies how destructive an action is, mirroring the existing
 * destructiveness ladder used by the homelab safety gate.
 *
 *   read-only    — no state change; no gate required
 *   reversible   — state change that can be undone; requires typed-CONFIRM
 *   irreversible — permanent or hard-to-undo change; requires typed-CONFIRM
 *   destructive  — data-loss risk; requires typed-CONFIRM
 */
export type ActionDestructiveness =
    | "read-only"
    | "reversible"
    | "irreversible"
    | "destructive";

/**
 * Context passed into every action handler. Contains the resolved
 * principal and role so handlers do not need to re-derive from raw auth.
 */
export interface ActionContext {
    /** Hono request context. */
    c: Context;
    /** Resolved actor id (source_user_id or "operator"). */
    actor: string;
    /** Resolved role for this actor per the portal RBAC config. */
    role: PortalRole;
    /** Any metadata carried through the typed-CONFIRM round-trip. */
    metadata?: Record<string, unknown>;
}

/**
 * A single named action contributed by a plugin.
 *
 * Core mounts it at `POST /portal/<contributionId>/action/<actionId>` and
 * routes every call through the action-gate bridge:
 *   - Checks RBAC: role ≥ `minRole` (defaults to "admin").
 *   - For destructiveness ≥ "reversible": issues a typed-CONFIRM token;
 *     the handler is NOT invoked until the client validates the token.
 *   - Emits an audit entry on every call (denied or executed).
 */
export interface ContributionAction {
    /** Stable id used as the URL segment and the audit action key. */
    id: string;
    /** Human-readable label shown in the confirm dialog. */
    label: string;
    /** How destructive this action is (drives gate class). Default "reversible". */
    destructiveness?: ActionDestructiveness;
    /**
     * Minimum role required to invoke this action. Callers below this
     * role receive 403 before the typed-CONFIRM step.
     * Default: "admin" — so omitting the field never weakens security.
     */
    minRole?: PortalRole;
    /**
     * The action executor. Called only after auth + RBAC + confirmation
     * pass. Returns a JSON-serializable result or a full Response.
     */
    handler(ctx: ActionContext): Promise<Record<string, unknown> | Response>;
}

// ---------------------------------------------------------------------------
// API route descriptor
// ---------------------------------------------------------------------------

/** Supported HTTP methods for contributed API routes. */
export type ContribMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * A generic API route contributed by a plugin. Mounted at
 * `/portal/<contributionId>/api/<path>`.
 *
 * The handler receives a plain Hono `Context` — the contribution is
 * responsible for auth/validation if it needs more than the global
 * middleware provides.
 */
export interface ContributionApiRoute {
    method: ContribMethod;
    /** Route path relative to the contribution's api namespace. No leading slash needed. */
    path: string;
    handler(c: Context): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Nav entry
// ---------------------------------------------------------------------------

/**
 * A rail-nav entry. When present, core injects this entry into the nav
 * alongside the static core items. The `group` and `iconName` fields follow
 * the same conventions as the static `NavItem` in `rail-nav.tsx`.
 */
export interface ContributionNavEntry {
    /** Anchor href — typically `/portal/<id>`. */
    href: string;
    /** Visible label. */
    label: string;
    /** Group bucket (operate / system / onboard or any string). */
    group: string;
    /** Lucide icon basename. Falls back to "layout" when the file is absent. */
    iconName: string;
}

// ---------------------------------------------------------------------------
// Main contribution interface
// ---------------------------------------------------------------------------

/**
 * Contract a plugin provides to contribute a panel into the portal.
 *
 * Core discovers contributions from the portal config's `contributions`
 * array (module paths) and from programmatic `registerContribution()` calls.
 * Each contribution is isolated: a failure in `renderPage` or an API handler
 * degrades only that contribution (the portal stays up).
 */
export interface PortalContribution {
    /**
     * Stable slug. Used as the URL path segment (`/portal/<id>`) and as the
     * audit namespace. Must match `[a-z][a-z0-9-]*`.
     */
    id: string;

    /**
     * Optional nav entry. When present, core injects it into the rail-nav
     * alongside the static core items. When absent, the contribution still
     * mounts its routes but appears in no nav.
     */
    nav?: ContributionNavEntry;

    /**
     * Render the panel page. Receives the Hono Context for the incoming
     * GET request. Returns either:
     *   - an HTML string (core wraps it in `c.html(...)`)
     *   - a full `Response` (returned as-is — allows redirects or streaming)
     *
     * When this throws, core catches the error, logs it, and returns a
     * graceful 500 fragment so the portal stays up.
     */
    renderPage?(c: Context): Promise<string | Response>;

    /**
     * Generic API routes mounted at `/portal/<id>/api/<path>`. These run
     * through the same auth + CSRF middleware as the core routes.
     */
    apiRoutes?: ContributionApiRoute[];

    /**
     * Named actions. Each is mounted at
     * `POST /portal/<id>/action/<actionId>` with the full typed-CONFIRM gate.
     */
    actions?: ContributionAction[];
}
