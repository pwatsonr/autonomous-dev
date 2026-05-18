// SPEC-035-4-03 — Playwright config for the portal visual regression suite.
//
// Two projects:
//   - `chromium` (default): pixel-perfect comparison against committed
//     goldens. `updateSnapshots: 'none'` means a missing golden is a hard
//     failure. CI uses this project (SPEC-035-4-04 AC-7).
//   - `golden-gen`: regenerates the goldens. Used ONLY by the local
//     `npm run gen:visual-goldens` script. CI never selects this project.
//
// `snapshotPathTemplate` pins goldens under `tests/visual-regression/goldens/`
// so spec + goldens live in the same tree (SPEC-035-4-03 AC-8).

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "tests/visual-regression",
    // *.visual.ts (not *.spec.ts) so bun's default test matcher skips
    // these specs — they import `@playwright/test` which isn't a bun
    // dependency. bun runs everything else; Playwright runs only these.
    testMatch: "**/*.visual.ts",
    timeout: 60_000,
    fullyParallel: false,
    workers: 1,
    reporter: [["list"], ["html", { open: "never" }]],
    snapshotPathTemplate:
        "tests/visual-regression/goldens/{arg}{ext}",
    expect: {
        toHaveScreenshot: {
            maxDiffPixelRatio: 0.001,
        },
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
            // SPEC-035-4-03 AC-8: missing goldens fail; never auto-create.
            updateSnapshots: "none",
        },
        {
            name: "golden-gen",
            use: { ...devices["Desktop Chrome"] },
            // Local-only project for `npm run gen:visual-goldens`.
            updateSnapshots: "all",
        },
    ],
});
