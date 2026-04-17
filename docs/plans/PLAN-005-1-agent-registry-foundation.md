# PLAN-005-1: Agent Registry Foundation

## Metadata
- **Parent TDD**: TDD-005-agent-factory
- **Estimated effort**: 8 days
- **Dependencies**: TDD-001 (System Core), TDD-002 (Document Pipeline)
- **Blocked by**: None (this is the foundation plan)
- **Priority**: P0
- **Risk Level**: Low

## Objective

Stand up the foundational layer of the Agent Factory: the agent definition schema, frontmatter parser, schema validator, committed-state integrity checks, agent registry (load, discover, version track), tool access enforcement, path filtering, and the first 6 foundation agent `.md` files. After this plan, agents can be loaded from git-committed files, validated, queried by name or domain, and invoked with runtime tool/path enforcement.

## Scope

### In Scope

- Agent definition format: YAML frontmatter schema + Markdown body (TDD 3.1)
- Frontmatter parser and all 10 validation rules (TDD 3.1.2)
- Tool access policy enforcement per role at load time (TDD 3.1.3)
- Committed-state check: `git status --porcelain` + SHA-256 hash verification (TDD 3.8.1)
- Agent Registry: in-memory `Map<string, AgentRecord>` catalog with `list()`, `get()`, `getForTask()`, `reload()`, `freeze()`, `unfreeze()` (TDD 3.2.1 - 3.2.4)
- Loading sequence: scan, verify, parse, validate, register (TDD 3.2.2)
- Version tracking: in-file version + git history cross-check (TDD 3.2.3)
- Agent discovery: exact name lookup and domain matching (exact + semantic) (TDD 3.2.4)
- Agent Runtime wrapper: pre/post hooks, tool call interception, path filtering (TDD 3.8.2)
- Audit log: append-only JSONL at `data/agent-audit.log` for security events (TDD 3.8.3)
- Foundation agent definitions: prd-author, tdd-author, code-executor, quality-reviewer, doc-reviewer, agent-meta-reviewer (TDD 3.9)
- Agent lifecycle states: REGISTERED, ACTIVE, FROZEN (TDD 2.2 -- subset)
- CLI commands: `agent list`, `agent inspect`, `agent reload`, `agent freeze`, `agent unfreeze` (TDD 5.1 -- subset)
- Configuration file: `config/agent-factory.yaml` with registry-relevant settings (Appendix B -- subset)
- File system layout for `agents/`, `data/`, `config/` directories (Appendix A)

### Out of Scope

- Metrics collection and storage (PLAN-005-2)
- Anomaly detection (PLAN-005-2)
- Improvement lifecycle (PLAN-005-3)
- A/B testing framework (PLAN-005-4)
- Dynamic agent creation, canary, autonomous promotion (PLAN-005-5)
- Rollback command (PLAN-005-2, depends on version history awareness from metrics)
- Remaining 7 foundation agents beyond the first 6 (deferred to PLAN-005-2 to allow pattern validation first)

## Tasks

1. **Agent definition frontmatter parser** -- Parse YAML frontmatter from `.md` files, extracting all required and optional fields into a typed `ParsedAgent` structure.
   - Files to create: `src/agent-factory/parser.ts`
   - Acceptance criteria: Correctly parses all fields from TDD 3.1.1; returns typed errors for malformed YAML; separates frontmatter from Markdown body.
   - Estimated effort: 6 hours

2. **Schema validator** -- Validate parsed frontmatter against all 10 rules from TDD 3.1.2.
   - Files to create: `src/agent-factory/validator.ts`
   - Acceptance criteria: Enforces name uniqueness, name-filename match, valid semver, role enum, tool allowlist per role (TDD 3.1.3), rubric minimum (2 dimensions), version_history consistency, turn_limit range (1-100), model registry check, temperature range (0.0-1.0). Each rule produces a specific, actionable error message.
   - Estimated effort: 8 hours

3. **Committed-state integrity checker** -- Verify that every agent file is in committed git state with matching SHA-256 hash.
   - Files to create: `src/agent-factory/integrity.ts`
   - Acceptance criteria: Runs `git status --porcelain agents/` to batch-check all files; runs `git show HEAD:<path> | sha256sum` per file; rejects files with any porcelain output (M, ?, A); rejects files where disk hash differs from git hash; logs security alert on rejection.
   - Estimated effort: 6 hours

4. **Agent Registry core** -- In-memory registry with the `AgentRegistry` interface from TDD 5.2.
   - Files to create: `src/agent-factory/registry.ts`, `src/agent-factory/types.ts`
   - Acceptance criteria: Implements `load()`, `reload()`, `list()`, `get()`, `getForTask()`, `freeze()`, `unfreeze()`, `getState()`. Loading sequence matches TDD 3.2.2 exactly (scan -> verify -> parse -> validate -> check uniqueness -> register). Performance target: load 50 agents in under 2 seconds (NFR-01). Returns `RegistryLoadResult` with loaded/rejected counts and errors.
   - Estimated effort: 10 hours

5. **Agent discovery: domain matching** -- Implement two-pass domain matching (exact tag match, then semantic similarity).
   - Files to create: `src/agent-factory/discovery.ts`
   - Acceptance criteria: Pass 1 returns agents with exact expertise tag matches (case-insensitive). Pass 2 computes cosine similarity between task description and agent description+expertise using a lightweight embedding approach. Returns `RankedAgent[]` sorted by score. Reports domain gap when no agent exceeds 0.6 threshold.
   - Estimated effort: 8 hours

6. **Agent Runtime wrapper: tool access enforcement** -- Intercept tool calls at runtime and enforce the per-role allowlist.
   - Files to create: `src/agent-factory/runtime.ts`
   - Acceptance criteria: Wraps every tool call; blocks calls to tools not in the agent's `tools` list; logs `tool_call_blocked` to audit log; returns clear error to the agent indicating the tool is not authorized.
   - Estimated effort: 6 hours

7. **Agent Runtime wrapper: path filtering** -- Block access to protected directories for all agents.
   - Files to modify: `src/agent-factory/runtime.ts`
   - Acceptance criteria: For Bash, Edit, and Write tools, rejects operations targeting `agents/**`, `data/agent-*`, or `data/metrics/**`. Implemented as a pre-tool-call hook (not prompt-based). Logs `path_access_blocked` to audit log. Handles path traversal attempts (e.g., `../agents/`).
   - Estimated effort: 6 hours

8. **Audit log writer** -- Append-only JSONL writer for security events.
   - Files to create: `src/agent-factory/audit.ts`
   - Acceptance criteria: Opens file in append mode only; writes one JSON object per line; includes timestamp, event type, agent name, and event-specific details per the format in TDD 3.8.3. No mechanism to truncate or edit the log.
   - Estimated effort: 4 hours

9. **Foundation agent definitions (first 6)** -- Write the 6 fully-specified agent `.md` files.
   - Files to create: `agents/prd-author.md`, `agents/tdd-author.md`, `agents/code-executor.md`, `agents/quality-reviewer.md`, `agents/doc-reviewer.md`, `agents/agent-meta-reviewer.md`
   - Acceptance criteria: Each file passes schema validation; frontmatter matches TDD 3.9 specifications exactly; system prompts are substantive and actionable; agent-meta-reviewer has `frozen: true`.
   - Estimated effort: 8 hours

10. **CLI commands (registry subset)** -- Implement `agent list`, `agent inspect`, `agent reload`, `agent freeze`, `agent unfreeze`.
    - Files to create: `src/agent-factory/cli.ts`
    - Acceptance criteria: `list` shows name, version, role, state for all agents. `inspect` shows full configuration, SHA-256 hash, loaded timestamp. `reload` triggers full registry reload and displays results. `freeze`/`unfreeze` toggle the frozen state and log to audit.
    - Estimated effort: 6 hours

11. **Configuration loader** -- Parse `config/agent-factory.yaml` for registry-relevant settings.
    - Files to create: `config/agent-factory.yaml`, `src/agent-factory/config.ts`
    - Acceptance criteria: Loads observation-threshold, rate limits, max-agents, domain-similarity-threshold, anomaly thresholds from YAML config. Provides defaults for all values per Appendix B.
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **TDD-001 (System Core)**: The registry integrates with the daemon process supervisor for startup sequencing. Agent loading occurs during system startup.
- **TDD-002 (Document Pipeline)**: The orchestrator (from PRD-004) calls `registry.get()` and `registry.getForTask()` to select agents for pipeline stages. This plan provides the API; the orchestrator consumes it.
- **Git**: The integrity checker requires a git repository with committed agent files. Integration tests must run in a git-initialized environment.

## Testing Strategy

**Unit tests:**
- Frontmatter parser: valid YAML, invalid YAML, missing required fields, type mismatches, empty expertise list, boundary values (turn_limit 1 and 100, temperature 0.0 and 1.0).
- Schema validator: each of the 10 validation rules individually, tool allowlist enforcement for each role, name uniqueness detection with duplicate agents.
- Integrity checker: committed file passes, modified file rejected (M), untracked file rejected (?), staged file rejected (A), hash mismatch rejected.
- Version parser: valid semver, invalid semver, version_history consistency check.
- Path filter: block `agents/foo.md`, block `data/agent-metrics.db`, block `../agents/foo.md`, allow `src/foo.ts`.

**Integration tests:**
- Full registry load cycle: scan 10+ agent files -> validate -> hash check -> register. Verify loaded/rejected counts.
- Committed-state enforcement: modify agent file without commit -> verify load rejection.
- Tool access enforcement: invoke reviewer agent -> attempt Edit tool -> verify block and audit log entry.
- Path access enforcement: invoke executor agent -> attempt write to `agents/` -> verify block and audit log entry.

**Security tests:**
- Uncommitted agent injection: place malicious `.md` file in `agents/` without committing. Verify it never loads.
- Path traversal via Bash: attempt to access `agents/meta-reviewer.md` through path traversal. Verify block.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Git operations slow for large repos | Low | Medium | Batch `git status` into single call; cache hashes during registry lifetime |
| Semantic domain matching quality is low | Medium | Low | Start with exact matching only; semantic matching is a best-effort enhancement; domain gap detection catches misses |
| Agent file format evolves during development | Low | Medium | Parser is the single entry point; changes require updating parser + validator only |

## Definition of Done

- [ ] All 6 foundation agent `.md` files committed and passing validation
- [ ] Registry loads all 6 agents in under 2 seconds
- [ ] Committed-state check rejects uncommitted/modified files (verified with test)
- [ ] Tool access enforcement blocks unauthorized tool calls at runtime (verified with test)
- [ ] Path filtering blocks access to `agents/` and protected data directories (verified with test)
- [ ] Audit log records all security-relevant events in append-only JSONL
- [ ] CLI commands `list`, `inspect`, `reload`, `freeze`, `unfreeze` functional
- [ ] Domain matching returns ranked results for exact and semantic queries
- [ ] All unit and integration tests pass
- [ ] Configuration loads from `config/agent-factory.yaml` with correct defaults
