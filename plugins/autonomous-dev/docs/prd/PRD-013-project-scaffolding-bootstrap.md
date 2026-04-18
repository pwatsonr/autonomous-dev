# PRD-013: Project Scaffolding & Bootstrap

| Field | Value |
|-------|-------|
| PRD ID | PRD-013 |
| Version | 0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Plugin | autonomous-dev |

---

## 1. Problem

Starting a new project with autonomous-dev requires hours or days of manual setup. A developer must create a repository, install the plugin, author CLAUDE.md and AGENTS.md, configure CI pipelines, choose a framework, provision tokens, wire observability, and designate a deploy target. Every artifact that PRDs 011 and 012 assume must exist day-one, yet agents operating on a bare repository have none of it.

This friction creates inconsistency across projects, slows onboarding, introduces security gaps (missing Secretlint, no SBOM, no SLSA attestation), and means the autonomous-dev agent cannot operate effectively until a human has done the scaffolding work manually. The result is that the promise of fully autonomous development breaks down at the very first step.

PRD-013 closes this gap by defining a single `autonomous-dev init` command that emits a complete, standards-compliant project scaffold in under five minutes.

---

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | `autonomous-dev init` one-command scaffold that produces a runnable project |
| G-2 | Preset library covering Next.js + shadcn, Vite + React, FastAPI, NestJS, Go-chi, .NET Aspire, Rails modulith, Expo, and Remix |
| G-3 | Emit `AGENTS.md` with a `CLAUDE.md` symlink so agents can orient immediately post-scaffold |
| G-4 | Emit a DTCG 2025.10-conformant `design-tokens.json` |
| G-5 | Emit an OpenTelemetry bootstrap with OTLP exporter and W3C Trace Context propagation |
| G-6 | Emit a `devcontainer.json` that satisfies the Dev Containers specification |
| G-7 | Emit a CloudEvents envelope SDK stub and AsyncAPI 3 schema seed |
| G-8 | Emit an ADR seed document and a MkDocs Material docs site skeleton |
| G-9 | Emit an OpenFeature provider configuration with flagd as the default local provider |
| G-10 | Emit a Backstage `catalog-info.yaml` describing the new service |

---

## 3. Non-Goals

| ID | Non-Goal |
|----|----------|
| NG-1 | PRD-013 is not a framework. It scaffolds into frameworks; it does not replace them. |
| NG-2 | It does not replace `gh repo create`. The `--create-repo` flag delegates to the GitHub CLI. |
| NG-3 | It does not deploy anything. Deployment is covered by PRD-014. |
| NG-4 | It does not operate as a package registry or host preset packages centrally. |
| NG-5 | It does not provide application hosting of any kind. |
| NG-6 | It does not prescribe business-logic architecture beyond the minimum scaffold. |

---

## 4. Personas

**New-Project Author (PM or Engineer).** Initiates a project, may not have deep toolchain knowledge. Needs interactive guidance and sensible defaults. Success looks like a running dev server with no manual steps after `init`.

**Platform Maintainer.** Owns the scaffold templates and preset library. Needs a clear YAML-based contribution model, semver versioning for presets, and CI integration tests that catch preset decay before it reaches users.

**Template Author.** An internal or community contributor adding a new framework preset. Needs a well-documented YAML schema, a template-scaffolder for presets ("scaffolding the scaffolder"), and a validation command.

**Security Reviewer.** Audits every scaffold output for secrets, vulnerable dependency pinning, and compliance artifacts. Needs Secretlint gate, SBOM output, SLSA attestation stub, and a documented review checklist.

---

## 5. User Stories

| ID | Story | Priority |
|----|-------|----------|
| US-01 | As a New-Project Author, running `autonomous-dev init my-app` produces a runnable repo in under 5 minutes so I can start building immediately. | P0 |
| US-02 | As a New-Project Author, I am guided through preset selection interactively so I do not need to know all available options upfront. | P0 |
| US-03 | As a Platform Maintainer, I can pass all wizard answers as CLI flags for scripted, non-interactive execution. | P0 |
| US-04 | As a Security Reviewer, I can audit every scaffold output and find no secrets, a Secretlint pre-commit hook, a CycloneDX SBOM stub, and a SLSA provenance attestation template. | P0 |
| US-05 | As a Template Author, I can add a new preset by writing a single YAML file and running `preset validate`. | P1 |
| US-06 | As a New-Project Author, I can pass `--create-repo` to have the CLI create a GitHub repository, push the initial commit, and apply branch protection rules from PRD-010. | P1 |
| US-07 | As a Platform Maintainer, re-running `init` on an existing directory is idempotent by default and refuses to overwrite without `--force`. | P0 |
| US-08 | As a New-Project Author, I can scaffold a Turborepo monorepo workspace with multiple apps and packages. | P1 |
| US-09 | As a Mobile Engineer, I can select the Expo preset and receive a React Native project with Expo Router. | P1 |
| US-10 | As an Autonomous Agent, I can read `AGENTS.md` immediately after scaffold to understand conventions, agent personas, memory configuration, and workflow rules. | P0 |
| US-11 | As a New-Project Author, the scaffold wires OpenTelemetry automatically so traces and metrics flow to my chosen backend without manual SDK configuration. | P0 |
| US-12 | As a Security Reviewer, I can find a CycloneDX SBOM generation step and a SLSA provenance attestation stub in the CI workflow. | P0 |
| US-13 | As a Platform Maintainer, every new project receives an ADR seed so architecture decisions are recorded from day one. | P1 |
| US-14 | As a New-Project Author, the scaffold includes a MkDocs Material site skeleton so documentation is publishable from the first commit. | P1 |
| US-15 | As a New-Project Author, feature flags are wired via OpenFeature with flagd so I can gate features without choosing a vendor on day one. | P1 |
| US-16 | As a Platform Maintainer, every scaffolded service includes a `catalog-info.yaml` that Backstage can index. | P1 |
| US-17 | As a Security Reviewer, a `.aiignore` file and a Secretlint pre-commit hook are present in every scaffold so sensitive files are never committed or sent to AI tools. | P0 |
| US-18 | As a Backend Engineer, the scaffold includes a CloudEvents envelope SDK stub and an AsyncAPI 3 schema seed so asynchronous event contracts are established from the start. | P1 |

---

## 6. Functional Requirements

### 6.1 Preset System (FR-100s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-100 | The system SHALL define a `PresetProvider` interface specifying the contract for loading, validating, and enumerating presets. | P0 |
| FR-101 | Presets SHALL be declared as YAML documents listing at minimum: `name`, `version`, `language`, `framework`, `styling`, `testing`, `a11y`, `i18n`, `observability`, `feature-flag`, `CI`, `container`, `catalog`, and `ADR` fields. | P0 |
| FR-102 | Built-in presets SHALL live under `plugins/autonomous-dev/templates/presets/` as versioned YAML files. | P0 |
| FR-103 | Phase 1 SHALL ship a minimum of five presets: Next.js + shadcn/ui, Vite + React, FastAPI, NestJS, and Go-chi. | P0 |
| FR-104 | Each preset YAML SHALL declare a `schemaVersion` field and be validated against the published preset JSON Schema on load. | P1 |
| FR-105 | Community presets SHALL be loadable from a directory specified by `AUTONOMOUS_DEV_PRESET_DIR` environment variable. | P1 |

### 6.2 Scaffold Engine (FR-200s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-200 | The scaffold engine SHALL use Handlebars or Mustache templating for all emitted files, with context variables derived from the resolved preset and user inputs. | P0 |
| FR-201 | The engine SHALL execute post-init hooks declared in the preset (e.g., `npm install`, `pip install`, `go mod tidy`) after file emission is complete. | P0 |
| FR-202 | The engine SHALL produce an initial git commit containing all scaffolded files with a standardised commit message. | P0 |
| FR-203 | A `--dry-run` flag SHALL cause the engine to print all files that would be created or modified without writing any file system changes. | P0 |
| FR-204 | The engine SHALL detect an existing `.autonomous-dev-scaffold` marker file and refuse to overwrite without `--force`, logging which files would differ. | P0 |
| FR-205 | The engine SHALL write a `.autonomous-dev-scaffold` manifest recording preset name, preset version, and scaffold timestamp after a successful run. | P0 |
| FR-206 | File writes SHALL be staged atomically: written to a temp directory first, then moved, so a partial failure leaves the target directory unchanged. | P1 |

### 6.3 Required Artifacts (FR-300s)

FR-300: Every scaffold output SHALL include the following files regardless of preset. Omission of any item SHALL cause the integration test suite to fail.

- `AGENTS.md` — minimum 1000 characters, describing agent personas, memory configuration, workflow rules, and tool conventions. A `CLAUDE.md` symbolic link pointing to `AGENTS.md` SHALL be created alongside it.
- `design-tokens.json` — conforming to the DTCG 2025.10 stable specification, with at minimum a colour palette, spacing scale, and typography scale populated from the preset's design system.
- `devcontainer.json` — satisfying the Dev Containers 2024 specification, including the recommended VS Code extensions for the chosen language and framework.
- `.aiignore` — listing patterns for environment files, credentials, private keys, and generated secrets.
- `.editorconfig` — with charset, indent style, indent size, and end-of-line settings appropriate for the chosen language.
- `README.md` — including project name, prerequisites, development server start command, test command, and links to docs.
- `CODEOWNERS` — with a placeholder `@your-team` entry.
- `LICENSE` — MIT by default; overridable via `--license` flag.
- `CHANGELOG.md` — initialised with a `[Unreleased]` section following Keep a Changelog conventions.
- `catalog-info.yaml` — Backstage descriptor with `kind: Component`, metadata populated from scaffold inputs.
- `docs/adr/0001-record-architecture-decisions.md` — MADR 4.0 formatted ADR seed.
- `.github/workflows/ci.yml` — including lint, test, build, SBOM generation (CycloneDX), and SLSA provenance attestation stub steps.
- `SECURITY.md` — with a vulnerability disclosure policy template.
- `docs/runbook.md` — skeleton runbook with section stubs for incident response, rollback, and on-call contacts.

### 6.4 Observability Bootstrap (FR-400s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-400 | The scaffold SHALL wire the OpenTelemetry SDK and an OTLP exporter appropriate to the chosen language. | P0 |
| FR-401 | W3C Trace Context (`traceparent`, `tracestate`) propagation SHALL be enabled by default. | P0 |
| FR-402 | The bootstrap SHALL read `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_ENDPOINT` environment variables, with the service name defaulting to the project name. | P0 |
| FR-403 | Observability backend selection (Grafana Cloud, Honeycomb, Jaeger, etc.) SHALL defer to PRD-021 and SHALL NOT be hardcoded in the scaffold. | P0 |
| FR-404 | The CI workflow SHALL include an OTEL-compatible test reporter step. | P1 |

### 6.5 Feature Flag Bootstrap (FR-500s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-500 | The scaffold SHALL wire the OpenFeature SDK for the chosen language. | P1 |
| FR-501 | The default local provider SHALL be flagd (CNCF), configured via a `flags.json` in the project root. | P1 |
| FR-502 | The `AGENTS.md` and `docs/runbook.md` SHALL include a documented migration path to LaunchDarkly, Unleash, and GrowthBook. | P1 |

### 6.6 Security Bootstrap (FR-600s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-600 | The CI workflow SHALL include a cosign image signing step with a placeholder for the signing key reference. | P0 |
| FR-601 | The CI workflow SHALL include a CycloneDX SBOM generation step that uploads the SBOM as a workflow artifact. | P0 |
| FR-602 | The CI workflow SHALL include a SLSA provenance attestation template step that is compatible with SLSA Build Level 2. | P0 |
| FR-603 | The CI workflow SHALL include a `dependency-review-action` step that blocks PRs introducing known-vulnerable dependencies. | P0 |
| FR-604 | A Secretlint pre-commit hook SHALL be configured via `.secretlintrc.json` and wired into the git hooks manager (lint-staged or Husky). | P0 |

### 6.7 Async/Event Bootstrap (FR-700s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-700 | The scaffold SHALL include a CloudEvents envelope library stub appropriate to the chosen language. | P1 |
| FR-701 | An AsyncAPI 3.0 schema seed SHALL be emitted at `docs/events/asyncapi.yaml` describing a placeholder domain event. | P1 |
| FR-702 | An event publishing SDK stub SHALL be emitted demonstrating how to wrap domain events in the CloudEvents envelope. | P1 |

### 6.8 Docs Bootstrap (FR-800s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-800 | The scaffold SHALL emit a `mkdocs.yml` configured with MkDocs Material theme as the default docs framework. | P1 |
| FR-801 | The `docs/` directory SHALL include `architecture/index.md`, `runbook.md`, `adr/index.md`, and `changelog.md` stubs. | P1 |
| FR-802 | The MkDocs output SHALL be TechDocs-compatible so Backstage can render it without additional configuration. | P1 |

### 6.9 Interactive Wizard (FR-900s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-900 | The interactive wizard SHALL be implemented using `@inquirer/prompts` (Inquirer.js v9+). | P0 |
| FR-901 | A `--non-interactive` flag SHALL skip all prompts; required values not supplied as flags SHALL cause a validation error with a clear message listing missing options. | P0 |
| FR-902 | The wizard SHALL display a summary of all selected options and ask for confirmation before writing any files. | P0 |

### 6.10 CLI Interface (FR-1000s)

FR-1000: The primary command SHALL be:

```
autonomous-dev init [name] [--preset <id>] [--non-interactive] [--dry-run] [--force] [--list-presets] [--license <spdx>] [--create-repo] [--monorepo]
```

FR-1001: The preset management sub-command SHALL be:

```
autonomous-dev preset add <path-or-url>
autonomous-dev preset list
autonomous-dev preset validate <path>
```

### 6.11 GitHub Integration (FR-1100s)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1100 | When `--create-repo` is passed, the CLI SHALL call `gh repo create` with visibility derived from a `--public` / `--private` flag (default: private). | P1 |
| FR-1101 | After repo creation, the CLI SHALL push the initial commit to the default branch. | P1 |
| FR-1102 | The CLI SHALL apply branch protection rules to the default branch per the policy defined in PRD-010. | P1 |

---

## 7. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | The full scaffold, including post-init hooks, SHALL complete within 5 minutes on a machine with a warm package manager cache (p95). |
| NFR-02 | Every preset SHALL be schema-validated on load; a malformed preset SHALL emit a structured error and abort. |
| NFR-03 | Re-running `init` on an already-scaffolded directory without `--force` SHALL be fully idempotent: no files written, no git changes, exit code 0. |
| NFR-04 | The CLI SHALL function without internet access when using built-in presets. All template fixtures SHALL be bundled. |
| NFR-05 | The scaffold engine core SHALL achieve ≥90% unit test line coverage. |
| NFR-06 | Presets SHALL use independent semver versioning decoupled from the autonomous-dev plugin version. |
| NFR-07 | Every built-in preset SHALL have a corresponding integration test that scaffolds and runs the framework's own test suite. |
| NFR-08 | The scaffold engine SHALL run on macOS (arm64, x64) and Linux (x64, arm64). Windows support is not required in Phase 1 and SHALL be documented as such. |
| NFR-09 | No template fixture SHALL contain secrets, API keys, passwords, or private key material. The CI pipeline SHALL run `secretlint` against all fixtures. |
| NFR-10 | The emitted `design-tokens.json` SHALL pass validation against the DTCG 2025.10 JSON Schema. |
| NFR-11 | The emitted `AGENTS.md` SHALL be a minimum of 1000 characters in length. |

---

## 8. Architecture

The scaffold pipeline is a linear, staged process with two optional downstream branches.

```
CLI Entry Point
      │
      ▼
Prompt Wizard / Flag Parser
      │
      ▼
PresetLoader ──────► Preset YAML (plugins/autonomous-dev/templates/presets/)
      │
      ▼
Template Resolver (Handlebars context assembly)
      │
      ▼
ScaffoldEngine
  ├── File Writer (atomic: temp dir → move)
  ├── Post-Init Hook Runner (npm install, go mod tidy, etc.)
  └── Manifest Writer (.autonomous-dev-scaffold)
      │
      ▼
Git Init + Initial Commit
      │
      ├──(--create-repo)──► gh repo create + push + branch protection (PRD-010)
      │
      ▼
Print Next Steps
```

**PresetLoader** reads YAML from the built-in presets directory or `AUTONOMOUS_DEV_PRESET_DIR`, validates against the preset JSON Schema, and returns a typed `Preset` object.

**Template Resolver** assembles the Handlebars context by merging preset metadata with user-supplied inputs (project name, author, license, etc.).

**ScaffoldEngine** iterates the resolved template manifest, renders each file, stages it to a temp directory, and on completion moves all files atomically to the target directory. Post-init hooks run in sequence after file moves. The manifest is written last.

**Git operations** use `simple-git` (Node) or a thin shell wrapper. The initial commit message follows Conventional Commits: `chore: scaffold project with autonomous-dev init`.

---

## 9. Testing Strategy

**Unit tests** cover the PresetLoader (valid/invalid YAML, missing fields), Template Resolver (context assembly, missing variable handling), ScaffoldEngine file writer (atomic write, idempotency detection), and each post-init hook executor.

**Integration tests** scaffold each built-in preset into a temporary directory, run the framework's own test command (e.g., `npm test`, `pytest`, `go test ./...`), and assert exit code 0. These tests run in CI on every PR and on a nightly schedule to detect preset decay.

**Snapshot tests** assert the rendered content of every required artifact (AGENTS.md, design-tokens.json, catalog-info.yaml, etc.) against a checked-in snapshot. Snapshot updates require an explicit reviewer approval step.

**Security audit tests** run `secretlint` and `gitleaks` against every scaffolded output directory to ensure no secrets are emitted.

**Idempotency tests** run `init` twice on the same directory and assert that the second run produces zero git diff, zero changed files, and exit code 0.

**Preset schema validation tests** run `preset validate` against every YAML file in the presets directory and assert that all pass without errors.

**DTCG conformance tests** parse the emitted `design-tokens.json` with a DTCG 2025.10 validator and assert no schema violations.

---

## 10. Migration & Rollout

**Phase 1 (Weeks 1–3):** Ship the scaffold engine, interactive wizard, CLI entry point, and five presets: Next.js + shadcn/ui, Vite + React, FastAPI, NestJS, and Go-chi. Every scaffold includes the required artifacts from FR-300 plus the basic CI workflow. Observability bootstrap is wired but OTLP endpoint defaults to `http://localhost:4318` with a clear comment directing the user to PRD-021. Security bootstrap includes Secretlint gate and dependency-review action; cosign/SBOM/SLSA stubs are present but marked TODO. Feature flag and CloudEvents bootstraps are not yet included.

**Phase 2 (Weeks 4–6):** Add the full observability bootstrap (FR-400s), feature flag bootstrap (FR-500s), complete security bootstrap (FR-600s: cosign, CycloneDX SBOM, SLSA), `catalog-info.yaml` generation, ADR seed, and MkDocs docs site. CloudEvents envelope stub and AsyncAPI schema seed added. All snapshot tests updated.

**Phase 3 (Weeks 7–10):** Add Expo, .NET Aspire, Rails modulith, and Turborepo monorepo presets. Implement `--create-repo` GitHub integration. Document the community preset contribution workflow and ship `preset add` and `preset validate` commands. Publish preset JSON Schema to a versioned URL for external tooling.

---

## 11. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| R-1 | Preset decay: framework updates break scaffolded output | High | High | Nightly preset integration tests; semver-pinned framework dependencies in presets |
| R-2 | Token conflicts between scaffold-emitted configs and user's global toolchain | Medium | Medium | Detect conflicting config files at init time and prompt the user |
| R-3 | Developers reject AI-shaped scaffolds as too opinionated | Medium | Medium | Keep scaffold minimalist; expose customization hooks in every preset |
| R-4 | Developer accidentally commits a secret via scaffold | Low | High | Secretlint pre-commit hook is non-optional; CI also runs secretlint |
| R-5 | Windows compatibility issues | High | Low | Document Windows as unsupported in Phase 1; track in backlog |
| R-6 | Network failure mid-scaffold leaves project in inconsistent state | Low | High | Atomic file write strategy; rollback to pre-scaffold state on any hook failure |
| R-7 | LICENSE conflicts in org-specific presets | Medium | Medium | Org-level license override config; validation check on `preset validate` |
| R-8 | Framework EOL during active use | Low | Medium | Emit a 30-day deprecation warning for presets whose framework has a published EOL date |
| R-9 | Idempotency edge cases (partially failed first run) | Medium | Medium | Manifest is written last; absence of manifest = allow re-run; partial manifests treated as absent |
| R-10 | Turborepo API churn across minor versions | Medium | Low | Pin Turborepo version in preset; document upgrade path |
| R-11 | High barrier for community preset authors | Medium | Medium | Ship a `preset new` template-scaffolder that generates a correctly structured YAML skeleton |
| R-12 | SLSA stub is insufficient for compliance | Low | High | PRD-022 owns the complete SLSA implementation; stub is explicitly labelled TODO with reference |

---

## 12. Success Metrics

| Metric | Target |
|--------|--------|
| Time-to-first-dev-server (p95) | ≤ 5 minutes from `init` invocation |
| Preset adoption concentration | ≥ 50% of new projects use one of the top-3 presets within 6 months |
| Secret leak incidents | 0 in any scaffold output over 12 months |
| Breaking preset changes | ≤ 2 per quarter after Phase 1 GA |
| Community-contributed presets | ≥ 3 merged by end of Phase 3 |
| Integration test pass rate | ≥ 99% on the nightly preset test run |
| AGENTS.md length compliance | 100% of scaffolds emit AGENTS.md ≥ 1000 chars |
| DTCG conformance | 100% of scaffolds pass DTCG 2025.10 schema validation |

---

## 13. Open Questions

| ID | Question | Owner | Due |
|----|----------|-------|-----|
| OQ-1 | Should the scaffold include a deploy target stub (Fly.io Dockerfile, Render render.yaml, Railway config) or remain deploy-agnostic until PRD-014? | Patrick Watson | Phase 1 kickoff |
| OQ-2 | How should org-specific presets be distributed — a private npm package, a git URL, or a registry entry in `autonomous-dev.config.yaml`? | Platform team | Phase 2 kickoff |
| OQ-3 | Should observability be opt-in (user chooses during wizard) or opt-out (included by default, user can remove)? | Patrick Watson | Phase 1 kickoff |
| OQ-4 | Which ADR format should the seed use — MADR 4.0, Nygard (original), or Y-Statement? Current preference is MADR 4.0 but the community may differ. | Template Authors | Phase 1 |
| OQ-5 | Should Rails modulith move to Phase 1 given its growing adoption, or stay in Phase 3? | Patrick Watson | Phase 1 kickoff |
| OQ-6 | Should preset versions track autonomous-dev plugin versions (lock-step) or be independently semver-versioned (preferred for flexibility)? | Platform team | Phase 1 |

---

## 14. References

### Internal PRDs

- PRD-001: Plugin Architecture Overview
- PRD-010: Branch Protection & Repository Policy
- PRD-011: Agent Memory & Context Management
- PRD-012: Autonomous Workflow Orchestration
- PRD-017: Design Token Pipeline
- PRD-021: Observability Backend Integration
- PRD-022: SLSA Supply Chain Security
- PRD-024: Backstage Integration
- PRD-025: Feature Flag Management

### External Specifications and Resources

- shadcn/ui CLI v4 (2026-03): https://ui.shadcn.com/docs/changelog/2026-03-cli-v4
- Dev Containers specification: https://containers.dev
- Architecture Decision Records: https://adr.github.io
- MADR 4.0: https://adr.github.io/madr/
- Backstage descriptor format: https://backstage.io/docs/features/software-catalog/descriptor-format/
- OpenFeature: https://openfeature.dev
- OpenTelemetry: https://opentelemetry.io
- CloudEvents: https://cloudevents.io
- Design Tokens Community Group 2025.10 specification: https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/
- SLSA framework: https://slsa.dev
- AsyncAPI 3.0: https://www.asyncapi.com/docs/reference/specification/v3.0.0
- CycloneDX specification: https://cyclonedx.org/specification/overview/
- flagd (OpenFeature provider): https://flagd.dev
- MkDocs Material: https://squidfunk.github.io/mkdocs-material/

---

**END PRD-013**
