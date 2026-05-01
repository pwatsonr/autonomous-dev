// SPEC-014-1-01 §Task 1.6 — requireAuth gate.
//
// Returns 401 unless `c.get('auth').authenticated === true`. The bypass
// list is hardcoded (PUBLIC_ROUTES) so adding a new public path requires
// a code change reviewed for security implications — there is no runtime
// flag by design (audit-safety).

import type { MiddlewareHandler } from "hono";

import type { AuthContext } from "../types";

export const PUBLIC_ROUTES: ReadonlyArray<string | RegExp> = [
    "/health",
    "/auth/login",
    "/auth/callback",
    "/auth/logout",
    /^\/static\//,
];

function isPublic(
    path: string,
    publicSet: ReadonlyArray<string | RegExp>,
): boolean {
    for (const entry of publicSet) {
        if (typeof entry === "string") {
            if (path === entry) return true;
        } else if (entry.test(path)) {
            return true;
        }
    }
    return false;
}

export function requireAuth(
    extraPublic: ReadonlyArray<string | RegExp> = [],
): MiddlewareHandler {
    const publicSet: ReadonlyArray<string | RegExp> = [
        ...PUBLIC_ROUTES,
        ...extraPublic,
    ];
    return async (c, next) => {
        if (isPublic(c.req.path, publicSet)) return next();
        const auth = c.get("auth") as AuthContext | undefined;
        if (auth === undefined || auth.authenticated !== true) {
            return c.json(
                {
                    error: "UNAUTHENTICATED",
                    message: "Authentication required",
                },
                401,
            );
        }
        return next();
    };
}
