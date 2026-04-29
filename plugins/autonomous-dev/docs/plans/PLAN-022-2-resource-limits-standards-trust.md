# PLAN-022-2: Chain Resource Limits + Standards-to-Fix Flow + Trust Integration

## Metadata
- **Parent TDD**: TDD-022-plugin-chaining-engine
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-022-1]
- **Priority**: P0

## Objective
Layer operational and security gates onto the chain executor: per-plugin and per-chain resource limits per TDD §9 (timeout, max chain length, artifact size cap), the canonical standards-to-fix flow per TDD §10 that wires the rule-set-enforcement-reviewer's findings into the code-fixer plugin with human approval, and trust integration per TDD §11 that gates chain execution on plugin allowlist + privileged-chain authorization. Without this plan, chains can run indefinitely, consume unbounded resources, or execute untrusted code without operator consent.

## Scope
### In Scope
- `ChainResourceLimits` config in `~/.claude/autonomous-dev.json` per TDD §9: `chains.max_length` (default 10), `chains.per_plugin_timeout_seconds` (default 120), `chains.per_chain_timeout_seconds` (default 600), `chains.max_artifact_size_mb` (default 10), `chains.max_concurrent_chains` (default 3 per request)
- Per-plugin timeout enforcement in `ChainExecutor` (PLAN-022-1): wrap each plugin invocation in a timeout race; on timeout, mark the plugin as failed and proceed with failure-mode semantics
- Chain-length limit: refuse to execute chains longer than `max_length`; emit a structured error with the chain path
- Artifact size cap: reject artifacts exceeding `max_artifact_size_mb` at persist time (`ArtifactRegistry.persist()` from PLAN-022-1 enforces this); the producer plugin's invocation is marked failed
- Concurrent-chain cap: track in-flight chains per request; refuse new chains beyond `max_concurrent_chains`
- Failure-mode semantics: each `produces`/`consumes` declaration optionally specifies `on_failure: 'block'|'warn'|'ignore'`. `block` halts the entire chain; `warn` logs and continues with downstream skipped (current PLAN-022-1 behavior); `ignore` continues including downstream consumers
- Standards-to-fix flow integration per TDD §10: when `rule-set-enforcement-reviewer` (PLAN-020-1) emits a security finding, the chain executor automatically triggers `code-fixer` (a fixture plugin demonstrating the canonical use case). The flow is wired by virtue of the producer/consumer manifest declarations; this plan ships the canonical fixture and end-to-end test.
- Human approval gate per TDD §10 / PRD-013 FR-1335: artifacts marked `requires_approval: true` are persisted but NOT automatically applied. The daemon raises an escalation (TDD-009) prompting the operator to approve via CLI or the portal.
- `autonomous-dev chains approve <artifact-id>` CLI subcommand that marks an artifact as approved and proceeds with the next chain step (e.g., a hypothetical `patch-applier` plugin downstream)
- Trust integration per TDD §11: chains require all plugins to pass PLAN-019-3's trust validator. Privileged chains (those that consume artifacts with `requires_approval: true` and produce artifacts that mutate code) require additional authorization in `extensions.privileged_chains[]` allowlist
- `extensions.privileged_chains[]` config field listing approved chain definitions (by `producer:consumer` pairs)
- Telemetry: every chain execution logs `{chain_id, plugins[], duration_ms, artifacts[], outcome}` to the metrics pipeline
- Unit tests for: timeout enforcement, chain-length limit, artifact-size cap, concurrent-chain cap, failure-mode behavior, privileged-chain authorization
- Integration test: standards-to-fix end-to-end (rule-set-enforcement → code-fixer with approval gate)

### Out of Scope
- Manifest schema, artifact registry, dependency graph, basic executor, cycle detection -- delivered by PLAN-022-1
- Inter-plugin data flow security (artifact sanitization, schema strictness) -- PLAN-022-3
- Audit log integration (this plan emits to telemetry; PLAN-022-3 emits to the HMAC-chained audit log)
- The `code-fixer` plugin's actual fix-generation logic — this plan ships a fixture stub that demonstrates the chain wiring; full code-fixer is a future plan
- Patch application (mutating user code) — chain produces patches; application is via the existing `code-executor` agent or a dedicated `patch-applier` plugin that's out of scope here
- Plugin marketplace approval workflow for new privileged chains — operator concern

## Tasks

1. **Add `chains` config section** -- Extend `~/.claude/autonomous-dev.json` schema with the `chains` object per TDD §9 (`max_length`, `per_plugin_timeout_seconds`, `per_chain_timeout_seconds`, `max_artifact_size_mb`, `max_concurrent_chains`). Conservative defaults documented.
   - Files to modify: `plugins/autonomous-dev/schemas/autonomous-dev-config.schema.json`, `plugins/autonomous-dev/config_defaults.json`
   - Acceptance criteria: `autonomous-dev config init --global` produces a config with the new section. Defaults match TDD §9. `autonomous-dev config validate` passes.
   - Estimated effort: 1.5h

2. **Implement per-plugin timeout enforcement** -- Wrap each plugin invocation in `ChainExecutor` with `Promise.race([invocation, timeoutPromise])`. On timeout, mark the plugin as failed, emit an escalation, and proceed per failure-mode.
   - Files to modify: `plugins/autonomous-dev/src/chains/executor.ts` (PLAN-022-1)
   - Acceptance criteria: A plugin that hangs for 130s is killed at 120s with `PluginTimeoutError`. Timeout is configurable per-plugin via the manifest's optional `timeout_seconds`. Tests use a fixture plugin that sleeps for a controlled duration.
   - Estimated effort: 3h

3. **Implement chain-length and artifact-size limits** -- Before executing, check that the topological order length is within `max_length`. After each plugin produces an artifact, check that the artifact size is within `max_artifact_size_mb`. Both check failures emit specific error types.
   - Files to modify: `plugins/autonomous-dev/src/chains/executor.ts`, `plugins/autonomous-dev/src/chains/artifact-registry.ts`
   - Acceptance criteria: Chain of length 12 with `max_length: 10` is rejected with `ChainTooLongError`. Artifact of 15MB with cap 10MB is rejected at persist time with `ArtifactTooLargeError`. The producer plugin's invocation is marked failed (does not crash the executor). Tests verify both limits.
   - Estimated effort: 2.5h

4. **Implement concurrent-chain cap** -- Maintain an in-memory counter of active chains per request. Before starting a new chain, check the counter. If at cap, queue or reject (configurable). Default behavior: reject with clear error (queueing is a future enhancement).
   - Files to modify: `plugins/autonomous-dev/src/chains/executor.ts`
   - Acceptance criteria: With `max_concurrent_chains: 3` and 3 already running, a 4th attempt is rejected with `ConcurrentChainLimitError`. After one completes, a new attempt is accepted. Tests use synthetic delays to simulate concurrent execution.
   - Estimated effort: 2h

5. **Implement per-declaration failure-mode** -- Extend `ProducesDeclaration` and `ConsumesDeclaration` (PLAN-022-1) with optional `on_failure: 'block'|'warn'|'ignore'`. Default is `warn` (current PLAN-022-1 behavior). Update `ChainExecutor` to honor the failure mode per declaration.
   - Files to modify: `plugins/autonomous-dev/schemas/plugin-manifest-v2.json` (extend declarations), `plugins/autonomous-dev/src/chains/executor.ts`
   - Acceptance criteria: A plugin with `on_failure: 'block'` that fails halts the entire chain. With `on_failure: 'warn'`, downstream is skipped (current behavior). With `on_failure: 'ignore'`, downstream continues. Tests cover each mode.
   - Estimated effort: 3h

6. **Author canonical `code-fixer` fixture plugin** -- Create `tests/fixtures/plugins/code-fixer/` with a manifest (`consumes: security-findings, produces: code-patches/requires_approval=true`) and a stub entry-point that reads findings, generates a placeholder patch (no actual code modification logic), and writes the artifact.
   - Files to create: `tests/fixtures/plugins/code-fixer/hooks.json`, `code-fixer.js`
   - Acceptance criteria: Plugin loads via PLAN-019-1's discovery. Plugin invocation produces a valid `code-patches` artifact validating against the schema. Patch entries have `requires_approval: true` set. Tests verify the plugin's output shape.
   - Estimated effort: 3h

7. **Implement human approval gate** -- After a plugin produces an artifact with `requires_approval: true`, the executor pauses the chain (saving state) and emits an escalation via TDD-009's escalation router. The chain resumes when the operator approves via CLI or portal.
   - Files to modify: `plugins/autonomous-dev/src/chains/executor.ts`
   - Acceptance criteria: When `code-fixer` emits patches with `requires_approval: true`, the chain pauses; an escalation is sent to the operator's notification channel; downstream plugins do not run until approval is granted. State is persisted (chain-id, paused-at-plugin) so daemon restarts don't lose context. Tests verify pause + resume.
   - Estimated effort: 4h

8. **Implement `chains approve` CLI subcommand** -- `autonomous-dev chains approve <artifact-id>` marks the artifact as approved (writes `approved.json` next to it) and resumes the paused chain. `chains reject <artifact-id> [--reason ...]` cancels the chain and logs the rejection.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/chains-approve.ts`, `chains-reject.ts`
   - Acceptance criteria: `chains approve VIO-123` marks the artifact and resumes the chain. `chains reject VIO-123 --reason "patches too risky"` cancels and logs. Both commands require admin authorization (per PRD-009). Tests cover both commands.
   - Estimated effort: 2.5h

9. **Implement trust integration** -- In `ChainExecutor`, before invoking each plugin, call PLAN-019-3's `TrustValidator.isTrusted(plugin.id)`. If untrusted, the plugin is skipped with an audit entry and `TrustValidationError`. For privileged chains (any consumes-with-`requires_approval: true` flow), additionally check `extensions.privileged_chains` allowlist contains the chain definition.
   - Files to modify: `plugins/autonomous-dev/src/chains/executor.ts`
   - Acceptance criteria: An untrusted producer is skipped (its consumers also skipped). A trusted plugin chained to an untrusted consumer halts at the consumer. A privileged chain not in `privileged_chains` allowlist is rejected even if individual plugins are trusted. Tests cover all three scenarios.
   - Estimated effort: 3h

10. **Telemetry integration** -- Emit `{chain_id, plugins[], duration_ms, artifacts[], outcome}` per chain execution to the metrics pipeline (TDD-007).
    - Files to modify: `plugins/autonomous-dev/src/chains/executor.ts`
    - Acceptance criteria: Each chain produces one telemetry event. Event shape matches the documented schema. Tests verify emission for both successful and failed chains.
    - Estimated effort: 1.5h

11. **Unit tests** -- `tests/chains/test-resource-limits.test.ts`, `test-failure-modes.test.ts`, `test-trust-integration.test.ts` covering all paths from tasks 2-5, 9. Use fixture plugins.
    - Files to create: three test files under `plugins/autonomous-dev/tests/chains/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on extended `executor.ts`. Tests use mocked timers for timeout scenarios (no real waiting).
    - Estimated effort: 4h

12. **Integration test: standards-to-fix end-to-end** -- `tests/integration/test-standards-to-fix.test.ts` per TDD §10: register `rule-set-enforcement-reviewer`, `code-fixer` (fixture from task 6), trigger via a code review on a fixture diff with a planted SQL injection, verify findings are emitted, code-fixer produces patches with `requires_approval: true`, escalation fires, `chains approve` resumes successfully.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-standards-to-fix.test.ts`
    - Acceptance criteria: Test passes deterministically (mocked agent responses). Each step in the documented flow occurs in order. Approval gate pauses execution until `chains approve` is called. Final state has all artifacts on disk and validates against schemas.
    - Estimated effort: 4h

## Dependencies & Integration Points

**Exposes to other plans:**
- Resource-limits config pattern reusable for any future bounded-execution context (e.g., custom evaluators in PLAN-021-2 follow the same pattern; this plan's design aligns with theirs).
- Failure-mode `block`/`warn`/`ignore` pattern shared with PLAN-019-4's hook system (intentional alignment).
- Approval-gate pattern (artifact persistence + escalation + CLI resume) reusable for any future human-in-the-loop chain step.
- `privileged_chains` allowlist pattern reusable for any future allowlist-style operator control.

**Consumes from other plans:**
- **PLAN-022-1** (blocking): manifest schema, artifact registry, dependency graph, executor base. This plan extends each.
- **PLAN-019-3** (existing on main): `TrustValidator` for per-plugin trust check.
- **PLAN-009-X** (existing on main): escalation router for human-approval notifications.
- TDD-007 / PLAN-007-X: telemetry pipeline.
- **PLAN-020-1** (existing on main): `rule-set-enforcement-reviewer` agent (the producer side of the canonical chain).

## Testing Strategy

- **Unit tests (task 11):** Resource limits, failure modes, trust integration. ≥95% coverage.
- **Integration test (task 12):** Standards-to-fix end-to-end including approval gate.
- **Adversarial tests:** Plugin that exceeds timeout, artifact that exceeds size cap, chain that exceeds length, untrusted plugin in mid-chain.
- **Approval-gate persistence test:** Daemon restart while a chain is paused should resume correctly when `chains approve` is called post-restart.
- **Manual smoke:** Real PR with a SQL injection violation; verify the full flow including operator approval via CLI.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Approval-gate state lost on daemon crash, leaving chains permanently paused | Medium | High -- operator can't resume | State persisted to `<request>/.autonomous-dev/chains/<chain-id>.state.json` via two-phase commit. On daemon restart, the state is loaded and pending approvals are restored to the escalation queue. Test verifies recovery. |
| Operator approves but the resume path has a bug, marking the chain as "applied" when downstream plugin failed | Low | High -- silent failure | Resume logic is idempotent and explicit: marks artifact approved → invokes downstream → checks downstream success → updates chain state. Each step has its own state file write. Recovery test covers partial-resume scenarios. |
| Privileged-chains allowlist too coarse (whole `producer:consumer` pair, no per-version tracking) | Medium | Medium -- new producer version not auto-allowed | Allowlist supports glob patterns: `rule-set-enforcement-reviewer:code-fixer@*` allows all versions. Operator can be specific: `...@1.x` for major-pinned. Documented in operator guide. |
| Per-plugin timeout interacts with hook execution timeouts (PLAN-019-4) creating compounding waits | Low | Low -- chain runs slower than expected | Chain executor's per-plugin timeout is independent of hook executor's per-hook timeout. They don't compound; each is a separate budget. Documented in JSDoc of both. |
| Concurrent-chain cap of 3 is too restrictive for repos with many simultaneous reviews | Medium | Low -- chains queue or reject | Cap is configurable per repo via `chains.max_concurrent_chains` override. Default is conservative; operators can raise after baseline data. |
| Large artifact (10MB) causes JSON parse to consume significant memory during validation | Medium | Medium -- daemon memory pressure | AJV validation streams in memory for large objects; 10MB is OK. Cap is configurable (`max_artifact_size_mb`). For larger artifacts (e.g., a binary patch file), use a separate "artifact-blob" field with on-disk reference. Future enhancement. |

## Definition of Done

- [ ] `chains` config section exists with all five fields and conservative defaults
- [ ] Per-plugin timeout enforced via `Promise.race`; configurable per manifest
- [ ] Chain-length, artifact-size, concurrent-chain limits enforced with specific error types
- [ ] `on_failure: 'block'|'warn'|'ignore'` declared per produces/consumes; executor honors each
- [ ] Canonical `code-fixer` fixture plugin demonstrates the standards-to-fix flow
- [ ] Human approval gate pauses chain on `requires_approval: true` artifact
- [ ] Approval state persists across daemon restarts
- [ ] `chains approve` and `chains reject` CLI subcommands work with admin auth
- [ ] Trust integration calls `TrustValidator.isTrusted()` before each plugin invocation
- [ ] Privileged-chains allowlist gates chains involving `requires_approval` artifacts
- [ ] Telemetry emits one event per chain execution
- [ ] Unit tests pass with ≥95% coverage on extended executor
- [ ] Integration test demonstrates standards-to-fix end-to-end (including approval pause/resume)
- [ ] No regressions in PLAN-022-1 functionality
