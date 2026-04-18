# PRD-025: Documentation Site & ADR Knowledge Base

| Field | Value |
|-------|-------|
| PRD ID | PRD-025 |
| Version | 0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Plugin | autonomous-dev |

## 1. Problem

Agents have amnesia across sessions. Why a decision was made, what alternatives were considered, what constraints apply — lives in heads, PRs, or scattered wikis. No machine-readable ADR trail agents can consult before re-proposing a rejected approach. Generated code repeatedly violates prior decisions. autonomous-dev itself has no user-facing docs site.

Three compounding failure modes drive this PRD:

1. **Decision amnesia.** An agent proposes using RabbitMQ. Six months ago the team evaluated RabbitMQ and rejected it in favour of NATS because of operational overhead. That ADR exists nowhere a machine can find it. The agent wastes a review cycle and erodes trust.
2. **Scattered context.** Architecture decisions live in Notion pages, Slack threads, GitHub PR descriptions, and Confluence spaces simultaneously. No canonical source. Engineers spend time re-litigating the same ground.
3. **No docs surface.** autonomous-dev ships CLIs, scaffolds, agents, and integrations, yet has no built docs site. Onboarding relies entirely on README fragments and tribal knowledge.

This PRD specifies a documentation site system with a machine-readable ADR knowledge base as its structural backbone.

---

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | MkDocs Material docs site per project and for autonomous-dev itself |
| G-2 | ADRs in MADR 4.0 format under `docs/adr/` |
| G-3 | TechDocs-compatible output (Backstage) |
| G-4 | Agents auto-discover ADRs via PRD-011 knowledge graph and MCP |
| G-5 | ADR lifecycle (Proposed / Accepted / Deprecated / Superseded) enforced by tooling |
| G-6 | Agent-authored ADRs on major decisions with human review gate |
| G-7 | Versioned docs (tag-per-release via `mike`) |
| G-8 | Diagram-as-code (Mermaid, D2, Structurizr C4) |
| G-9 | Link-check and spell-check CI gates |
| G-10 | Search — Meilisearch cross-project, native lunr per-project |

---

## 3. Non-Goals

| ID | Non-Goal |
|----|----------|
| NG-1 | Not a CMS — no WYSIWYG editing, no content scheduling |
| NG-2 | Not replacing wiki / Notion / Confluence for general team knowledge |
| NG-3 | Not authoring product marketing or external-facing sales content |
| NG-4 | Not a diagramming tool — diagram-as-code rendered, not drawn |
| NG-5 | Not a public docs host — deployment target is chosen per project |

---

## 4. Personas

| Persona | Description |
|---------|-------------|
| **Agent** | Reads ADRs before proposing approaches; cites ADR IDs in review comments |
| **Engineer** | Authors ADRs; runs `adr new`; merges docs changes with code |
| **Project Owner** | Approves or rejects ADRs; monitors decision coverage metrics |
| **Architect** | Authors C4 diagrams; defines system context; owns supersede chains |
| **External Contributor** | Consults published docs site; cannot author ADRs without PR |

---

## 5. User Stories

| ID | Story | Priority |
|----|-------|----------|
| US-01 | As an agent, I query "async broker decisions" and receive ADR-0042 Accepted so I do not re-propose rejected alternatives | P0 |
| US-02 | As an engineer, I run `adr new "Use NATS for async"` and receive a pre-filled MADR 4.0 template with sequential ID | P0 |
| US-03 | As a project owner, docs site publishes automatically when I push a version tag | P0 |
| US-04 | As a reviewer agent, I block a PR proposing a deprecated pattern and cite the superseding ADR ID | P0 |
| US-05 | As an architect, I write a Structurizr DSL file and C4 diagrams are rendered in CI with no local toolchain | P1 |
| US-06 | As an engineer, I switch the version dropdown from v1.0 to v2.0 and see the correct docs | P1 |
| US-07 | As a CI job, I run link-checker and fail the build on a broken internal reference | P0 |
| US-08 | As an engineer, I type a search query and receive relevant ADRs in under 300 ms | P1 |
| US-09 | As a platform engineer, I navigate to the Backstage catalog entry and click "Docs" to see the TechDocs-rendered site | P1 |
| US-10 | As the ADR lint gate, I block a commit whose frontmatter is missing `status` or `date` | P0 |
| US-11 | As an engineer, I view an ADR and see the full supersede chain rendered as a linked timeline | P1 |
| US-12 | As a reviewer agent, my review findings include `ADR:` citation trailers for every referenced decision | P0 |
| US-13 | As an engineer working offline, Mermaid diagrams render from local assets without CDN calls | P1 |
| US-14 | As a mobile user, the docs site is readable and navigable on a 390 px viewport | P1 |
| US-15 | As a CI job, I run axe on the built site and fail on any WCAG 2.2 AA violation | P1 |
| US-16 | As a code-executor agent, my commits that implement an ADR decision include an `ADR:` git trailer | P1 |
| US-17 | As an engineer running `mkdocs serve`, a single-page edit reloads in under 10 seconds | P1 |
| US-18 | As a docs maintainer, optional MkDocs Insiders features are documented as requiring a sponsor token | P2 |

---

## 6. Functional Requirements

### 6.1 Site Generator (FR-100s)

**FR-100** MkDocs Material is the default site generator, pinned to a specific minor version in `requirements/docs.txt`.

**FR-101** A pluggable `SiteGenerator` interface allows future swap to Docusaurus or Astro Starlight without changing the ADR toolchain.

**FR-102** Both autonomous-dev itself and every project scaffolded by autonomous-dev receive a `docs/` directory and `mkdocs.yml` at scaffold time.

**FR-103** `mkdocs.yml` is generated from a versioned Jinja2 template stored in `plugins/autonomous-dev/templates/docs/mkdocs.yml.j2`, parameterised by project name, repo URL, and optional feature flags.

**FR-104** Theme, palette, fonts, and navigation are pre-configured with sensible defaults; projects may extend but not entirely override the base config without opting out explicitly.

### 6.2 ADR Format (FR-200s)

**FR-200** ADRs are stored at `docs/adr/NNNN-slug.md` using MADR 4.0 format. File names are zero-padded to four digits.

**FR-201** Required frontmatter fields: `status`, `date`, `deciders`, `consulted`, `informed`. Optional: `supersedes`, `superseded-by`, `tags`.

**FR-202** `autonomous-dev adr new "title"` creates a templated file with the next sequential ID, pre-populated frontmatter, and MADR 4.0 section headings.

**FR-203** Sub-commands: `adr list` (table of ID, title, status, date), `adr show <id>` (full render), `adr supersede <old-id> <new-id>` (updates both frontmatter fields and emits a confirmation).

**FR-204** The MADR template includes sections: Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome, Consequences (Good / Bad), Confirmation, Pros and Cons of the Options.

### 6.3 Lifecycle States (FR-300s)

**FR-300** Valid status transitions: `Proposed` → `Accepted` | `Rejected`; `Accepted` → `Deprecated` | `Superseded`; `Rejected` is terminal; `Deprecated` is terminal.

**FR-301** Current status is rendered as a coloured badge in the MkDocs output: Proposed (yellow), Accepted (green), Deprecated (orange), Superseded (grey), Rejected (red).

**FR-302** `adr lint` (also run in CI via `docs.yml`) validates: status is one of the five values, date is ISO-8601, `superseded-by` is set when status is Superseded, `supersedes` on the new ADR matches `superseded-by` on the old ADR.

**FR-303** ADR lint failure is a hard CI gate on the `main` branch; advisory warning on feature branches.

### 6.4 Agent Integration (FR-400s)

**FR-400** ADR files are indexed by the PRD-011 knowledge graph indexer on every `docs/adr/` change. Index fields: id, title, status, date, deciders, tags, full-text body.

**FR-401** MCP server exposes three tools: `list_adrs(status?, tag?, query?)`, `get_adr(id)`, `search_adrs(query, top_k?)`. Results include id, title, status, date, summary (first 500 chars of Decision Outcome section).

**FR-402** Reviewer agents SHALL include at least one `ADR:` citation in their structured review output whenever an ADR is relevant to the change under review. Review pipeline enforces this as a lint rule.

**FR-403** Code-executor agents applying a decision documented in an ADR SHALL append an `ADR: NNNN` git trailer to the commit message. The trailer is a recommendation enforced by post-commit hook documentation, not a hard block.

**FR-404** Before proposing a significant architectural choice, planner agents SHALL call `search_adrs` with the proposed technology or pattern as query and surface any Accepted or Deprecated ADRs in their plan output.

### 6.5 Diagram-as-Code (FR-500s)

**FR-500** Mermaid diagrams are rendered natively via `mkdocs-material`'s built-in Mermaid support with offline-compatible local asset bundle (no CDN call).

**FR-501** D2 diagrams in `docs/diagrams/*.d2` are rendered to SVG during `mkdocs build` via a MkDocs plugin that shells out to the `d2` binary. D2 binary is pinned and downloaded in CI.

**FR-502** Structurizr Lite DSL files in `docs/diagrams/structurizr/` are rendered to C4 Level 1–3 SVGs via `structurizr-cli` in CI. Local preview uses `structurizr-lite` Docker image.

**FR-503** All rendered diagram artefacts are committed to `docs/diagrams/rendered/` on the `gh-pages` branch, not the source branch.

### 6.6 Versioning (FR-600s)

**FR-600** `mike` plugin manages multi-version deployment to the `gh-pages` branch. Each version maps to a directory `/vMAJOR.MINOR/`.

**FR-601** CI workflow step `publish-versioned-docs` triggers on `v*.*.*` tags, runs `mike deploy --push --update-aliases vMAJOR.MINOR latest`.

**FR-602** The `latest` alias always points to the highest stable semver tag. Pre-release tags (`-alpha`, `-beta`, `-rc`) do not update `latest`.

**FR-603** The version switcher is rendered in the MkDocs Material header. Versions are fetched from the `versions.json` file generated by `mike`.

### 6.7 Search (FR-700s)

**FR-700** Default search uses MkDocs Material's built-in lunr.js — fully offline, zero external dependencies, per-project scope.

**FR-701** Optional Meilisearch integration for monorepo or multi-project scope: a `meilisearch` feature flag in `mkdocs.yml` enables a plugin that pushes index documents to a configured Meilisearch instance on each build.

**FR-702** Optional RAG-search plugin wires a Claude API call to the docs site, allowing natural-language Q&A scoped to indexed content. Disabled by default; requires `ANTHROPIC_API_KEY` and explicit opt-in.

### 6.8 CI and Publishing (FR-800s)

**FR-800** `.github/workflows/docs.yml` runs on every PR: `mkdocs build --strict`, `adr lint`, `lychee --verbose`, `cspell lint "docs/**/*.md"`.

**FR-801** On tag push matching `v*.*.*`, workflow publishes to GitHub Pages via `mike deploy`. S3 and GCS targets are supported via `mkdocs-s3-deploy` plugin, configured by environment variables.

**FR-802** Lychee checks all internal and external links. External link failures are reported but do not block merge (rate limits make external checks flaky). Internal link failures are hard blocking.

**FR-803** cspell uses a project-level `.cspell.json` that inherits a shared wordlist from `plugins/autonomous-dev/config/cspell-base.json` and allows per-project overrides.

**FR-804** ADR lint is a hard gate on `main`. Docs build with `--strict` (warnings-as-errors) is a hard gate on `main`.

### 6.9 Backstage TechDocs (FR-900s)

**FR-900** `mkdocs-techdocs-core` plugin is included in `requirements/docs.txt` and enabled in `mkdocs.yml` when `techdocs: true` is set in scaffold config.

**FR-901** `catalog-info.yaml` at project root includes `backstage.io/techdocs-ref: dir:.` pointing at the `docs/` directory and `mkdocs.yml`.

**FR-902** TechDocs CI pipeline renders docs and pushes to the Backstage TechDocs storage bucket (GCS or S3) configured via `TECHDOCS_S3_BUCKET_NAME` environment variable. This is an opt-in feature; default deployment is GitHub Pages.

### 6.10 CLI (FR-1000s)

**FR-1000** `autonomous-dev docs serve` runs `mkdocs serve` with live-reload. `autonomous-dev docs build` runs `mkdocs build --strict`.

**FR-1001** `autonomous-dev adr new <title>` | `adr list` | `adr show <id>` | `adr supersede <old> <new>` | `adr lint` | `adr link-check` | `adr render-c4`.

**FR-1002** All CLI commands respect `--project-dir` to operate on a non-cwd project. Useful in monorepos.

---

## 7. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | Full docs build completes in under 2 minutes for a 500-page site on a standard CI runner (4 vCPU, 8 GB RAM) |
| NFR-02 | Incremental `mkdocs serve` reload for a single changed page completes in under 10 seconds |
| NFR-03 | Lychee link-check for a 500-page site with up to 2000 internal links completes in under 5 minutes |
| NFR-04 | Search p95 response time under 300 ms for lunr (local) and Meilisearch (remote) |
| NFR-05 | Rendered site passes mobile responsive checks at 390 px, 768 px, and 1280 px viewports |
| NFR-06 | Full build is offline-capable — no runtime CDN calls; all assets bundled |
| NFR-07 | Toolchain (mkdocs, adr CLI, d2, lychee, cspell) runs on macOS arm64, macOS x86_64, and Linux x86_64 |
| NFR-08 | Built site passes axe WCAG 2.2 AA automated scan with zero violations |
| NFR-09 | No external CDN URLs in generated HTML when `offline: true` flag is set in mkdocs.yml |
| NFR-10 | MADR frontmatter schema is backward-compatible — adding new optional fields does not break existing ADR lint |

---

## 8. Architecture

```
Source Files
  docs/**/*.md
  docs/adr/NNNN-*.md          ──── PRD-011 indexer ────► Knowledge Graph
  docs/diagrams/*.d2|*.mmd           │
  docs/diagrams/structurizr/*.dsl    │ MCP tools
                                     ▼
                              Agent Search Layer
                              list_adrs / get_adr / search_adrs

MkDocs Build Pipeline
  ├── mkdocs-material (theme + Mermaid)
  ├── mkdocs-techdocs-core (Backstage compat)
  ├── d2 render plugin
  ├── structurizr render plugin
  ├── mike (versioning)
  └── search plugin (lunr | Meilisearch)
       │
       ▼
  Site HTML + assets
       │
  ┌────┴──────────────────────────┐
  │                               │
  ▼                               ▼
GitHub Pages                Backstage TechDocs
  /vMAJOR.MINOR/              storage (S3/GCS)
  /latest/
```

**ADR Lifecycle State Machine**

```
Proposed ──► Accepted ──► Deprecated  (terminal)
    │             │
    │             └──► Superseded  (terminal, links to successor)
    │
    └──► Rejected  (terminal)
```

**Agent Decision Flow (FR-404)**

```
Planner receives task
  │
  ▼
search_adrs(proposed_technology)
  │
  ├── ADR found, status=Accepted   → include in plan context, proceed
  ├── ADR found, status=Deprecated → warn, prefer alternative
  ├── ADR found, status=Superseded → follow superseded-by chain
  └── No ADR found                 → proceed; flag as candidate for new ADR
```

---

## 9. Testing Strategy

| Layer | Test type | Scope |
|-------|-----------|-------|
| ADR lint | Unit | Validate every transition rule; test all five status values; test malformed frontmatter |
| Site build | Snapshot | Build `fixtures/sample-project/docs/`; compare HTML output against committed snapshots; detect regressions |
| Link-check | Integration | Lychee against built site on localhost; assert zero internal 404s |
| Accessibility | E2E | axe-cli on five representative pages; assert zero WCAG 2.2 AA violations |
| Search relevance | Smoke | Ten canned queries against the autonomous-dev docs index; assert expected ADR IDs in top-3 results |
| Versioning | Smoke | `mike deploy v0.1 latest`; assert `/v0.1/` and `/latest/` directories created; assert version switcher JSON |
| TechDocs | Integration | `npx @techdocs/cli generate`; assert no errors; assert `techdocs_metadata.json` present |
| MCP tools | Unit | Mock knowledge graph; assert `list_adrs`, `get_adr`, `search_adrs` return correct shapes |
| Diagram render | Integration | D2 and Structurizr render against fixture DSL files; assert SVG output; assert no binary diff on re-render |
| CLI | Unit + Integration | `adr new`, `adr list`, `adr supersede`, `adr lint` with fixture `docs/adr/` directory |

---

## 10. Migration and Rollout

### Phase 1 — Foundation (Weeks 1–3)

Deliverables: MkDocs Material site generator, ADR CLI (`new`, `list`, `show`, `supersede`, `lint`), MADR 4.0 template, per-project `docs/` scaffold, autonomous-dev own docs site published on first tag, CI docs build gate.

Definition of done: `autonomous-dev adr new` works; `adr lint` runs in CI; autonomous-dev docs site is live on GitHub Pages.

### Phase 2 — Diagrams, Versioning, CI Hardening (Weeks 4–6)

Deliverables: Mermaid offline bundle, D2 render plugin, Structurizr render plugin, `mike` versioning, Lychee link-check gate, cspell gate, ADR status badge rendering, supersede chain timeline view.

Definition of done: C4 diagrams render in CI; version switcher shows two versions; link-check blocks on broken internal references.

### Phase 3 — Agent Integration and Search (Weeks 7–9)

Deliverables: PRD-011 indexer extension for ADR files, MCP tools (`list_adrs`, `get_adr`, `search_adrs`), reviewer-agent ADR citation enforcement, Meilisearch cross-project search, optional RAG plugin, Backstage TechDocs plugin.

Definition of done: Agent demo cites ADR ID in a PR review; Backstage renders the docs site; Meilisearch returns results across two projects.

---

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| R-1 | Docs rot — code changes without corresponding ADR update | High | High | `require-docs-update` PR label enforced by reviewer agent; ADR coverage metric tracked |
| R-2 | Mermaid syntax drift between versions causes render failures | Medium | Low | Pin Mermaid version in offline bundle; snapshot test diagrams |
| R-3 | MkDocs Insiders features are sponsor-gated and block CI for non-sponsors | Low | High | Core path uses only community features; Insiders listed as optional with `insiders:` flag |
| R-4 | ADRs become bureaucratic overhead and engineers skip them | High | High | Keep template short (MADR 4.0 minimal variant); reviewer agent prompts but does not block on missing ADR for small changes |
| R-5 | Versioned docs diverge in content between branches | Medium | Medium | `mike` manages per-tag snapshots; no retroactive edits to published versions |
| R-6 | Backstage TechDocs storage costs in large monorepos | Low | Medium | Opt-in feature; default is GitHub Pages |
| R-7 | Meilisearch index becomes too large in a large monorepo | Low | Medium | Per-project lunr remains the default; Meilisearch is opt-in with index size monitoring |
| R-8 | Lychee false positives on external links cause CI noise | High | Low | External link failures are advisory only; override list for known-flaky URLs |
| R-9 | ADR lifecycle state in frontmatter drifts from actual codebase state | Medium | High | Agents cross-check ADR status during code review; deprecated ADR triggers a warning when related code is modified |
| R-10 | D2 or Structurizr license changes affect distribution | Low | High | License reviewed quarterly; MIT/Apache-compatible verified at PRD approval; fallback to Mermaid-only if needed |

---

## 12. Success Metrics

| Metric | Target | Measurement period |
|--------|--------|--------------------|
| Major architectural decisions with an ADR | >70% | 6 months post-launch |
| Agent reviews that cite at least one ADR ID | ≥30% of reviews touching architecture files | Rolling 30 days |
| Docs site 404 rate | <0.5% of all page requests | Weekly lychee report |
| Time-to-first-docs-deploy for a new scaffolded project | <1 working day | Measured at scaffold |
| Repos with committed `docs/` directory | ≥90% of active repos | 6 months post scaffold adoption |
| Docs build CI time (500-page site) | <2 minutes p95 | CI metrics dashboard |
| ADR lint pass rate on first commit attempt | >80% | Monthly |

---

## 13. Open Questions

| ID | Question | Owner | Due |
|----|----------|-------|-----|
| OQ-1 | MADR 4.0 vs Nygard format vs Y-Statement — which MADR variant as default? Minimal or full? | Architect | Phase 1 kickoff |
| OQ-2 | Who approves ADRs — human-only, agent-panel, or hybrid? What constitutes a quorum? | Project Owner | Phase 1 kickoff |
| OQ-3 | `docs/adr/` vs `.autonomous-dev/adrs/` — should ADRs live in the visible `docs/` tree or the hidden config directory? | Engineering Lead | Phase 1 kickoff |
| OQ-4 | How far should auto-linking between ADRs and code go — file-level, symbol-level, or line-level? | PRD-011 Owner | Phase 3 kickoff |
| OQ-5 | Default publish target — GitHub Pages, a custom domain, or Read the Docs? Per project or centralised? | Platform Team | Phase 2 kickoff |
| OQ-6 | Should docs lint (link-check, spell-check, ADR lint) be a mandatory merge gate or advisory for all branches? | Engineering Lead | Phase 1 kickoff |

---

## 14. References

**Internal PRDs:** PRD-001 (Project Scaffold), PRD-002 (Plugin Architecture), PRD-010 (Agent Orchestration), PRD-011 (Knowledge Graph), PRD-013 (MCP Server), PRD-020 (Platform Plane), PRD-022 (Backstage Integration).

**External References:**

- MkDocs Material: https://squidfunk.github.io/mkdocs-material/
- ADR GitHub Organisation: https://adr.github.io
- MADR 4.0: https://adr.github.io/madr/
- Backstage TechDocs: https://backstage.io/docs/features/techdocs/techdocs-overview
- D2 language: https://d2lang.com
- Structurizr: https://structurizr.com
- Mermaid: https://mermaid-js.github.io
- mike (versioning): https://github.com/jimporter/mike
- Meilisearch: https://www.meilisearch.com
- Lychee link-checker: https://lychee.cli.rs
- cspell: https://cspell.org

---

**END PRD-025**
