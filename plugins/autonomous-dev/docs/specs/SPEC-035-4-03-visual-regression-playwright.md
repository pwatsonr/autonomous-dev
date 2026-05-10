# SPEC-035-4-03: Visual Regression Playwright Suite

## Metadata
- **Parent Plan**: PLAN-035-4
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§10.4)
- **Parent PRD**: PRD-018-portal-visual-redesign (M-03)
- **Tasks Covered**: PLAN-035-4 Tasks 8, 9, 10
- **Depends on**: SPEC-035-4-01, SPEC-035-4-02
- **Estimated effort**: 0.7 day
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Author the Playwright visual regression suite that uses `/design-system` as the canonical CI gate against primitive drift. The suite captures one full-page screenshot plus 20 per-section screenshots scoped to `#preview-{1..20}`, compares against goldens at `tests/visual-regression/goldens/`, and runs deterministically — pulse animations are paused, the viewport is fixed, and the screenshots are byte-identical between local macOS generation and the pinned Docker CI run.

## Acceptance Criteria

- AC-1 Spec file lives at `tests/visual-regression/design-system.spec.ts` (path matches the bootstrap CI job in SPEC-035-4-04). PLAN-035-4 task 8 references the older `tests/visual/` path; this spec normalizes on `tests/visual-regression/` so the goldens and spec live in the same tree.
- AC-2 The spec launches the portal in test mode (`PORT=19281 NODE_ENV=test PORTAL_WORDMARK_BRACKETS=1`) before the test run, navigates to `http://127.0.0.1:19281/design-system`, and tears the server down after the run.
- AC-3 Viewport is fixed at `1440x900`. Color scheme is forced via the `portal-theme=light` cookie set on the browser context. Animations are disabled before screenshots.
- AC-4 Before screenshots, the test injects a stylesheet via `page.addStyleTag` with the rule `.dot.live, .dot.live::before, .dot.live::after { animation: none !important; }` so the pulse never produces a non-deterministic frame.
- AC-5 The test waits for `domcontentloaded`, then for `[data-section-count]` (or 20 `.ds-card` elements) to be present, then for the live-dot's parent to be `visible`, before any screenshot.
- AC-6 Screenshots produced (21 total): `design-system-full.png` (full page) and `design-system-card-{01..20}.png` (per-section, scoped via `page.locator('#preview-{n}').screenshot()`). Filenames are zero-padded `{01..20}`.
- AC-7 Pixel-diff threshold is exactly `0.1%` (`maxDiffPixelRatio: 0.001`). Any diff above this fails the test.
- AC-8 Goldens directory is `tests/visual-regression/goldens/`. If a golden is missing, Playwright's `toMatchSnapshot` is configured with `updateSnapshots: 'none'` so the test fails with the message wired by SPEC-035-4-04 (no auto-generation in normal runs).
- AC-9 Local generation script `npm run gen:visual-goldens` is added to `package.json` and wraps `UPDATE_GOLDEN=1 npx playwright test tests/visual-regression/design-system.spec.ts --project=golden-gen`. The Playwright config defines two projects: `golden-gen` (sets `updateSnapshots: 'all'`) and the default `chromium` project (locked to `updateSnapshots: 'none'`).
- AC-10 Re-running `npm run gen:visual-goldens` twice in clean working trees produces zero `git diff` (deterministic).
- AC-11 If the total size of `tests/visual-regression/goldens/` exceeds 500KB, `.gitattributes` adds `tests/visual-regression/goldens/*.png filter=lfs diff=lfs merge=lfs -text` and goldens are re-staged via `git lfs`. Below 500KB, goldens are committed as inline blobs.

## Implementation

**`tests/visual-regression/design-system.spec.ts`**:

```typescript
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

let server: ChildProcess;
test.beforeAll(async () => {
  server = spawn('bun', ['run', 'server/index.ts'], {
    env: { ...process.env, PORT: '19281', NODE_ENV: 'test', PORTAL_WORDMARK_BRACKETS: '1' },
    stdio: 'pipe',
  });
  await waitForPort(19281);
});
test.afterAll(() => server.kill());

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'portal-theme', value: 'light', url: 'http://127.0.0.1:19281' }]);
});

test('design-system page — full + 20 sections', async ({ page }) => {
  await page.goto('http://127.0.0.1:19281/design-system', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: `.dot.live, .dot.live::before, .dot.live::after { animation: none !important; }` });
  await expect(page.locator('section.ds-card')).toHaveCount(20);
  await expect(page).toHaveScreenshot('design-system-full.png', { maxDiffPixelRatio: 0.001, fullPage: true });
  for (let n = 1; n <= 20; n++) {
    const id = String(n).padStart(2, '0');
    await expect(page.locator(`#preview-${n}`)).toHaveScreenshot(`design-system-card-${id}.png`, { maxDiffPixelRatio: 0.001 });
  }
});
```

**`playwright.config.ts`** (root): `snapshotPathTemplate: 'tests/visual-regression/goldens/{arg}{ext}'`, `projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'golden-gen', use: { ...devices['Desktop Chrome'] }, updateSnapshots: 'all' }]`, `expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001 } }`.

**`package.json`** scripts addition:

```json
"gen:visual-goldens": "UPDATE_GOLDEN=1 npx playwright test tests/visual-regression/design-system.spec.ts --project=golden-gen"
```

**Bootstrap**: run `npm run gen:visual-goldens` once locally; commit the 21 PNGs. Run `du -sh tests/visual-regression/goldens/`; if > 500KB, configure `git lfs track "tests/visual-regression/goldens/*.png"` and re-stage.

## Tests

- **Determinism**: run `npm run gen:visual-goldens` twice consecutively; assert `git diff --stat tests/visual-regression/goldens/` is empty after the second run.
- **Threshold sensitivity**: programmatically apply a 1px shift to a primitive (e.g., temporarily change `.btn` padding by 1px in `portal.css`) and run the spec; assert the corresponding section's diff exceeds 0.1% and the test fails.
- **Class-removal sensitivity**: temporarily strip `.primary` from `.btn.primary` styling; assert section-09 fails with a non-trivial diff (confirms the surface exercises the actual component code, not raw HTML).
- **Missing-golden behavior**: delete `tests/visual-regression/goldens/design-system-card-09.png` and run the spec without `--project=golden-gen`; assert the test fails with a Playwright error referencing the missing snapshot. The CI wrapper in SPEC-035-4-04 turns this into the human-readable `GOLDEN_MISSING` message.

## Verification

- `npx playwright test tests/visual-regression/design-system.spec.ts` passes locally on macOS against committed goldens.
- The 21 expected PNGs exist under `tests/visual-regression/goldens/`.
- `npm run gen:visual-goldens` regenerates all 21 files; second run produces zero diffs.
- The pulse-animation pause stylesheet is present in the test (grep for `animation: none`).
- `du -sh tests/visual-regression/goldens/` is documented in the PR; if > 500KB, `.gitattributes` includes the LFS filter line.
