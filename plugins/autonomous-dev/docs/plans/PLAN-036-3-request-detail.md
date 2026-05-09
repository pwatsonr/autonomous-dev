# PLAN-036-3: Request Detail Surface Re-skin

## Metadata
- **Parent TDD**: TDD-036-portal-redesign-surfaces (v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 4 days
- **Dependencies**: ["PLAN-035-2"]
- **Blocked by**: PLAN-035-2 (primitives — `Btn`, `Chip`, `Score`, `ConfirmModal`)
- **Priority**: P1
- **Stage**: Surface rollout order #4 per TDD-036 §9 (medium-high complexity)

## Objective

Re-skin the Request Detail surface (`GET /repo/:repo/request/:id`) to match
`RequestDetail.jsx` from the design system kit, consuming the primitives
delivered by TDD-035 and adding the two substantial v1.1 regions —
**artifact pane** (persistent inline reading surface for PRD/TDD/diff
content) and **run history** (table of past daemon iterations that touched
this request). This plan covers PRD-018 R-17 in full per TDD-036 §6.2.

The Request Detail surface is the operator's deepest-dive view of a single
request and is the most conditionally-rendered surface in the portal —
sections appear or hide based on `phase`, `status`, and `flags`. The
artifact pane (v1.1) and run history (v1.1) are net-new; the other regions
(pipeline, reviewer chain, deploy pipeline, gate detail, standards
applied, confirm modal, phase-artifact modal) are pixel-faithful ports of
the kit. This warrants its own plan because the new v1.1 regions involve
markdown rendering, diff coloring, and a substantial new data shape
(`RequestArtifact`, `RequestRunRef`).

Solo plan rationale: pairing this with another surface would either
push the combined effort over a week or force shipping the artifact-pane
and run-history regions partially. Both v1.1 regions are substantial
enough to merit dedicated focus.

## Scope

### In Scope
- Rewrite `templates/views/request-detail.tsx` to compose 11 conditionally-rendered sections per TDD-036 §6.2 table:
  1. **Back row + page head** — always; flex row with back link + request ID + page actions (Pause/Kill `Btn`).
  2. **Request header** — always; title + meta chips (phase, variant, stack) + stat strip (started, cost, turns, score).
  3. **Pipeline visualization** — always; horizontal phase steps with `done`/`now`/`pending` states. New `fragments/pipeline-vis.tsx`.
  4. **Artifact pane (v1.1)** — always; persistent inline reading surface for current phase artifact. New `fragments/artifact-pane.tsx`.
  5. **Reviewer chain** — when `phase in {review, code}`; grid of reviewer cards. New `fragments/reviewer-chain.tsx`.
  6. **Deploy pipeline** — when `phase === 'deploy'`; horizontal deploy stage steps. New `fragments/deploy-pipeline.tsx`.
  7. **Gate detail** — when `status === 'gate'`; warning-tinted card with approve/reject `Btn`. New `fragments/gate-detail.tsx`.
  8. **Standards applied** — when `request.flags.hasStandards`; stacked rule rows.
  9. **Run history (v1.1)** — always (may be empty); table of past daemon iterations. New `fragments/run-history.tsx`.
  10. **Confirm modal** — client-triggered; uses `ConfirmModal` primitive from TDD-035 (R-08 §6.5.7).
  11. **Phase artifact modal** — client-triggered; wide modal for expanded artifact reading. New vanilla JS `static/js/phase-artifact-modal.js`.
- Implement `fragments/pipeline-vis.tsx` per TDD-036 §6.2 ("Pipeline visualization"): horizontal flex container, edge-to-edge `pipe-step` buttons, three visual states (`done` / `now` with `--brand-tint` glow ring / `pending`), first/last steps get rounded corners.
- Implement `fragments/artifact-pane.tsx` per TDD-036 §6.2 (full markup verbatim):
  - `format === 'diff'`: `<pre class="artifact-pre artifact-diff">`, `+` lines tinted `--ok-tint`, `-` lines tinted `--err-tint`, `@@` headers tinted `--info-tint`.
  - `format === 'markdown'`: `<div class="artifact-prose" dangerouslySetInnerHTML={renderMarkdown(content)}>`. Server-side markdown rendering only; content is server-authored artifact prose, never user input (see TDD-036 OI-002 sanitization story).
  - `format === 'text'`: plain `<pre class="artifact-pre">`.
  - When `currentArtifact` undefined: muted text "No artifact available for this phase".
- Implement server-side `renderMarkdown()` helper in `server/lib/markdown.ts` (lightweight, no external dep — supports headers, paragraphs, code blocks, lists, links). Document XSS posture: artifact content is daemon-authored, not operator input, and the trust boundary is the daemon writing to disk; no upstream sanitization is needed beyond the renderer escaping HTML in code blocks.
- Implement `fragments/run-history.tsx` per TDD-036 §6.2 (full markup verbatim): table with cols (Run, Time, Phase, Outcome, Cost), outcome tone mapping (`pass` → ok, `fail` → err, `block` → warn), `EmptyState noun="prior runs"` when empty. Sorted by timestamp descending.
- Implement `fragments/reviewer-chain.tsx`, `fragments/deploy-pipeline.tsx`, `fragments/gate-detail.tsx` per kit (`RequestDetail.jsx` line ranges per TDD-036 §5.2 mapping).
- Phase artifact modal (vanilla JS): clicking a `pipe-step` opens a wide modal for that phase's artifact. The modal is a server-rendered hidden `<dialog>` populated for each phase that has an artifact, opened by `dialog.showModal()` keyed by `data-phase`.
- Static JS module `static/js/phase-artifact-modal.js`: wires click handlers on `.pipe-step` to open the appropriate `<dialog>`, handles backdrop dismiss, traps focus.
- Extend `types/render.ts` per TDD-036 §5.3: `RequestArtifact`, `RequestRunRef`, extend `RequestDetail` with `currentArtifact?` and `runs?`.
- Extend `stubs/requests.ts` with `currentArtifact` (one example each: PRD markdown, TDD markdown, code diff) and `runs` (5-8 entries spanning past phases).
- Wire SSE channels per TDD-036 §5.2: `request:{id}:meta`, `request:{id}:phase`, `request:{id}:artifact`, `request:{id}:deploy`.
- Empty-state coverage per TDD-036 §6.2 ("Empty states") for all conditional sections.
- Visual regression test: `tests/visual/request-detail.visual.test.ts` (light + dark + 4 phase variants: prd, review, deploy, code-with-gate).
- Integration test: `tests/integration/request-detail.test.ts` — assert each conditional section renders only under its trigger condition.
- M-04 before/after screenshots (light + dark, 4 PNGs).

### Out of Scope
- Primitives (`Btn`, `Chip`, `Score`, `ConfirmModal`) — TDD-035 / PLAN-035-2.
- Layout shell — TDD-035 / PLAN-035-1.
- Other surfaces — sister plans.
- New daemon data plumbing for `currentArtifact` / `runs` — stub loaders supply representative data per NG-3606. Wiring to real daemon artifact storage is a follow-up.
- Approval workflow logic (the actual approve/reject HTTP handlers) — already exists; this plan only re-skins the buttons and confirm modal.
- Non-Request-Detail agent log — that lives on Ops per TDD-036 §6.2 "Note on agent log" and PLAN-036-2.

## Tasks

1. **Extend `types/render.ts`** with `RequestArtifact`, `RequestRunRef`, and extend `RequestDetail` with `currentArtifact?: RequestArtifact` and `runs?: RequestRunRef[]`. Both fields optional for backward compat.
   - Files: `plugins/autonomous-dev-portal/server/types/render.ts`.
   - Acceptance: `bun tsc --noEmit` passes.
   - Effort: 0.25 day.

2. **Populate `stubs/requests.ts`** with `currentArtifact` for at least 3 phase examples (PRD markdown, TDD markdown, code diff) and `runs` array (5-8 entries with mixed outcomes spanning prd → review).
   - Files: `plugins/autonomous-dev-portal/server/stubs/requests.ts`.
   - Acceptance: Stub renders the kit's full visual; markdown stub includes headers + lists + code block; diff stub includes `+`/`-`/`@@` lines.
   - Effort: 0.25 day.

3. **Implement `server/lib/markdown.ts`** — lightweight server-side markdown renderer. Supports `# ## ###` headers, paragraphs, fenced code blocks (with HTML escaping inside), unordered/ordered lists, inline `code`, bold/italic, links. No external dep. Document the trust-boundary rationale in module header.
   - Files: `plugins/autonomous-dev-portal/server/lib/markdown.ts`, `tests/lib/markdown.test.ts`.
   - Acceptance: Unit test covers each supported syntax; HTML in code blocks is escaped (`<script>` becomes `&lt;script&gt;`); HTML outside code blocks passes through (artifact prose may legitimately contain HTML for tables, etc., authored by the daemon).
   - Effort: 0.5 day.

4. **Implement `fragments/pipeline-vis.tsx`.** Horizontal flex container, `pipe-step` per phase with `done` / `now` (with glow ring + brand-tinted background) / `pending` states. First step has `border-radius` on left, last on right, all `border-right: 0` except last. Each step is a button (clickable to open phase artifact modal).
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/pipeline-vis.tsx`.
   - Acceptance: Visual snapshot of 8-phase pipeline with `now` at index 3 matches kit; clicking step opens correct modal in integration test.
   - Effort: 0.5 day.

5. **Implement `fragments/artifact-pane.tsx`.** Per TDD-036 §6.2 markup verbatim. Three render branches based on `format`. Diff coloring via per-line `<span>` wrappers (no clientside JS — all server-rendered). Empty case shows muted text.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/artifact-pane.tsx`.
   - Acceptance: Snapshot tests for each format (markdown, diff, text, undefined). Diff lines have correct color tokens. Markdown content is rendered as HTML.
   - Effort: 0.5 day.

6. **Implement `fragments/run-history.tsx`.** Per TDD-036 §6.2 markup verbatim. Table with 5 cols, sorted desc by timestamp, outcome chip tone mapping, empty case `EmptyState noun="prior runs"`.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/run-history.tsx`.
   - Acceptance: Renders 5+ rows when populated; empty array → `EmptyState`; outcome tones correct.
   - Effort: 0.25 day.

7. **Implement `fragments/reviewer-chain.tsx`, `fragments/deploy-pipeline.tsx`, `fragments/gate-detail.tsx`.** Pixel-faithful ports of the kit's `RequestDetail.jsx` regions. Reviewer cards expose blocking/passing states. Deploy pipeline is horizontal stage list with `done` / `now` / `pending`. Gate detail uses warning-tinted card with `Btn kind="primary"` (approve) and `Btn kind="destructive"` (reject); both trigger `ConfirmModal` from TDD-035.
   - Files: `plugins/autonomous-dev-portal/server/templates/fragments/{reviewer-chain,deploy-pipeline,gate-detail}.tsx`.
   - Acceptance: Each fragment passes its own snapshot test in light + dark theme.
   - Effort: 0.5 day.

8. **Implement `static/js/phase-artifact-modal.js`.** Vanilla JS module. On `DOMContentLoaded`: query `.pipe-step[data-phase]`; bind click → `document.getElementById('artifact-modal-' + phase).showModal()`. Backdrop click + ESC dismisses (native `<dialog>` behavior). Focus trap inherited from `<dialog>`.
   - Files: `plugins/autonomous-dev-portal/server/static/js/phase-artifact-modal.js`, `tests/clientside/phase-artifact-modal.test.ts`.
   - Acceptance: jsdom unit test simulates click → asserts `showModal()` called for correct dialog; ESC keypress triggers `close()`.
   - Effort: 0.25 day.

9. **Rewrite `templates/views/request-detail.tsx`** to compose all 11 sections with their conditional render logic. Wire `request:{id}:meta`, `request:{id}:phase`, `request:{id}:artifact`, `request:{id}:deploy` SSE channel `id` attributes for OOB swaps.
   - Files: `plugins/autonomous-dev-portal/server/templates/views/request-detail.tsx`, `server/routes/request-detail.ts`.
   - Acceptance: Visual snapshot for 4 phase variants (prd, review, deploy, code-with-gate) passes. Confirm modal opens on approve/reject click. Phase artifact modal opens on `pipe-step` click.
   - Effort: 0.5 day.

10. **Empty-state coverage and conditional-render integration tests.** Verify each conditional section renders or hides correctly:
    - `phase=prd` → no reviewer chain, no deploy, no gate, no standards.
    - `phase=review` → reviewer chain renders.
    - `phase=deploy` → deploy pipeline renders, no reviewer chain.
    - `status=gate` → gate detail card renders.
    - `flags.hasStandards=true` → standards section renders.
    - `currentArtifact=undefined` → artifact pane shows "No artifact available".
    - `runs=[]` → run history shows `EmptyState`.
    - Files: `plugins/autonomous-dev-portal/tests/integration/request-detail.test.ts`.
    - Acceptance: 7 distinct render-condition test cases, each asserts presence/absence of expected sections.
    - Effort: 0.5 day.

11. **Capture M-04 before/after screenshots** (light + dark + at least 1 phase variant where v1.1 regions are exercised, ideally `phase=review` with both artifact pane and reviewer chain visible).
    - Files: `plugins/autonomous-dev-portal/docs/screenshots/redesign/request-detail-{before,after}-{light,dark}.png`.
    - Acceptance: 4 PNGs minimum committed; reviewer can eyeball-compare.
    - Effort: 0.25 day.

## Verification

- `bun test plugins/autonomous-dev-portal/tests/integration/request-detail.test.ts` passes — all 7 conditional-render cases.
- `bun playwright test plugins/autonomous-dev-portal/tests/visual/request-detail.visual.test.ts` passes for 4 phase variants × 2 themes = 8 snapshots.
- `bun test plugins/autonomous-dev-portal/tests/lib/markdown.test.ts` passes — markdown renderer handles all supported syntax + escapes HTML in code blocks.
- `bun test plugins/autonomous-dev-portal/tests/clientside/phase-artifact-modal.test.ts` passes — jsdom modal open/close.
- M-04 deliverable: 4+ screenshots committed.
- Manual sanity: `bun run dev`, visit `/repo/example-repo/request/req-001`, click each `pipe-step` to confirm phase artifact modal opens with correct content.

## Test Plan

- **Visual regression** per TDD-036 §8.1 — 4 phase variants × 2 themes.
- **Component integration** per TDD-036 §8.3 — 7 conditional-render cases.
- **Empty state** per TDD-036 §8.4 — `currentArtifact=undefined`, `runs=[]`, `flags.hasStandards=false`.
- **Data shape compatibility** per TDD-036 §8.2.
- **Markdown renderer unit tests**: headers, lists, code blocks (HTML-escaped), links, paragraphs.
- **Diff renderer**: per-line color test for `+` / `-` / `@@`.
- **Client-side JS unit tests** per TDD-036 §8.6 — phase artifact modal open/close, backdrop dismiss.

## Rollback

Per TDD-036 §9, revert `views/request-detail.tsx` plus the 7 new fragments + `lib/markdown.ts` + `static/js/phase-artifact-modal.js` in a single commit. The `RenderProps` extensions (`currentArtifact?`, `runs?`) are optional and backward-compatible. Reverting the view restores the prior unstyled Request Detail without breaking the route handler or daemon integrations.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Markdown renderer XSS — daemon-authored content unexpectedly contains HTML+JS payload | Low | High | Document trust boundary in `lib/markdown.ts` header. Code blocks always HTML-escape. Out-of-code HTML passes through (per design — daemon may emit tables, etc.). If risk profile changes, swap in a vetted library; module is small enough to replace without surface-level changes. |
| `<dialog>` browser support — older browsers degrade poorly | Low | Low | All target operator browsers (Chrome/Safari/Firefox current) support `<dialog>` natively since 2022. Document min-version in TDD if challenged. Graceful degradation: hidden `<dialog>` falls back to inline content (still readable). |
| Phase artifact modal opens with stale data after SSE update changes the artifact | Medium | Low | The `<dialog>` content is server-rendered and SSE-swappable via OOB. The modal's `<dialog id="artifact-modal-{phase}">` sits in the DOM and its body is the SSE swap target. |
| Conditional rendering combinatorics — 4 phases × 3 statuses × 2 standards-flag = 24 visual variants, infeasible to snapshot all | High (combinatorics) | Medium | Snapshot the 4 most-distinct phase variants only (prd, review, deploy, code-with-gate). Integration test covers individual section presence/absence per condition. Visual regression catches kit-fidelity drift; combinatorial coverage isn't necessary. |
| Artifact-pane diff rendering escapes special characters incorrectly (e.g., HTML entities in code) | Medium | Medium | Always wrap diff content in `<pre>` and use `textContent` semantics; per-line span wrappers receive escaped text. Unit test feeds `<script>alert(1)</script>` in diff lines and asserts no script execution. |
| Run history grows unbounded for long-lived requests | Low | Low | Cap `runs` to last 50 entries server-side; emit a "view full history" link for follow-up if needed (not in scope). |
| Pipeline-vis `now` step glow ring conflicts with hairline-elevation rule | Low | Low | Glow ring is a CSS `outline` on the `pipe-step`, not a `box-shadow` — exempt from R-15a's `box-shadow:` lint. Document inline in fragment. |
