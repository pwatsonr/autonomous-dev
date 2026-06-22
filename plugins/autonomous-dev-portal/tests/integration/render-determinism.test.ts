// #361 — render-determinism contract for the visual-regression goldens.
//
// The pixel goldens (tests/visual-regression/*.visual.ts) can only be captured
// reproducibly if the eight operator surfaces render byte-identically under a
// fixed fixture state-dir + a frozen clock. This test proves the NON-PIXEL half
// of that contract entirely in-process (no Playwright, no Docker), so the
// remaining work to un-skip the pixel suite is purely "capture goldens in CI".
//
// What it guarantees:
//   1. Every surface renders 200 and is byte-identical across repeated renders
//      at a fixed AUTONOMOUS_DEV_NOW (no un-frozen clock / nonce / RNG leak).
//   2. Relative-time output is driven by the injected clock, not wall-clock:
//      the heartbeat fixture is dated T-5s, so "/ops" must read "5s ago". A
//      real-clock leak would render the (wildly different) wall-clock delta.
//   3. Month-windowed aggregates track the injected clock: June MTD ($210 from
//      21 ledger days) disappears when the clock is moved to September.
//
// Renders go through `registerRoutes()` directly (no auth/CSP middleware), so
// csrfToken + cspNonce default to "" and the only remaining variability is the
// clock — exactly what #361 freezes.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { __resetDaemonReaderCacheForTests } from "../../server/wiring/daemon-readers";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

// Frozen reference. The kit-parity heartbeat fixture's timestamp is T-5s and
// its cost-ledger has 21 June days at $10 -> $210 MTD under T.
const T = "2026-06-21T12:00:00Z";

// The eight operator surfaces the visual-regression suite screenshots.
const SURFACES = [
    "/",
    "/approvals",
    "/requests",
    "/costs",
    "/ops",
    "/settings",
    "/agents",
    "/repos",
] as const;

const ORIG_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];
const ORIG_NOW = process.env["AUTONOMOUS_DEV_NOW"];

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

async function render(
    path: string,
    nowIso: string,
): Promise<{ status: number; html: string }> {
    process.env["AUTONOMOUS_DEV_NOW"] = nowIso;
    // Isolate the shared 5s reader cache so each render reflects only the
    // current clock + fixture state-dir — not a value another test (or our
    // own prior render at a different clock) left behind.
    __resetDaemonReaderCacheForTests();
    const res = await freshApp().request(path);
    return { status: res.status, html: await res.text() };
}

beforeAll(() => {
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
});

afterAll(() => {
    const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };
    restore("AUTONOMOUS_DEV_STATE_DIR", ORIG_STATE_DIR);
    restore("AUTONOMOUS_DEV_NOW", ORIG_NOW);
});

describe("#361 render determinism (frozen clock + kit-parity fixtures)", () => {
    it("every surface renders 200 and is byte-identical across repeated renders", async () => {
        for (const path of SURFACES) {
            const a = await render(path, T);
            const b = await render(path, T);
            expect(a.status, `${path} should render 200`).toBe(200);
            // Byte-for-byte stability under a fixed clock is the core contract.
            expect(b.html, `${path} is not deterministic under a fixed clock`).toBe(
                a.html,
            );
        }
    });

    it("relative time is driven by the injected clock (ops heartbeat = '5s ago')", async () => {
        const { html } = await render("/ops", T);
        // heartbeat.json timestamp = T - 5s. Only the env clock yields "5s ago";
        // a wall-clock leak would render a years-off delta.
        expect(html).toContain("5s ago");
    });

    it("the same relative heartbeat shows on a non-ops surface (global rail uses the clock)", async () => {
        // The left rail's daemon pill renders on every surface from the same
        // heartbeat (T-5s), so a different surface is an independent witness
        // that the clock is wired (not just the ops reader). The rail renders
        // the bare delta in a `.v` span: `<span class="v">5s</span>`.
        const { html } = await render("/requests", T);
        expect(html).toContain('<span class="v">5s</span>');
    });

    it("month-windowed aggregates track the injected clock (June MTD vs September)", async () => {
        // June: 21 ledger days * $10 = $210 MTD.
        const june = await render("/costs", "2026-06-21T12:00:00Z");
        // September is later than June (so the 5s MTD cache expires) and has no
        // ledger entries -> $0 MTD.
        const sept = await render("/costs", "2026-09-15T12:00:00Z");

        expect(june.html).toContain("$210.00");
        expect(sept.html).not.toContain("$210.00");
        expect(june.html).not.toBe(sept.html);
    });
});
