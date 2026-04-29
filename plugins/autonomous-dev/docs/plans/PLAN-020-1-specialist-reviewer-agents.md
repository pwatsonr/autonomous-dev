# PLAN-020-1: Specialist Reviewer Agents (QA, UX/UI, Accessibility, Rule-Set Enforcement)

## Metadata
- **Parent TDD**: TDD-020-quality-reviewer-suite
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Author the four specialist reviewer agents that augment the generic PRD-002 reviewers with domain-specific expertise: `qa-edge-case-reviewer`, `ux-ui-reviewer`, `accessibility-reviewer`, and `rule-set-enforcement-reviewer`. This plan ships the agent definition files (with carefully scoped tools and system prompts), the shared `reviewer-finding-v1.json` output schema, and the frontend detection cache that UX/UI and accessibility reviewers share to avoid redundant scanning. Reviewer chain configuration, scheduler orchestration, and score aggregation are handled by PLAN-020-2.

## Scope
### In Scope
- `agents/qa-edge-case-reviewer.md` per TDD §5.1: model `claude-sonnet-4-6`, tools `Read, Glob, Grep`, system prompt covering input validation, boundary conditions, race conditions, error paths, null handling, and resource leaks
- `agents/ux-ui-reviewer.md` per TDD §5.2: same tools, prompt covering information density, color-only signaling, state coverage (loading/empty/error/success), mobile responsiveness, form labels, button labels
- `agents/accessibility-reviewer.md` per TDD §5.3: same tools, prompt covering WCAG 2.2 AA contrast (4.5:1 / 3:1), keyboard accessibility, focus order, ARIA name/role/value, alt text on non-text content
- `agents/rule-set-enforcement-reviewer.md` per TDD §5.4: tools `Read, Glob, Grep, Bash(node *)` (the bash for invoking custom evaluators), prompt that reads `.autonomous-dev/standards.yaml`, evaluates each rule against the change, emits findings tagged with `rule_id`
- Shared `schemas/reviewer-finding-v1.json` per TDD §5.5: `reviewer`, `verdict` (APPROVE/CONCERNS/REQUEST_CHANGES), `score` (0-100), `findings[]` with required `file`, `line`, `severity`, `category`, `title`, `description`, `suggested_fix`, optional `rule_id`
- `FrontendDetection` interface and per-request cache per TDD §5.6: `isFrontendChange`, `detectedFiles[]`, `framework?`, `hasViewportMeta`. Cache keyed by `request_id` so UX and a11y don't re-scan
- `detectFrontendChanges(repoPath, changedFiles)` helper at `src/reviewers/frontend-detection.ts` that runs once per request and populates the cache
- Per-reviewer eval scenarios at `plugins/autonomous-dev-assist/evals/test-cases/{qa,ux,a11y,standards}-reviewer-eval.yaml` per TDD §9: 25 + 20 + 30 + 15 = 90 cases total. Security-critical cases (SQL injection, path traversal, null deref, keyboard trap, missing alt, contrast <3:1, forbidden imports, exposed secrets) must pass at 100%
- Per-reviewer cost and timeout caps registered with the existing budget system (TDD-010): qa $1.50/8min, ux $1.00/5min, a11y $1.25/6min, standards $0.75/4min
- Unit tests for the frontend-detection helper covering: React/Vue/Svelte/Angular framework detection, viewport-meta detection, files outside frontend patterns ignored
- Integration tests: invoke each reviewer against a small fixture diff that contains a known issue from its domain; assert the reviewer produces a finding matching the schema

### Out of Scope
- Reviewer chain config (`reviewer-chains.json`) and per-request-type defaults -- PLAN-020-2
- Reviewer scheduler with concurrent/sequential execution -- PLAN-020-2
- Score aggregator with built-in-minimum rule -- PLAN-020-2
- Eval suite runner / regression gate (TDD-017 / PLAN-017-3 already covers eval execution; this plan adds the test cases)
- Standards DSL itself, custom evaluator sandbox, ReDoS defense -- PLAN-021-* / TDD-021
- Plugin chaining for fix-recipe → code-fixer (NG-03 in TDD-020, deferred to TDD-022)
- WCAG automated tooling (axe-core integration); the reviewer reads the diff and reports against the rubric

## Tasks

1. **Author `reviewer-finding-v1.json` schema** -- Create the shared output schema per TDD §5.5 with required and optional fields, severity enum, and `rule_id` field for the rule-set-enforcement reviewer.
   - Files to create: `plugins/autonomous-dev/schemas/reviewer-finding-v1.json`
   - Acceptance criteria: Schema validates a fixture finding clean. Missing `file` fails. Invalid `severity` (`urgent`) fails. The `rule_id` field is optional (absent for non-rule-driven reviewers).
   - Estimated effort: 1.5h

2. **Author `qa-edge-case-reviewer.md`** -- Create the agent definition with frontmatter (name, description, model, tools) and a system prompt that systematically walks through the six categories from TDD §5.1. Output instruction: "produce JSON matching `schemas/reviewer-finding-v1.json`."
   - Files to create: `plugins/autonomous-dev/agents/qa-edge-case-reviewer.md`
   - Acceptance criteria: Frontmatter matches TDD §5.1 verbatim. Prompt covers all six categories (input validation, boundary, race, error paths, null, resource leaks) with example concerns each. Output instruction references the schema.
   - Estimated effort: 2h

3. **Author `ux-ui-reviewer.md`** -- Create the agent with the prompt covering the six UX categories per TDD §5.2. Tools: `Read, Glob, Grep`. Includes guidance to consult the frontend-detection cache (set by PLAN-020-2's scheduler) before scanning.
   - Files to create: `plugins/autonomous-dev/agents/ux-ui-reviewer.md`
   - Acceptance criteria: Frontmatter has tools restricted to read-only set. Prompt enumerates: density/hierarchy, color-only signals, state coverage, responsiveness, form labels, button labels. Includes "if the diff is non-frontend, return APPROVE with empty findings" instruction (since the scheduler may invoke optimistically).
   - Estimated effort: 2h

4. **Author `accessibility-reviewer.md`** -- Same shape as task 3 but with WCAG 2.2 AA criteria from TDD §5.3 (1.4.3, 2.1, 2.4.3, 4.1.2, 1.1.1). Includes contrast measurement guidance and ARIA correctness checks.
   - Files to create: `plugins/autonomous-dev/agents/accessibility-reviewer.md`
   - Acceptance criteria: Prompt explicitly cites WCAG criterion numbers in each finding's `category`. Includes the same "non-frontend → APPROVE" guard as the UX reviewer. Output schema references shared `reviewer-finding-v1.json`.
   - Estimated effort: 2h

5. **Author `rule-set-enforcement-reviewer.md`** -- Create the agent with tools `Read, Glob, Grep, Bash(node *)`. The Bash tool is restricted to `node` invocations only — used for calling the custom-evaluator subprocess (PLAN-021-2). Prompt: read `.autonomous-dev/standards.yaml`, for each rule whose `applies_to` matches the change, invoke the configured evaluator, and emit a finding (with `rule_id` set) for each violation.
   - Files to create: `plugins/autonomous-dev/agents/rule-set-enforcement-reviewer.md`
   - Acceptance criteria: Tools restricted as documented (no `Bash` wildcard, only `Bash(node *)`). Prompt explicitly requires every finding to set `rule_id`. Includes guidance on handling "evaluator unavailable" gracefully (emit a `low`-severity warning rather than failing the gate).
   - Estimated effort: 2h

6. **Implement `detectFrontendChanges()`** -- Create `src/reviewers/frontend-detection.ts` with the `FrontendDetection` interface and the detection function that scans `changedFiles[]` for paths matching `**/components/**`, `**/views/**`, `**/pages/**`, `*.tsx|*.jsx|*.vue|*.svelte`. Detects framework via `package.json` deps. Per-request cache lives in a `Map<string, FrontendDetection>` exported from the module.
   - Files to create: `plugins/autonomous-dev/src/reviewers/frontend-detection.ts`
   - Acceptance criteria: A diff touching `src/components/Button.tsx` is detected as frontend; framework `react`. A diff touching only `src/services/auth.ts` is not detected. Cache hit returns the same `FrontendDetection` object reference. Cache miss runs the scan once. Tests cover all four frameworks plus vanilla.
   - Estimated effort: 3h

7. **Author 25 qa-reviewer-eval cases** -- Create `plugins/autonomous-dev-assist/evals/test-cases/qa-reviewer-eval.yaml` with 25 scenarios per TDD §9. At least 5 must be security-critical (SQL injection, path traversal, null deref, race condition, error-path leak). Each case has `input` (small code diff), `expected_findings[]` with severity and category, `forbidden_findings[]` (false positives the reviewer should NOT produce).
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/qa-reviewer-eval.yaml`
   - Acceptance criteria: 25 cases total. 5+ security-critical cases tagged `security_critical: true` and required to pass at 100%. Each case is reproducible (input is a complete diff, not a reference to a real file).
   - Estimated effort: 4h

8. **Author 20 ux-reviewer-eval cases** -- Same shape, 20 cases covering UX heuristics. No security-critical cases (per TDD §9 table). Mix of clean cases (no findings expected) and dirty cases (specific findings expected).
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/ux-reviewer-eval.yaml`
   - Acceptance criteria: 20 cases. ~50/50 clean/dirty split. Each dirty case has at least one expected finding with `category` matching one of the six UX heuristics.
   - Estimated effort: 3h

9. **Author 30 a11y-reviewer-eval cases** -- 30 cases covering WCAG criteria. Security-critical at 100%: keyboard trap, missing alt on non-decorative image, contrast ratio <3:1.
   - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/a11y-reviewer-eval.yaml`
   - Acceptance criteria: 30 cases. Security-critical cases tagged. Cases reference WCAG criterion numbers in `category`. Includes positive (compliant) and negative (violation) examples for each major criterion.
   - Estimated effort: 4h

10. **Author 15 standards-reviewer-eval cases** -- 15 cases against fixture `standards.yaml` files. Security-critical: forbidden imports, exposed secrets via standards rules.
    - Files to create: `plugins/autonomous-dev-assist/evals/test-cases/standards-reviewer-eval.yaml`, `tests/fixtures/standards/{small,large}.yaml`
    - Acceptance criteria: 15 cases referencing fixture standards files. 2+ security-critical cases. Each case's expected finding includes `rule_id` matching the fixture rule that should fire.
    - Estimated effort: 3h

11. **Unit tests for frontend detection** -- `tests/reviewers/test-frontend-detection.test.ts` covering: react detection from package.json + .tsx files; vue detection from .vue files; svelte from .svelte; angular from `@angular/core` dep; vanilla (no framework deps). Cache hit/miss semantics.
    - Files to create: `plugins/autonomous-dev/tests/reviewers/test-frontend-detection.test.ts`
    - Acceptance criteria: All five framework cases pass. Cache returns same object on repeat calls. Cache invalidation occurs on `clearCache()`. Coverage ≥95%.
    - Estimated effort: 2h

12. **Integration tests for each reviewer agent** -- `tests/integration/test-{qa,ux,a11y,standards}-reviewer.test.ts` that invokes each agent (mocked Claude responses) against a small fixture diff containing a known issue. Asserts the response validates against `reviewer-finding-v1.json` and contains the expected finding.
    - Files to create: four test files under `plugins/autonomous-dev/tests/integration/`
    - Acceptance criteria: Each test produces a deterministic verdict against the fixture. Schema validation passes. Tests use mocked agent responses (no real API calls in CI).
    - Estimated effort: 4h

## Dependencies & Integration Points

**Exposes to other plans:**
- The four agent definition files referenced by PLAN-020-2 (chain config), PLAN-019-3 (agent-meta-reviewer audits these), and any future plan that registers reviewers via the hook system.
- `reviewer-finding-v1.json` schema reused by any future custom reviewer plugin.
- `FrontendDetection` interface and cache reused by any future frontend-aware reviewer.
- The 90 eval cases consumed by PLAN-017-3's assist-evals workflow (regression baseline).

**Consumes from other plans:**
- TDD-019 / PLAN-019-3: agent-meta-reviewer will audit these reviewer-slot agents on registration. The frontmatter is designed to pass meta-review (read-only tools where possible, restricted Bash in the standards reviewer).
- TDD-021 / PLAN-021-1: `standards.yaml` artifact format consumed by `rule-set-enforcement-reviewer`.
- TDD-021 / PLAN-021-2: custom-evaluator subprocess sandbox invoked by `rule-set-enforcement-reviewer` via `Bash(node *)`.
- TDD-002 / PLAN-002-3: existing review-gate evaluator that will dispatch these reviewers (via PLAN-020-2's scheduler).

## Testing Strategy

- **Unit tests (task 11):** Frontend-detection helper, cache semantics. ≥95% coverage.
- **Integration tests (task 12):** One per reviewer agent against fixture diffs. Mocked Claude responses for determinism.
- **Eval suite (tasks 7-10):** 90 cases across the four reviewers. Run by PLAN-017-3's assist-evals workflow on PR + nightly cron.
- **Schema validation:** Every reviewer's output validates against `reviewer-finding-v1.json` in CI (lint step).
- **Manual smoke:** Run each reviewer against a real PR with a known issue; verify the finding fires.
- **Agent-meta-reviewer pre-flight:** Before merging this plan's PR, run agent-meta-reviewer (PLAN-017-2) against each new agent file to confirm tool restrictions pass the security checklist.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Specialist reviewers produce a high false-positive rate, causing operator fatigue | High | High -- reviewers get muted or removed from chain | TDD §11 phased rollout: ship as advisory only (Phase 1), promote to blocking individually after 80% precision / 70% recall on the 20-PR fixture corpus (Phase 2). Auto-rollback to advisory if false-positive rate exceeds 25% over 30 days (Phase 3 monitoring). |
| `accessibility-reviewer` produces flaky verdicts because contrast ratios depend on rendered pixels (not source code) | High | Medium -- verdict drift between identical inputs | The reviewer flags "potential" contrast issues from CSS color values. Definitive verdict requires automated tooling (axe-core), which is out of scope for this plan. Documented in the agent's prompt: "report likely contrast issues; final verdict requires axe-core in CI." Future plan adds axe-core integration. |
| `rule-set-enforcement-reviewer` calls the custom evaluator with malicious input that escapes the sandbox | Low | Critical -- code execution from a standards rule | The evaluator subprocess is sandboxed by PLAN-021-2 (execFile, ro-fs, no-net, 30s/256MB caps). The reviewer here only invokes the sandboxed wrapper; it cannot bypass the sandbox. PLAN-021-2's tests cover sandbox escape attempts. |
| Frontend-detection cache leaks across requests (cache key collision) | Low | Low -- minor wrong-detection bug | Cache key is `request_id` which is unique per request. Cache is cleared at request completion via the existing lifecycle hooks. Test verifies isolation across two simultaneous requests. |
| Eval suite cases drift from the actual reviewer behavior over time as agent prompts evolve | High | Medium -- baseline pass-rate fluctuates, blocking releases | Eval cases pin the expected finding by `rule_id` or `category` (not exact text). Permissive matching tolerates prompt drift. PLAN-017-3's 5-point regression threshold catches material changes. |
| `Bash(node *)` tool grant on the standards reviewer is too permissive (allows any node script, not just the sandbox wrapper) | Medium | High -- standards reviewer can exfiltrate data | The agent prompt explicitly directs it to invoke ONLY `bin/run-evaluator.js` (the sandbox wrapper from PLAN-021-2). Agent-meta-reviewer audits this constraint and rejects registrations that drift. Future hardening: replace `Bash(node *)` with a dedicated tool per PRD-001 sandbox plan. |

## Definition of Done

- [ ] `reviewer-finding-v1.json` schema exists and validates a fixture finding
- [ ] All four agent files exist with frontmatter matching TDD §5.1-5.4
- [ ] Each agent's tools list is the minimum required (read-only where possible)
- [ ] `detectFrontendChanges()` helper detects all four frameworks plus vanilla
- [ ] Frontend-detection cache returns same object on repeat calls within a request
- [ ] All 90 eval cases exist across the four sub-suites
- [ ] Security-critical eval cases (15+ across all suites) are tagged for 100% pass-rate enforcement
- [ ] Unit tests pass with ≥95% coverage on `frontend-detection.ts`
- [ ] Integration tests pass for each reviewer (mocked responses)
- [ ] Agent-meta-reviewer passes for each new agent (verified manually before merge)
- [ ] Per-reviewer cost and timeout caps are registered with the budget system
- [ ] Documentation: each agent's role and trigger conditions in `docs/operators/reviewer-suite.md`
