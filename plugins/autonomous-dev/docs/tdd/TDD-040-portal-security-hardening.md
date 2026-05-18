# TDD-040: Portal Security Hardening

| Field | Value |
|-------|-------|
| **TDD ID** | TDD-040 |
| **Parent PRD** | PRD-023 |
| **Date** | 2026-05-18 |
| **Status** | Proposed |

> Companion to PRD-023. This TDD pins the architecture, decision points,
> and risk acceptance for closing the 92 failing assertions in the
> portal's existing security test corpus. Implementation lands in
> separate PRs per PLAN-041.

---

## 1. Architecture Overview

There are two independent code paths to harden. They live in the same
plugin but share nothing at runtime, so they're designed and shipped
separately.

### 1a. Markdown sanitization pipeline

The pipeline already exists at
`server/security/sanitization-pipeline.ts` (SPEC-014-2-03). The
fault is not in its shape, it's in three places where the runtime
contract drifts from the test contract.

```
                       Input markdown (untrusted)
                                │
                                ▼
              ┌─────────────────────────────────────┐
              │ 1. Length guard (maxContentLength)  │
              │ 2. SHA-256 cache lookup (LRU)       │
              └─────────────────────────────────────┘
                                │
                                ▼
              ┌─────────────────────────────────────┐
              │ 3. marked@5 render                  │  ← renderer overrides
              │    • renderer.link   (rel/target)   │     are defined but
              │    • renderer.image (data: gate)    │     NOT invoked for
              │    • renderer.code  (escape body)   │     every call site
              │    • renderer.html  (escape raw)    │     because the Marked
              └─────────────────────────────────────┘     instance is built
                                │                        per pipeline instance
                                ▼                        and the default
              ┌─────────────────────────────────────┐    instance + tests
              │ 4. DOMPurify sanitize               │  ← hooks are registered
              │    • tag / attr allowlist           │     globally on a SHARED
              │    • addHook uponSanitizeAttribute  │     cachedPurify, so a
              │      ╴ strip on*=                   │     second pipeline can
              │      ╴ strip data-*                 │     overwrite the first's
              │      ╴ filter class= tokens         │     hook with `setConfig`
              └─────────────────────────────────────┘     without `removeAllHooks`
                                │                        being a no-op at the
                                ▼                        right time
              ┌─────────────────────────────────────┐
              │ 5. Post-sanitization scan           │  ← POST_SANITIZATION_BAD_
              │    POST_SANITIZATION_BAD_PATTERNS   │     PATTERNS list is the
              │    drop content on match            │     last net — gaps here
              └─────────────────────────────────────┘     are why `alert(`
                                │                        survives certain
                                ▼                        OWASP-evasion inputs
                       Sanitized HTML / refusal
```

### 1b. Request-detail handler

```
   GET /repo/:repo/request/:id
              │
              ▼
   ┌──────────────────────────────────────────┐
   │ request-detail.ts                         │
   │   regex-guard repo + id (404 on miss)     │
   │   loadRequestRecord(repo, id)             │
   │   ├─ tier 1: request-action + state.json  │
   │   ├─ tier 2: request-action only          │
   │   ├─ tier 3: stub (kit-parity)            │
   │   └─ tier 4: null                         │
   │                                           │
   │   if record === null → notFound(c)        │  ← already correct
   │   else → renderPage(c, "request-detail",  │     for the null tier;
   │            { request, csrfToken })        │     the bug is downstream
   └──────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────────────────────────┐
   │ templates/views/request-detail/...        │  ← one of the region
   │   ShellLayout → region-grid → 11 regions  │     templates returns
   │                                           │     `null` from a switch
   │   region templates inspect `request`       │     branch when an
   │   fields and dispatch by `phase` /         │     unexpected phase or
   │   `status` / `currentArtifact.format`     │     status appears in a
   │                                           │     partial record. Hono
   │   any branch that returns `null` rather   │     JSX requires a JSX
   │   than `<></>` triggers Hono's            │     node or string, not
   │   `TypeError: null is not an object       │     `null`.
   │    (evaluating 'res.isEscaped')`          │
   └──────────────────────────────────────────┘
```

The route handler is **already correct**. The fault is in the JSX
templates downstream — they return `null` from at least one branch when
the request record's shape is partial (e.g., `phase_history` empty,
`currentArtifact` missing, `runs` undefined). Tier-2 records (action
present but no state.json) are the most likely trigger because they're
the most field-sparse path through `loadRequestRecord`.

---

## 2. Design Decisions

### D-01: Stay on marked@5 + DOMPurify; write a strict allowlist hardening pass

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **A. Stay on marked + DOMPurify, fix the existing pipeline's wiring + post-scan** | Smallest change; existing test corpus already targets this exact pipeline; team understands the surface; renderer overrides are already authored | Need to be careful about hook lifecycle on the shared `cachedPurify` instance | ✓ **Chosen** |
| B. Replace with `sanitize-html` | One module, fewer moving parts | Loses marked's renderer hooks; can't enforce rel/target at parse time; bigger blast radius | Rejected |
| C. Replace with `rehype-sanitize` (unified pipeline) | Modern AST-based, easier to reason about | Major dependency shift; rewrite of templates that import sanitizeMarkdown; out of proportion to the actual bugs | Rejected |
| D. Hand-rolled regex sanitizer | Zero deps | Universally a bad idea; this is exactly what the OWASP filter-evasion category is designed to defeat | Rejected outright |

### D-02: Link hardening — fix renderer wiring, not post-process the AST

The renderer override at
`sanitization-pipeline.ts:88–106` already emits the right HTML for
absolute URLs. The failure is that DOMPurify's allowlist passes `<a
href>` but its default config strips `target` and `rel` because they
aren't on `flattenAllowedAttrs(...allowedAttributes)` for the `<a>`
tag.

Two ways to fix:

| Option | Mechanism | Decision |
|--------|-----------|----------|
| **A. Extend the `<a>` allowlist in `sanitization-config.ts` to include `target` and `rel`, then add a DOMPurify `uponSanitizeAttribute` hook that *enforces* `rel=noopener noreferrer` and `target=_blank` for any absolute URL after purification** | Single source of truth, idempotent, works whether the renderer fired or not | ✓ **Chosen** |
| B. Post-process the marked output with a string regex before DOMPurify | Cheap but fragile | Rejected |
| C. Trust the renderer override alone | Already what we do; clearly doesn't work | Rejected |

### D-03: Script / event-handler stripping — make the post-scan exhaustive

The `POST_SANITIZATION_BAD_PATTERNS` list is currently narrow. The fix
is to add patterns derived directly from the FORBIDDEN_PATTERNS list in
`xss-payload-tests.spec.ts:35–56` — that test file is the security
contract, so we mirror its patterns into the post-scan and refuse on
match.

We do **not** weaken the upstream stages (renderer + DOMPurify) — the
post-scan is the second net, not the first.

### D-04: Mutation XSS / OWASP filter evasion — rely on the post-scan + DOMPurify SAFE_FOR_TEMPLATES

DOMPurify exposes a `SAFE_FOR_TEMPLATES: true` flag that disables
template-syntax bypasses, and a `FORCE_BODY` flag that prevents
re-parenting tricks. We enable both. For the residual mutation XSS
cases, the post-scan catches what the parser couldn't.

### D-05: SVG / CSS / data: — already allowlisted; the gap is in DOMPurify config

Today `FORBIDDEN_TAGS` includes `svg` but DOMPurify still permits
`<svg>` content when the parent allowlist contains generic tags. The
fix is `USE_PROFILES: { svg: false, svgFilters: false, mathMl: false,
html: true }` plus an explicit `FORBID_CONTENTS` for `svg` and `style`.

### D-06: Encoding bypass — `KEEP_CONTENT: false` for forbidden tags

Currently the pipeline uses `KEEP_CONTENT: true`. That choice means
when DOMPurify strips `<script>alert(1)</script>`, it keeps the
text `alert(1)` as the body. The post-scan then sees `alert(` and
refuses, but only for the markdown pipeline — the escapeHtml path
returns the text. We flip `KEEP_CONTENT` to `false` for forbidden tags
(script, style, iframe, object, embed, svg) while keeping it true for
benign cases where DOMPurify drops a wrapper tag but the inner text is
fine.

### D-07: Missing-state route — render the 404 template

The actual fix will be a few lines in
`server/routes/request-detail.ts` around line 33–36 (the
`request === null` branch is already correct), plus auditing the
region templates under
`server/templates/views/request-detail/` for any branch that returns
`null` rather than `<></>` or a placeholder element. Specifically:

```
  the actual fix will be a small change in
  server/templates/views/request-detail/<one or two region files>.tsx
  to replace `return null;` with `return <></>;` (Fragment).
  We will NOT include the fix in this PR — implementation lands in
  PLAN-041 Phase A.
```

The route handler itself does not need to change.

---

## 3. Failure Modes Table

Mirrors PRD-022 §8 style — known limitations the design accepts.

| Mode | Likelihood | Symptom | Mitigation |
|------|------------|---------|------------|
| DOMPurify hook ordering bug between two pipelines sharing the cached instance | Medium today; the code re-applies config on every sanitize call but the hook is registered globally | Hook from pipeline B silently affects pipeline A | Document the shared-instance contract; add a regression test that constructs two pipelines and asserts independence |
| New marked@5 minor changes renderer override signatures | Medium across minor versions | Some renderer overrides become no-ops; rel/target silently absent | The post-scan + allowlist enforcement (D-02 option A hook) catches the case even if the renderer regresses |
| Operator allows custom HTML schemes in `allowedUrlSchemes` | Low; would be a config change | `escapeUrl` accepts the new scheme | The CSP nonce layer is the second line of defense; sanitizer is not the last word |
| Region template returns `null` from a future branch | Medium during template evolution | Live 500 returns | Add an integration test that loads a tier-2 (sparse) record and asserts 200; PLAN-041 Phase A includes the test alongside the fix |
| Legitimate content false-positive in `POST_SANITIZATION_BAD_PATTERNS` | Low; the four legitimate-content tests guard the boundary | Operator markdown rejected | The four tests are part of AC-19 — they must pass for the PR to ship |
| `KEEP_CONTENT: false` drops text that was actually safe | Low | Operator-authored prose that legitimately mentions `<script>` in body content (e.g., inside a code fence) renders empty | Code fences route through `renderer.code` and escape before DOMPurify sees them; `KEEP_CONTENT: false` is scoped to forbidden TAGS, not to body text |

---

## 4. State Files / Runtime Contracts

This PRD does not introduce new state files. It tightens the
configuration contract on three existing surfaces:

| Surface | Today | Post-PRD |
|---------|-------|----------|
| `DEFAULT_SANITIZATION_CONFIG.allowedAttributes` (in `sanitization-config.ts`) | `<a>` allows `href` only | `<a>` allows `href`, `target`, `rel` (with the post-purify hook enforcing safe values) |
| `configurePurify(...)` flags | `KEEP_CONTENT: true`, no `USE_PROFILES`, no `SAFE_FOR_TEMPLATES` | `KEEP_CONTENT: false` for forbidden TAGS, `USE_PROFILES: { html: true }`, `SAFE_FOR_TEMPLATES: true`, explicit `FORBID_CONTENTS: ["script", "style", "svg"]` |
| `POST_SANITIZATION_BAD_PATTERNS` (in `sanitization-config.ts`) | A short list | Mirrors the 7-entry `FORBIDDEN_PATTERNS` array in `xss-payload-tests.spec.ts:35–56`, plus the `\bjavascript\s*:` and `expression\s*\(` patterns |

The CSP nonce contract (SPEC-014-2-04) is unchanged.

---

## 5. Test Strategy

This is the rare case where the test corpus exists and the
implementation needs to catch up.

- **No new test files.** All 92 failing assertions live in existing
  files and exercise the production surface.
- **Per-phase verification.** Each PLAN-041 phase has a specific
  pass-count target. The PR is mergeable when that phase's tests pass
  AND no previously-passing test regresses.
- **Regression guardrail.** The four "false-positive-prevention" tests
  (`MarkdownSanitizationPipeline — false-positive prevention` describe
  block in `security-sanitization.test.ts`) must continue to pass at
  every phase. If a phase fixes its target tests but breaks a
  legitimate-content test, that phase is rejected.
- **Manual smoke per phase.** A short manual script (curl + expect)
  documented in PLAN-041 runs the live portal against three known-bad
  payloads + one known-good payload after each phase merges.
- **Corpus integrity check.** The `xss-payloads.json` corpus file
  itself is not modified — adding payloads to the corpus to make
  tests pass would defeat the contract. The PR diff for any phase
  must show `tests/security/xss-payloads.json` unchanged.

---

## 6. Risks Accepted

- **DOMPurify upstream regressions.** A future DOMPurify minor could
  change `SAFE_FOR_TEMPLATES` semantics. We pin the major version
  (already done in package.json) and rely on the post-scan as the last
  net.
- **Marked@5 deprecation timeline.** marked@6 changes the renderer
  signature object-shape vs positional args. When we upgrade, the
  `renderer.link` override has to be re-typed. Out of scope here.
- **JSDOM cost.** The JSDOM window allocation (~3MB) is shared across
  the process via `cachedPurify`. Switching `SAFE_FOR_TEMPLATES` does
  not change this cost. No new allocation introduced.
- **No new CSP work.** This PRD does not tighten the CSP. A sufficiently
  determined attacker who finds a sanitizer bypass after this PRD ships
  will succeed against the current CSP. We accept that — the CSP
  hardening is its own PRD when needed.
- **Single fix surface for the 500.** The 500 is symptomatic of a
  pattern (region templates returning `null`); we fix the offending
  branch but do not audit every template. Future regressions of the
  same shape are possible; PLAN-041 Phase A's integration test catches
  the specific case but not the general one.

---

## 7. Architecture Decision Records (mini-ADRs)

- **ADR-040-01:** Allow `target` and `rel` on `<a>` in the allowlist,
  then *enforce* their values via a post-purify hook. Status: accepted.
- **ADR-040-02:** Mirror `xss-payload-tests.spec.ts` `FORBIDDEN_PATTERNS`
  into `POST_SANITIZATION_BAD_PATTERNS`. Status: accepted.
- **ADR-040-03:** Set `KEEP_CONTENT: false` for forbidden tags only,
  scoped via `FORBID_CONTENTS` rather than a global flip. Status:
  accepted.
- **ADR-040-04:** Replace `return null` with `return <></>` in
  request-detail region templates. Status: accepted, target file
  identified during PLAN-041 Phase A scoping.

---

## 8. References

- **Parent PRD:** PRD-023
- **Companion plan:** PLAN-041
- **Implementation surface:**
  - `plugins/autonomous-dev-portal/server/security/sanitization-pipeline.ts`
  - `plugins/autonomous-dev-portal/server/security/sanitization-config.ts`
  - `plugins/autonomous-dev-portal/server/security/escape-helpers.ts`
  - `plugins/autonomous-dev-portal/server/routes/request-detail.ts`
  - `plugins/autonomous-dev-portal/server/templates/views/request-detail/` (region files)
- **Test surface:**
  - `plugins/autonomous-dev-portal/tests/unit/security-sanitization.test.ts`
  - `plugins/autonomous-dev-portal/tests/security/xss-payload-tests.spec.ts`
  - `plugins/autonomous-dev-portal/tests/security/xss-payloads.json`
  - `plugins/autonomous-dev-portal/tests/routes/request-detail.test.ts`
  - `plugins/autonomous-dev-portal/tests/integration/request-detail-regions.test.ts`
  - `plugins/autonomous-dev-portal/tests/integration/request-detail-actions.test.ts`
- **Related specs:**
  - SPEC-014-2-03 — Sanitization pipeline
  - SPEC-014-2-04 — CSP / nonce
  - SPEC-014-2-05 — XSS payload corpus
  - SPEC-036-3-01 — Request detail re-skin
