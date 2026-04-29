# PLAN-019-4: Reviewer Slots + Sequential Execution + Audit Log

## Metadata
- **Parent TDD**: TDD-019-extension-hook-system
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: [PLAN-019-1, PLAN-019-2, PLAN-019-3]
- **Priority**: P0

## Objective
Complete the extension hook system by delivering: (1) the reviewer-slot mechanics that allow plugins to register custom AI reviewers (per TDD §11) with multi-reviewer minimum enforcement and verdict fingerprinting; (2) the sequential execution semantics within hook points (per TDD §12) covering priority ordering, context propagation, and failure-mode behavior (`block`/`warn`/`ignore`); (3) the comprehensive audit log (per TDD §14) that records every plugin lifecycle event, every hook execution, every reviewer verdict, and every trust decision with HMAC chaining for tamper detection. This plan finishes the hook system end-to-end, leaving only the sandbox runtime (coordinated separately with PRD-001) as a downstream enhancement.

## Scope
### In Scope
- `ReviewerSlot` interface in `src/hooks/types.ts` per TDD §11.1: `agent_name`, `review_gates[]`, `expertise_domains[]`, `minimum_threshold`, `fingerprint_format`
- Reviewer registration: when a hook with `reviewer_slot` is registered, the registry adds it to a separate `Map<ReviewGate, ReviewerSlot[]>` so the review-gate evaluator can find all custom reviewers per gate
- Multi-reviewer minimum enforcement per TDD §11.2: the `code-review` and `security-review` gates require at least 2 distinct reviewer plugins (configurable via `extensions.min_reviewers_per_gate`); if fewer are registered, the gate falls back to the built-in reviewers (PRD-004)
- Verdict fingerprinting per TDD §11.3: each reviewer's verdict is hashed (SHA-256 over `{plugin_id, plugin_version, agent_name, input_fingerprint, output_verdict}`) and recorded; identical inputs produce identical fingerprints (deterministic) so reviewer drift is detectable
- Plugin name and version in audit entries per TDD §11.4: every audit entry includes `{plugin_id, plugin_version}` for the contributing plugin (or `built-in` for autonomous-dev's own reviewers)
- Sequential execution per TDD §12.1: within a hook point, hooks run in priority order (descending). Each hook receives the output of the previous hook as part of its input context (chained), so later hooks can see and react to earlier results. Failure-mode behavior: `block` fails the entire hook-point execution; `warn` logs and continues; `ignore` silently continues.
- Audit log per TDD §14: append-only JSONL file at `~/.autonomous-dev/audit.log` with HMAC chaining (each entry includes `prev_hmac` of the previous entry, signed with `AUDIT_HMAC_KEY`). Entries are written via the existing audit-log writer (TDD-009 / PLAN-009-5 if it exists, otherwise this plan introduces it).
- `autonomous-dev audit verify` CLI subcommand that walks the audit log forward, verifies the HMAC chain, and reports any tampering. Exits 0 only if the chain is intact.
- `autonomous-dev audit query --plugin <id> --since <ts> --limit <n>` for operator forensics.
- Integration with PLAN-019-3's runtime trust check: every audit entry from trust enforcement uses this plan's writer.
- Unit tests for: priority ordering (already in PLAN-019-1, extended here for chained context), failure-mode behavior, fingerprint determinism, HMAC chain integrity, multi-reviewer minimum enforcement
- Integration test: register two reviewer plugins for `code-review`, run a review gate, verify both verdicts are captured with fingerprints; tamper with the audit log, verify `audit verify` reports the tampering

### Out of Scope
- The hook engine, registry, executor, validation pipeline, trust validator -- delivered by PLAN-019-1/2/3
- Sandbox runtime (worker_threads, capability isolation) -- coordinated with PRD-001 sandbox plan
- Reviewer agent prompt design (the `agent_name` references an existing agent registered via PLAN-005)
- Cross-plugin communication, dynamic registration, plugin marketplace -- TDD-019 §17 deferred
- Audit log forwarding to external SIEM systems -- separate observability plan
- Audit log retention/rotation policy -- ops concern, defaults provided here

## Tasks

1. **Author `ReviewerSlot` interface** -- Add to `src/hooks/types.ts` (from PLAN-019-1) the `ReviewerSlot` shape, `ReviewGate` enum (`code-review`, `security-review`, plus the document-review gates from PLAN-017-2), and the `Verdict` shape (`verdict: APPROVE|CONCERNS|REQUEST_CHANGES`, `score: number`, `findings: Finding[]`, `fingerprint: string`).
   - Files to modify: `plugins/autonomous-dev/src/hooks/types.ts`
   - Acceptance criteria: Types compile. `ReviewerSlot` matches TDD §11.1 verbatim. JSDoc cross-references TDD §11.
   - Estimated effort: 1.5h

2. **Extend `HookRegistry` with reviewer-slot lookup** -- Add `getReviewersForGate(gate)` method that returns all registered `ReviewerSlot` entries whose `review_gates` includes `gate`. Maintains a separate `Map<ReviewGate, ReviewerSlot[]>` index for O(1) lookup.
   - Files to modify: `plugins/autonomous-dev/src/hooks/registry.ts`
   - Acceptance criteria: Registering a hook with `reviewer_slot.review_gates: ['code-review']` makes it discoverable via `getReviewersForGate('code-review')`. Unregistering the plugin removes it from both the hook-point and review-gate indices. Test verifies isolation across multiple gates.
   - Estimated effort: 2h

3. **Implement multi-reviewer minimum enforcement** -- Modify the review-gate evaluator (existing in `bin/score-evaluator.sh` or wherever PRD-004 reviewers run) to consult `getReviewersForGate(gate)`. If `count < extensions.min_reviewers_per_gate` (default 2 for `code-review` and `security-review`), fall back to the built-in reviewers and log a warning. Otherwise, invoke each plugin reviewer and aggregate the verdicts.
   - Files to modify: `plugins/autonomous-dev/bin/score-evaluator.sh` (or the TS equivalent if it exists)
   - Acceptance criteria: With one plugin reviewer for `code-review` and `min_reviewers_per_gate: 2`, the gate falls back to built-in. With two plugin reviewers, both are invoked. The configuration override (`min_reviewers_per_gate: 1`) allows single-plugin reviewing. Test cases cover the truth table.
   - Estimated effort: 3h

4. **Implement verdict fingerprinting** -- Per TDD §11.3, each verdict's fingerprint is `sha256(json.stringify({plugin_id, plugin_version, agent_name, input_fingerprint, output_verdict}))` where `input_fingerprint` is the SHA-256 of the canonical-JSON input. Identical inputs produce identical fingerprints so drift across reviewer iterations is detectable.
   - Files to create: `plugins/autonomous-dev/src/hooks/fingerprint.ts`
   - Acceptance criteria: Two consecutive reviews of the same input by the same plugin produce identical fingerprints. Changing any field in the input (even whitespace, before canonicalization) produces a different fingerprint. Two different plugins reviewing the same input produce different fingerprints. Test enumerates determinism cases.
   - Estimated effort: 3h

5. **Implement sequential execution with chained context** -- Update `HookExecutor.executeHooks()` so that within a hook point, the i-th hook receives `{originalContext, previousResults: results[0..i-1]}` as input. The executor passes the chained context to each hook in priority order. Failures propagate per the failure-mode rules (task 6).
   - Files to modify: `plugins/autonomous-dev/src/hooks/executor.ts`
   - Acceptance criteria: Three hooks at priorities 100, 75, 50 — the 75 hook sees `previousResults: [result_of_100]`, the 50 hook sees `previousResults: [result_of_100, result_of_75]`. Tests use fixture hooks that record what they saw.
   - Estimated effort: 3h

6. **Implement failure-mode semantics** -- Per the manifest's `failure_mode` field per hook entry: `block` causes the hook-point execution to abort with the failure, propagating to the daemon; `warn` logs the failure and continues with the next hook; `ignore` silently continues. The aggregated result includes a `failures[]` array listing all warn/ignore failures so callers can audit even when execution proceeded.
   - Files to modify: `plugins/autonomous-dev/src/hooks/executor.ts`
   - Acceptance criteria: A `block`-mode hook that throws aborts the executor with the error. A `warn`-mode hook that throws is logged at WARN level and skipped; iteration continues. An `ignore`-mode hook that throws is silently skipped. The result object's `failures[]` includes warn and ignore failures (not block, since block aborts). Tests cover all three modes.
   - Estimated effort: 3h

7. **Author audit log writer** -- Create `src/audit/audit-writer.ts` that maintains an open append-only file handle to `~/.autonomous-dev/audit.log`. Each entry is one line of canonical JSON containing `{ts, type, payload, prev_hmac, hmac}`. The HMAC is computed over `prev_hmac + canonical_json(payload)` using `AUDIT_HMAC_KEY` (env var, generated on first run if absent). The first entry has `prev_hmac: "GENESIS"`.
   - Files to create: `plugins/autonomous-dev/src/audit/audit-writer.ts`
   - Acceptance criteria: Writing 1000 entries produces 1000 lines, each with a non-empty HMAC and the previous entry's HMAC as `prev_hmac`. Concurrent writes from multiple promises are serialized (single fd, with a mutex). File is opened with `O_APPEND` so crashes don't corrupt mid-line. `AUDIT_HMAC_KEY` is auto-generated to a 32-byte hex string on first run, stored in `~/.autonomous-dev/audit-key` with mode 0600.
   - Estimated effort: 4h

8. **Wire audit-writer into all hook events** -- Every plugin lifecycle event (registered, rejected, runtime-revoked) from PLAN-019-3 and every hook invocation (success/warn/ignore failure/block failure) from this plan emits an audit entry with the appropriate type. Trust decisions, meta-review verdicts, and reviewer-slot verdicts also emit entries.
   - Files to modify: `plugins/autonomous-dev/src/hooks/trust-validator.ts`, `plugins/autonomous-dev/src/hooks/executor.ts`
   - Acceptance criteria: After registering one plugin, invoking one hook (success), and revoking the plugin, the audit log has at least three entries: `{type: 'plugin_registered'}`, `{type: 'hook_invoked', plugin: ..., outcome: 'success'}`, `{type: 'plugin_revoked'}`. Each entry's HMAC chain is intact (no breaks).
   - Estimated effort: 3h

9. **Implement `audit verify` CLI subcommand** -- `autonomous-dev audit verify` walks `~/.autonomous-dev/audit.log` line by line, recomputes each HMAC, and reports any mismatches. Exits 0 if intact, 1 if tampered. JSON output mode emits the line numbers of any tampered entries.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/audit-verify.ts`
   - Acceptance criteria: A clean audit log produces "Verified N entries; chain intact" and exit 0. Modifying any byte in any entry produces "Tampered entry at line K" and exit 1. Test fixtures include both clean and tampered logs.
   - Estimated effort: 2h

10. **Implement `audit query` CLI subcommand** -- `autonomous-dev audit query [--plugin <id>] [--since <ISO-timestamp>] [--type <event-type>] [--limit <n>] [--json]` for operator forensics. Filters and projects fields from the audit log.
    - Files to create: `plugins/autonomous-dev/src/cli/commands/audit-query.ts`
    - Acceptance criteria: `audit query --plugin com.acme.foo --limit 10` returns the 10 most recent entries for that plugin in tabular form. `--json` emits JSONL. `--since 2026-04-01T00:00:00Z` filters by timestamp. Combining filters works (AND semantics). Test exercises all flags.
    - Estimated effort: 2h

11. **Unit tests for sequential execution and audit** -- `tests/hooks/test-executor-sequential.test.ts`, `test-failure-modes.test.ts`, `test-fingerprint.test.ts`, `test-audit-writer.test.ts`, `test-audit-verify.test.ts` covering all paths from tasks 4, 5, 6, 7, 9. Use fixture hooks and synthetic audit logs.
    - Files to create: five test files under `plugins/autonomous-dev/tests/hooks/` and `tests/audit/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on `executor.ts` (extended), `fingerprint.ts`, `audit-writer.ts`. Audit verify tests use both clean and tampered fixtures. Tests run in <10s total.
    - Estimated effort: 4h

12. **Integration test: full review-gate flow with audit** -- `tests/integration/test-reviewer-slot-flow.test.ts` that registers two reviewer plugins for `code-review`, runs a review gate against a fixture diff, asserts both reviewers were invoked, asserts both verdicts are in the audit log with non-empty fingerprints, then tampers with the audit log and asserts `audit verify` detects the tampering.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-reviewer-slot-flow.test.ts`
    - Acceptance criteria: Test passes deterministically. Audit log has at least 4 entries (2 hook-invoked + 2 reviewer-verdict). Tampering test mutates a single byte and confirms `audit verify` exits 1 with the right line number.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `ReviewerSlot` and `Verdict` types consumed by future plans that integrate custom reviewers (e.g., a future PRD-004 v2 that bridges built-in and plugin reviewers).
- `AuditWriter` class reused by any future component that needs append-only HMAC-chained logging (e.g., approval-gate decisions in PRD-009, kill-switch events).
- `audit verify` and `audit query` CLI patterns for any future audit surface.
- Sequential-execution context-chaining contract that hook authors must follow.

**Consumes from other plans:**
- **PLAN-019-1** (blocking): `HookExecutor`, `HookRegistry`, types.
- **PLAN-019-2** (blocking): `ValidationPipeline` for input/output validation around each sequential hook invocation.
- **PLAN-019-3** (blocking): `TrustValidator` for runtime trust check before each invocation; trust-decision events that flow into this plan's audit log.
- TDD-009 / PLAN-009-X: existing escalation/notification infrastructure for `block`-mode failures.
- PRD-004 / TDD-004: existing review-gate evaluator that this plan extends with multi-reviewer logic.

## Testing Strategy

- **Unit tests (task 11):** Sequential execution, failure modes, fingerprint determinism, audit writer integrity, audit verify detection. ≥95% coverage.
- **Integration test (task 12):** Full review-gate flow with two plugin reviewers + audit-log tamper detection.
- **Determinism check:** Fingerprint tests run the same input through the same plugin 100 times; assert all fingerprints are identical.
- **HMAC chain integrity:** Generate 10,000 audit entries, verify the chain end-to-end. Tamper with entries at positions 100, 5000, 9999 and assert all three are detected.
- **Concurrency test:** 100 concurrent writers (Promise.all) producing audit entries. Final log has exactly 100 entries with intact HMAC chain.
- **Manual smoke:** Real plugin registers a reviewer, runs against a real PR diff, audit log entries are spot-checked for sanity.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `block`-mode failure aborts the entire daemon iteration, leading to stuck requests | Medium | High -- requests don't progress | The block applies to the hook-point execution, not the daemon iteration. Daemon catches the block, marks the request as `failed`, raises an escalation, and continues with the next request. Documented in the executor's JSDoc. |
| Verdict fingerprint includes timestamps or other non-determinism, breaking determinism test | Medium | Medium -- drift detection becomes unreliable | The fingerprint excludes any field that varies across runs. The `output_verdict` is the verdict + score + findings — no timestamp. Test that runs the same input 100× must produce 100 identical fingerprints. |
| Audit log fills the disk over long uptime | High | High -- daemon stops writing | Default rotation policy: 100MB cap, rotate to `audit.log.1`, `.2`, ..., `.10` (max 1GB total). Old rotations are gzipped. Operator can configure via `extensions.audit_log.max_size_mb`. Documented in the operator guide. |
| HMAC key is lost (operator deletes `~/.autonomous-dev/audit-key`), breaking chain verification on subsequent runs | Medium | High -- no audit forensics possible after key loss | On startup, daemon checks for the key file. If missing, it logs a CRITICAL warning, generates a new key, and writes a "key rotation" entry as the first entry (with `prev_hmac: "GENESIS"`, since the chain is broken). `audit verify` reports the chain as having two segments separated by the rotation. |
| `audit verify` is too slow on large logs (10M entries) for routine operator use | Low | Low -- only run periodically | Verification is O(n) but each entry is microseconds. 10M entries take ~30s. Acceptable for nightly forensic runs. Operator guide recommends running daily as part of cron, not interactively. |
| Multi-reviewer minimum forces operators to install ≥2 plugin reviewers when they only want one | Low | Low -- ergonomics | The minimum is configurable via `extensions.min_reviewers_per_gate`. Default of 2 is conservative; operators can lower to 1 if they accept the trade-off. Documented in the operator guide. |
| Sequential execution context chaining means a slow hook delays all downstream hooks (no parallelism) | High | Medium -- hook-point latency grows with N | Sequential execution is intentional (TDD §12.1) so each hook can react to predecessors. Operators can manage by setting `priority` carefully and by enforcing per-hook timeouts (capabilities → resource limits). Documented in the hook-author guide. |

## Definition of Done

- [ ] `ReviewerSlot`, `ReviewGate`, `Verdict` types match TDD §11
- [ ] `HookRegistry.getReviewersForGate()` returns the right reviewers per gate
- [ ] Multi-reviewer minimum enforcement falls back to built-in when below threshold
- [ ] Verdict fingerprinting is deterministic across identical inputs
- [ ] Sequential execution chains context (`previousResults[]`) per priority order
- [ ] Failure-mode semantics (`block`/`warn`/`ignore`) work as specified in TDD §12
- [ ] Audit log writer maintains HMAC chain across all entries
- [ ] `AUDIT_HMAC_KEY` is auto-generated on first run with secure permissions
- [ ] `audit verify` detects single-byte tampering at any position in the log
- [ ] `audit query` filters by plugin, since-timestamp, type, and limit
- [ ] All hook lifecycle events, trust decisions, and reviewer verdicts emit audit entries
- [ ] Unit tests pass with ≥95% coverage on extended executor, fingerprint, audit-writer
- [ ] Integration test demonstrates full review-gate flow with audit + tamper detection
- [ ] Concurrent writes (100 simultaneous) produce intact HMAC chain
- [ ] No regressions in PLAN-019-1/2/3 functionality
- [ ] Operator guide documents audit log layout, rotation policy, and verify/query workflows
