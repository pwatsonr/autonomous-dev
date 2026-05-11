// SPEC-034-1-05 — Server-side theme cookie reader.
// SPEC-037-1-01 — Defensive default flipped from "light" to "dark" to match
// the kit's dashboard.png baseline. Only the literal value `"light"` is
// accepted as a non-default; any other value (missing, `"dark"`, tampered,
// or unexpected) falls back to `"dark"`.
//
// Used by route handlers that render `BaseLayout` so the server-rendered
// HTML carries the same `data-theme` the client-side IIFE will apply,
// eliminating flash-of-unstyled-content on full-page reloads.

import { getCookie } from "hono/cookie";
import type { Context } from "hono";

export type Theme = "light" | "dark";

const COOKIE_NAME = "portal-theme";

export function getThemeFromCookie(c: Context): Theme {
    const raw = getCookie(c, COOKIE_NAME);
    return raw === "light" ? "light" : "dark";
}
