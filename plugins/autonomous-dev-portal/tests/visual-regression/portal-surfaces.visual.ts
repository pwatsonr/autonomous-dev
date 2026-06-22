// PLAN-038 TASK-022 / TDD-037 AC-3713 — visual regression for every
// operator surface against the kit-parity fixture state-dir.
//
// Sister to design-system.spec.ts. Same determinism contract:
//   - viewport 1440x900
//   - light theme forced via cookie
//   - .dot.live animation paused
//   - 0.1% pixel-diff threshold (maxDiffPixelRatio: 0.001)
//
// The portal is spawned with `AUTONOMOUS_DEV_STATE_DIR` pointed at
// `server/fixtures/kit-parity/` so the screenshots are reproducible
// across machines and CI runs (TDD-037 §5.8). No PORTAL_DEMO_MODE flag.
//
// First-run baseline: `npm run gen:visual-goldens` (extend the existing
// `--project=golden-gen` invocation to include this spec). The committed
// PR can include the spec without baselines; CI fails until the operator
// regenerates and commits the goldens in a follow-up commit.

import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// Playwright runs these specs under Node, where Bun's `import.meta.dir`
// is undefined — derive the directory portably from import.meta.url.
const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 19282; // distinct from design-system spec's 19281
const BASE_URL = `http://127.0.0.1:${PORT}`;
// #361: the frozen render clock. Kit-parity fixtures are dated relative to
// this (heartbeat = T-5s; cost-ledger fills June through this day). Mirrors
// the reference used by tests/integration/render-determinism.test.ts.
const FROZEN_NOW = "2026-06-21T12:00:00Z";
const FIXTURE_STATE_DIR = join(
    SPEC_DIR,
    "..",
    "..",
    "server",
    "fixtures",
    "kit-parity",
);

const SURFACES: Array<{ path: string; name: string }> = [
    { path: "/", name: "dashboard" },
    { path: "/approvals", name: "approvals" },
    { path: "/requests", name: "requests" },
    { path: "/costs", name: "costs" },
    { path: "/ops", name: "ops" },
    { path: "/settings", name: "settings" },
    { path: "/agents", name: "agents" },
    { path: "/repos", name: "repos" },
];

async function waitForPort(port: number, timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await new Promise<void>((resolve, reject) => {
                const sock = connect(port, "127.0.0.1");
                sock.once("connect", () => {
                    sock.end();
                    resolve();
                });
                sock.once("error", reject);
            });
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error(`Portal did not bind ${port} within ${timeoutMs}ms`);
}

let server: ChildProcess | undefined;

test.beforeAll(async () => {
    server = spawn("bun", ["run", "server/server.ts"], {
        env: {
            ...process.env,
            PORTAL_PORT: String(PORT),
            NODE_ENV: "test",
            AUTONOMOUS_DEV_STATE_DIR: FIXTURE_STATE_DIR,
            // #361: freeze the render clock so the kit-parity fixtures (dated
            // relative to this reference) produce reproducible screenshots.
            // Must match the reference the fixtures are built around — the
            // heartbeat is T-5s and the cost-ledger fills June up to this day.
            AUTONOMOUS_DEV_NOW: FROZEN_NOW,
        },
        stdio: "pipe",
    });
    await waitForPort(PORT);
});

test.afterAll(() => {
    if (server) server.kill();
});

test.use({ viewport: { width: 1440, height: 900 } });

// QUARANTINED (2026-06-09) — comment updated #361 (2026-06-21).
//
// Three of the original four blockers are now RESOLVED (#361):
//   ✓ Reader isolation — surfaces resolve paths via `stateDirRoot()`, which
//     honors AUTONOMOUS_DEV_STATE_DIR.
//   ✓ Clock determinism — every render-path "now" read routes through
//     server/lib/clock.ts (nowMs/nowDate/nowIso), honoring AUTONOMOUS_DEV_NOW.
//     This beforeAll spawns the server with that env frozen (FROZEN_NOW), and
//     tests/integration/render-determinism.test.ts proves the 8 surfaces render
//     byte-identically under it (incl. the request-ledger ordering fix, #566).
//   ✓ Fixture freshness — server/fixtures/kit-parity/ now carries June-dated
//     cost-ledger.json + heartbeat.json (T-5s) + cost-cap.json so the MTD /
//     30-day / heartbeat windows are populated under FROZEN_NOW.
//
// REMAINING (the only reason this stays skipped):
//   • Surface goldens have never been captured/committed, and cross-OS pixel
//     parity needs the pinned Playwright Docker image — capture must happen in
//     the visual-regression CI job (`npm run gen:visual-goldens`), not on a dev
//     macOS. Once captured + committed, flip this skip and add this spec to the
//     CI `npx playwright test` invocation.
// Tracked as #361.
test.skip(true, "determinism + fixtures DONE (#361); remaining: capture surface goldens in CI Docker, then un-skip");

test.beforeEach(async ({ context }) => {
    await context.addCookies([
        { name: "portal-theme", value: "light", url: BASE_URL },
    ]);
});

for (const surface of SURFACES) {
    test(`surface — ${surface.name} (${surface.path})`, async ({ page }) => {
        await page.goto(`${BASE_URL}${surface.path}`, {
            waitUntil: "domcontentloaded",
        });
        // Freeze ALL animations/transitions so screenshots are deterministic.
        // The v3 redesign adds several (phase-track pulseBrand, activity-feed
        // flash, kbtn.engaged pulse) beyond the original .dot.live pulse, so a
        // targeted freeze is not enough.
        await page.addStyleTag({
            content:
                "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
        });
        await expect(page).toHaveScreenshot(`surface-${surface.name}.png`, {
            fullPage: true,
            maxDiffPixelRatio: 0.001,
        });
    });
}

// AC-3705 — the 404 surface for a missing request must render the same
// shell + 404 view, not a 500.
test("surface — request-detail 404 (no-such-repo / REQ-999999)", async ({ page }) => {
    await page.goto(`${BASE_URL}/repo/no-such-repo/request/REQ-999999`, {
        waitUntil: "domcontentloaded",
    });
    await page.addStyleTag({
        content: ".dot.live, .dot.live::before, .dot.live::after { animation: none !important; }",
    });
    await expect(page).toHaveScreenshot("surface-request-detail-404.png", {
        fullPage: true,
        maxDiffPixelRatio: 0.001,
    });
});
