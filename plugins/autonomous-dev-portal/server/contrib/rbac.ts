// #672 — Per-action RBAC roles for portal contributions.
//
// Resolves the authenticated principal to a `PortalRole` based on the
// portal config's role-map. The resolved role is passed into every
// action's `ActionContext` so handlers use one source of truth.
//
// Role model (four tiers, see types.ts):
//   viewer < operator < deployer < admin
//
// Config schema (`portal_roles` in portal config):
//   {
//     "role_map": [
//       { "principal": "alice", "role": "admin" },
//       { "principal": "*",     "role": "viewer" }
//     ],
//     "default_role": "admin"
//   }
//
// Resolution order:
//   1. Exact match on principal name.
//   2. Wildcard "*" entry.
//   3. `default_role` (defaults to "admin" — zero-config installs keep
//      current behavior where the single operator is fully privileged).
//
// Denial is always audited before any side-effect (AC #4 of #672).

import type { PortalRole } from "./types";
import { ROLE_ORDER } from "./types";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export interface RoleMapEntry {
    /** Principal id or "*" for wildcard. */
    principal: string;
    role: PortalRole;
}

export interface PortalRolesConfig {
    /** Ordered list of principal→role mappings. First match wins. */
    role_map?: RoleMapEntry[];
    /**
     * Role assigned when no role_map entry matches. Defaults to "admin"
     * so a zero-config install (single operator, no role_map) stays fully
     * privileged.
     */
    default_role?: PortalRole;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the effective role for `actor` given the portal roles config.
 *
 * Resolution:
 *   1. Exact principal match in `role_map` (first wins).
 *   2. Wildcard "*" match in `role_map`.
 *   3. `config.default_role` or "admin".
 *
 * @param actor   The principal id (from `resolveActor()`).
 * @param config  The portal roles config (may be undefined/empty).
 * @returns       The resolved `PortalRole`.
 */
export function resolveRole(
    actor: string,
    config: PortalRolesConfig | undefined,
): PortalRole {
    const map = config?.role_map ?? [];
    let wildcard: PortalRole | undefined;

    for (const entry of map) {
        if (entry.principal === actor) return entry.role;
        if (entry.principal === "*") wildcard = entry.role;
    }

    if (wildcard !== undefined) return wildcard;
    return config?.default_role ?? "admin";
}

/**
 * Returns `true` when `actual` is at least as privileged as `required`.
 *
 * @param actual   The role the principal holds.
 * @param required The minimum role the action demands.
 */
export function hasRole(actual: PortalRole, required: PortalRole): boolean {
    return ROLE_ORDER[actual] >= ROLE_ORDER[required];
}

/**
 * Validate that a string is a valid `PortalRole`. Returns the role if
 * valid, `undefined` otherwise.
 */
export function parseRole(value: unknown): PortalRole | undefined {
    if (
        value === "viewer" ||
        value === "operator" ||
        value === "deployer" ||
        value === "admin"
    ) {
        return value;
    }
    return undefined;
}
