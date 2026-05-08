# autonomous-dev-assist

Expert assistance, troubleshooting, and eval harness for the autonomous-dev plugin.

## What this plugin does

autonomous-dev-assist is a companion plugin for the autonomous-dev system. It provides:

- An expert assistant that answers questions about commands, configuration, agents, pipeline phases, and common issues
- A quickstart guide that walks through prerequisites, installation, configuration, and first run
- An eval harness to validate skill accuracy and track quality over time
- Surface-specific guidance for plugin chains, deploy backends, cloud onboarding, credential proxy, and egress firewall under the same `assist` entrypoint
- An eight-suite eval harness gating ≥95% on security/cost-critical surfaces and ≥80% on others; schema-locked at `evals/schema/eval-case-v1.json`
- Surface-specific runbooks under `instructions/` covering chains, deploy, cred-proxy, firewall, and the cloud setup-wizard handoff
- Anchor-only cross-references to upstream `autonomous-dev` core TDDs; no commit-SHA pinning (per FR-1540)

## Installation

The plugin is registered in the autonomous-dev marketplace. Ensure the plugin directory exists at:

```
plugins/autonomous-dev-assist/
```

And that it is listed in `.claude-plugin/marketplace.json`.

## Available commands

### `/autonomous-dev-assist:assist <question>`

Ask any question about the autonomous-dev system. The assistant classifies your question (help, troubleshoot, or config), searches the codebase for relevant information, and provides a clear answer with exact commands to run.

Examples:
```
/autonomous-dev-assist:assist How do I configure the observation loop?
/autonomous-dev-assist:assist The pipeline is stuck on the review gate
/autonomous-dev-assist:assist What agents are available?
```

### `/autonomous-dev-assist:eval [suite]`

Run the eval harness to validate that the assist command produces accurate answers. Specify a suite or run all:

```
/autonomous-dev-assist:eval help
/autonomous-dev-assist:eval troubleshoot
/autonomous-dev-assist:eval config
/autonomous-dev-assist:eval all
```

Results are saved to `evals/results/` with timestamps for tracking over time.

### `/autonomous-dev-assist:quickstart`

Step-by-step guided setup. Checks prerequisites (Node.js, Claude Code CLI, git, jq), verifies plugin installation, initializes configuration, validates the setup, and runs your first command.

```
/autonomous-dev-assist:quickstart
```

## How to run evals

1. Per-PR single-suite invocation: `autonomous-dev eval --suite chains` (or `deploy`, `cred-proxy`, `firewall`, `help`, `troubleshoot`, `config`, `onboarding`). Cost ≈ $1.50 per suite.
2. Nightly full-coverage invocation: `autonomous-dev eval --suite all` runs all eight suites in `default_invocation_order`. Cost ≈ $8.50.
3. Every case conforms to `evals/schema/eval-case-v1.json` (the schema lock); meta-lint (`evals/meta-lint.sh`) blocks PRs that introduce malformed cases.
4. Each suite has at least 5 negative cases (`must_not_mention`) targeting catastrophic-command hallucinations.
5. Threshold split via `evals/eval-config.yaml`: default 80%; cred-proxy, firewall, deploy, and chains enforce 95% via `per_suite_overrides`.
6. Results land at `evals/results/<timestamp>/<suite>/results.json` for downstream cost and drift tracking (per PRD-015).

## Project structure

```
plugins/autonomous-dev-assist/
  .claude-plugin/
    plugin.json          # Plugin metadata
  agents/
    onboarding.md        # First-run onboarding agent
    troubleshooter.md    # Diagnostic agent for stuck pipelines
  commands/
    assist.md            # Expert assistant command
    eval.md              # Eval harness command
    quickstart.md        # Quickstart guide command
  skills/
    config-guide/        # Configuration reference skill
    help/                # General-help skill
    setup-wizard/        # Step-by-step setup skill
    troubleshoot/        # Diagnostic / fix-it skill
  instructions/
    runbook.md           # Operational runbook
    chains-runbook.md          # Plugin-chains operator deep-dive (TDD-026)
    deploy-runbook.md          # Deploy-framework operator deep-dive (TDD-026)
    cred-proxy-runbook.md      # Credential-proxy operator deep-dive (TDD-025)
    firewall-runbook.md        <!-- pending: TDD-025 -->
    cloud-prompt-tree.md       # Cloud setup-wizard handoff tree (TDD-027)
  evals/                 # Eval case definitions
    eval-config.yaml     # Suite registration + per-suite thresholds
    runner.sh            # Suite invocation
    scorer.sh            # Pass/fail scoring
    meta-lint.sh         # CI-time schema linter (SPEC-028-1-02)
    schema/
      eval-case-v1.json  # Versioned eval-case schema (SPEC-028-1-01)
    test-cases/
      help-questions.yaml
      troubleshoot-scenarios.yaml
      config-questions.yaml
      onboarding-questions.yaml
      chains-eval.yaml         # NEW (SPEC-028-2-01)
      deploy-eval.yaml         # NEW (SPEC-028-2-02)
      cred-proxy-eval.yaml     # NEW (SPEC-028-3-01)
      firewall-eval.yaml       # NEW (SPEC-028-3-02)
    results/             # Eval run results (timestamped)
  README.md              # This file
```

## Document map

| Question type | Start surface | Procedural deep-dive |
|---------------|---------------|----------------------|
| What does this plugin do? | This README §What this plugin does | [PRD-015](../autonomous-dev/docs/prd/PRD-015-assist-extension-for-chains-deploy-cloud.md) |
| How do I install/use it? | This README §Available commands | `skills/help/SKILL.md` |
| How do I deploy? | `skills/help/SKILL.md` | `instructions/deploy-runbook.md` |
| How do I work with chains? | `skills/help/SKILL.md` | `instructions/chains-runbook.md` |
| How do I configure cred-proxy? | `skills/help/SKILL.md` | `instructions/cred-proxy-runbook.md` |
| How do I work with the firewall? | `skills/help/SKILL.md` | `instructions/firewall-runbook.md` <!-- pending: TDD-025 --> |
| How do I onboard to cloud? | `skills/setup-wizard/SKILL.md` | `instructions/cloud-prompt-tree.md` |
| Why did my deploy fail? | `skills/troubleshoot/SKILL.md` | `instructions/deploy-runbook.md` |
| How do I run evals locally? | This README §How to run evals | `evals/eval-config.yaml`, `commands/eval.md` |
| Where is the decomposition rationale? | This README §footer | [PRD-015 §11 Launch Plan](../autonomous-dev/docs/prd/PRD-015-assist-extension-for-chains-deploy-cloud.md#11-launch-plan) |

---

This plugin's current capabilities were authored under [PRD-015](../autonomous-dev/docs/prd/PRD-015-assist-extension-for-chains-deploy-cloud.md). For decomposition rationale and the four-TDD breakdown (TDD-025, TDD-026, TDD-027, TDD-028), see [PRD-015 §11 Launch Plan](../autonomous-dev/docs/prd/PRD-015-assist-extension-for-chains-deploy-cloud.md#11-launch-plan).
