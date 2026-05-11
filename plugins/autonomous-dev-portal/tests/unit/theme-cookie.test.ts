// SPEC-034-1-05 / SPEC-037-1-01 — getThemeFromCookie unit tests.
//
// Per SPEC-037-1-01, the defensive default flipped from "light" to "dark".
// Only the literal cookie value `"light"` returns "light"; missing, empty,
// or unexpected values resolve to "dark".

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { getThemeFromCookie } from "../../server/lib/theme";

/**
 * Helper: dispatch a `GET /` against a tiny Hono app that calls
 * `getThemeFromCookie` and returns the resolved theme as a header so
 * the caller can assert on it without depending on render plumbing.
 */
async function resolveCookieTheme(
    cookieHeader?: string,
): Promise<"light" | "dark"> {
    const app = new Hono();
    app.get("/", (c) => {
        const theme = getThemeFromCookie(c);
        return c.text(theme);
    });
    const res = await app.request("/", {
        headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
    });
    const text = await res.text();
    return text === "light" ? "light" : "dark";
}

describe("getThemeFromCookie — SPEC-037-1-01 dark default", () => {
    test("C-01: no cookie returns 'dark'", async () => {
        const theme = await resolveCookieTheme();
        expect(theme).toBe("dark");
    });

    test("C-02: portal-theme=light returns 'light'", async () => {
        const theme = await resolveCookieTheme("portal-theme=light");
        expect(theme).toBe("light");
    });

    test("C-03: portal-theme=dark returns 'dark'", async () => {
        const theme = await resolveCookieTheme("portal-theme=dark");
        expect(theme).toBe("dark");
    });

    test("C-04: portal-theme=garbage returns 'dark' (defensive default)", async () => {
        const theme = await resolveCookieTheme("portal-theme=garbage");
        expect(theme).toBe("dark");
    });

    test("C-05: portal-theme= (empty value) returns 'dark'", async () => {
        const theme = await resolveCookieTheme("portal-theme=");
        expect(theme).toBe("dark");
    });
});
