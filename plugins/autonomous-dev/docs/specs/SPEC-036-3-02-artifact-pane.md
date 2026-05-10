# SPEC-036-3-02: Artifact Pane (v1.1) — Persistent Reading Surface

## Metadata
- **Parent Plan**: PLAN-036-3
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.2 "Artifact pane")
- **Parent PRD**: PRD-018-portal-visual-redesign (R-17)
- **Tasks Covered**: PLAN-036-3 Tasks 1, 2, 3, 5
- **Dependencies**: SPEC-035-2 (primitives — `Chip`)
- **Estimated effort**: 1.25 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement the v1.1 **artifact pane** region: a persistent (NOT modal)
inline reading surface for the current phase's PRD/TDD prose or code
diff. The pane is part of every Request Detail render and surfaces
artifact content without requiring the operator to open a separate
overlay. This SPEC owns the new `RequestArtifact` type, the server-side
markdown renderer, and the diff-tinting logic.

## Acceptance Criteria

1. `RequestArtifact` is added to `server/types/render.ts` with fields:
   `phase: string`, `format: "markdown" | "diff" | "text"`, `content:
   string`, `artifactId?: string`. `RequestDetail.currentArtifact?:
   RequestArtifact` is added (optional, backward-compatible).
2. The fragment renders three branches by `format`:
   - `diff`: `<pre class="artifact-pre artifact-diff">` with per-line
     `<span>` wrappers; lines starting with `+` get `--ok-tint`, `-`
     get `--err-tint`, `@@` get `--info-tint`. All line text is
     HTML-escaped before insertion.
   - `markdown`: `<div class="artifact-prose">` populated from
     `renderMarkdown(content)`.
   - `text`: plain `<pre class="artifact-pre">` (HTML-escaped).
3. When `currentArtifact` is undefined, the pane renders muted text:
   "No artifact available for this phase".
4. Section head shows `Artifact · ${phase.toUpperCase()}` and the
   `artifactId` in `meta-mono dim` to its right.
5. `server/lib/markdown.ts` supports headers (`# ## ###`), paragraphs,
   fenced code blocks (HTML-escaped inside), unordered/ordered lists,
   inline `code`, bold/italic, links. The module header documents the
   trust boundary: artifact content is daemon-authored, the daemon's
   write to disk is the trust boundary, code blocks always escape, and
   prose-level HTML passes through by design.
6. `<script>` injected inside a fenced code block in any of the three
   branches MUST NOT execute (HTML-escaped to `&lt;script&gt;`).
7. Stub fixture `stubs/requests.ts` carries one example each of PRD
   markdown, TDD markdown, and code diff so the pane renders the kit's
   visual variants out of the box.

## Implementation

**Files**
- `server/types/render.ts` — extend with `RequestArtifact` and the
  optional `RequestDetail.currentArtifact`.
- `server/lib/markdown.ts` — lightweight renderer; no external deps.
- `server/templates/fragments/artifact-pane.tsx` — fragment per TDD-036
  §6.2 markup verbatim with the three format branches.
- `server/stubs/requests.ts` — populate `currentArtifact` for the three
  example phases.

**Diff coloring**
Per-line classification is done server-side: split content on `\n`,
inspect the first character per line, emit `<span class="diff-add">` /
`diff-del` / `diff-hunk` / no class. CSS in the design tokens layer
(SPEC-035-2 / TDD-035) maps these classes to the tint variables.

## Tests

- `tests/lib/markdown.test.ts`: header / paragraph / list / code-block /
  link / inline-code coverage; `<script>` inside ``` blocks escapes.
- `tests/fragments/artifact-pane.test.ts`: snapshot per format; undefined
  case shows "No artifact available"; diff lines carry correct classes.
- `tests/security/artifact-xss.test.ts`: `<script>alert(1)</script>` in
  diff content does NOT yield an executable `<script>` tag.

## Verification

- `bun test tests/lib/markdown.test.ts tests/fragments/artifact-pane.test.ts tests/security/artifact-xss.test.ts` passes.
- Visual snapshot covered transitively by SPEC-036-3-01.
