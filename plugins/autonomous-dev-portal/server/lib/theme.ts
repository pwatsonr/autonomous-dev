// SPEC-034-1-05 — Server-side theme cookie reader.
//
// Reads the `portal-theme` cookie written by `static/theme-toggle.js` and
// returns a validated theme string. Only the literal value `"dark"` is
// accepted as a non-default; any other value (missing, `"light"`, tampered,
// or unexpected) falls back to `"light"` per TDD-034 §10.2.
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
    return raw === "dark" ? "dark" : "light";
}
