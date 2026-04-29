# PLAN-021-3: Standards-Aware Author Agents + Meta-Reviewer + Fix-Recipe Schema

## Metadata
- **Parent TDD**: TDD-021-standards-dsl-auto-detection
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: [PLAN-021-1, PLAN-021-2]
- **Priority**: P1

## Objective
Complete the standards subsystem by wiring the resolved standards into the daemon's author agents (prd-author, tdd-author, code-executor) so they read and respect the rules at task start, by adding the `standards-meta-reviewer` governance agent that audits proposed changes to `standards.yaml` for consistency and unworkability, and by defining the `fix-recipe` schema that the rule-set-enforcement-reviewer (PLAN-020-1) emits when standards rules are violated. The fix-recipe schema is the contract that TDD-022 plugin chains will consume to automatically apply fixes.

## Scope
### In Scope
- Standards-aware agent prompt template per TDD §11 at `templates/standards-prompt-section.md`: a markdown section that renders the resolved standards as guidance for the agent. Includes severity-ordered rules with descriptions and a "do this" instruction per rule.
- Prompt-injection helper at `src/standards/prompt-renderer.ts` that takes a `ResolvedStandards` and produces the markdown section. Used by prd-author, tdd-author, code-executor at the start of their session.
- Modifications to `agents/prd-author.md`, `agents/tdd-author.md`, `agents/code-executor.md` to include the standards-prompt section. The rendered section is injected by the daemon before the agent's main prompt; the agents include a directive: "if any rule is unworkable for this task, document the deviation in the artifact's 'Known Limitations' section. Do NOT silently violate."
- `agents/standards-meta-reviewer.md` per TDD §12: model `claude-sonnet-4-6`, tools `Read, Glob, Grep`, system prompt for auditing standards.yaml changes:
  - Detect rule conflicts (two rules requiring opposite things)
  - Detect unworkability (rule requires X but X is unattainable on this stack)
  - Detect impact (would this rule fail on existing code? scan recent commits)
  - Detect overly broad predicates
- Standards-meta-reviewer trigger: PRD-002 review gate fires this reviewer when a PR modifies `standards.yaml` (path-filter triggered)
- Two-person approval requirement for major changes: any change adding `immutable: true` rules or framework requirements requires two human approvers
- `fix-recipe-v1.json` schema at `plugins/autonomous-dev/schemas/fix-recipe-v1.json` per TDD §13: `violation_id`, `rule_id`, `file`, `line`, `fix_type` (code-replacement, file-creation, dependency-add), `before`, `after_template`, `confidence` (0-1), optional `manual_review_required: bool`
- `FixRecipe` TypeScript interface at `src/standards/fix-recipe.ts` matching the schema
- Helper `emitFixRecipe(violation)` at `src/standards/fix-recipe.ts` that the rule-set-enforcement-reviewer (PLAN-020-1) calls when emitting findings; persists recipes to `<state-dir>/fix-recipes/<violation-id>.json` for downstream chain consumers
- Fixture fix-recipes at `tests/fixtures/fix-recipes/` covering code-replacement, file-creation, and dependency-add types
- Unit tests for: prompt-renderer (with various standards inputs), fix-recipe schema validation, standards-meta-reviewer agent definition (frontmatter validity, tool restrictions)
- Integration test: simulate a PR touching `standards.yaml`, verify the meta-reviewer fires and produces a structured verdict; simulate a violation and verify the fix-recipe is persisted with valid schema

### Out of Scope
- Standards artifact schema, inheritance resolver, auto-detection scanner -- delivered by PLAN-021-1
- Built-in evaluator catalog, sandbox, ReDoS defense -- delivered by PLAN-021-2
- The rule-set-enforcement-reviewer agent that emits findings -- delivered by PLAN-020-1 (this plan only defines the fix-recipe schema it emits)
- Plugin chaining infrastructure (`produces`/`consumes`) that consumes fix-recipes -- TDD-022
- Code-fixer plugin that applies recipes -- TDD-022 (first downstream consumer of this plan's schema)
- Two-person approval workflow implementation (UI / CLI) -- separate plan; this plan documents the policy and exposes the trigger condition
- Standards versioning / semver evolution / grandfathering -- TDD-021 §18 open question, deferred

## Tasks

1. **Author standards prompt template** -- Create `templates/standards-prompt-section.md` per TDD §11 with placeholders for rules. The rendered output groups rules by severity (blocking first, then warn, then advisory) and includes a "do this" instruction per rule.
   - Files to create: `plugins/autonomous-dev/templates/standards-prompt-section.md`
   - Acceptance criteria: Template uses `{{rules}}` placeholder. Manual rendering with sample standards produces text matching TDD §11. Template includes the "if any rule is unworkable, document the deviation" directive.
   - Estimated effort: 1.5h

2. **Implement `prompt-renderer`** -- `src/standards/prompt-renderer.ts` with `renderStandardsSection(resolved: ResolvedStandards): string` that takes the resolver output (PLAN-021-1) and produces the markdown section. Sorts by severity, then by rule ID alphabetical. Handles empty rules array (returns "No standards apply.").
   - Files to create: `plugins/autonomous-dev/src/standards/prompt-renderer.ts`
   - Acceptance criteria: With 3 blocking + 2 warn + 1 advisory rules, the output has them in the right order. Empty resolver produces the "No standards apply." text. Unicode rule descriptions render correctly. Unit tests cover empty, single-severity, multi-severity, and unicode cases.
   - Estimated effort: 2h

3. **Modify author agents to inject standards section** -- Update `agents/prd-author.md`, `agents/tdd-author.md`, `agents/code-executor.md` to include a `{{STANDARDS_SECTION}}` placeholder at the start of the system prompt. The daemon's session-spawn helper (PLAN-018-2) replaces the placeholder with the rendered standards before invoking the agent.
   - Files to modify: three agent files in `plugins/autonomous-dev/agents/`
   - Acceptance criteria: Each agent file has the placeholder. The placeholder is replaced at session-spawn time. If no standards apply (empty resolver), the placeholder is replaced with the "No standards apply" text. Tests verify the substitution happens correctly.
   - Estimated effort: 2h

4. **Wire standards loading into session spawn** -- Modify the session-spawn helper from PLAN-018-2 to load the resolved standards (via PLAN-021-1's resolver) at the start of each session and substitute `{{STANDARDS_SECTION}}` in the agent prompt. Cache the resolved standards in the request's state to avoid re-resolution within a session.
   - Files to modify: `plugins/autonomous-dev/bin/spawn-session.sh`, `plugins/autonomous-dev/src/sessions/session-spawner.ts`
   - Acceptance criteria: A session spawned for a feature request reads `<repo>/.autonomous-dev/standards.yaml`, runs the resolver, and substitutes the rendered section. Cache hit on subsequent spawns within the same request. Tests verify substitution and caching.
   - Estimated effort: 3h

5. **Author `standards-meta-reviewer.md`** -- Create the agent definition per TDD §12 with frontmatter (`model: claude-sonnet-4-6`, `tools: Read, Glob, Grep`) and the system prompt covering: detect rule conflicts, detect unworkability, detect impact (scan recent commits), detect overly broad predicates. Output verdict and findings JSON matching `reviewer-finding-v1.json` (PLAN-020-1).
   - Files to create: `plugins/autonomous-dev/agents/standards-meta-reviewer.md`
   - Acceptance criteria: Frontmatter matches TDD §12 verbatim. Prompt covers all four detection categories. Output instruction references `reviewer-finding-v1.json`. The agent is read-only (no Write/Edit/Bash tools).
   - Estimated effort: 2h

6. **Wire meta-reviewer into review gates** -- Add a path-filter trigger so that PRs touching `<repo>/.autonomous-dev/standards.yaml` automatically invoke `standards-meta-reviewer`. The trigger lives in the reviewer-chain config from PLAN-020-2.
   - Files to modify: `plugins/autonomous-dev/config_defaults/reviewer-chains.json`
   - Acceptance criteria: A PR diff containing `standards.yaml` triggers the meta-reviewer. A PR diff without it does not. The meta-reviewer's verdict is part of the gate aggregation. Tests verify the trigger fires on path match.
   - Estimated effort: 1.5h

7. **Implement two-person approval flag for major changes** -- Add detection logic that flags `standards.yaml` changes containing new `immutable: true` rules or modifications to framework requirements. When flagged, the meta-reviewer's verdict includes `requires_two_person_approval: true`, which the gate aggregator (PLAN-020-2) uses to require an additional human approval before the gate passes.
   - Files to modify: `plugins/autonomous-dev/agents/standards-meta-reviewer.md` (prompt instruction), `plugins/autonomous-dev/src/reviewers/aggregator.ts` (PLAN-020-2 — add the flag handling)
   - Acceptance criteria: A PR adding an immutable rule triggers `requires_two_person_approval: true` in the verdict. A PR removing an immutable rule (also a major change) likewise. A PR adding only an advisory rule does not. Aggregator gates the merge until two distinct human approvers have approved the PR.
   - Estimated effort: 3h

8. **Author `fix-recipe-v1.json` schema** -- Create the JSON Schema per TDD §13 with required fields (`violation_id`, `rule_id`, `file`, `line`, `fix_type`, `before`, `after_template`, `confidence`) and optional fields (`manual_review_required`). `fix_type` enum covers `code-replacement`, `file-creation`, `dependency-add`. Confidence is 0-1.
   - Files to create: `plugins/autonomous-dev/schemas/fix-recipe-v1.json`
   - Acceptance criteria: Schema validates the TDD §13 example. Missing `violation_id` fails. Invalid `fix_type` fails. Confidence > 1 fails. Schema includes worked examples for each fix_type.
   - Estimated effort: 2h

9. **Implement `FixRecipe` interface and emitter** -- Create `src/standards/fix-recipe.ts` with `FixRecipe` TypeScript interface and `emitFixRecipe(violation, stateDir)` helper that constructs a recipe and writes it to `<state-dir>/fix-recipes/<violation-id>.json`. Used by the rule-set-enforcement-reviewer (PLAN-020-1).
   - Files to create: `plugins/autonomous-dev/src/standards/fix-recipe.ts`
   - Acceptance criteria: TypeScript compiles. Emitter writes valid JSON validating against the schema. Filename pattern `<state-dir>/fix-recipes/VIO-<timestamp>-<hash>.json`. Tests verify emit + read roundtrip and schema validation.
   - Estimated effort: 2h

10. **Author fixture fix-recipes** -- Create three fixture recipes covering each `fix_type`:
    - `tests/fixtures/fix-recipes/code-replacement-sql.json`: SQL injection fix
    - `tests/fixtures/fix-recipes/file-creation-health.json`: missing /health endpoint
    - `tests/fixtures/fix-recipes/dependency-add-fastapi.json`: missing FastAPI dep
    - Files to create: three JSON files
    - Acceptance criteria: All three validate against `fix-recipe-v1.json`. Each demonstrates the typical shape of its `fix_type`. Documented as the canonical examples in the schema's `examples` field.
    - Estimated effort: 1.5h

11. **Unit tests for renderer, fix-recipe, meta-reviewer agent** -- `tests/standards/test-prompt-renderer.test.ts`, `test-fix-recipe.test.ts`, `test-meta-reviewer-agent.test.ts` covering all paths. Meta-reviewer agent test validates the agent file's frontmatter and prompt structure (not the agent's actual outputs, which require integration testing).
    - Files to create: three test files under `plugins/autonomous-dev/tests/standards/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on `prompt-renderer.ts` and `fix-recipe.ts`. Meta-reviewer agent file's frontmatter passes the agent-meta-reviewer (PLAN-017-2) checklist.
    - Estimated effort: 3h

12. **Integration test: end-to-end standards flow** -- `tests/integration/test-standards-author-flow.test.ts` that simulates: (a) a PR touching `standards.yaml` triggers the meta-reviewer; (b) a feature request session-spawns with the standards section injected; (c) a rule violation produces a fix-recipe.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-standards-author-flow.test.ts`
    - Acceptance criteria: All three scenarios pass deterministically (mocked agent responses for the meta-reviewer). The fix-recipe is persisted to disk with a valid schema. The agent prompt contains the rendered standards section.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `fix-recipe-v1.json` schema and `FixRecipe` interface consumed by TDD-022 plugin chains (the canonical contract for code-fixer plugins).
- `standards-meta-reviewer` agent reused by any future governance scenario where a config change requires structural review.
- `prompt-renderer` reusable by any future agent that wants to inject standards-like guidance.
- Two-person approval flag in reviewer verdicts consumed by PLAN-020-2's aggregator.

**Consumes from other plans:**
- **PLAN-021-1** (blocking): `Rule`, `ResolvedStandards` types, inheritance resolver. Used by `prompt-renderer` and the meta-reviewer.
- **PLAN-021-2** (blocking): evaluator catalog. Used by the rule-set-enforcement-reviewer (PLAN-020-1) when emitting fix-recipes — this plan's emitter is called from there.
- **PLAN-018-2** (existing on main): session-spawn helper that this plan extends with standards substitution.
- **PLAN-020-1** (existing on main): rule-set-enforcement-reviewer that calls `emitFixRecipe()`.
- **PLAN-020-2** (existing on main): reviewer-chain config that this plan extends with the meta-reviewer trigger; aggregator that handles two-person approval flag.
- **PLAN-017-2** (existing on main): agent-meta-reviewer that validates the new `standards-meta-reviewer` agent.

## Testing Strategy

- **Unit tests (task 11):** Renderer with various inputs, fix-recipe schema validation, meta-reviewer agent frontmatter. ≥95% coverage.
- **Integration test (task 12):** End-to-end flow covering all three integration points (meta-reviewer trigger, session spawn substitution, fix-recipe emission).
- **Schema validation:** All fixture fix-recipes validate. The schema's `examples` field is checked against the actual schema (self-test).
- **Agent-meta-reviewer pre-flight:** Before merging this plan's PR, run agent-meta-reviewer (PLAN-017-2) against `standards-meta-reviewer.md` to confirm the read-only tools constraint passes.
- **Manual smoke:** Modify `standards.yaml` in a real test repo, open a PR, verify the meta-reviewer fires and produces a verdict. Then introduce a violation in code, verify the fix-recipe is written.
- **Two-person approval workflow:** Manual end-to-end test simulating a PR adding an immutable rule; verify the gate blocks until two approvers click Approve.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Standards prompt section becomes too long (50+ rules), exceeding agent context budget | Medium | Medium -- agent ignores or truncates | Renderer enforces a 2KB cap on the rendered section. Rules beyond the cap are summarized as "X additional advisory rules apply; see standards.yaml for full list". The cap is configurable via `extensions.standards_prompt_max_bytes`. Documented in the operator guide. |
| Meta-reviewer's "detect impact" step (scan recent commits) is slow on large repos | Medium | Low -- review takes minutes longer | The agent's prompt restricts the scan to the last 50 commits. For larger scans, the reviewer recommends a separate offline analysis. Documented as a known minor edge case. |
| Two-person approval flag is bypassed if the aggregator (PLAN-020-2) doesn't honor it | Low | High -- governance hole | PLAN-020-2's aggregator MUST be updated as part of this plan's task 7. Cross-plan dependency is enforced by the test in task 12 verifying the flag flows correctly. PR review checklist for this plan includes verifying PLAN-020-2's aggregator handles the flag. |
| Fix-recipes accumulate without being applied, filling the state directory | Medium | Low -- disk usage grows | Default retention: 30 days for unapplied recipes (existing cleanup retention from PRD-007). After 30 days, recipes are archived to `<state-dir>/archive/fix-recipes/`. Documented in the operator guide. |
| Agent prompt substitution races with concurrent session spawns from different requests | Low | Low -- wrong standards in agent prompt | Substitution happens per session-spawn; each session has its own template instance. No shared mutable state. Test verifies isolation across two simultaneous spawns. |
| Standards-meta-reviewer false-flags legitimate changes as conflicts (e.g., a rule update is mistaken for a new rule + removal) | Medium | Medium -- false-positive blocks legitimate work | Reviewer's prompt includes "consider rule updates as a single change, not delete+add". Eval cases for the meta-reviewer cover update scenarios. False-positive monitoring (TDD §11 phased rollout) catches drift. |

## Definition of Done

- [ ] Standards prompt template renders correctly for various input shapes (empty, single severity, mixed severities)
- [ ] `prompt-renderer` enforces 2KB cap with summary fallback for excess rules
- [ ] Three author agents (prd-author, tdd-author, code-executor) include the `{{STANDARDS_SECTION}}` placeholder
- [ ] Session-spawn helper substitutes the placeholder with rendered standards before agent invocation
- [ ] Cached resolved standards prevent redundant resolution within a session
- [ ] `standards-meta-reviewer` agent file exists with read-only tools and the four detection categories
- [ ] Reviewer-chain config triggers the meta-reviewer on `standards.yaml` changes
- [ ] Two-person approval flag is set by meta-reviewer for major changes (immutable rules, framework requirements)
- [ ] Aggregator (PLAN-020-2) honors the two-person approval flag
- [ ] `fix-recipe-v1.json` schema validates examples for all three `fix_type` values
- [ ] `emitFixRecipe()` helper persists recipes to `<state-dir>/fix-recipes/<id>.json`
- [ ] Fixture fix-recipes exist for code-replacement, file-creation, dependency-add
- [ ] Unit tests pass with ≥95% coverage on renderer and fix-recipe modules
- [ ] Integration test demonstrates end-to-end flow (meta-review trigger + session-spawn substitution + fix-recipe emission)
- [ ] Agent-meta-reviewer passes for `standards-meta-reviewer.md`
- [ ] No regressions in PLAN-018-2, PLAN-020-1/2, PLAN-021-1/2 functionality
