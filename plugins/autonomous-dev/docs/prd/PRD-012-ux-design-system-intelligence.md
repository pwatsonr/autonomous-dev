# PRD-012: UX & Design-System Intelligence

| Field | Value |
|---|---|
| PRD | PRD-012 |
| Version | v0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Plugin | autonomous-dev |

---

## 1. Problem

Agents building UI today generate "looks-like" markup with no canonical source of truth. Design tokens, component libraries, accessibility rules, voice/tone guidelines, and icon sets drift independently from one another. UIs pass TypeScript compilation while silently changing visual appearance and regressing accessibility conformance. There is no ingestion of existing style guides and no synchronization mechanism to keep generated code aligned with designer intent.

The W3C Design Tokens specification reached stable status in October 2025. Figma Dev Mode MCP is generally available. These milestones mean that agents can now bind to canonical, machine-readable sources of design truth rather than relying on screenshots or tribal knowledge. There is no longer a justification for agents to guess at design intent.

The core failure modes today are:

- Agents hardcode raw hex values, spacing numbers, and font sizes instead of referencing tokens.
- No component registry exists at codegen time, so agents reinvent components already provided by the design system.
- Accessibility violations reach production because no automated gate enforces WCAG 2.2 in CI.
- Brand voice and tone rules are not machine-readable, so generated prose drifts from brand guidelines.
- When a designer renames a token in Figma, code is never updated.
- Visual regressions caused by token changes go undetected until a human notices.

---

## 2. Goals

| ID | Goal | Priority |
|---|---|---|
| G-1 | Ingest existing design guidance from DTCG token files, Figma Variables, DOM style extraction, and screenshot vision | P0 |
| G-2 | Maintain a canonical `design-tokens.json` in W3C DTCG format (2025.10 spec) as the single source of truth | P0 |
| G-3 | Expose tokens, component registry, a11y rules, and voice/tone rules via MCP at codegen time so agents have structured access | P0 |
| G-4 | Enforce visual regression testing (Chromatic or Lost Pixel) in CI to catch token-drift-induced visual changes | P0 |
| G-5 | Enforce accessibility conformance via `@axe-core/playwright` and `jsx-a11y` ESLint with WCAG 2.2 rules | P0 |
| G-6 | Enforce prose and voice compliance via Vale with brand-derived style rules | P1 |
| G-7 | Detect Figma variable drift via webhooks and open automated PRs when upstream tokens change | P1 |
| G-8 | Ship shadcn/ui + Radix + Tailwind v4 as the default component/styling stack, extensible via `ComponentRegistry` interface | P0 |
| G-9 | Generate Storybook stories and MDX documentation for every component in the registry | P1 |
| G-10 | Never hardcode a vendor at the library layer; every external integration SHALL be behind a named interface | P0 |

---

## 3. Non-Goals

| ID | Non-Goal |
|---|---|
| NG-1 | This system is not a general-purpose visual design tool |
| NG-2 | This system SHALL NOT replace Figma or author original visual design |
| NG-3 | This system SHALL NOT make aesthetic design decisions; it enforces and propagates decisions made by designers |
| NG-4 | Content management and CMS integration are out of scope |
| NG-5 | Static-site deployment is out of scope; see PRD-014 |

---

## 4. Personas

| Persona | Description |
|---|---|
| Frontend Agent | An autonomous coding agent generating React/HTML/CSS; primary consumer of the MCP server and component registry |
| Designer | A human working in Figma who publishes variables and component definitions; the authoritative source for token values |
| Accessibility Reviewer | A human or automated reviewer verifying WCAG conformance; consumes axe-core CI reports |
| Brand / Content Reviewer | A human reviewing generated prose against voice and tone standards; consumes Vale CI reports |
| Project Owner | Configures which adapters and gates are active per repository; sets warning vs. blocking thresholds |

---

## 5. User Stories

| ID | Story | Priority |
|---|---|---|
| US-01 | As a Frontend Agent, I SHALL query the MCP server for current token values before generating any CSS or style props, so that I never hardcode raw values | P0 |
| US-02 | As a Designer, when I update a Figma Variable, the system SHOULD open an automated PR updating `design-tokens.json` and downstream generated styles within one hour | P1 |
| US-03 | As an Accessibility Reviewer, I SHALL see a per-PR axe-core findings summary with WCAG 2.2 violation counts, impacted components, and suggested remediation | P0 |
| US-04 | As a Brand Reviewer, I SHOULD see a per-PR Vale findings summary listing voice/tone violations with rule names and suggested corrections | P1 |
| US-05 | As a Project Owner, running `autonomous-dev ux ingest <url>` on an existing application SHALL produce a DTCG-format `design-tokens.json` and a component inventory within ten minutes | P0 |
| US-06 | As a Frontend Agent, visual regression SHALL be run in CI and I SHALL be blocked from merging if a story snapshot diverges beyond the configured threshold | P0 |
| US-07 | As a Designer, when I rename a token across a multi-team monorepo, the rename SHALL propagate to all packages that reference the token | P1 |
| US-08 | As a Frontend Agent, offline mode SHALL work without access to the Figma MCP, falling back to the last committed `design-tokens.json` | P1 |
| US-09 | As a Project Owner operating a multi-brand product, I SHALL scope token trees by brand ID so that brand A tokens never bleed into brand B output | P1 |
| US-10 | As a Frontend Agent, an ESLint rule SHALL block me from hardcoding raw hex values, pixel numbers, or font sizes that exist as named tokens | P0 |
| US-11 | As a Developer, TechDocs pages SHALL link to Storybook stories for every component so that documentation and implementation stay co-located | P2 |
| US-12 | As an Accessibility Reviewer, generated UI SHALL pass WCAG 2.2 AA criteria for all critical and serious violations before merge | P0 |
| US-13 | As a Frontend Agent, I SHALL query the component registry before generating a new component and SHOULD use an existing registry component when one satisfies the requirement | P0 |
| US-14 | As a Designer, screenshot-vision ingestion SHOULD extract candidate tokens from a Figma export or design screenshot when no Figma MCP or DTCG file is available | P2 |
| US-15 | As a Project Owner, Vale gate severity SHOULD be configurable per-repository as warn or block | P1 |
| US-16 | As a Frontend Agent, generated icon usage SHALL reference named icons from the configured icon registry rather than inline SVG literals | P1 |
| US-17 | As a Project Owner, the Style Dictionary pipeline SHALL emit CSS custom properties, Tailwind config, iOS Swift tokens, and Android XML from a single `design-tokens.json` | P0 |
| US-18 | As a Developer, contrast ratio SHALL be enforced on all color token pairs used in text-on-background combinations as part of the token validation pipeline | P0 |

---

## 6. Functional Requirements

### 6.1 Token Management (FR-100s)

| ID | Requirement | Priority |
|---|---|---|
| FR-100 | The system SHALL maintain `design-tokens.json` at the repository root (or configured path) in W3C DTCG format per the 2025.10 stable specification | P0 |
| FR-101 | A Style Dictionary pipeline SHALL transform `design-tokens.json` and emit: CSS custom properties, Tailwind v4 config, iOS Swift token file, and Android XML resource file | P0 |
| FR-102 | All token access SHALL go through a `TokenProvider` interface with methods `getToken(id)`, `listTokens(filter)`, `resolveAlias(alias)`, and `validateContrast(fg, bg)` | P0 |
| FR-103 | The system SHALL accept Figma Variables webhooks and write updated values to `design-tokens.json` via an automated PR | P1 |
| FR-104 | `design-tokens.json` SHALL be versioned with a `$version` field following semver; breaking renames SHALL increment the major version | P1 |
| FR-105 | The system SHALL flag any color token pair used together as text-on-background where the WCAG 2.2 contrast ratio falls below 4.5:1 (AA normal text) or 3.0:1 (AA large text) | P0 |

### 6.2 Component Registry (FR-200s)

| ID | Requirement | Priority |
|---|---|---|
| FR-200 | The system SHALL expose a `ComponentRegistry` interface with methods: `getAll()`, `getByName(name)`, `getProps(name)`, `getCodeExample(name, props)` | P0 |
| FR-201 | The system SHALL ship named adapters: `shadcn` (default), `radix`, `material3`, `polaris`, `custom` | P0 |
| FR-202 | Agents SHALL query `ComponentRegistry.getByName()` before generating any new component; if a match exists the agent SHOULD use it | P0 |
| FR-203 | Each registry entry SHALL include: name, description, props schema, usage example, Storybook story path, a11y notes, and associated design tokens | P1 |
| FR-204 | The registry SHOULD support per-package overrides in monorepo workspaces | P2 |

### 6.3 Ingestion (FR-300s)

| ID | Requirement | Priority |
|---|---|---|
| FR-300 | The `ux ingest <url>` command SHALL run a Playwright DOM scraper that clusters computed styles into DTCG candidate tokens, targeting completion within ten minutes for a 100-page application | P0 |
| FR-301 | The ingestion pipeline SHALL support AST extraction from Tailwind config files, SCSS variable declarations, and CSS custom property declarations | P0 |
| FR-302 | The system MAY ingest design intent from screenshots or Figma exports using Claude vision at 2576px resolution; outputs SHALL be flagged as `$source: "vision-inferred"` and require human review before promotion to canonical | P2 |
| FR-303 | The ingestion pipeline SHALL flag low-contrast color pairs and SHOULD propose component abstractions from recurring DOM patterns | P1 |
| FR-304 | Vision-based ingestion results SHALL be cached by image hash to avoid redundant API calls | P2 |

### 6.4 Figma MCP (FR-400s)

| ID | Requirement | Priority |
|---|---|---|
| FR-400 | The system SHALL support an optional `figma-dev-mode` MCP server integration that exposes current Figma Variables and Code Connect component mappings at codegen time | P1 |
| FR-401 | All Figma MCP interactions SHALL be behind a `FigmaProvider` interface; the system SHALL gracefully degrade to local `design-tokens.json` when the Figma MCP is unavailable | P1 |
| FR-402 | The `FigmaProvider` SHALL expose: `getVariables()`, `getCodeConnect(componentId)`, `subscribeWebhook(event)` | P1 |

### 6.5 Visual Regression (FR-500s)

| ID | Requirement | Priority |
|---|---|---|
| FR-500 | All visual regression interactions SHALL go through a `VisualRegressionProvider` interface with methods: `snapshot(story)`, `compare(baseline, current)`, `updateBaseline(story)` | P0 |
| FR-501 | The system SHALL ship named adapters: `chromatic` (remote CI default), `lost-pixel` (local/self-hosted default), `playwright-screenshots` (CI-native fallback) | P0 |
| FR-502 | Visual regression jobs SHALL be integrated with the CI pipeline defined in PRD-010 and SHALL run on every pull request | P0 |
| FR-503 | The system SHALL detect token-drift-induced visual changes by re-running snapshots after any `design-tokens.json` modification | P1 |

### 6.6 Accessibility (FR-600s)

| ID | Requirement | Priority |
|---|---|---|
| FR-600 | The system SHALL run axe-core 4.5 or later with the WCAG 2.2 ruleset against all testable pages and components | P0 |
| FR-601 | An `@axe-core/playwright` CI job SHALL run on every pull request and report findings grouped by impact level | P0 |
| FR-602 | `jsx-a11y` ESLint plugin SHALL be enabled with the recommended ruleset for all JSX/TSX files | P0 |
| FR-603 | Merging a pull request SHALL be blocked when axe-core reports any finding at critical or serious impact level | P0 |
| FR-604 | Contrast ratio validation from FR-105 SHALL run as a blocking step in the token validation pipeline | P0 |

### 6.7 Voice and Tone (FR-700s)

| ID | Requirement | Priority |
|---|---|---|
| FR-700 | The system SHALL run Vale linter with a brand-derived style guide generated from the repository's `BRAND.md` file | P1 |
| FR-701 | Vale gate severity SHALL be configurable per-repository as `warn` (non-blocking) or `block` (merge-blocking); default is `warn` | P1 |
| FR-702 | The system SHALL ship a reference Vale ruleset modeled on the Mailchimp Content Style Guide as a starting point | P2 |
| FR-703 | The system SHALL maintain an icon registry supporting: Lucide (default), Phosphor, Heroicons, and Tabler; agents SHALL reference icons by name from the active registry | P1 |

### 6.8 MCP Server (FR-800s)

| ID | Requirement | Priority |
|---|---|---|
| FR-800 | The MCP server SHALL expose the following tools: `get_design_tokens(filter?)`, `get_component(name)`, `list_components()`, `get_a11y_rules()`, `get_voice_rules()`, `check_design_token_usage(code)` | P0 |
| FR-801 | The MCP server SHALL auto-register with Claude Code via the standard MCP registration protocol defined in PRD-001 | P0 |
| FR-802 | All MCP tool responses SHALL be returned within 200ms at p95 under normal operating conditions | P0 |
| FR-803 | The `check_design_token_usage(code)` tool SHALL return a list of hardcoded values found in the provided code snippet along with the canonical token name that should be used instead | P0 |

### 6.9 CLI (FR-900s)

| ID | Requirement | Priority |
|---|---|---|
| FR-900 | `autonomous-dev ux ingest <url>` SHALL scrape a running application and produce a DTCG `design-tokens.json` and component inventory | P0 |
| FR-901 | `autonomous-dev ux ingest --figma <file-id>` SHALL pull variables from a Figma file via the Figma MCP or REST API | P1 |
| FR-902 | `autonomous-dev ux sync` SHALL pull the latest Figma Variables and open a PR if `design-tokens.json` would change | P1 |
| FR-903 | `autonomous-dev ux check <path>` SHALL run axe-core, Vale, and token-usage linting against the specified path and print a findings summary | P0 |

### 6.10 Reporting (FR-1000s)

| ID | Requirement | Priority |
|---|---|---|
| FR-1000 | The CI pipeline SHALL post a per-PR UX summary comment containing: token diff table, axe-core findings by impact, visual diff thumbnails, and Vale findings by rule | P1 |
| FR-1001 | The summary comment format SHALL be defined in an interface so that different comment backends (GitHub, GitLab, Bitbucket) can be supported | P2 |

---

## 7. Non-Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| NFR-01 | DOM ingestion SHALL complete within ten minutes for an application with up to one hundred pages | P0 |
| NFR-02 | Visual snapshot capture SHALL complete within thirty seconds per Storybook story | P0 |
| NFR-03 | axe-core page scan SHALL complete within two seconds per page | P0 |
| NFR-04 | MCP server tool responses SHALL be returned at p95 under 200ms | P0 |
| NFR-05 | DTCG output SHALL conform to the 2025.10 stable W3C specification | P0 |
| NFR-06 | The system SHALL operate in offline mode using only local Vale, axe-core, and the last committed `design-tokens.json` when external services are unavailable | P1 |
| NFR-07 | All CLI commands and CI jobs SHALL run on macOS and Linux without platform-specific workarounds | P0 |
| NFR-08 | Token overrides SHALL be supported at the per-package level in monorepo workspaces without modifying the root `design-tokens.json` | P1 |
| NFR-09 | No vendor name, URL, or SDK SHALL appear in the library layer; all integrations SHALL be accessed through named interfaces | P0 |
| NFR-10 | Vision-based ingestion results SHALL be cached by image hash; identical images SHALL NOT trigger repeated API calls | P2 |

---

## 8. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        SOURCES                              │
│  Figma MCP  │  DOM Scraper  │  Vision  │  Existing DTCG    │
└──────┬──────┴──────┬────────┴────┬─────┴────────┬──────────┘
       │             │             │              │
       └─────────────┴─────────────┴──────────────┘
                           │
                   ┌───────▼────────┐
                   │ Canonicalizer  │
                   │ (TokenProvider)│
                   └───────┬────────┘
                           │
                   ┌───────▼────────────┐
                   │ design-tokens.json │
                   │  (W3C DTCG 2025.10)│
                   └───────┬────────────┘
                           │
              ┌────────────▼────────────────┐
              │      Style Dictionary       │
              └──┬──────┬──────┬────────┬───┘
                 │      │      │        │
              CSS vars  TW  iOS SW  Android XML
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
┌───────▼──────┐  ┌────────▼───────┐  ┌──────▼──────┐
│  Component   │  │ A11y Rule Set  │  │ Voice Rules │
│  Registry    │  │ (axe/WCAG 2.2) │  │  (Vale)     │
└───────┬──────┘  └────────┬───────┘  └──────┬──────┘
        │                  │                  │
        └──────────────────▼──────────────────┘
                           │
                   ┌───────▼────────┐
                   │   MCP Server   │
                   │  (FR-800s)     │
                   └───────┬────────┘
                           │
                   ┌───────▼────────┐
                   │ Code-gen Agents│
                   └────────────────┘

CI Pipeline (PRD-010):
  ┌──────────────────────────────────────────┐
  │  Chromatic / Lost Pixel (FR-500s)        │
  │  @axe-core/playwright   (FR-600s)        │
  │  Vale                   (FR-700s)        │
  │  Token usage lint       (FR-803)         │
  │  Per-PR UX summary      (FR-1000)        │
  └──────────────────────────────────────────┘
```

All source adapters implement their respective provider interfaces. The Canonicalizer accepts any provider and writes normalized DTCG. Style Dictionary consumes DTCG and emits platform artifacts. The MCP server composes all data layers and serves agents with structured tool responses.

---

## 9. Testing Strategy

| Layer | Approach |
|---|---|
| TokenProvider adapters | Unit tests per adapter with fixture DTCG files; assert round-trip fidelity |
| ComponentRegistry adapters | Unit tests asserting `getByName`, `getProps`, and `getCodeExample` return correct schema |
| Ingestion pipeline | Fixture-based tests using captured DOM snapshots and CSS files; assert DTCG candidate output |
| Figma MCP adapter | Contract tests against a mock Figma MCP server; test graceful degradation path |
| VisualRegressionProvider | Integration tests with a Storybook fixture; assert snapshot capture and diff detection |
| axe-core integration | A11y regression corpus of known-passing and known-failing HTML; assert zero false negatives on critical/serious |
| Vale integration | Correctness tests against a labeled corpus; assert false-positive rate below fifteen percent |
| MCP server | Integration tests asserting each tool returns valid JSON within 200ms p95 |
| CLI commands | End-to-end tests in a sandboxed temporary directory |

---

## 10. Migration Plan

### Phase 1 — Core Foundation (Weeks 1–3)

Deliverables: DTCG schema loader and validator; Style Dictionary pipeline emitting CSS vars and Tailwind config; shadcn/ui ComponentRegistry adapter; `@axe-core/playwright` CI job; Vale CI job with default ruleset; `TokenProvider` interface; `check_design_token_usage` ESLint rule skeleton.

Exit criteria: `autonomous-dev ux check <path>` runs locally and in CI; axe gate blocks critical/serious findings; DTCG file validates against 2025.10 spec.

### Phase 2 — Ingestion and Visual Regression (Weeks 4–6)

Deliverables: Playwright DOM scraper ingestion; SCSS/CSS/Tailwind AST extraction; Figma MCP `FigmaProvider` adapter; Chromatic and Lost Pixel `VisualRegressionProvider` adapters; `ux ingest <url>` CLI command; MCP server exposing all FR-800s tools; auto-registration with Claude Code.

Exit criteria: `ux ingest` completes on a 100-page app within ten minutes; visual regression runs in CI; MCP server responds within 200ms p95.

### Phase 3 — Automation and Multi-Brand (Weeks 7–9)

Deliverables: Figma webhook listener and automated PR on token changes; per-package token overrides; multi-brand token scoping by brand ID; screenshot-vision ingestion (opt-in); per-PR UX summary comment; iOS and Android Style Dictionary outputs; Storybook story generation.

Exit criteria: Token rename in Figma opens a PR within one hour; multi-brand token trees do not bleed; onboarding an existing application takes under one day.

---

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Figma MCP unavailable or rate-limited | Medium | Medium | Graceful fallback to local `design-tokens.json`; offline mode (NFR-06) |
| R-2 | Visual snapshot flakiness due to animation or font-rendering variance | High | Medium | Configurable pixel-diff threshold; animation suppression in Playwright; per-story opt-out |
| R-3 | Vale false-positive rate exceeds fifteen percent on generated prose | Medium | Low | Allow-list file per repository; default gate is warn not block |
| R-4 | Breaking DTCG spec evolution before 1.0 finalization | Low | High | Pin spec version in `$schema` field; track errata; version DTCG file with semver |
| R-5 | Token rename migrations break downstream packages | Medium | High | CLI migration codemod; semver major bump; deprecation period |
| R-6 | Brand token values leak across packages via shared DTCG | Low | High | Brand-ID scoped token trees; `.aiignore` for brand files |
| R-7 | Vision ingestion API cost exceeds budget | Medium | Low | Image-hash cache (FR-304, NFR-10); opt-in flag; cost dashboard |
| R-8 | axe-core ruleset changes cause false positives after upgrade | Low | Medium | Pin axe-core minor version; upgrade in dedicated PR with corpus re-validation |
| R-9 | Icon license incompatibility when bundling icon registry | Medium | Medium | License audit per registry; default only to MIT-licensed sets (Lucide, Heroicons) |
| R-10 | Agents bypass token lint and hardcode values | Medium | High | ESLint `no-raw-design-values` rule as P0 gate; `check_design_token_usage` MCP tool |
| R-11 | Multi-brand scoping complexity causes configuration errors | Low | Medium | Validated schema for brand config; integration test per brand |

---

## 12. Success Metrics

| Metric | Target | Measurement Method |
|---|---|---|
| WCAG 2.2 critical/serious pass rate | >98% of PRs | axe-core CI report aggregate |
| Visual regression escape rate | <5% of token changes cause undetected visual regressions | Post-release visual incident tracking |
| Vale false-positive rate | <15% of Vale findings are incorrect | Periodic hand-labeled corpus evaluation |
| Token drift incidents | ≤2 per quarter where production tokens diverge from `design-tokens.json` | Token audit job in CI |
| Existing app onboarding time | ≤1 day from `ux ingest` to passing CI | Measured during Phase 2 pilot |
| MCP tool response time | p95 ≤200ms | MCP server observability dashboard |

---

## 13. Open Questions

| ID | Question | Owner | Target Resolution |
|---|---|---|---|
| OQ-1 | Multi-brand token scoping: flat namespace with prefix or nested tree per brand? Impact on Style Dictionary output | Patrick Watson | Week 1 |
| OQ-2 | Component registries: versioned per repository or pulled from a global registry server? | Patrick Watson | Week 2 |
| OQ-3 | Screenshot-vision ingestion: default on with cost cap or explicit opt-in flag? | Patrick Watson | Week 4 |
| OQ-4 | Vale gate: should the default be warn or block? Different defaults for human-authored vs. agent-generated prose? | Patrick Watson | Week 3 |
| OQ-5 | Icon license policy: require MIT only, or allow Apache 2.0 and disclose? | Patrick Watson | Week 2 |

---

## 14. References

### Related PRDs

| PRD | Relationship |
|---|---|
| PRD-001 | Agent framework and MCP registration protocol |
| PRD-002 | Project scaffolding; token files placed at scaffold time |
| PRD-010 | CI/CD pipeline; visual regression and a11y jobs run here |
| PRD-011 | Documentation system; Storybook stories surfaced in TechDocs |
| PRD-013 | API intelligence; design system tokens may include API-driven theme values |
| PRD-017 | Observability; MCP server latency and token-drift metrics exported here |

### External References

| Resource | URL |
|---|---|
| W3C Design Tokens Specification (stable 2025.10) | https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/ |
| DTCG Format specification | https://www.designtokens.org/tr/drafts/format/ |
| Style Dictionary DTCG documentation | https://styledictionary.com/info/dtcg/ |
| Figma MCP Server announcement | https://www.figma.com/blog/introducing-figma-mcp-server/ |
| shadcn/ui CLI v4 changelog | https://ui.shadcn.com/docs/changelog/2026-03-cli-v4 |
| Lost Pixel visual regression | https://www.lost-pixel.com/ |
| axe-core accessibility engine | https://github.com/dequelabs/axe-core |
| Vale prose linter | https://vale.sh |
| Model Context Protocol | https://modelcontextprotocol.io |

---

**END PRD-012**
