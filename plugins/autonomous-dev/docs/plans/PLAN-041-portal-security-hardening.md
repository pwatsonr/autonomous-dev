# PLAN-041: Portal Security Hardening — Task Decomposition

| Field | Value |
|-------|-------|
| **PLAN ID** | PLAN-041 |
| **Parent PRD** | PRD-023 |
| **Parent TDD** | TDD-040 |
| **Date** | 2026-05-18 |
| **Status** | Proposed |

> Companion to PRD-023 and TDD-040. Decomposes the 92 failing
> assertions into five independently-shippable phases, ordered
> low-risk-to-high-risk. Each phase has a specific pass-count target;
> none weakens an earlier phase's guarantees.

---

## Slicing strategy

Phases are ordered by **blast radius first, test count second**.
Phase A is a tiny, contained fix that unblocks 18 tests immediately
and is the easiest to roll back. Phases B–E follow in increasing
complexity of the sanitization surface they touch.

| Phase | What | Tests fixed | Risk | Rough hours |
|-------|------|-------------|------|-------------|
| A | request-detail missing/sparse-state 500 → render correctly | 18 | Low | 1.0 |
| B | sanitizer link hardening (rel/target for absolute URLs) | ~5 | Low | 1.5 |
| C | script-tag + event-handler stripping | ~29 | Medium | 2.5 |
| D | OWASP filter evasion + mutation XSS + SVG/CSS/data: | ~30 | Medium-High | 4.0 |
| E | encoding bypass + edge cases | ~10 | Medium | 2.0 |

**Total: ~11 hours of focused implementation work across 5 PRs, plus a
~1-hour CI / smoke verification pass after Phase E.**

Each phase is independently revertable. None of them depend on each
other for *correctness* — they touch different lines — but ordering
them as above means each PR's review surface is small and each merge
has obvious failing-test → passing-test signal.

---

## Phase A — Request-detail missing/sparse-state 500

**Goal:** `GET /repo/:repo/request/REQ-NNNNNN` for any valid path
returns either 200 (with content) or 404 (with the not-found template).
No 500.

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-041-A-01 | Reproduce against live portal: `curl http://localhost:19280/repo/acme/request/REQ-000001` → 500 with `TypeError: null is not an object (evaluating 'res.isEscaped')` in stderr | TBD | Todo | 0.1 | Confirm before changing anything |
| T-041-A-02 | Audit `server/templates/views/request-detail/` for any `return null;` branch in region templates (grep is enough; this is a small tree) | TBD | Todo | 0.2 | Likely target file: one of the artifact-pane / phase-history / gate-detail variants based on a tier-2 record path |
| T-041-A-03 | Replace `return null;` with `return <></>;` (Fragment) in each identified branch | TBD | Todo | 0.2 | One-line change per occurrence |
| T-041-A-04 | Manually verify all 18 failing tests in `tests/routes/request-detail.test.ts` + `tests/integration/request-detail-regions.test.ts` + `tests/integration/request-detail-actions.test.ts` now pass | TBD | Todo | 0.3 | `bun test tests/routes/request-detail.test.ts tests/integration/request-detail-*.test.ts` |
| T-041-A-05 | Add one new integration assertion: a tier-2 record (request-action present, state.json absent) renders 200, NOT 500 | TBD | Todo | 0.2 | Closes the general case, not just the specific REQ-000001 path |

**Pass target after Phase A: 18 tests (AC-20, AC-21, AC-22, AC-23, AC-24
from PRD-023 §5).**

**File:line targets:**
- `plugins/autonomous-dev-portal/server/templates/views/request-detail/` — region template(s) with `return null;`
- (no route handler changes; `request-detail.ts:34–36` is already correct)

---

## Phase B — Sanitizer link hardening

**Goal:** Every absolute http(s) URL emitted by the sanitizer carries
`target="_blank"` and `rel="noopener noreferrer"` in the final HTML, no
matter which code path the URL took (markdown link, autolink,
reference-style).

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-041-B-01 | Add `target` and `rel` to the `<a>` entry in `DEFAULT_SANITIZATION_CONFIG.allowedAttributes` (`server/security/sanitization-config.ts`) | TBD | Todo | 0.1 | Single-line change in the allowlist map |
| T-041-B-02 | Add a `uponSanitizeAttribute` hook in `configurePurify(...)` (`server/security/sanitization-pipeline.ts`) that, for `<a>` with an absolute http(s) href, forces `target=_blank` and `rel=noopener noreferrer` regardless of input value | TBD | Todo | 0.4 | ~10-line hook; idempotent; mirrors the existing on*/data-* / class hooks |
| T-041-B-03 | Verify: `sanitizeMarkdown("[home](https://example.com)")` produces HTML containing both attributes | TBD | Todo | 0.1 | The "renders well-formed external links with rel/target" test in `security-sanitization.test.ts` |
| T-041-B-04 | Verify: relative URLs (`[x](/foo)`) do NOT get target/rel injected | TBD | Todo | 0.2 | Don't over-apply; check the false-positive-prevention block stays green |
| T-041-B-05 | Verify: `mailto:` URLs do NOT get target/rel | TBD | Todo | 0.1 | Same |
| T-041-B-06 | Run full sanitization suite, confirm no regressions in false-positive-prevention tests | TBD | Todo | 0.3 | `bun test tests/unit/security-sanitization.test.ts` |

**Pass target after Phase B: ~5 additional tests (AC-18, AC-19, parts
of AC-17).**

**File:line targets:**
- `plugins/autonomous-dev-portal/server/security/sanitization-config.ts:DEFAULT_SANITIZATION_CONFIG.allowedAttributes`
- `plugins/autonomous-dev-portal/server/security/sanitization-pipeline.ts:configurePurify` (the hook section, around line 205–222)

---

## Phase C — Script tag + event handler stripping

**Goal:** No payload from `corpus.scriptTagAttacks` or
`corpus.eventHandlerAttacks` produces output containing `<script`,
`on*=`, or executable function-call substrings (`alert(`, `prompt(`,
`confirm(`, `eval(`).

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-041-C-01 | Set `KEEP_CONTENT: false` in `configurePurify(...)` and add `FORBID_CONTENTS: ["script", "style", "iframe", "object", "embed", "svg"]` | TBD | Todo | 0.3 | Drops text content of forbidden tags, killing the `alert(1)`-survival cases |
| T-041-C-02 | Mirror the 7-entry `FORBIDDEN_PATTERNS` from `tests/security/xss-payload-tests.spec.ts:35–56` into `POST_SANITIZATION_BAD_PATTERNS` (`server/security/sanitization-config.ts`) | TBD | Todo | 0.4 | The post-scan becomes a strict mirror of the test contract |
| T-041-C-03 | Extend the `on*=` hook in `configurePurify` to ALSO match attributes with whitespace before `=`, mixed case, and unicode dashes | TBD | Todo | 0.3 | The current regex is `name.startsWith("on")` which is fine for DOMPurify's normalized attr name, but the post-scan also needs to catch evasions that re-introduce the attribute after escaping |
| T-041-C-04 | Verify all 16 escapeHtml event-handler tests pass | TBD | Todo | 0.2 | `bun test tests/security/xss-payload-tests.spec.ts -t "escapeHtml — event handler"` |
| T-041-C-05 | Verify all 13 sanitizeMarkdown event-handler tests pass | TBD | Todo | 0.2 | `-t "sanitizeMarkdown — event handler"` |
| T-041-C-06 | Verify all 3 MarkdownSanitizationPipeline XSS tests pass (`blocks <script> tag` etc.) | TBD | Todo | 0.2 | `tests/unit/security-sanitization.test.ts` |
| T-041-C-07 | Manual smoke: send `<img src=x onerror=alert(1)>` markdown through the live portal; verify no `onerror=` in rendered HTML and no `alert(` substring | TBD | Todo | 0.2 | Document the manual check in the PR description |

**Pass target after Phase C: ~29 additional tests (AC-01, AC-02 partial,
AC-09, AC-10, AC-11 partial, AC-17).**

**File:line targets:**
- `plugins/autonomous-dev-portal/server/security/sanitization-pipeline.ts:configurePurify` (around line 185–222)
- `plugins/autonomous-dev-portal/server/security/sanitization-config.ts:POST_SANITIZATION_BAD_PATTERNS`
- `plugins/autonomous-dev-portal/server/security/sanitization-config.ts:FORBIDDEN_TAGS` and `FORBIDDEN_ATTRIBUTES` (audit, not necessarily change)

---

## Phase D — OWASP filter evasion + mutation XSS + SVG/CSS/data:

**Goal:** Every payload in the four hardest corpus categories
(`owaspFilterEvasion`, `mutationXss`, `svgAttacks`, `cssAttacks`,
`dataUriAttacks`) produces sanitized output that violates none of the 7
`FORBIDDEN_PATTERNS`.

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-041-D-01 | Enable `SAFE_FOR_TEMPLATES: true` in `configurePurify` | TBD | Todo | 0.2 | DOMPurify flag that defeats most template-injection-shaped bypasses |
| T-041-D-02 | Set `USE_PROFILES: { html: true }` (explicit) to reject SVG/MathML profiles outright | TBD | Todo | 0.2 | Belt-and-suspenders with `FORBIDDEN_TAGS` already containing `svg`, `math` |
| T-041-D-03 | Set `ALLOW_ARIA_ATTR: false` and `ALLOW_DATA_ATTR: false` (latter is already in the config; confirm) | TBD | Todo | 0.1 | Reduces aria-* abuse surface |
| T-041-D-04 | Add a CSS-content scan to `POST_SANITIZATION_BAD_PATTERNS`: `/expression\s*\(/i`, `/behavior\s*:/i`, `/-moz-binding/i` | TBD | Todo | 0.3 | Catches IE/Gecko style-channel attacks |
| T-041-D-05 | Confirm `escapeUrl` (`server/security/escape-helpers.ts:50–63`) is the gate for ALL URL attributes (href, src, action, formaction). Audit DOMPurify's allowed URI regex to ensure no scheme leaks past the helper | TBD | Todo | 0.4 | The current `ALLOWED_URI_REGEXP` is built from `allowedUrlSchemes`; verify it correctly rejects `javascript:`, `vbscript:`, `data:text/html`, `file:` |
| T-041-D-06 | Add a mutation-XSS regression check by running the corpus's `mutationXss` array through `sanitizeMarkdown` and asserting `FORBIDDEN_PATTERNS` all return false | TBD | Todo | 0.3 | This is what the test already does; we're just verifying the implementation work above closes it |
| T-041-D-07 | Verify all 10 `escapeHtml — OWASP filter evasion` tests pass | TBD | Todo | 0.2 | |
| T-041-D-08 | Verify all 6 `sanitizeMarkdown — OWASP filter evasion` tests pass | TBD | Todo | 0.2 | |
| T-041-D-09 | Verify all 5+5 mutation XSS tests pass (escapeHtml + sanitizeMarkdown) | TBD | Todo | 0.2 | |
| T-041-D-10 | Verify all 3+3 SVG tests pass | TBD | Todo | 0.2 | |
| T-041-D-11 | Verify all 2+1 CSS tests pass | TBD | Todo | 0.2 | |
| T-041-D-12 | Verify both data: URI tests pass (escapeHtml + sanitizeMarkdown) | TBD | Todo | 0.2 | |
| T-041-D-13 | Confirm the four false-positive-prevention tests still pass | TBD | Todo | 0.2 | Critical regression guardrail |

**Pass target after Phase D: ~30 additional tests (AC-02 remainder,
AC-03, AC-04, AC-05, AC-07, AC-11 remainder, AC-12, AC-13, AC-15, AC-16).**

**File:line targets:**
- `plugins/autonomous-dev-portal/server/security/sanitization-pipeline.ts:configurePurify` (the `setConfig` block, around line 187–203)
- `plugins/autonomous-dev-portal/server/security/sanitization-config.ts:POST_SANITIZATION_BAD_PATTERNS`
- `plugins/autonomous-dev-portal/server/security/escape-helpers.ts:escapeUrl` (audit only)

---

## Phase E — Encoding bypass + remaining edge cases

**Goal:** Every payload in `corpus.encodingBypassAttacks`,
`corpus.markdownSpecific`, and the leftover single-test categories
produces sanitized output free of forbidden patterns. After this phase
all 74 sanitization tests pass.

### Targets

| ID | Task | Owner | Status | Hours | Notes |
|----|------|-------|--------|-------|-------|
| T-041-E-01 | Add HTML-entity normalization to the input pre-pass: decode `&#x...`, `&#...`, and named entities BEFORE passing to marked, then re-encode safe characters after sanitization | TBD | Todo | 0.5 | Catches encoded-byte bypass attempts at the front door instead of relying on post-scan |
| T-041-E-02 | Add a double-decode check: if the post-scan finds a forbidden pattern after a second decoding pass, refuse | TBD | Todo | 0.4 | Defends against attackers who hope the parser will decode `&amp;#x3C;script&amp;#x3E;` into something executable in the DOM |
| T-041-E-03 | Audit markdown-specific tricks: reference-style links (`[x][ref]\n[ref]: javascript:...`), image-as-link (`[![alt](safe)](javascript:...)`), autolinks (`<javascript:...>`), HTML inline anchors | TBD | Todo | 0.4 | Each path should route through `escapeUrl` (already does for direct links); verify the reference-link path uses the same renderer |
| T-041-E-04 | Verify `escapeHtml — encoding bypass` test passes | TBD | Todo | 0.1 | |
| T-041-E-05 | Verify `escapeHtml — data: URI` test passes (if not already in Phase D) | TBD | Todo | 0.1 | |
| T-041-E-06 | Verify `escapeHtml — markdown-specific` test passes | TBD | Todo | 0.1 | |
| T-041-E-07 | Verify `escapeHtml — base` test passes | TBD | Todo | 0.1 | |
| T-041-E-08 | Verify `sanitizeMarkdown — encoding bypass` test passes | TBD | Todo | 0.1 | |
| T-041-E-09 | Final pass: `bun test tests/unit/security-sanitization.test.ts tests/security/xss-payload-tests.spec.ts` reports 0 failures | TBD | Todo | 0.2 | This is the AC for the entire trio |
| T-041-E-10 | Final pass: `bun test tests/routes/request-detail.test.ts tests/integration/request-detail-*.test.ts` reports 0 failures | TBD | Todo | 0.1 | Re-verify Phase A didn't regress |

**Pass target after Phase E: 10 additional tests (AC-06, AC-08, AC-14,
plus any AC-07/AC-15 remainder). All 92 PRD-023 acceptance criteria
satisfied.**

**File:line targets:**
- `plugins/autonomous-dev-portal/server/security/sanitization-pipeline.ts:sanitizeMarkdown` (the entry point — add the pre-pass at the top, post-pass before cache write)
- `plugins/autonomous-dev-portal/server/security/escape-helpers.ts:escapeHtml` (verify behavior on already-encoded input is the expected idempotent re-encode)

---

## Cross-cutting

### Verification gate per PR

Every PR in this plan must:

1. Run the full bun test suite locally and post a before/after diff in
   the PR description (pass count, no new failures).
2. Confirm the four `MarkdownSanitizationPipeline — false-positive
   prevention` tests are still green.
3. Confirm `tests/security/xss-payloads.json` is unchanged in the diff
   (modifying the corpus would invalidate the contract).
4. Manually exercise the live portal with at least one payload from
   the phase's target category and one legitimate-content payload.

### Rollback strategy

Each phase is a single PR. Rollback = revert the merge commit. Phase A
has the smallest diff and the cleanest revert. Later phases touch
shared config values; reverting Phase D after Phase E would re-open
the encoding bypass surface but does not break Phase A's fix.

---

## Follow-ups (out of scope)

| ID | Idea | Why deferred |
|----|------|--------------|
| F-041-01 | Tighten the Content Security Policy (script-src, style-src nonce-only, no `unsafe-inline`) | CSP authoring is its own PRD; orthogonal to sanitizer correctness |
| F-041-02 | Add a `[security]` log channel that records every refusal with payload prefix | Surfacing existing data; UX not hardening |
| F-041-03 | Expand `xss-payloads.json` with new categories (DOM clobbering, prototype pollution, postMessage abuse) | Corpus expansion belongs in a separate PRD after this one ships |
| F-041-04 | Audit the rest of the portal's templates for `return null` branches (generalization of Phase A) | A grep-driven sweep with no specific failing test today; do when a second instance surfaces |
| F-041-05 | Refuse-to-start guardrail when bound to non-loopback without `--public` flag | Operator safety, not sanitization; separate PRD |

---

## References

- **Parent PRD:** PRD-023
- **Parent TDD:** TDD-040
- **Test files:**
  - `plugins/autonomous-dev-portal/tests/unit/security-sanitization.test.ts`
  - `plugins/autonomous-dev-portal/tests/security/xss-payload-tests.spec.ts`
  - `plugins/autonomous-dev-portal/tests/security/xss-payloads.json`
  - `plugins/autonomous-dev-portal/tests/routes/request-detail.test.ts`
  - `plugins/autonomous-dev-portal/tests/integration/request-detail-regions.test.ts`
  - `plugins/autonomous-dev-portal/tests/integration/request-detail-actions.test.ts`
- **Implementation files:**
  - `plugins/autonomous-dev-portal/server/security/sanitization-pipeline.ts`
  - `plugins/autonomous-dev-portal/server/security/sanitization-config.ts`
  - `plugins/autonomous-dev-portal/server/security/escape-helpers.ts`
  - `plugins/autonomous-dev-portal/server/routes/request-detail.ts`
  - `plugins/autonomous-dev-portal/server/templates/views/request-detail/`
- **Related plans:** PLAN-013-2 (server bootstrap), PLAN-014-2 (CSRF/XSS), PLAN-036-3 (request detail)
