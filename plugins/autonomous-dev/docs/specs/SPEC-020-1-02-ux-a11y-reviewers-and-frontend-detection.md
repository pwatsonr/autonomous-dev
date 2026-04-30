# SPEC-020-1-02: UX/UI Reviewer, Accessibility Reviewer & Frontend Detection Helper

## Metadata
- **Parent Plan**: PLAN-020-1
- **Tasks Covered**: Task 3 (ux-ui-reviewer), Task 4 (accessibility-reviewer), Task 6 (detectFrontendChanges helper + cache)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-020-1-02-ux-a11y-reviewers-and-frontend-detection.md`

## Description
Ships the two frontend-aware specialist reviewers (`ux-ui-reviewer`, `accessibility-reviewer`) and the shared helper that prevents them from re-scanning the same diff twice (`detectFrontendChanges`). The helper exposes a typed `FrontendDetection` interface and an in-process per-request cache keyed by `request_id`; both reviewer agents are instructed to consult that cache via the scheduler context (PLAN-020-2). When the diff contains no frontend files, both reviewers short-circuit to `APPROVE` with empty `findings`, so the scheduler can dispatch them optimistically without burning tokens on backend-only changes.

The agents are pure Markdown frontmatter documents (no runtime code). The helper is a small TypeScript module exported from `src/reviewers/frontend-detection.ts`. Both agents declare the v1 schema (SPEC-020-1-01) as their output contract.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/agents/ux-ui-reviewer.md` | Create | Read-only tools; six UX heuristic categories; non-frontend short-circuit |
| `plugins/autonomous-dev/agents/accessibility-reviewer.md` | Create | Read-only tools; WCAG 2.2 AA criteria 1.4.3, 2.1, 2.4.3, 4.1.2, 1.1.1; non-frontend short-circuit |
| `plugins/autonomous-dev/src/reviewers/frontend-detection.ts` | Create | `FrontendDetection` interface, `detectFrontendChanges()`, `clearCache()`, exported `Map<string, FrontendDetection>` |
| `plugins/autonomous-dev/src/reviewers/index.ts` | Create | Barrel re-export: `export * from './frontend-detection'` |

## Implementation Details

### `FrontendDetection` Interface and Detection Function

```ts
// src/reviewers/frontend-detection.ts
export interface FrontendDetection {
  isFrontendChange: boolean;
  detectedFiles: string[];
  framework?: 'react' | 'vue' | 'svelte' | 'angular' | 'vanilla';
  hasViewportMeta: boolean;
}

const FRONTEND_PATH_PATTERNS = [
  /\/components\//,
  /\/views\//,
  /\/pages\//,
  /\.(tsx|jsx|vue|svelte)$/,
];

const FRAMEWORK_DEPS: Array<[FrontendDetection['framework'], string[]]> = [
  ['react',   ['react', 'react-dom', 'next']],
  ['vue',     ['vue', 'nuxt']],
  ['svelte',  ['svelte', '@sveltejs/kit']],
  ['angular', ['@angular/core']],
];

const cache = new Map<string, FrontendDetection>();

export function detectFrontendChanges(
  requestId: string,
  repoPath: string,
  changedFiles: string[],
): FrontendDetection {
  if (cache.has(requestId)) return cache.get(requestId)!;
  const detected = changedFiles.filter(f => FRONTEND_PATH_PATTERNS.some(re => re.test(f)));
  const framework = detected.length > 0 ? detectFramework(repoPath) : undefined;
  const hasViewportMeta = detected.length > 0 ? scanForViewportMeta(repoPath, detected) : false;
  const result: FrontendDetection = {
    isFrontendChange: detected.length > 0,
    detectedFiles: detected,
    framework,
    hasViewportMeta,
  };
  cache.set(requestId, result);
  return result;
}

export function clearCache(requestId?: string): void {
  if (requestId === undefined) { cache.clear(); return; }
  cache.delete(requestId);
}

export const __cacheForTests = cache; // internal handle for unit tests only
```

`detectFramework(repoPath)` reads `<repoPath>/package.json` (if present), checks `dependencies` and `devDependencies` against `FRAMEWORK_DEPS` in order, and returns the first match or `'vanilla'`. Missing package.json returns `'vanilla'`.

`scanForViewportMeta(repoPath, files)` greps the detected files for `<meta name="viewport"` (case-insensitive) and returns `true` if any match.

### `ux-ui-reviewer.md` Frontmatter

```yaml
---
name: ux-ui-reviewer
version: "1.0.0"
role: reviewer
model: claude-sonnet-4-6
temperature: 0.2
turn_limit: 15
tools:
  - Read
  - Glob
  - Grep
expertise:
  - ux-heuristics
  - information-architecture
  - state-coverage
  - responsive-design
output_schema: schemas/reviewer-finding-v1.json
description: "Specialist reviewer for UX/UI heuristics: density, color signaling, state coverage, responsiveness, form/button labels."
---
```

Prompt body must contain six labeled sections, each with one example violation and one example fix:
1. **Information density and hierarchy** — too many primary buttons; missing visual grouping.
2. **Color-only signaling** — error indicated only by red text (no icon/aria-label).
3. **State coverage** — missing loading, empty, error, success states.
4. **Mobile responsiveness** — fixed-width breakpoints; horizontal overflow.
5. **Form labels** — inputs without `<label>` or `aria-labelledby`.
6. **Button labels** — generic "Click here", icon-only buttons without `aria-label`.

Non-frontend guard (verbatim, first paragraph after intro):

> If the scheduler context indicates `isFrontendChange: false`, return immediately with `{"reviewer": "ux-ui-reviewer", "verdict": "APPROVE", "score": 100, "findings": []}` and do not perform any further analysis.

### `accessibility-reviewer.md` Frontmatter

```yaml
---
name: accessibility-reviewer
version: "1.0.0"
role: reviewer
model: claude-sonnet-4-6
temperature: 0.1
turn_limit: 15
tools:
  - Read
  - Glob
  - Grep
expertise:
  - wcag-2.2-aa
  - keyboard-accessibility
  - aria
  - color-contrast
output_schema: schemas/reviewer-finding-v1.json
description: "Specialist reviewer for WCAG 2.2 AA conformance: contrast (4.5:1 / 3:1), keyboard accessibility, focus order, ARIA, alt text."
---
```

Prompt MUST cite WCAG criterion numbers in each section's heading and require findings to set `category` to the criterion number (e.g. `category: "WCAG 2.2 AA 1.4.3 Contrast"`):
- **1.4.3 Contrast (Minimum)** — 4.5:1 normal text, 3:1 large text. Inspect CSS color pairs in the diff.
- **2.1 Keyboard Accessible** — every interactive element reachable; no keyboard traps.
- **2.4.3 Focus Order** — `tabindex` does not skip ahead/back unexpectedly.
- **4.1.2 Name, Role, Value** — every custom widget exposes a name, role, and current value via ARIA.
- **1.1.1 Non-text Content** — `<img>` has `alt`; decorative images use `alt=""` or `role="presentation"`.

Non-frontend guard: identical to UX reviewer (substitute `accessibility-reviewer`).

Contrast caveat (verbatim, after section 1.4.3):

> Contrast ratios computed from CSS color values are advisory; the rendered pixel value may differ. Set finding `severity` to `medium` when reporting contrast issues from source CSS. Definitive contrast verdicts require axe-core or equivalent rendered-pixel analysis (out of scope for this reviewer).

## Acceptance Criteria

- [ ] `agents/ux-ui-reviewer.md` and `agents/accessibility-reviewer.md` exist; frontmatter `tools` is exactly `[Read, Glob, Grep]` for both (no Bash, Edit, or Write).
- [ ] Both agents reference `schemas/reviewer-finding-v1.json` in frontmatter `output_schema`.
- [ ] UX prompt enumerates all six heuristic categories with at least one example each.
- [ ] Accessibility prompt cites WCAG criterion numbers (1.4.3, 2.1, 2.4.3, 4.1.2, 1.1.1) and instructs that findings put the criterion number in `category`.
- [ ] Both agents contain the verbatim non-frontend short-circuit instruction returning `APPROVE` with empty findings.
- [ ] Accessibility agent contains the verbatim contrast caveat instructing `medium` severity for source-CSS contrast findings.
- [ ] `src/reviewers/frontend-detection.ts` exports `FrontendDetection`, `detectFrontendChanges`, `clearCache`, and `__cacheForTests`.
- [ ] A diff containing `src/components/Button.tsx` returns `{ isFrontendChange: true, framework: 'react' }` when `package.json` lists `react` as a dependency.
- [ ] A diff containing only `src/services/auth.ts` returns `{ isFrontendChange: false, detectedFiles: [], framework: undefined }`.
- [ ] Calling `detectFrontendChanges('req-123', ...)` twice in succession returns the same object reference (cache hit).
- [ ] `clearCache('req-123')` evicts only that request's entry; `clearCache()` (no arg) evicts all entries.
- [ ] All four frameworks (react, vue, svelte, angular) and the vanilla case (no framework deps) resolve correctly via `detectFramework()`. (Verified by SPEC-020-1-05 unit tests.)
- [ ] `src/reviewers/index.ts` re-exports the public surface.

## Dependencies

- **Upstream**: SPEC-020-1-01 (reviewer-finding-v1.json schema) — both agents reference this schema.
- **Downstream**: SPEC-020-1-04 (UX + a11y eval cases consume these agents); SPEC-020-1-05 (unit tests for `frontend-detection.ts`, integration tests for both agents); PLAN-020-2 (scheduler reads `FrontendDetection` to decide whether to dispatch these reviewers).

## Notes

- The cache is process-local. PLAN-020-2's scheduler is responsible for calling `clearCache(requestId)` at request completion via the existing lifecycle hooks. This spec does not wire that hook.
- Framework detection precedence (`react` before `next`, `vue` before `nuxt`) matters because Next.js and Nuxt projects also list the underlying framework. We return the more specific match by inspecting the deps array order. Test cases in SPEC-020-1-05 cover this.
- The viewport-meta scan is a heuristic for "is this a real web app vs. a component library snippet". The accessibility reviewer uses it to decide whether to look for responsive-design issues at all.
- Both reviewers run with `Read, Glob, Grep` only — no Bash. They cannot invoke axe-core or any external tool. The contrast caveat documents this limitation explicitly so operators know when to rely on the verdict.
- The non-frontend short-circuit lets PLAN-020-2's scheduler dispatch the chain optimistically (run all reviewers in parallel, let irrelevant ones APPROVE quickly) instead of doing detection up front and gating dispatch. This avoids a serial bottleneck.
