# PRD-023: Portal Security Hardening

| Field | Value |
|-------|-------|
| **PRD ID** | PRD-023 |
| **Title** | Portal Security Hardening — sanitization correctness + missing-state route |
| **Version** | 1.0 |
| **Date** | 2026-05-18 |
| **Status** | Proposed |
| **Plugin** | autonomous-dev-portal |

> Surfaced during the 2026-05-17/18 bun-test triage. The portal's existing security pipeline (`server/security/sanitization-pipeline.ts`, SPEC-014-2-03) already exists and is wired in; this PRD is about closing the gap between its **stated contract** (the existing test corpus) and its **actual runtime behavior**.

---

## 1. Problem Statement

A full bun-test run against `plugins/autonomous-dev-portal/` produces two
distinct, real failure clusters that the team had previously written off as
"test drift":

- **74 failing assertions in the sanitization layer** — across
  `tests/unit/security-sanitization.test.ts` and
  `tests/security/xss-payload-tests.spec.ts`. The tests assert specific
  contracts that the code is *supposed* to honor (link hardening, script
  stripping, OWASP filter evasion resistance, mutation XSS, SVG, CSS,
  encoded-byte bypasses, data: URI handling, markdown-specific tricks).
- **18 failing assertions on `GET /repo/:repo/request/:id`** — across
  `tests/routes/request-detail.test.ts`,
  `tests/integration/request-detail-regions.test.ts`,
  `tests/integration/request-detail-actions.test.ts`. The valid-input
  cases (200 with a populated stub) and the malformed-id cases (404) are
  both failing.

Manual reproduction confirmed both clusters are real, not drift:

- `sanitizeMarkdown("[home](https://example.com)")` is documented in the
  renderer (`sanitization-pipeline.ts:88–106`) to emit `target="_blank"`
  and `rel="noopener noreferrer"` on absolute URLs. A direct call returns
  HTML without those attributes — the renderer override is correctly
  written but the marked@5 renderer is not routing through it on every
  build, so DOMPurify sees the default output and the hardening is
  silently dropped.
- `sanitizeMarkdown("<script>alert(1)</script>")` is supposed to be
  stripped to empty body content; the live response retains the literal
  text `alert(` past the sanitizer's post-scan, which means the
  `POST_SANITIZATION_BAD_PATTERNS` net is letting executable substrings
  through in some inputs.
- `curl http://localhost:19280/repo/acme/request/REQ-000001` returns
  **HTTP 500**. The handler in `server/routes/request-detail.ts` reaches
  `renderPage(c, "request-detail", { request, csrfToken })` with a
  partial `request` object, the JSX template at one of the region
  templates returns `null` from a `case` branch, and Hono's JSX
  renderer throws `TypeError: null is not an object (evaluating 'res.isEscaped')`.

### Threat model

The portal binds to `127.0.0.1:19280` by default (`server/lib/config.ts`).
For an external attacker on the network, this is unreachable. The
realistic attack surfaces are:

1. **Local-process malice / dependency compromise.** Anything that can
   already run code as the operator can post markdown into the request
   queue, where it later renders in the portal. A bypass here gets DOM
   access to whatever the operator does in the portal — including
   reading state files, exfiltrating via fetch, or proxying CSRF tokens
   to a second site. Not "remote pre-auth RCE," but real.
2. **Misconfigured public binding.** Operators occasionally rebind to
   `0.0.0.0` (Tailscale, lab access). Once that happens the gap is a
   plain reflected-XSS-via-stored-content surface.
3. **CI / fuzz-corpus drift.** The 74-test corpus is the team's
   declared security contract. Letting it fail indefinitely teaches us
   to ignore failures and erodes the rest of the suite's signal.

We do **not** speculate about CVEs or assign severity scores. This is
internal hardening; the deliverable is "the existing test corpus passes
and the live 500 disappears."

---

## 2. Goals & Non-Goals

### Goals

| ID | Goal |
|----|------|
| G-01 | Every assertion in `tests/unit/security-sanitization.test.ts` passes |
| G-02 | Every assertion in `tests/security/xss-payload-tests.spec.ts` passes against the production sanitizer |
| G-03 | `GET /repo/:repo/request/REQ-000001` returns 200 with a stub-populated body (no 500) |
| G-04 | `GET /repo/:repo/request/REQ-NOTREAL` returns 404 with the not-found template, not 500 |
| G-05 | Legitimate prose / code blocks / tables / well-formed links continue to render unchanged |
| G-06 | The fix is a property of the pipeline, not a per-test special case — no test-specific allowlist entries |

### Non-Goals

- **New sanitizer library.** We stay on marked@5 + DOMPurify@3. Swapping
  is a research project, not a hardening pass.
- **Content Security Policy authoring.** A CSP is already emitted via
  the middleware (SPEC-014-2-04); tightening its directives is its own
  PRD if needed.
- **Authentication / session work.** Out of scope — covered by
  TDD-014.
- **New test cases.** The existing corpus is the contract. We make it
  pass; we don't add to it in this PRD. Follow-up corpus expansion is
  fine in a later PRD.
- **Public-binding deployment guidance.** Operator-facing docs are
  separate. The portal's default-loopback remains the assumed deployment.

---

## 3. User Personas

- **Primary: Operator.** Renders agent-generated markdown (PRDs, TDDs,
  artifacts, diff output) in the portal. Expects content to render the
  way the sanitizer's existing test suite says it will. When a request
  detail page 500s, has no good recovery path other than `cat
  ~/.autonomous-dev/state/...` from a separate terminal.
- **Secondary: Attacker (threat actor).** Local-process or
  misconfigured-public. Inputs reach the portal via the
  request-action ledger, agent artifacts, or user-supplied
  intake. The sanitization pipeline is the only thing between their
  payload and the operator's DOM.
- **Tertiary: Plugin maintainer.** Wants the bun-test suite to mean
  something. Failing assertions in security tests erode the suite's
  signal across the codebase.

---

## 4. Functional Requirements

| ID | Requirement | Source signal |
|----|-------------|---------------|
| FR-023-01 | `renderer.link` output for absolute http(s) URLs MUST contain `target="_blank"` and `rel="noopener noreferrer"` in the final sanitized HTML | "renders well-formed external links with rel/target" test |
| FR-023-02 | `<script>…</script>` tags in raw HTML or in markdown raw-html blocks MUST be removed; the literal substring `alert(` MUST NOT survive to the output | "blocks <script> tag" + 16 event-handler tests |
| FR-023-03 | `on*=` attributes (onerror, onclick, onload, onfocus, onmouseover, etc.) MUST be stripped regardless of tag, case, or whitespace padding around the `=` | 16 escapeHtml event-handler tests + 13 sanitizeMarkdown event-handler tests |
| FR-023-04 | OWASP filter-evasion patterns (mixed case `<ScRiPt>`, padded `< script`, comment-broken `<scr<!---->ipt>`, unicode-encoded tag names) MUST NOT yield executable output | 10 + 6 OWASP filter evasion tests |
| FR-023-05 | mutation-XSS payloads (DOMPurify edge cases where the parser's normalization re-introduces executable structure) MUST be neutralized by the post-sanitization scan | 5 + 5 mutation XSS tests |
| FR-023-06 | SVG-embedded scripts and event handlers (`<svg onload=…>`, `<svg><script>…</script></svg>`) MUST be stripped | 3 + 3 SVG tests |
| FR-023-07 | CSS-channel attacks (`expression(`, `behavior:`, `javascript:` in style) MUST NOT survive sanitization | 2 + 1 CSS tests |
| FR-023-08 | `data:` URIs MUST be rejected for everything except whitelisted image MIME types under `maxDataUrlSize` | 1 + 1 data: tests |
| FR-023-09 | Encoded-byte bypass attempts (HTML entities, hex escapes, double-encoding) MUST normalize to a form the post-scan can reject | 1 + 1 encoding bypass tests |
| FR-023-10 | Markdown-specific tricks (reference-style links to `javascript:`, image-as-link nesting, autolink protocol abuse) MUST not yield executable output | 1 markdown-specific test |
| FR-023-11 | `GET /repo/:repo/request/REQ-NNNNNN` for a path that passes regex validation but has no on-disk state MUST return 404 via the not-found template, not propagate a null-render through the JSX engine | 18 request-detail tests |
| FR-023-12 | Legitimate content (prose mentioning "javascript", code fences containing the word "script", well-formed markdown tables, normal https links) MUST survive sanitization unchanged | 2 legitimate-content tests |

---

## 5. Acceptance Criteria

One row per failing test category. The acceptance criterion is "the
corresponding bun test must pass" — these are existing assertions and we
are working against a known target.

| ID | Category | Test source | Count | Criterion |
|----|----------|-------------|-------|-----------|
| AC-01 | escapeHtml — event handler attacks | xss-payload-tests.spec.ts | 16 | All pass |
| AC-02 | escapeHtml — OWASP filter evasion | xss-payload-tests.spec.ts | 10 | All pass |
| AC-03 | escapeHtml — mutation XSS | xss-payload-tests.spec.ts | 5 | All pass |
| AC-04 | escapeHtml — SVG | xss-payload-tests.spec.ts | 3 | All pass |
| AC-05 | escapeHtml — CSS | xss-payload-tests.spec.ts | 2 | All pass |
| AC-06 | escapeHtml — encoding bypass | xss-payload-tests.spec.ts | 1 | Passes |
| AC-07 | escapeHtml — data: URI | xss-payload-tests.spec.ts | 1 | Passes |
| AC-08 | escapeHtml — markdown-specific | xss-payload-tests.spec.ts | 1 | Passes |
| AC-09 | escapeHtml — base | xss-payload-tests.spec.ts | 1 | Passes |
| AC-10 | sanitizeMarkdown — event handler attacks | xss-payload-tests.spec.ts | 13 | All pass |
| AC-11 | sanitizeMarkdown — OWASP filter evasion | xss-payload-tests.spec.ts | 6 | All pass |
| AC-12 | sanitizeMarkdown — mutation XSS | xss-payload-tests.spec.ts | 5 | All pass |
| AC-13 | sanitizeMarkdown — SVG | xss-payload-tests.spec.ts | 3 | All pass |
| AC-14 | sanitizeMarkdown — encoding bypass | xss-payload-tests.spec.ts | 1 | Passes |
| AC-15 | sanitizeMarkdown — data: URI | xss-payload-tests.spec.ts | 1 | Passes |
| AC-16 | sanitizeMarkdown — CSS | xss-payload-tests.spec.ts | 1 | Passes |
| AC-17 | MarkdownSanitizationPipeline — XSS payloads | security-sanitization.test.ts | 3 | All pass |
| AC-18 | MarkdownSanitizationPipeline — happy path (links) | security-sanitization.test.ts | 1 | Passes |
| AC-19 | Legitimate content survives sanitization | security-sanitization.test.ts | 2 | Both pass |
| AC-20 | Request Detail — populated stub | request-detail-regions.test.ts | 8 | All pass (no 500) |
| AC-21 | Request Detail Actions | request-detail-actions.test.ts | 7 | All pass |
| AC-22 | request-detail — repo slug variants | request-detail.test.ts | 2 | Both pass |
| AC-23 | request-detail — REQ-id format validation | request-detail.test.ts | 1 | Passes |
| AC-24 | Request Detail — region ordering | request-detail-regions.test.ts | 1 | Passes |

**Total: 92 failing assertions → 92 passing.**

---

## 6. Success Metrics

- **Sanitization failure count.** Pre-PRD: 74 in
  `xss-payload-tests.spec.ts` + `security-sanitization.test.ts`.
  Post-PRD: 0.
- **Request-detail 500 rate.** Pre-PRD: 100% of populated-stub
  requests against the live portal return 500. Post-PRD: 0.
- **Manual XSS bypass.** A pre-PRD walk through the xss-payloads.json
  corpus by hand finds executable patterns surviving in
  multiple categories. Post-PRD: no payload in any of the 10 corpus
  categories produces a forbidden pattern (script tag, event handler,
  javascript: URL, expression(), data:text/html) in sanitized output.
- **Regression guardrail.** All four `false-positive-prevention` tests
  (legitimate content) continue to pass — we don't over-sanitize.

---

## 7. Open Questions

| ID | Question | Tentative answer |
|----|----------|------------------|
| Q-023-01 | Do we keep marked+DOMPurify, or switch sanitizer libraries (e.g., sanitize-html, isomorphic-dompurify, rehype-sanitize)? | **Keep.** Library swap is a much bigger change and the existing pipeline's architecture (renderer overrides + DOMPurify allowlist + post-scan) is sound. The failures are configuration / wiring gaps, not library limitations. Reassessed in TDD-040 §2. |
| Q-023-02 | Should the portal also emit a stricter Content-Security-Policy alongside the sanitizer fix? | **Out of scope here.** A CSP is already emitted (SPEC-014-2-04); tightening directives is orthogonal and tracked separately. |
| Q-023-03 | Is the right behavior for missing-state requests a 404 page or a 200 "request not found yet" placeholder (since requests can be ingested before their state file is written)? | **404.** Today the route already returns 404 for unknown IDs; the bug is the 500. Once state-write timing is settled, a 200 "pending" page could be a follow-up. |
| Q-023-04 | Should we add a `[security]` log channel that records every blocked payload for forensics? | **Defer.** The pipeline already populates `result.blocked` and `result.warnings`; surfacing them in `/logs` is a UX-on-top-of-existing-data task, not a hardening one. |
| Q-023-05 | Do we want to enforce that the portal refuse to start when bound to a non-loopback address without a `--public` flag? | **Defer.** Belongs to a config/safety PRD, not this one. |

---

## 8. References

- **Companion docs**
  - TDD-040 — design + module breakdown
  - PLAN-041 — phased task list
- **Failing-test sources**
  - `plugins/autonomous-dev-portal/tests/unit/security-sanitization.test.ts`
  - `plugins/autonomous-dev-portal/tests/security/xss-payload-tests.spec.ts`
  - `plugins/autonomous-dev-portal/tests/security/xss-payloads.json` (corpus)
  - `plugins/autonomous-dev-portal/tests/routes/request-detail.test.ts`
  - `plugins/autonomous-dev-portal/tests/integration/request-detail-regions.test.ts`
  - `plugins/autonomous-dev-portal/tests/integration/request-detail-actions.test.ts`
- **Implementation surface**
  - `plugins/autonomous-dev-portal/server/security/sanitization-pipeline.ts`
  - `plugins/autonomous-dev-portal/server/security/sanitization-config.ts`
  - `plugins/autonomous-dev-portal/server/security/escape-helpers.ts`
  - `plugins/autonomous-dev-portal/server/routes/request-detail.ts`
  - `plugins/autonomous-dev-portal/server/lib/response-utils.ts`
- **Prior PRDs**
  - PRD-009 — Web control plane
  - PRD-018 — Portal visual redesign
  - SPEC-014-2-03 — Sanitization pipeline
  - SPEC-014-2-04 — CSP / nonce
  - SPEC-036-3-01 — Request detail re-skin
