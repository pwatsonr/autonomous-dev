// Global CSRF header wiring — the shell must emit the per-request token
// as <meta name="csrf-token"> and load csrf-htmx.js, so EVERY htmx
// request carries X-CSRF-Token (fixes the recurring missed-hx-include
// class: approvals #391, rd-v3 panel, notification Test buttons).

import { describe, expect, test } from "bun:test";

import { renderFullPage } from "../../server/templates";

describe("global CSRF header wiring", () => {
    test("shell emits csrf-token meta + loads csrf-htmx.js when a token exists", async () => {
        const html = await renderFullPage(
            "404",
            { path: "/x" },
            undefined,
            "test-nonce",
            "dark",
            // minimal shell state stub so the renderer skips disk derivation
            { daemonStatus: "unknown" } as any,
            "tok-global-csrf",
        );
        expect(html).toContain('<meta name="csrf-token" content="tok-global-csrf"');
        expect(html).toContain('src="/static/csrf-htmx.js"');
    });

    test("no token → no meta tag (script still loads, no-ops)", async () => {
        const html = await renderFullPage(
            "404",
            { path: "/x" },
            undefined,
            "test-nonce",
            "dark",
            { daemonStatus: "unknown" } as any,
            "",
        );
        expect(html).not.toContain('name="csrf-token"');
    });
});
