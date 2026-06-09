// SPEC-035-4-03 — Visual regression Playwright suite.
//
// Captures one full-page screenshot plus 20 per-section screenshots scoped
// to `#preview-{1..20}`, comparing against goldens under
// `tests/visual-regression/goldens/`. The suite is the canonical CI gate
// against primitive drift (PRD-018 M-03).
//
// Determinism contract:
//   - Viewport pinned to 1440x900 (AC-3).
//   - Theme forced via `portal-theme=light` cookie (AC-3).
//   - `.dot.live` pulse animation paused via injected stylesheet (AC-4)
//     so the strobe can never produce a non-deterministic frame.
//   - Pixel-diff threshold is exactly 0.1% (`maxDiffPixelRatio: 0.001`) —
//     anything above fails the test (AC-7).
//   - In CI, `updateSnapshots: 'none'` (configured at the playwright.config
//     level) so a missing golden is a hard test failure with the
//     `GOLDEN_MISSING` message wired by SPEC-035-4-04.
//
// Local golden generation:
//   `npm run gen:visual-goldens` (defined in package.json) sets the
//   `--project=golden-gen` flag whose `updateSnapshots: 'all'` regenerates
//   every PNG. AC-10: re-running twice produces zero git-diff.

import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

import { expect, test } from "@playwright/test";

const PORT = 19281;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | undefined;

/**
 * Probe the loopback port until it is reachable or `deadlineMs` elapses.
 * Resolves on success, rejects on timeout. Used as a thin substitute for
 * a `wait-on` dep — keeping the visual regression suite zero-extra-deps
 * relative to Playwright + Bun.
 */
async function waitForPort(port: number, deadlineMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        const reachable = await new Promise<boolean>((resolve) => {
            const socket = connect(port, "127.0.0.1");
            socket.on("connect", () => {
                socket.destroy();
                resolve(true);
            });
            socket.on("error", () => {
                socket.destroy();
                resolve(false);
            });
        });
        if (reachable) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for 127.0.0.1:${port} after ${deadlineMs}ms`);
}

test.beforeAll(async () => {
    // Spawn the portal in test mode. PORTAL_WORDMARK_BRACKETS=1 freezes
    // the wordmark variant so the brand-section golden doesn't depend on
    // any local env override.
    server = spawn("bun", ["run", "server/server.ts"], {
        env: {
            ...process.env,
            PORTAL_PORT: String(PORT),
            NODE_ENV: "test",
            PORTAL_WORDMARK_BRACKETS: "1",
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
    // AC-3: light theme forced via cookie before navigation. The cookie
    // URL must match the BASE_URL host so the cookie scope is right.
    await context.addCookies([
        {
            name: "portal-theme",
            value: "light",
            url: BASE_URL,
        },
    ]);
});

test("design-system page — full + 20 sections", async ({ page }) => {
    await page.goto(`${BASE_URL}/design-system`, {
        waitUntil: "domcontentloaded",
    });

    // AC-4: pause the live-dot pulse animation. Done via addStyleTag so
    // the rule applies AFTER any page styles and trumps them via
    // `!important`. Targets all `.dot.live` pseudo-elements as well so the
    // ::before / ::after pulse halos are halted.
    await page.addStyleTag({
        content:
            ".dot.live, .dot.live::before, .dot.live::after { animation: none !important; }",
    });

    // AC-5: wait until the page reports its expected section count and
    // every `.ds-card` is present. The data attribute is emitted by the
    // route's <div class="ds-layout" data-section-count={SECTIONS.length}>.
    await expect(page.locator("[data-section-count]")).toHaveAttribute(
        "data-section-count",
        "20",
    );
    await expect(page.locator("section.ds-card")).toHaveCount(20);
    await expect(page.locator(".dot.live").first()).toBeVisible();

    // AC-6: full-page screenshot first.
    await expect(page).toHaveScreenshot("design-system-full.png", {
        fullPage: true,
        maxDiffPixelRatio: 0.001,
    });

    // AC-6: per-section screenshots scoped via `page.locator('#preview-N')`.
    // Filenames are zero-padded `01..20` so glob ordering matches numeric.
    for (let n = 1; n <= 20; n++) {
        const id = String(n).padStart(2, "0");
        await expect(page.locator(`#preview-${n}`)).toHaveScreenshot(
            `design-system-card-${id}.png`,
            { maxDiffPixelRatio: 0.001 },
        );
    }
});
