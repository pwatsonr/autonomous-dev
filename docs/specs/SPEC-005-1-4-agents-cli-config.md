# SPEC-005-1-4: Foundation Agent Definitions, CLI Commands, and Configuration

## Metadata
- **Parent Plan**: PLAN-005-1
- **Tasks Covered**: Task 9 (Foundation agent definitions, first 6), Task 10 (CLI commands, registry subset), Task 11 (Configuration loader)
- **Estimated effort**: 18 hours

## Description

Create the first 6 foundation agent `.md` definition files that establish the patterns for all agents in the system, implement the registry-subset CLI commands for inspecting and managing agents, and build the configuration loader for `agent-factory.yaml`. These are the concrete artifacts that make the registry operational for downstream consumers.

## Files to Create/Modify

### New Files

**`agents/prd-author.md`** -- PRD writing agent
**`agents/tdd-author.md`** -- TDD writing agent
**`agents/code-executor.md`** -- Code implementation agent
**`agents/quality-reviewer.md`** -- Code quality review agent
**`agents/doc-reviewer.md`** -- Documentation review agent
**`agents/agent-meta-reviewer.md`** -- Meta-review of agent proposals (frozen)

**`src/agent-factory/cli.ts`** -- CLI command handlers

**`config/agent-factory.yaml`** -- System configuration
**`src/agent-factory/config.ts`** -- Configuration loader

## Implementation Details

### Foundation Agent Definitions

Each agent `.md` file follows this template structure:

```markdown
---
name: {agent-name}
version: "1.0.0"
role: {author|executor|reviewer|meta}
model: "claude-sonnet-4-20250514"
temperature: {0.0-1.0}
turn_limit: {1-100}
tools:
  - Read
  - {other tools per role allowlist}
expertise:
  - {domain tag 1}
  - {domain tag 2}
evaluation_rubric:
  - name: {dimension}
    weight: {0.0-1.0}
    description: {what this measures}
  - name: {dimension}
    weight: {0.0-1.0}
    description: {what this measures}
version_history:
  - version: "1.0.0"
    date: "2026-04-08"
    change: "Initial release"
description: "{one-line description}"
frozen: {true|false, optional}
---

{System prompt: detailed, actionable instructions for the agent}
```

**Agent 1: `prd-author.md`**
- role: `author`
- temperature: 0.7
- turn_limit: 30
- tools: `[Read, Glob, Grep, WebSearch, WebFetch]`
- expertise: `[product-requirements, user-stories, acceptance-criteria, stakeholder-analysis]`
- evaluation_rubric:
  - `completeness` (weight: 0.3) -- All PRD sections populated with substantive content
  - `clarity` (weight: 0.3) -- Requirements are unambiguous and testable
  - `feasibility` (weight: 0.2) -- Technical feasibility considered
  - `stakeholder-alignment` (weight: 0.2) -- User needs and business goals addressed
- System prompt: Instructions for producing structured PRDs following the project template, discovering existing codebase context, identifying stakeholders, defining acceptance criteria, and structuring user stories.

**Agent 2: `tdd-author.md`**
- role: `author`
- temperature: 0.5
- turn_limit: 40
- tools: `[Read, Glob, Grep, WebSearch, WebFetch]`
- expertise: `[technical-design, api-design, architecture, data-modeling, system-integration]`
- evaluation_rubric:
  - `technical-accuracy` (weight: 0.3) -- Design is technically sound and implementable
  - `completeness` (weight: 0.25) -- All TDD sections populated
  - `integration-awareness` (weight: 0.25) -- Dependencies and interfaces documented
  - `testability` (weight: 0.2) -- Design enables test-driven development
- System prompt: Instructions for producing technical design documents from approved PRDs, exploring codebase architecture, defining APIs and data models, and specifying integration points.

**Agent 3: `code-executor.md`**
- role: `executor`
- temperature: 0.3
- turn_limit: 50
- tools: `[Read, Glob, Grep, Bash, Edit, Write, WebSearch, WebFetch]`
- expertise: `[implementation, typescript, testing, refactoring, debugging]`
- evaluation_rubric:
  - `correctness` (weight: 0.35) -- Code compiles, passes tests, meets spec
  - `code-quality` (weight: 0.25) -- Clean code, proper patterns, no duplication
  - `test-coverage` (weight: 0.25) -- Tests cover critical paths and edge cases
  - `spec-adherence` (weight: 0.15) -- Implementation matches specification
- System prompt: Instructions for implementing code from specs, writing tests first (TDD), running lint and test commands, and committing incremental changes.

**Agent 4: `quality-reviewer.md`**
- role: `reviewer`
- temperature: 0.2
- turn_limit: 20
- tools: `[Read, Glob, Grep]`
- expertise: `[code-review, testing, security, performance, typescript]`
- evaluation_rubric:
  - `issue-detection` (weight: 0.35) -- Finds real bugs, security issues, performance problems
  - `actionability` (weight: 0.3) -- Feedback is specific, with suggested fixes
  - `false-positive-rate` (weight: 0.2) -- Low rate of spurious findings
  - `coverage` (weight: 0.15) -- Reviews all changed files and critical paths
- System prompt: Instructions for conducting structured code review, scoring against rubric dimensions, identifying bugs, security issues, and performance problems, and providing actionable suggestions.

**Agent 5: `doc-reviewer.md`**
- role: `reviewer`
- temperature: 0.2
- turn_limit: 20
- tools: `[Read, Glob, Grep]`
- expertise: `[documentation, prd-review, tdd-review, writing-quality, consistency]`
- evaluation_rubric:
  - `accuracy` (weight: 0.3) -- Document content is technically correct
  - `completeness` (weight: 0.3) -- All required sections present and substantive
  - `clarity` (weight: 0.2) -- Writing is clear, unambiguous, well-structured
  - `consistency` (weight: 0.2) -- Consistent with project conventions and related docs
- System prompt: Instructions for reviewing documents (PRDs, TDDs, plans) against templates, checking for completeness, clarity, accuracy, and consistency with existing project documentation.

**Agent 6: `agent-meta-reviewer.md`**
- role: `meta`
- temperature: 0.1
- turn_limit: 15
- tools: `[Read, Glob, Grep]`
- **frozen: true**
- expertise: `[agent-safety, prompt-review, security-review, schema-validation]`
- evaluation_rubric:
  - `safety-detection` (weight: 0.4) -- Identifies privilege escalation, scope creep, prompt injection
  - `thoroughness` (weight: 0.3) -- All 6 checklist items evaluated
  - `proportionality` (weight: 0.15) -- Findings match actual risk level
  - `false-positive-rate` (weight: 0.15) -- Low spurious blocker rate
- System prompt: Instructions for evaluating agent modification proposals against the 6-point security checklist: (1) tool access escalation, (2) role change, (3) scope creep, (4) prompt injection vectors, (5) schema compliance, (6) proportionality of change to weakness.

### CLI Commands (`cli.ts`)

**`agent list`**
- Output format (table):
```
NAME                  VERSION  ROLE      STATE    EXPERTISE
prd-author            1.0.0    author    ACTIVE   product-requirements, user-stories
tdd-author            1.0.0    author    ACTIVE   technical-design, api-design
code-executor         1.0.0    executor  ACTIVE   implementation, typescript
quality-reviewer      1.0.0    reviewer  ACTIVE   code-review, testing
doc-reviewer          1.0.0    reviewer  ACTIVE   documentation, prd-review
agent-meta-reviewer   1.0.0    meta      FROZEN   agent-safety, prompt-review
```

**`agent inspect <name>`**
- Output: Full configuration dump including all frontmatter fields, SHA-256 hash, loaded timestamp, current state, file path, and the first 5 lines of the system prompt (truncated).

**`agent reload`**
- Triggers `registry.reload()`. Displays `RegistryLoadResult`: loaded count, rejected count, each error.

**`agent freeze <name>`**
- Calls `registry.freeze(name)`. Displays confirmation.

**`agent unfreeze <name>`**
- Calls `registry.unfreeze(name)`. Displays confirmation.

### Configuration (`config/agent-factory.yaml` and `config.ts`)

```yaml
# Agent Factory Configuration
registry:
  agents-dir: "agents/"
  max-agents: 50

observation:
  default-threshold: 10
  per-agent-overrides: {}

domain-matching:
  similarity-threshold: 0.6
  max-results: 5

rate-limits:
  modifications-per-agent-per-week: 1
  agent-creations-per-week: 1

anomaly-thresholds:
  approval-rate-drop: 0.70
  quality-decline-points: 0.5
  quality-decline-window: 10
  escalation-rate: 0.30
  token-budget-multiplier: 2.0

model-registry:
  - "claude-sonnet-4-20250514"
  - "claude-opus-4-20250514"

paths:
  audit-log: "data/agent-audit.log"
  metrics-jsonl: "data/metrics/agent-invocations.jsonl"
  metrics-db: "data/agent-metrics.db"
  weakness-reports: "data/weakness-reports.jsonl"
  proposals: "data/proposals.jsonl"
  domain-gaps: "data/domain-gaps.jsonl"
  evaluations-dir: "data/evaluations/"
  proposed-agents-dir: "data/proposed-agents/"
  canary-state: "data/canary-state.json"
  compatibility: "data/agent-compatibility.json"
```

**Config loader** (`config.ts`):

```typescript
interface AgentFactoryConfig {
  registry: { agentsDir: string; maxAgents: number };
  observation: { defaultThreshold: number; perAgentOverrides: Record<string, number> };
  domainMatching: { similarityThreshold: number; maxResults: number };
  rateLimits: { modificationsPerAgentPerWeek: number; agentCreationsPerWeek: number };
  anomalyThresholds: {
    approvalRateDrop: number;
    qualityDeclinePoints: number;
    qualityDeclineWindow: number;
    escalationRate: number;
    tokenBudgetMultiplier: number;
  };
  modelRegistry: string[];
  paths: Record<string, string>;
}

function loadConfig(configPath?: string): AgentFactoryConfig
```

- Loads from `config/agent-factory.yaml` (or provided path).
- Provides defaults for every value (the values shown in the YAML above).
- If config file is missing, returns all defaults (does not fail).
- Validates that required paths are relative (not absolute).

## Acceptance Criteria

1. All 6 agent `.md` files pass schema validation (parser + validator from SPEC-005-1-1).
2. Each agent's frontmatter matches TDD 3.9 specifications exactly.
3. System prompts are substantive (minimum 200 words each) and actionable.
4. `agent-meta-reviewer.md` has `frozen: true`.
5. Tool lists conform to role-based allowlists.
6. `agent list` displays name, version, role, state, and expertise for all agents.
7. `agent inspect` displays full configuration including SHA-256 hash and loaded timestamp.
8. `agent reload` triggers full registry reload and displays results.
9. `agent freeze` / `agent unfreeze` toggle state and log to audit.
10. Configuration loads from YAML with correct defaults for all values.
11. Missing config file does not crash; defaults are used.

## Test Cases

### Agent Definition Validation Tests

```
test_prd_author_passes_validation
  Input: agents/prd-author.md
  Expected: parser succeeds, validator returns valid=true

test_tdd_author_passes_validation
  Input: agents/tdd-author.md
  Expected: valid=true

test_code_executor_passes_validation
  Input: agents/code-executor.md
  Expected: valid=true

test_quality_reviewer_passes_validation
  Input: agents/quality-reviewer.md
  Expected: valid=true

test_doc_reviewer_passes_validation
  Input: agents/doc-reviewer.md
  Expected: valid=true

test_agent_meta_reviewer_passes_validation
  Input: agents/agent-meta-reviewer.md
  Expected: valid=true, frozen=true in parsed output

test_all_agents_have_minimum_2_rubric_dimensions
  Input: all 6 agent files
  Expected: each has >= 2 evaluation_rubric entries

test_all_agents_respect_tool_allowlist
  Input: all 6 agent files
  Expected: each agent's tools are subset of their role's allowlist

test_all_system_prompts_are_substantive
  Input: all 6 agent files
  Expected: each system_prompt has >= 200 words
```

### CLI Unit Tests

```
test_list_command_output_format
  Setup: Registry with 3 loaded agents
  Expected: Table with columns NAME, VERSION, ROLE, STATE, EXPERTISE

test_inspect_command_shows_full_config
  Setup: Registry with agent "code-executor"
  Action: agent inspect code-executor
  Expected: Output includes all frontmatter fields, SHA-256 hash, loadedAt

test_inspect_unknown_agent_shows_error
  Action: agent inspect nonexistent
  Expected: Error message "Agent 'nonexistent' not found"

test_reload_command_displays_results
  Action: agent reload
  Expected: Output shows loaded count, rejected count, any errors

test_freeze_command
  Action: agent freeze code-executor
  Expected: Output confirms freeze, audit log has entry

test_unfreeze_command
  Action: agent unfreeze agent-meta-reviewer
  Expected: Output confirms unfreeze, audit log has entry

test_freeze_nonexistent_agent
  Action: agent freeze nonexistent
  Expected: Error message
```

### Configuration Tests

```
test_load_valid_config
  Setup: agent-factory.yaml with all fields
  Expected: AgentFactoryConfig with correct values

test_load_config_with_defaults
  Setup: agent-factory.yaml with only registry section
  Expected: Other sections populated with defaults

test_load_missing_config_file
  Setup: No config file at expected path
  Expected: AgentFactoryConfig with all defaults, no error thrown

test_model_registry_populated
  Expected: modelRegistry contains at least one model name

test_paths_are_relative
  Setup: Config with absolute path "/data/agent-audit.log"
  Expected: Validation warning or rejection

test_per_agent_overrides
  Setup: Config with observation.per-agent-overrides: { "code-executor": 20 }
  Expected: Config reflects override value
```
