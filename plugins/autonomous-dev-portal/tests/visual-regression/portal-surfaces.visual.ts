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
import { join } from "node:path";

import { expect, test } from "@playwright/test";

const PORT = 19282; // distinct from design-system spec's 19281
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_STATE_DIR = join(
    import.meta.dir,
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
    server = spawn("bun", ["run", "server/index.ts"], {
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: "test",
            AUTONOMOUS_DEV_STATE_DIR: FIXTURE_STATE_DIR,
        },
        stdio: "pipe",
    });
    await waitForPort(PORT);
});

test.afterAll(() => {
    if (server) server.kill();
});

test.use({ viewport: { width: 1440, height: 900 } });

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
        await page.addStyleTag({
            content:
                ".dot.live, .dot.live::before, .dot.live::after { animation: none !important; }",
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
