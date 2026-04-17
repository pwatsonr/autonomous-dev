# autonomous-dev-assist

Expert assistance, troubleshooting, and eval harness for the autonomous-dev plugin.

## What this plugin does

autonomous-dev-assist is a companion plugin for the autonomous-dev system. It provides:

- An expert assistant that answers questions about commands, configuration, agents, pipeline phases, and common issues
- A quickstart guide that walks through prerequisites, installation, configuration, and first run
- An eval harness to validate skill accuracy and track quality over time

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

1. Add eval cases to `evals/` as JSON files with `id`, `suite`, `input`, `expected`, and `must_not_contain` fields
2. Run `/autonomous-dev-assist:eval all` to execute all suites
3. Review the results table for PASS/PARTIAL/FAIL scores
4. Check `evals/results/` for historical results

## Project structure

```
plugins/autonomous-dev-assist/
  .claude-plugin/
    plugin.json          # Plugin metadata
  commands/
    assist.md            # Expert assistant command
    eval.md              # Eval harness command
    quickstart.md        # Quickstart guide command
  evals/                 # Eval case definitions
    results/             # Eval run results (timestamped)
  README.md              # This file
```
