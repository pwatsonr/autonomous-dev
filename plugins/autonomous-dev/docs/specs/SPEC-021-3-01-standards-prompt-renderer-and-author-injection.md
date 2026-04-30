# SPEC-021-3-01: Standards Prompt Template, Renderer, and Author-Agent Injection

## Metadata
- **Parent Plan**: PLAN-021-3
- **Tasks Covered**: Task 1 (standards prompt template), Task 2 (`prompt-renderer`), Task 3 (author-agent placeholders), Task 4 (session-spawn substitution)
- **Estimated effort**: 8.5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-3-01-standards-prompt-renderer-and-author-injection.md`

## Description
Deliver the standards-injection pipeline that takes a `ResolvedStandards` (from PLAN-021-1's `InheritanceResolver`) and surfaces it as guidance text inside the prd-author, tdd-author, and code-executor agents at session-spawn time. This spec ships four artifacts: the markdown template that defines the rendered shape (TDD-021 §11), the `renderStandardsSection()` helper that produces the markdown from a `ResolvedStandards` map, the `{{STANDARDS_SECTION}}` placeholder edits to the three author agent files, and the daemon's session-spawn extension that resolves standards once per request and substitutes the placeholder before invoking each agent.

The renderer enforces a 2KB cap (per PLAN-021-3 risk-table mitigation) with a summary fallback that lists "X additional advisory rules apply; see standards.yaml for full list" when the cap is exceeded. The cap is configurable via `extensions.standards_prompt_max_bytes`. Substitution happens per session-spawn with no shared mutable state; the resolved standards are cached on the request's state object so subsequent spawns within the same request reuse the cached value rather than re-running the resolver.

This spec does NOT define the `standards-meta-reviewer` agent (SPEC-021-3-02), the `fix-recipe` schema or emitter (SPEC-021-3-03), or the test files (SPEC-021-3-04). It assumes PLAN-021-1's `Rule`, `ResolvedStandards`, and `loadStandardsFile()` already exist on `main`, and PLAN-018-2's `bin/spawn-session.sh` and `src/sessions/session-spawner.ts` are present.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/templates/standards-prompt-section.md` | Create | Markdown template with `{{rules}}` placeholder; defines rendered shape |
| `plugins/autonomous-dev/src/standards/prompt-renderer.ts` | Create | `renderStandardsSection(resolved, opts?)` exported helper |
| `plugins/autonomous-dev/agents/prd-author.md` | Modify | Insert `{{STANDARDS_SECTION}}` placeholder at start of system prompt |
| `plugins/autonomous-dev/agents/tdd-author.md` | Modify | Insert `{{STANDARDS_SECTION}}` placeholder at start of system prompt |
| `plugins/autonomous-dev/agents/code-executor.md` | Modify | Insert `{{STANDARDS_SECTION}}` placeholder at start of system prompt |
| `plugins/autonomous-dev/bin/spawn-session.sh` | Modify | Resolve standards before invoking the TS spawner; cache key per request |
| `plugins/autonomous-dev/src/sessions/session-spawner.ts` | Modify | Substitute `{{STANDARDS_SECTION}}` in the agent prompt; honor request-scoped cache |

## Implementation Details

### `templates/standards-prompt-section.md`

Single-file markdown template containing the literal `{{rules}}` placeholder. The template body is the canonical wrapping that the renderer fills in. Verbatim contents:

```markdown
## Standards in Effect for This Task

The following rules apply to the work in this session. They are sorted by severity
(blocking first, then warn, then advisory) and within each severity by rule ID.

{{rules}}

**Directive:** if any rule is unworkable for this task, document the deviation
in the artifact's "Known Limitations" section. Do NOT silently violate.
```

Each rule rendered into `{{rules}}` follows this per-rule format (one block per rule, blank line between):

```
### [<severity>] <rule-id>
<description>
**Do this:** <derived "do this" instruction — see derivation below>
```

Derivation of the "Do this" instruction:
- If the rule has an `assertion.kind == "exposes_endpoint"`, render `Do this: ensure the application exposes the <path> endpoint with method <method>.`
- If the rule has `assertion.kind == "framework_match"`, render `Do this: use the <framework> framework for this work.`
- If the rule has `assertion.kind == "uses_pattern"`, render `Do this: use the pattern matching <pattern> in qualifying code.`
- If the rule has `assertion.kind == "excludes_pattern"`, render `Do this: do not introduce code matching <pattern>.`
- If the rule has `assertion.kind == "dependency_present"`, render `Do this: ensure dependency <name> is declared.`
- If the rule has `assertion.kind == "custom_evaluator_args"` or any unknown kind, render `Do this: see standards.yaml rule <rule-id> for the full requirement.`

When the resolver is empty (no rules apply), the renderer returns the literal string `No standards apply.` (with no surrounding template wrapping). Callers compare on equality with this sentinel for empty-set behavior.

### `src/standards/prompt-renderer.ts`

Exported surface:

```typescript
import type { ResolvedStandards } from './resolver';

export interface RenderOptions {
  /** Hard byte cap before summary fallback. Default: 2048. */
  maxBytes?: number;
}

/**
 * Render a ResolvedStandards map into the standards prompt section markdown.
 * - Empty map => "No standards apply." (no template wrapping).
 * - Sorts blocking, then warn, then advisory; within each severity by rule.id alpha-asc.
 * - Enforces maxBytes (default 2048): when the rendered body exceeds the cap, advisory
 *   rules are dropped from the bottom and summarized as
 *   "_X additional advisory rules apply; see standards.yaml for full list._".
 *   If even the blocking+warn rules exceed the cap, the renderer truncates within
 *   advisory after blocking+warn are emitted and prepends the summary; blocking and
 *   warn rules are NEVER dropped (they are always rendered, even past the cap).
 */
export function renderStandardsSection(
  resolved: ResolvedStandards,
  opts?: RenderOptions,
): string;
```

Algorithm:

1. Extract the rules iterable (`resolved.rules.values()` per PLAN-021-1's resolver shape).
2. If empty, return `"No standards apply."` and exit.
3. Sort rules: severity priority `blocking < warn < advisory`, ties broken by ascending `id`.
4. Read the template from `templates/standards-prompt-section.md` (resolved relative to the plugin root via `__dirname`-style lookup; the spec leaves the exact path-resolution helper to follow the existing convention used elsewhere in `src/standards/`).
5. For each rule, render the per-rule block (see derivation table above).
6. Concatenate all blocking blocks, then all warn blocks, then all advisory blocks (each separated by a single blank line). Substitute the result into the template's `{{rules}}` placeholder.
7. Measure the resulting string length in UTF-8 bytes (`Buffer.byteLength(s, 'utf8')`).
8. If under the cap, return as-is.
9. If over the cap and there are advisory rules, drop the lowest-priority advisory rules (alpha-descending within advisory) one at a time, re-render, until under the cap OR no advisory rules remain. Append `_<dropped> additional advisory rules apply; see standards.yaml for full list._` immediately after the last advisory block before the directive.
10. If still over the cap (blocking+warn alone exceed it), return the rendering as-is — blocking/warn are never dropped. The cap is a soft target for advisory only.

Configuration override: callers can pass `opts.maxBytes` to override the 2048 default; the daemon reads `extensions.standards_prompt_max_bytes` from the request config and forwards it.

Unicode handling: rule descriptions and IDs are rendered verbatim; no escaping. UTF-8 byte counting (not char count) handles multi-byte glyphs correctly.

### Author-Agent Placeholder Insertion

Each of the three author agent files MUST be modified so the very first line of the agent's system prompt body (i.e., the first line after the YAML frontmatter delimiter `---`) is the literal placeholder line:

```
{{STANDARDS_SECTION}}
```

followed by a blank line, followed by the existing prompt body. Example excerpt for `prd-author.md`:

```markdown
---
name: prd-author
description: ...
model: claude-sonnet-4-6
tools: [Read, Glob, Grep, Write, Edit]
---

{{STANDARDS_SECTION}}

You are the PRD author for the autonomous-dev workflow...
```

The placeholder MUST appear exactly once per agent file. The renderer's output (or the `"No standards apply."` sentinel) will replace this token in full.

### Session-Spawn Substitution

#### `bin/spawn-session.sh` extension

Before invoking the TypeScript session spawner, the bash entrypoint resolves the request's standards once and writes the rendered section to a per-request scratch file under `<state-dir>/sessions/<request-id>/standards-section.md`. The file is created with mode `0600`. The bash entrypoint:

1. Computes `STANDARDS_FILE="<repo>/.autonomous-dev/standards.yaml"`.
2. If the cache file `<state-dir>/sessions/<request-id>/standards-section.md` already exists for this request, skips re-resolution (cache hit).
3. Otherwise, calls a small TS helper (added under `src/standards/render-cli.ts` as part of this spec) via `node` (or the project's existing TS runner) that loads `STANDARDS_FILE` (PLAN-021-1's `loadStandardsFile`), runs the resolver (PLAN-021-1's `InheritanceResolver`), calls `renderStandardsSection()`, and writes the output to the scratch path.
4. Exports `STANDARDS_SECTION_FILE=<absolute path>` into the env that the TypeScript spawner inherits.

If the standards file does not exist (no `.autonomous-dev/standards.yaml`), the resolver still runs against defaults+org tiers and may produce an empty set. In that case the rendered file contains `"No standards apply."` — never absent, never empty.

#### `src/sessions/session-spawner.ts` extension

Inside the existing spawn function (do not introduce a new entrypoint), before sending the agent prompt to the model:

1. Read the agent prompt body (existing logic from PLAN-018-2).
2. Read `process.env.STANDARDS_SECTION_FILE` to get the per-request rendered section path.
3. Read the file contents synchronously (small file, well under 4KB after cap enforcement).
4. Replace the literal token `{{STANDARDS_SECTION}}` in the agent prompt body with the contents.
5. Assert (post-substitution) that the substituted prompt no longer contains `{{STANDARDS_SECTION}}`. If it does, throw with `Error("standards substitution failed: token still present")`.
6. Proceed with the existing spawn flow.

Concurrency: each session-spawn call reads its own `STANDARDS_SECTION_FILE` path; there is no shared mutable state between spawns, so two concurrent requests for the same repo (different request IDs) write to different scratch paths and do not race.

### `src/standards/render-cli.ts` (small support helper)

A minimal CLI wrapper invoked by `spawn-session.sh`. Surface:

```
node src/standards/render-cli.js <standards-file> <output-path> [--max-bytes N]
```

Behavior: load → resolve → render → write. Exit 0 on success; exit non-zero on resolver/loader errors with stderr explaining which step failed. Never silently produces an empty output file: an empty resolver produces `"No standards apply."`.

## Acceptance Criteria

- [ ] `templates/standards-prompt-section.md` exists, contains exactly one `{{rules}}` token, and includes the "if any rule is unworkable, document the deviation" directive verbatim.
- [ ] `renderStandardsSection()` with an empty `ResolvedStandards` returns the literal string `"No standards apply."` (no template wrapping, no leading/trailing whitespace).
- [ ] With 3 blocking, 2 warn, and 1 advisory rules, the rendered output orders them blocking → warn → advisory and within each severity sorts by `id` ascending; verified by string-position assertions on the rendered markdown.
- [ ] With a single rule of `severity: blocking`, the rendered output contains exactly one `### [blocking]` header.
- [ ] When the rendered body exceeds the 2048-byte cap because of many advisory rules, advisory rules are dropped from the bottom (alpha-descending) and replaced by the literal summary line `_<N> additional advisory rules apply; see standards.yaml for full list._`; blocking and warn rules are never dropped.
- [ ] Passing `opts.maxBytes: 4096` allows more rules to be rendered than the default; verified by comparing output lengths.
- [ ] A rule whose description contains multi-byte UTF-8 (e.g., emoji or CJK characters) renders verbatim and the byte-count check uses `Buffer.byteLength(..., 'utf8')` (not `.length`).
- [ ] Each of `agents/prd-author.md`, `agents/tdd-author.md`, `agents/code-executor.md` contains exactly one `{{STANDARDS_SECTION}}` placeholder, located on a line by itself immediately after the closing YAML frontmatter delimiter.
- [ ] `bin/spawn-session.sh` writes the rendered section to `<state-dir>/sessions/<request-id>/standards-section.md` with mode `0600` and exports `STANDARDS_SECTION_FILE` to the spawner.
- [ ] `bin/spawn-session.sh` skips re-resolution on a cache hit (existing scratch file present for the request); verified by absence of a second invocation of `render-cli` when called twice for the same request ID.
- [ ] `src/sessions/session-spawner.ts` replaces `{{STANDARDS_SECTION}}` with the file contents before invoking the model. After substitution, the prompt MUST NOT contain the token; if it does, the spawner throws.
- [ ] When no `standards.yaml` exists in the repo, the rendered file contains `"No standards apply."` and the agent prompt is substituted with that sentinel rather than left blank.
- [ ] Two concurrent spawns for different request IDs in the same repo each write to their own scratch file; verified by inspecting the scratch directory after the test.

## Dependencies

- **PLAN-021-1** (blocking): `Rule`, `ResolvedStandards`, `InheritanceResolver`, `loadStandardsFile()` from `src/standards/{types,resolver,loader}.ts`. The renderer consumes the resolver output verbatim. The CLI helper consumes the loader.
- **PLAN-018-2** (existing on main): `bin/spawn-session.sh` and `src/sessions/session-spawner.ts`. This spec extends both.
- **No new external libraries**. Existing dependencies (Node `Buffer`, the project's TS runtime, `js-yaml` already present from PLAN-021-1) cover all needs.

## Notes

- The 2KB cap is a soft target for advisory rules only. The TDD-021 §11 design treats blocking and warn as non-negotiable; truncating them silently would amount to the very "silent violation" the directive forbids. If blocking+warn alone exceed the cap, that is a signal the operator authored too many critical rules — surfaced via a follow-up monitoring metric (out of scope for this spec; a TODO comment in the renderer is sufficient).
- Substitution is intentionally per-spawn rather than baked into the agent file at install time: agents are static, but the resolver output depends on per-request state (org+repo+request-overrides). The placeholder/substitute pattern keeps agent files diffable and review-friendly.
- The `STANDARDS_SECTION_FILE` env var (vs. inline string) was chosen over passing the rendered text through the env directly because (a) the rendered section can be up to 4KB and Node `process.env` size limits vary by OS, and (b) a file path is auditable/inspectable after the fact, supporting post-mortem of "what did the agent see?".
- Future extensibility: the renderer's per-rule "Do this" derivation table can be extended without breaking callers; new assertion kinds simply add a row. SPEC-021-3-04's unit tests should include a kind-not-in-table case to ensure the fallback path is covered.
- The `render-cli.ts` helper is intentionally minimal — just glue between bash and TypeScript. The substantive logic lives in `prompt-renderer.ts` and `resolver.ts`. Keeping the CLI thin avoids duplicating tests.
