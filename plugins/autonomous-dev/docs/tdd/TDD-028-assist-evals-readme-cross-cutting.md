# TDD-028: Assist Eval Suites, README, and Cross-Cutting Updates

| Field          | Value                                                         |
|----------------|---------------------------------------------------------------|
| **Title**      | Assist Eval Suites, README, and Cross-Cutting Updates         |
| **TDD ID**     | TDD-028                                                       |
| **Version**    | 1.0                                                           |
| **Date**       | 2026-05-02                                                    |
| **Status**     | Draft                                                         |
| **Author**     | Patrick Watson                                                |
| **Parent PRD** | PRD-015: Extend autonomous-dev-assist for Chains/Deploy/Cloud |
| **Plugin**     | autonomous-dev-assist                                         |
| **Sibling TDDs** | TDD-025 (cloud + cred-proxy SKILLs), TDD-026 (chains + deploy SKILLs), TDD-027 (agents + wizard) |

---

## 1. Summary

This is the fourth and final TDD in the PRD-015 decomposition. It owns the **eval framework expansion**, the **README and agent-count refresh**, and the **cross-cutting administrative work** that ties the three sibling TDDs (025, 026, 027) into a coherent merge. Where the siblings author content (SKILL sections, runbooks, agent prompts), this TDD authors the **measurement and discoverability infrastructure** that makes the content trustworthy and findable.

The three concrete deliverables:

1. **Four new eval suites with structured registration.** `chains-eval.yaml`, `deploy-eval.yaml`, `cred-proxy-eval.yaml`, `firewall-eval.yaml` — together ~80 cases per FR-1532 through FR-1535. Each sibling TDD authors the case **content** for its surface; **this TDD owns the schema, the directory structure, the YAML registration in `eval-config.yaml`, and the eval-the-eval meta-validation**. This separation matters: the four suites must use a single shared schema (FR-1536) so the existing `runner.sh` and `scorer.sh` need no modification, and the registration step is a single shared file.

2. **README.md, plugin agent count, and cross-link sweep.** `skills/help/SKILL.md` currently lists 13 agents; the canonical count is 18 after TDD-020 (FR-1501). The plugin README has not been refreshed since PRD-006 and does not document the new commands, runbooks, or eval suites (FR-1526). Cross-links from the existing 1263-line `instructions/runbook.md` to the four new runbooks (FR-1531, partially owned by TDD-026 for the chains/deploy entries; this TDD owns the cred-proxy/firewall entries and the unified See-also block).

3. **Cross-cutting baselines and meta-evals.** Establishes the ≥95% pass-rate baselines per FR-1538-1540, the regression-stable promise on the existing 90 reviewer-eval cases per PRD-015 §8.6, and the meta-eval framework that catches schema drift across the four new suites.

The design decision driving the structure of this TDD is **the eval-suite registration as a single-point-of-failure boundary**: if `eval-config.yaml` is wrong, all four suites silently fail to register; if the schema diverges between two suites, `runner.sh` rejects one of them. By centralizing registration here (rather than splitting it across the sibling TDDs), the merge sequence is robust to any sibling landing in any order.

In-scope FR coverage from PRD-015: FR-1501 (agent count), FR-1525 (eval command), FR-1526 (README), FR-1527-1530 (the four new runbook cross-links), FR-1532-1538 (eval suite contents and registration), FR-1539-1540 (cross-cutting tone & SHA-pinning bans), FR-1541 (cross-link contract), FR-1542 (decomposition acknowledgement). Out-of-scope (covered by siblings): SKILL.md content (TDD-025, 026), agent extensions (TDD-027), command surface extensions for `assist.md` and `quickstart.md` (TDD-026).

---

## 2. Goals & Non-Goals

### 2.1 Goals

| ID   | Goal                                                                                                                                                                       |
|------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| G-01 | Author the **shared eval-case schema** (FR-1536) used by all four new suites. Validate that `runner.sh` and `scorer.sh` need no modification.                              |
| G-02 | Establish the **directory structure** (`evals/test-cases/{chains,deploy,cred-proxy,firewall}-eval.yaml`) and the four placeholder files with valid frontmatter. The sibling TDDs populate the cases. |
| G-03 | Wire **`evals/eval-config.yaml`** (FR-1537): register the four new suites with `enabled: true`, define the default invocation order, and set per-suite thresholds.         |
| G-04 | Update the **`commands/eval.md`** prompt (FR-1525) to recognize the four new suite arguments and document the order of `eval all`.                                         |
| G-05 | Update **`skills/help/SKILL.md`** to bump the agent count from 13 to 18 (FR-1501).                                                                                          |
| G-06 | Update **`README.md`** (FR-1526) to reflect the new commands, runbooks, eval suites, and project structure.                                                                |
| G-07 | Author the **See-also index** in `instructions/runbook.md` (FR-1531) listing all four new runbooks (chains, deploy, cred-proxy, firewall). The runbook **content** is owned by TDDs 025 and 026; this TDD owns the unified index. |
| G-08 | Establish the **eval-the-eval** meta-validation: a CI lint step that ensures (a) every suite's schema matches the shared schema, (b) every suite has ≥5 negative cases (`must_not_mention`), (c) per-suite case counts meet the minima (FR-1538). |
| G-09 | Define the **regression-stable** contract: the existing 90 cases (across the existing four suites) must continue to pass at ≥95% after the four new suites are merged.    |
| G-10 | Define the **per-PR vs. nightly** eval invocation policy: per-PR runs use `--suite <single>`; nightly runs use `eval all` to catch cross-suite drift.                       |

### 2.2 Non-Goals

| ID    | Non-Goal                                                                                                                       |
|-------|--------------------------------------------------------------------------------------------------------------------------------|
| NG-01 | **Authoring eval-case bodies for the four new suites.** Bodies are owned by sibling TDDs: chains+deploy by TDD-026, cred-proxy+firewall by TDD-025. This TDD owns the schema, the registration, and the meta-validation. |
| NG-02 | **Authoring runbook content.** The four new runbook files are owned by TDDs 025 and 026. This TDD only owns the See-also index in the existing `runbook.md`. |
| NG-03 | **Modifying `runner.sh` or `scorer.sh`.** Per FR-1536, the existing harness scripts must work unchanged. If the new suites cannot conform, this TDD has failed and we re-decompose. |
| NG-04 | **Adding new SKILL.md sections.** Section additions are owned by TDDs 025 and 026.                                              |
| NG-05 | **Adding new agents.** None. The agent count goes from 13 to 18 because TDD-020 already added 5 agents to the core plugin; this TDD only updates the listing in `help/SKILL.md`. |
| NG-06 | **Pinning specific TDD commit SHAs.** Forbidden by PRD-015 FR-1540. The anchor convention from TDD-026 §8 applies here.        |
| NG-07 | **Modifying the existing 90 eval cases.** They must remain bit-identical to preserve the regression-stable contract.            |

### 2.3 Tenets

1. **Schema is law.** Every eval case across all eight suites (4 existing + 4 new) conforms to one schema. Divergence is a CI failure.
2. **Negative cases are mandatory.** Each suite has ≥5 `must_not_mention` clauses targeting the dominant hallucinations on its surface (FR-1538).
3. **Discoverability beats elegance.** The README, the agent listing, the See-also index — all are reference surfaces. They optimize for "operator finds the answer" not for prose flow.
4. **Per-PR vs. nightly.** Per-PR CI runs targeted suites only (cost discipline). Nightly runs `eval all` to catch cross-suite drift. PRD-015 R-2 demands this.

---

## 3. Background

### 3.1 The current eval harness

`evals/runner.sh` and `evals/scorer.sh` were authored under PRD-006 (intake & communication, the original assist plugin PRD) and have been stable since. They consume:

- **`evals/eval-config.yaml`**: framework metadata, suite registration, scoring weights, thresholds, runner settings.
- **`evals/test-cases/<suite>.yaml`**: per-suite cases, each with `id`, `category`, `difficulty`, `question`, `expected_topics`, `must_mention`, `must_not_mention`.

Today four suites are registered:
- `help` → `help-questions.yaml` (>30 cases)
- `troubleshoot` → `troubleshoot-scenarios.yaml` (≥30 cases)
- `config` → `config-questions.yaml` (≥30 cases)
- `onboarding` → `onboarding-questions.yaml` (currently `enabled: false` — no cases)

Plus four reviewer-eval suites (TDD-020/021): `a11y-reviewer-eval.yaml`, `qa-reviewer-eval.yaml`, `standards-reviewer-eval.yaml`, `ux-reviewer-eval.yaml`. The "existing 90 cases" referenced by PRD-015 §8.6 are these four reviewer suites.

### 3.2 The schema baseline

Every existing case follows this shape:

```yaml
- id: <suite>-<category>-<NNN>
  category: <category>
  difficulty: easy | medium | hard
  question: "<the operator's question, verbatim>"
  expected_topics:
    - <topic 1>
    - <topic 2>
  must_mention:
    - <substring 1>
  must_not_mention:
    - <substring 1>
```

The `runner.sh` invokes `claude -p "<question>"` and the `scorer.sh` matches the response against `must_mention` (factual correctness, weight 50%), `expected_topics` (completeness, weight 30%), and the `actionability` heuristic (weight 20%). `must_not_mention` is a hard-fail (any match drops the case to FAIL regardless of other dimensions).

### 3.3 The gap

PRD-015 FR-1532-1535 demand four new suites totaling ≥80 cases. None exist today. The siblings (TDD-025 for cred-proxy + firewall; TDD-026 for chains + deploy) author the case bodies. This TDD authors the connective tissue: schema lock, registration, meta-validation, and per-PR/nightly invocation policy.

### 3.4 The README and agent-count gap

`README.md` (87 lines) was authored under PRD-006 and references three commands and 13 agents. After TDD-020 the canonical agent count is 18. The README also does not list the new runbooks, eval suites, or the `--with-cloud` quickstart toggle. PRD-015 §8.3 explicitly checks the agent count and the README structure.

### 3.5 Why cross-cutting concerns still apply

This TDD owns YAML files and a README. The cross-cutting concerns still apply because the eval suites are the gate that protects against R-4 (hallucination) and R-7 (audit-log destruction). A weak schema lock means a future contributor can write a "passing" case that doesn't actually exercise the dangerous hallucinations. A wrong agent count in `help/SKILL.md` propagates to operator confusion. A broken cross-link in the runbook See-also index strands operators on dead ends.

---

## 4. Architecture

### 4.1 Component map

```
                ┌────────────────────────────────────┐
                │ /autonomous-dev-assist:eval [suite]│
                │   (commands/eval.md)              │
                └──────────────────┬─────────────────┘
                                   │
                                   ▼
                ┌────────────────────────────────────┐
                │ evals/runner.sh + scorer.sh        │
                │   (UNCHANGED — must work as-is)    │
                └──────────────────┬─────────────────┘
                                   │
                                   ▼
                ┌────────────────────────────────────┐
                │ evals/eval-config.yaml             │
                │   suites:                          │
                │     help, troubleshoot, config,    │
                │     onboarding (existing)          │
                │     chains, deploy, cred-proxy,    │ ← THIS TDD adds
                │     firewall (new)                 │ ← these
                └──────────────────┬─────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
    │ existing      │    │ new suite     │    │ shared schema │
    │ 90 cases      │    │ files         │    │ (this TDD §5) │
    │ (regression-  │    │ (siblings     │    │               │
    │  stable)      │    │  populate)    │    │               │
    └───────────────┘    └───────────────┘    └───────────────┘
              │                    │
              └────────────────────┘
                       ▼
          ┌────────────────────────┐
          │ meta-eval (CI lint)    │
          │   schema check          │
          │   negative-case count   │
          │   case-count minima     │
          └────────────────────────┘
```

### 4.2 The schema-lock mechanism

A new file `evals/schema/eval-case-v1.json` (JSON Schema) authored by this TDD enforces the case shape. Every new YAML in `evals/test-cases/` is validated against it at CI time. The existing 90 cases are also validated retroactively (they should already conform; if any do not, that's a finding that pre-dates this work).

### 4.3 The meta-eval pipeline

```
CI step: meta-eval lint
  ├── load eval-config.yaml
  ├── for each registered suite:
  │     ├── load test-cases/<suite>.yaml
  │     ├── validate against eval-case-v1.json
  │     ├── count cases; assert >= per-suite minimum (from eval-config)
  │     └── count must_not_mention entries; assert >= 5
  └── exit 0 if all pass; non-zero with summary if any fail
```

This step runs in the existing CI workflow (PRD-010) on every PR that touches `plugins/autonomous-dev-assist/evals/**`.

### 4.4 The README structural pattern

The README before/after diff:

| Section                   | Before                       | After                                                                |
|---------------------------|------------------------------|----------------------------------------------------------------------|
| Header                    | "Expert assistance, ..."     | unchanged                                                             |
| What this plugin does     | 3 bullets                     | 7 bullets (add: chains/deploy/cloud/cred-proxy/firewall/cost guidance, runbooks, eval suites) |
| Available commands        | 3 commands                    | 3 commands (no new commands per NG; toggle is a flag)                |
| How to run evals          | Generic                       | Specific: 8 suites, per-PR vs. nightly, the meta-eval lint            |
| Project structure         | 8 entries                     | 14 entries (add: 4 new runbooks, 4 new eval files, schema dir)        |
| (new) Document map        | absent                        | Anchor table: every operator question type → which surface answers it |

The Document Map is the discoverability artifact: a 1-table reference that tells an operator "if you have a deploy question, start at help/SKILL.md Deploy Framework section; for procedure go to deploy-runbook.md".

---

## 5. Eval-case schema (G-01)

### 5.1 The shared schema

Authored as `evals/schema/eval-case-v1.json`:

```json
{
  "$id": "https://autonomous-dev/schemas/eval-case-v1.json",
  "type": "object",
  "required": ["id", "category", "difficulty", "question", "expected_topics", "must_mention", "must_not_mention"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*-[0-9]{3}$",
      "description": "Format: <suite>-<category>-<NNN>. Example: chains-list-001."
    },
    "category": {
      "type": "string",
      "enum": ["what-is", "command-syntax", "concept-explanation", "comparison", "edge-case", "troubleshoot-scenario", "config-lookup", "happy-path", "negative", "warning"]
    },
    "difficulty": {
      "type": "string",
      "enum": ["easy", "medium", "hard"]
    },
    "question": {
      "type": "string",
      "minLength": 5,
      "maxLength": 500
    },
    "expected_topics": {
      "type": "array",
      "minItems": 1,
      "items": {"type": "string"}
    },
    "must_mention": {
      "type": "array",
      "items": {"type": "string"}
    },
    "must_not_mention": {
      "type": "array",
      "items": {"type": "string"}
    }
  }
}
```

### 5.2 The suite-file shape

Each `<suite>-eval.yaml` opens with:

```yaml
suite: <suite-name>
skill: assist
description: >
  <one-sentence purpose>
schema: eval-case-v1
case_minimum: <integer per FR-1532..1535>
negative_minimum: 5

cases:
  - id: ...
    ...
```

`schema`, `case_minimum`, and `negative_minimum` are this TDD's additions to the file frontmatter; the meta-eval lint step reads them.

### 5.3 The category bag

Per-surface category recommendations (the sibling TDDs are encouraged to use these for consistency):

| Suite        | Categories                                                                                    |
|--------------|-----------------------------------------------------------------------------------------------|
| `chains`     | `command-syntax`, `concept-explanation`, `troubleshoot-scenario`, `negative`, `warning`        |
| `deploy`     | `command-syntax`, `concept-explanation`, `happy-path`, `troubleshoot-scenario`, `negative`     |
| `cred-proxy` | `command-syntax`, `troubleshoot-scenario`, `warning`, `negative`                                |
| `firewall`   | `command-syntax`, `troubleshoot-scenario`, `warning`, `negative`                                |

---

## 6. Eval-config registration (G-03, G-04)

### 6.1 `evals/eval-config.yaml` additions

The existing file gains four new entries under `suites:`:

```yaml
suites:
  # ... existing four entries ...

  chains:
    file: test-cases/chains-eval.yaml
    description: "Validates assist answers chain questions correctly (TDD-022 surface)."
    enabled: true
    case_minimum: 20
    negative_minimum: 5

  deploy:
    file: test-cases/deploy-eval.yaml
    description: "Validates assist answers deploy questions correctly (TDD-023 surface)."
    enabled: true
    case_minimum: 30
    negative_minimum: 5

  cred-proxy:
    file: test-cases/cred-proxy-eval.yaml
    description: "Validates assist answers cred-proxy questions correctly (TDD-024 §7-§10)."
    enabled: true
    case_minimum: 15
    negative_minimum: 5

  firewall:
    file: test-cases/firewall-eval.yaml
    description: "Validates assist answers firewall questions correctly (TDD-024 §11-§13)."
    enabled: true
    case_minimum: 15
    negative_minimum: 5
```

### 6.2 Threshold inheritance

The existing `thresholds:` block remains:

```yaml
thresholds:
  per_case: 60
  per_suite: 80
  global_minimum: 80
  max_case_failure_pct: 20
```

But PRD-015 FR-1538 demands ≥95% per the four new suites. We add per-suite overrides:

```yaml
thresholds:
  per_case: 60
  per_suite: 80
  global_minimum: 80
  max_case_failure_pct: 20
  per_suite_overrides:
    chains: 95
    deploy: 95
    cred-proxy: 95
    firewall: 95
```

The `runner.sh` is updated **only if** it does not already honor `per_suite_overrides`. Per FR-1536 / NG-03, we prefer to extend the YAML and have the runner read the override (a 3-line addition to existing logic) over adding a new flag. This is verified at TDD-implementation time; if the runner cannot be extended without a structural change, that becomes an open question (see §16 OQ-1).

### 6.3 Default invocation order

The existing runner has no concept of order. We add:

```yaml
default_invocation_order:
  - help
  - troubleshoot
  - config
  - onboarding
  - chains
  - deploy
  - cred-proxy
  - firewall
```

`runner.sh` walks this list when `--suite all` is requested. If the runner does not currently honor an order field, we either (a) extend it in a 5-line patch or (b) accept the existing alphabetical order. This is acknowledged in OQ-2.

### 6.4 `commands/eval.md` extension (FR-1525)

The existing prompt's Step 1:

```markdown
The user may specify a suite argument:
- `help` -- Run only the help/usage question evals
- `troubleshoot` -- Run only the troubleshooting evals
- `config` -- Run only the configuration evals
- `all` or no argument -- Run all suites
```

Becomes:

```markdown
The user may specify a suite argument:
- `help` -- Run only the help/usage question evals
- `troubleshoot` -- Run only the troubleshooting evals
- `config` -- Run only the configuration evals
- `chains` -- Run only the chain-surface evals (TDD-022)
- `deploy` -- Run only the deploy-surface evals (TDD-023)
- `cred-proxy` -- Run only the credential-proxy evals (TDD-024 §7-§10)
- `firewall` -- Run only the egress-firewall evals (TDD-024 §11-§13)
- `all` or no argument -- Run all eight suites in invocation order

**Per-PR vs. nightly invocation:**
- Per-PR CI: invoke single suites with `--suite <name>` to keep CI cost low (one suite ≈ $1.50).
- Nightly: invoke `--suite all` to catch cross-suite drift (~$8.50).
```

This adds ~10 lines to `commands/eval.md`.

---

## 7. README and agent-count refresh (G-05, G-06)

### 7.1 Agent-count bump (FR-1501)

In `skills/help/SKILL.md`, the existing "Available agents" table lists 13 agents. After TDD-020 the canonical list is 18. The five new agents added by TDD-020:

| Agent                              | Fires during                              |
|------------------------------------|--------------------------------------------|
| `standards-meta-reviewer`          | Standards artifact reviews                |
| `qa-edge-case-reviewer`            | Code review                                |
| `ux-ui-reviewer`                   | UI/UX-impacting code review                |
| `accessibility-reviewer`           | UI code review                             |
| `rule-set-enforcement-reviewer`    | Standards rule enforcement on artifacts    |

Each row: `<name> | <one-line description> | <pipeline phase>`. The table grows from 13 → 18 rows. The exact descriptions are sourced from the agent frontmatter `description` field for accuracy.

### 7.2 README refresh (FR-1526)

The README (87 lines) is rewritten section-by-section:

#### "What this plugin does" (3 → 7 bullets)

```markdown
autonomous-dev-assist is a companion plugin for the autonomous-dev system. It provides:

- An expert assistant that answers questions about commands, configuration, agents, pipeline phases, and common issues
- A quickstart guide that walks through prerequisites, installation, configuration, and first run, with an optional `--with-cloud` toggle for cloud onboarding
- A guided onboarding agent for first-run setup (local-only by default; cloud-aware if you opt in)
- A diagnostic troubleshooter agent that recognizes the chain audit log, deploy ledger, cred-proxy socket, and egress firewall
- An eval harness with eight suites totaling ~170 cases that gate ≥95% pass rate on the security- and cost-critical surfaces
- Surface-specific runbooks: chains, deploy, credential proxy, and egress firewall
- Cross-references to the upstream `autonomous-dev` core plugin TDDs by section anchor (never by commit SHA)
```

#### "How to run evals" (rewritten)

```markdown
1. Per-PR (single suite): `/autonomous-dev-assist:eval <suite>` — picks one of the eight suites
2. Nightly (full): `/autonomous-dev-assist:eval all` — runs all eight in invocation order
3. Schema-lock: every case validates against `evals/schema/eval-case-v1.json` at CI time
4. Negative cases: each suite has ≥5 `must_not_mention` clauses targeting dominant hallucinations
5. Pass thresholds: existing four suites at ≥80% per case; four new suites at ≥95% per case (PRD-015 FR-1538)
6. Results: `evals/results/eval-<timestamp>.json` (existing path; no schema change)
```

#### "Project structure" (8 → 14 entries)

```markdown
plugins/autonomous-dev-assist/
  .claude-plugin/
    plugin.json
  agents/
    onboarding.md
    troubleshooter.md
  commands/
    assist.md
    eval.md
    quickstart.md
  skills/
    config-guide/
    help/
    setup-wizard/
    troubleshoot/
  instructions/
    runbook.md
    chains-runbook.md         # NEW (TDD-026)
    deploy-runbook.md          # NEW (TDD-026)
    cred-proxy-runbook.md      # NEW (TDD-025)
    firewall-runbook.md        # NEW (TDD-025)
    cloud-prompt-tree.md       # NEW (TDD-027 phase-16 boundary)
  evals/
    eval-config.yaml
    runner.sh
    scorer.sh
    schema/
      eval-case-v1.json        # NEW (TDD-028 schema-lock)
    test-cases/
      help-questions.yaml
      troubleshoot-scenarios.yaml
      config-questions.yaml
      onboarding-questions.yaml
      chains-eval.yaml          # NEW (TDD-026)
      deploy-eval.yaml           # NEW (TDD-026)
      cred-proxy-eval.yaml       # NEW (TDD-025)
      firewall-eval.yaml         # NEW (TDD-025)
      a11y-reviewer-eval.yaml    # existing (TDD-020)
      qa-reviewer-eval.yaml
      standards-reviewer-eval.yaml
      ux-reviewer-eval.yaml
    results/
  README.md
```

#### "Document map" (new section)

A new H2 anchor table:

```markdown
## Document map

| If you have a question about… | Start here…                                          | Procedural deep-dive…              |
|------------------------------|-------------------------------------------------------|-------------------------------------|
| Commands, agents, concepts    | `skills/help/SKILL.md`                                 | `instructions/runbook.md`            |
| Configuration                 | `skills/config-guide/SKILL.md`                         | `instructions/runbook.md`            |
| Plugin chains                 | `skills/help/SKILL.md` Plugin Chains section           | `instructions/chains-runbook.md`     |
| Deploy framework              | `skills/help/SKILL.md` Deploy Framework section        | `instructions/deploy-runbook.md`     |
| Cloud backends                | `skills/help/SKILL.md` Cloud Backends section          | `instructions/deploy-runbook.md` + per-cloud TDD-024 §6 |
| Credential proxy              | `skills/help/SKILL.md` Credential Proxy section        | `instructions/cred-proxy-runbook.md` |
| Egress firewall               | `skills/help/SKILL.md` Egress Firewall section         | `instructions/firewall-runbook.md`   |
| Cost estimation               | `skills/help/SKILL.md` Cost Estimation section + `skills/config-guide/SKILL.md` `cost_estimation` section | `instructions/deploy-runbook.md` §3 |
| Onboarding                    | `agents/onboarding.md` (or `/autonomous-dev-assist:setup-wizard`) | `instructions/runbook.md` |
| Diagnostics                   | `agents/troubleshooter.md` (or `/autonomous-dev-assist:assist`) | the relevant runbook              |
```

This is the single most operator-discoverable artifact in the plugin.

---

## 8. The `runbook.md` See-also index (G-07)

The existing `instructions/runbook.md` (1263 lines) gains a final H2:

```markdown
## See also

For surface-specific procedural depth, see the corresponding runbook:

| Topic                   | Runbook                                                 | Owning TDD       |
|-------------------------|---------------------------------------------------------|-------------------|
| Plugin chains           | [chains-runbook.md](./chains-runbook.md)                | TDD-022 (upstream) |
| Deploy framework        | [deploy-runbook.md](./deploy-runbook.md)                 | TDD-023 (upstream) |
| Credential proxy         | [cred-proxy-runbook.md](./cred-proxy-runbook.md)         | TDD-024 §7-§10     |
| Egress firewall          | [firewall-runbook.md](./firewall-runbook.md)             | TDD-024 §11-§13    |
| Cloud backend onboarding | `/autonomous-dev-assist:setup-wizard --with-cloud`       | TDD-027 + TDD-033  |
```

The four runbook files are owned by sibling TDDs (chains/deploy by TDD-026; cred-proxy/firewall by TDD-025). This TDD owns the unified See-also block. The markdown-link-checker (PRD-010 CI) verifies all four links resolve.

---

## 9. Meta-eval design (G-08)

A new shell script `evals/meta-lint.sh` (authored under this TDD, ~80 lines) implements:

```bash
#!/usr/bin/env bash
# Lint every test-cases/*.yaml against eval-case-v1.json schema.
# Verify per-suite case_minimum and negative_minimum.
# Exit non-zero on any violation.

set -euo pipefail

CONFIG="evals/eval-config.yaml"
SCHEMA="evals/schema/eval-case-v1.json"

# 1. Parse eval-config.yaml; extract suite registrations.
# 2. For each suite:
#      a. Load the YAML; transform to JSON.
#      b. Validate top-level frontmatter (suite, schema, case_minimum, negative_minimum).
#      c. Validate each case against eval-case-v1.json.
#      d. Count cases; compare to case_minimum.
#      e. Count must_not_mention entries; compare to negative_minimum.
# 3. Aggregate findings; exit 0 (pass) or 1 (fail).
```

Invoked from CI (PRD-010) on any PR touching `plugins/autonomous-dev-assist/evals/**`. Output is a Markdown summary table that attaches to the PR.

### 9.1 What meta-lint catches

- A new case missing the `must_not_mention` field → suite fails the negative-minimum check.
- A new case with a malformed `id` → schema validation fails.
- A new case with a category not in the enum → schema validation fails.
- A suite below its `case_minimum` → meta-lint fails.
- A suite without the `schema: eval-case-v1` declaration → meta-lint fails (forces schema lock).

### 9.2 What meta-lint does NOT catch

- A case that mentions a hallucinated command in `must_mention` (positive hallucination). The case will pass meta-lint but the assist response will fail it; the eval-baseline run catches it (PRD-015 §11 phase 4).
- A case whose `expected_topics` are too narrow (the assist answers correctly but doesn't hit the listed topics). This is a content-quality issue, not a schema issue; manual review during PR catches it.

---

## 10. Cross-cutting concerns

### 10.1 Security

- **Schema-lock prevents weak negative cases.** Without `negative_minimum: 5`, a contributor could ship a suite with zero `must_not_mention` clauses, which would let hallucinated commands like `chains rotate-key` slip through. The meta-lint enforces the floor.
- **`must_not_mention` patterns are regex.** Each suite's negative bag (defined by sibling TDDs) targets the catastrophic-command patterns: `rm.*audit\.log`, `chains rotate-key`, `edit.*ledger\.json`, `firewall disable-all`, `cred-proxy.*rotate-root`. The eval scorer treats any match as hard-fail.
- **Anchor convention forbids SHA pinning.** The reviewer agent enforces FR-1540 (TDD-026 §8 specifies the regex). This TDD inherits the rule for its YAMLs and README.
- **README is non-prescriptive on credentials.** The "What this plugin does" bullets reference cred-proxy bootstrap by command name only; they never paste a credential.

### 10.2 Privacy

- All eval-case `question` strings are synthetic. The schema does not allow operator-provided text to leak in.
- The README's "Document map" uses placeholder REQ-NNNNNN where examples are needed.
- Eval results in `evals/results/` may contain operator-specific paths (the user's repo path); this is unchanged from the existing harness and is documented in the README.

### 10.3 Scalability

- 8 suites × ~25 average cases = 200 cases at full scale. At ~$0.05/case → ~$10/run.
- Per-PR cost: $1.50 for one suite. Acceptable.
- Nightly cost: $10 × ~30 nights/month = $300/month. Documented in §10.6 below.
- Meta-lint cost: zero (static YAML check).
- README rendering cost: zero.

### 10.4 Reliability

- **Regression-stable.** The existing 90 reviewer-eval cases are not modified. The schema-lock applies retroactively but they should already conform; if any do not, that's a finding pre-existing this work and tracked separately.
- **Per-PR vs. nightly.** Per-PR runs target single suites — bounded cost, bounded latency. Nightly runs catch drift across suites.
- **Schema-lock guarantees forward-compatible suites.** A new sibling adding a suite tomorrow inherits the schema and is automatically lint-validated.

### 10.5 Observability

- Meta-lint output attaches to every PR as a Markdown table; reviewers see schema violations before merge.
- `eval-config.yaml` is the single source of truth; `Grep` for a suite name returns its registration.
- The `Document map` in the README is a visual TOC; operators landing on the README find their question's answer in <30 seconds.
- Eval results JSON files are timestamped; pass-rate trend is queryable.

### 10.6 Cost

- Per-PR CI eval cost: targeted to one suite per PR; $1.50/PR average. With ~10 PRs/week landing the assist plugin: ~$60/month.
- Nightly cost: ~$300/month (see §10.3).
- One-time meta-lint authoring: ~3 hours.
- One-time README + Document Map authoring: ~4 hours.
- One-time eval-config + commands/eval.md updates: ~2 hours.
- One-time schema authoring: ~3 hours.
- Total one-time authoring for this TDD: ~12 hours. The four new suites' bodies (the case content) are ~20 hours but owned by sibling TDDs.

---

## 11. APIs & interfaces

### 11.1 Eval-case API (the schema)

See §5.1 above. Treated as a versioned interface; bumping to `eval-case-v2.json` requires a migration plan.

### 11.2 Eval-config API

Per §6.1-§6.3. Backward-compatible: new fields (`case_minimum`, `negative_minimum`, `per_suite_overrides`, `default_invocation_order`) are additive.

### 11.3 Meta-lint API

```
$ ./evals/meta-lint.sh
[OK] help (35 cases, 7 negative)
[OK] troubleshoot (32 cases, 9 negative)
[OK] config (28 cases, 5 negative)
[FAIL] chains: 18 cases (minimum 20)
[FAIL] deploy: 4 negative cases (minimum 5)
exit 1
```

JSON output via `--json` flag for CI consumption.

### 11.4 README's Document Map (an interface)

The Document Map is treated as a contract: every cell must resolve to an extant file or section anchor. The markdown-link-checker enforces.

---

## 12. Error handling

### 12.1 Author-time

| Error                                                            | Detection                                    | Action                                                                  |
|------------------------------------------------------------------|-----------------------------------------------|--------------------------------------------------------------------------|
| Suite YAML missing `schema: eval-case-v1` frontmatter             | Meta-lint                                     | CI fail.                                                                 |
| Suite YAML below `case_minimum`                                   | Meta-lint                                     | CI fail.                                                                 |
| Case missing `must_not_mention` field                             | Schema validation                             | CI fail.                                                                 |
| Case `id` not matching `<suite>-<category>-<NNN>` pattern        | Schema validation                             | CI fail.                                                                 |
| README's Document Map link broken                                 | markdown-link-check                           | CI fail.                                                                 |
| Agent-count in `help/SKILL.md` does not match the agent file count | Reviewer agent (counts files in `agents/`)   | CI fail.                                                                 |
| SHA pinning in any new content                                    | Reviewer agent regex (TDD-026 §8 convention)   | CI fail.                                                                 |

### 12.2 Runtime (operator using assist)

| Error                                                              | Behavior                                                                                |
|--------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| Operator runs `eval all` with no plugins installed                 | All four new suites still run (they only test assist's responses, not real subsystems).  |
| `runner.sh` cannot read `per_suite_overrides`                      | Falls back to `per_suite: 80`. Acceptable degradation; logged in CI summary.            |
| Meta-lint fails on an existing case (legacy violation)             | Treated as a separate task; PR not blocked unless the violation is on a NEW case.        |

---

## 13. Performance

| Metric                                            | Target     | Notes                                                                       |
|---------------------------------------------------|------------|------------------------------------------------------------------------------|
| Meta-lint runtime (8 suites, ~200 cases)          | <5 s        | Static YAML+JSON validation only.                                            |
| `eval` single suite (30 cases)                    | <8 min      | Existing harness, unchanged.                                                  |
| `eval all` (200 cases)                            | <55 min     | 8 suites × ~7 min average.                                                    |
| README rendering                                   | <500 ms     | Static markdown.                                                              |
| Document Map link check                           | <2 s         | Existing markdown-link-check action.                                          |

---

## 14. Migration & rollout

| Phase | Activity                                                                                         | Exit criterion                                  |
|-------|---------------------------------------------------------------------------------------------------|--------------------------------------------------|
| 1     | Author the schema (`evals/schema/eval-case-v1.json`).                                             | Schema validates against existing 90 cases.      |
| 2     | Author meta-lint (`evals/meta-lint.sh`).                                                           | Meta-lint runs clean against existing suites.    |
| 3     | Wire `eval-config.yaml`: register four new suites with `enabled: true`, thresholds, order.        | `runner.sh` enumerates the eight suites.         |
| 4     | Update `commands/eval.md` to document the four new suite arguments.                                | Eval cases for `commands/eval.md` pass.          |
| 5     | Bump agent count in `skills/help/SKILL.md` from 13 to 18.                                          | Reviewer agent's count check passes.             |
| 6     | Refresh `README.md`: 7-bullet "What", new "How to run evals", expanded "Project structure", new "Document map". | Markdown lint passes; Document map links resolve. |
| 7     | Append See-also index to `instructions/runbook.md` (FR-1531).                                      | Markdown-link-check passes.                       |
| 8     | Coordinate with siblings (TDDs 025, 026, 027): they populate the four new YAMLs; this TDD's meta-lint validates. | Meta-lint passes for all four populated suites.  |
| 9     | Eval-baseline run on `main`: capture pass rate on existing 90 cases.                              | Captured.                                         |
| 10    | Eval-post run after merge: confirm ≥95% on new suites; ≥95% on existing 90 (no regression).         | Both gates green.                                 |

Rollback per-step: revert the relevant commit. The pieces are independently revertable except step 5 (agent count) and step 6 (README refresh), which are tied together by the Document Map.

---

## 15. Test strategy

### 15.1 Unit-level

- Schema validation tests: 20 fixtures (10 valid, 10 invalid covering each rule).
- Meta-lint tests: 5 scenarios (clean pass, missing schema field, below case_minimum, below negative_minimum, broken YAML).
- Agent-count check: 1 test against the canonical agent listing.

### 15.2 Integration-level

- Run all 8 suites (after siblings populate); ≥95% on the four new, ≥95% on the four existing.
- Markdown-link-check on the new README, the runbook See-also, and the Document Map.
- Reviewer-agent SHA-pinning check on README and YAMLs.

### 15.3 Regression-stable contract test

- The diff against the existing 90 cases should be empty (only new files added; existing files only get new rows or a new See-also section).

### 15.4 Eval-the-eval

- For each of the four new suites, run eval-baseline (before sibling content lands) → expected to fail. Run eval-post (after sibling content lands) → expected to pass at ≥95%. The delta proves the schema and the cases are doing useful work.

---

## 16. Open questions

| ID    | Question                                                                                                                  | Recommended answer                                                                                            | Status |
|-------|---------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|--------|
| OQ-1  | If `runner.sh` does not honor `per_suite_overrides`, do we extend the runner or accept the default 80% threshold for the new suites? | **Extend the runner** with a 3-line patch. PRD-015 FR-1538 explicitly demands ≥95% on the new suites; degrading to 80% violates the merge gate. | Open |
| OQ-2  | Does `runner.sh` support `default_invocation_order`?                                                                       | If not, accept alphabetical order for v1; revisit in PRD-016. The order matters less than the per-suite gates.  | Open   |
| OQ-3  | Should the schema be `v1.0.0` (semver) or `v1` (the current style)?                                                       | **`v1`.** Matches existing config style. Semver bumps when fields are added; major bumps require migration plan. | Closed |
| OQ-4  | Should the README's Document Map be a separate file (`docs/document-map.md`) or stay in the README?                        | **In the README.** Discoverability beats decomposition for this artifact.                                       | Closed |
| OQ-5  | If meta-lint catches a violation in an existing 90-case suite (legacy), do we block the PR?                                | **No.** Legacy violations get their own ticket; new violations block.                                            | Open   |
| OQ-6  | Should the `commands/eval.md` per-PR/nightly invocation guidance be a CI policy or a docs note?                            | **Docs note for v1; CI policy in PRD-016 if PR cost is observed to be too high.**                              | Open   |
| OQ-7  | Should the eval result JSON include the meta-lint summary?                                                                  | **Yes.** Append `meta_lint: {pass: true, findings: []}` to each result file.                                    | Open   |
| OQ-8  | If a sibling TDD lands without populating its eval suite (e.g., TDD-025 ships SKILLs but no cred-proxy-eval cases), what happens? | Meta-lint fails (`case_minimum` violated) → PR cannot merge. Forces sibling TDDs to ship cases alongside content. | Closed |

---

## 17. References

| Document                                                                              | Relationship                                  |
|---------------------------------------------------------------------------------------|------------------------------------------------|
| `plugins/autonomous-dev/docs/prd/PRD-015-assist-extension-for-chains-deploy-cloud.md` | Parent PRD                                    |
| `plugins/autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md`                   | Surface gated by chains-eval                  |
| `plugins/autonomous-dev/docs/tdd/TDD-023-deployment-backend-framework-core.md`        | Surface gated by deploy-eval                  |
| `plugins/autonomous-dev/docs/tdd/TDD-024-cloud-backends-credential-proxy.md`          | Surfaces gated by cred-proxy-eval, firewall-eval |
| `plugins/autonomous-dev/docs/tdd/TDD-025-assist-cloud-credproxy-surface.md`           | Sibling — populates cred-proxy-eval, firewall-eval |
| `plugins/autonomous-dev/docs/tdd/TDD-026-assist-chains-deploy-cli-surfaces.md`        | Sibling — populates chains-eval, deploy-eval  |
| `plugins/autonomous-dev/docs/tdd/TDD-027-assist-agents-wizard-handoff.md`             | Sibling — agent extensions, phase-16 contract |
| `plugins/autonomous-dev/docs/tdd/TDD-016-baseline-ci-plugin-validation.md`            | CI infrastructure that runs meta-lint         |
| `plugins/autonomous-dev/docs/tdd/TDD-020-quality-reviewer-suite.md`                   | Source of the 5 new agents (count goes 13 → 18) |
| `plugins/autonomous-dev-assist/evals/eval-config.yaml`                                | Surface modified by FR-1537                   |
| `plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json`                        | New file (this TDD)                           |
| `plugins/autonomous-dev-assist/evals/meta-lint.sh`                                    | New file (this TDD)                           |
| `plugins/autonomous-dev-assist/commands/eval.md`                                      | Surface modified by FR-1525                   |
| `plugins/autonomous-dev-assist/skills/help/SKILL.md`                                  | Surface modified by FR-1501 (agent count)     |
| `plugins/autonomous-dev-assist/README.md`                                             | Surface modified by FR-1526                   |
| `plugins/autonomous-dev-assist/instructions/runbook.md`                               | Surface modified by FR-1531 (See-also index)  |

---

## 18. Appendix: file-by-file change inventory

| File                                                                                       | Change   | Lines added (approx.)   | FR coverage          |
|--------------------------------------------------------------------------------------------|----------|--------------------------|----------------------|
| `plugins/autonomous-dev-assist/evals/schema/eval-case-v1.json`                              | New      | ~50 (JSON schema)         | FR-1536              |
| `plugins/autonomous-dev-assist/evals/meta-lint.sh`                                          | New      | ~80                       | FR-1538              |
| `plugins/autonomous-dev-assist/evals/eval-config.yaml`                                      | Modified | +35                       | FR-1537              |
| `plugins/autonomous-dev-assist/evals/test-cases/chains-eval.yaml`                           | New (frontmatter only; cases by TDD-026) | ~10  | FR-1532              |
| `plugins/autonomous-dev-assist/evals/test-cases/deploy-eval.yaml`                           | New (frontmatter only; cases by TDD-026) | ~10  | FR-1533              |
| `plugins/autonomous-dev-assist/evals/test-cases/cred-proxy-eval.yaml`                       | New (frontmatter only; cases by TDD-025) | ~10  | FR-1534              |
| `plugins/autonomous-dev-assist/evals/test-cases/firewall-eval.yaml`                         | New (frontmatter only; cases by TDD-025) | ~10  | FR-1535              |
| `plugins/autonomous-dev-assist/commands/eval.md`                                            | Modified | +15                       | FR-1525              |
| `plugins/autonomous-dev-assist/skills/help/SKILL.md`                                        | Modified | +10 (agent count rows)    | FR-1501              |
| `plugins/autonomous-dev-assist/README.md`                                                    | Modified | +60 (rewritten + Document map) | FR-1526         |
| `plugins/autonomous-dev-assist/instructions/runbook.md`                                     | Modified | +20 (See-also index)      | FR-1531              |

**Total**: 6 modified, 6 new = **12 file changes**.

---

*End of TDD-028.*
