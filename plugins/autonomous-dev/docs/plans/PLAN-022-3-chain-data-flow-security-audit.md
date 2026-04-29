# PLAN-022-3: Chain Data Flow Security + HMAC-Chained Audit Log

## Metadata
- **Parent TDD**: TDD-022-plugin-chaining-engine
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: [PLAN-022-1, PLAN-022-2]
- **Priority**: P0

## Objective
Lock down the security boundary between chained plugins per TDD §12 and ship the HMAC-chained audit log per TDD §13. The data-flow security layer enforces strict schema validation on every artifact handoff (no extra fields, no field-name confusion across plugin boundaries, no injection attacks in artifact content), capability-scoped artifact reads (consumers can only read artifacts they declare), and signed artifacts when a producer plugin is in the privileged-chain allowlist. The audit log captures every chain execution event with HMAC chaining identical to PLAN-019-4's hook audit log, with `chains query` and `chains audit verify` CLI subcommands for forensics.

## Scope
### In Scope
- Strict schema enforcement at the consumer boundary per TDD §12.1: every artifact read by a consumer is re-validated against the consumer's declared `consumes.schema_version`. Even if the producer wrote an extended schema, the consumer only sees the declared shape (extra fields stripped via AJV `removeAdditional: 'all'` per PLAN-019-2's pattern)
- Capability-scoped artifact reads per TDD §12.2: each plugin can only read artifacts of types it declares in `consumes[]`. Attempts to read other artifact types (e.g., via filesystem traversal) are blocked at the `ArtifactRegistry.read()` boundary
- Producer integrity: a producer plugin's artifact is signed (HMAC-SHA256) using the request's chain key (derived from `BUDGET_HMAC_KEY`-style secret, or a dedicated `CHAIN_HMAC_KEY`); consumers verify the signature before accepting the artifact
- Sanitization at the artifact-content level per TDD §12.3: artifact fields containing user-supplied paths, URLs, or shell-metacharacter strings are validated against allowlists. Path traversal (`../`, absolute paths outside the request worktree), URL schemes outside `https://`, and shell metacharacters in fields not declared as `format: shell-command` are rejected
- Privileged-chain artifact signing per TDD §12.4: when both producer and consumer are in `privileged_chains` allowlist, the artifact additionally carries an Ed25519 signature from the producer plugin's signing key (PLAN-019-3's trusted-keys infrastructure)
- HMAC-chained audit log per TDD §13: every chain execution event (chain_started, plugin_invoked, plugin_completed, plugin_failed, artifact_emitted, approval_requested, approval_granted, approval_rejected, chain_completed, chain_failed) emits an entry to `~/.autonomous-dev/chains-audit.log` with HMAC chaining identical to PLAN-019-4's `audit.log`
- `autonomous-dev chains audit verify` CLI subcommand verifies the chain audit log's HMAC chain (analogous to PLAN-019-4's `audit verify`)
- `autonomous-dev chains audit query [--chain <id>] [--plugin <id>] [--since <ts>] [--type <event>]` for forensics
- Integration with PLAN-019-4's audit-writer: the chain audit log either lives in the same file (separated by event-type prefix) or in a separate file (separate HMAC chain). This plan implements the separate-file approach for clean separation; cross-correlation queries are handled by a wrapper subcommand
- Unit tests for: schema strictness at consumer boundary, capability-scoped reads, HMAC signature verification, sanitization rejection of malicious values
- Integration test: malicious producer attempts to leak data via extra fields, oversized values, and path traversal; all attempts are blocked

### Out of Scope
- Manifest, artifact registry, executor base, cycle detection -- delivered by PLAN-022-1
- Resource limits, standards-to-fix flow, trust integration, approval gate -- delivered by PLAN-022-2
- The trust validator and signature verifier themselves -- delivered by PLAN-019-3 (this plan reuses them)
- The hook system audit log -- delivered by PLAN-019-4 (this plan ships an analogous chain audit log)
- The `code-fixer` plugin's actual fix-generation logic — fixture from PLAN-022-2
- Cross-request artifact sharing (NG-2204)

## Tasks

1. **Implement strict-schema consumer boundary** -- In `ArtifactRegistry.read(consumer, artifactPath)`, validate the loaded artifact against the consumer's declared `consumes.schema_version` (not the producer's). Use AJV with `removeAdditional: 'all'` so extra fields produced by the producer are stripped before the consumer sees them.
   - Files to modify: `plugins/autonomous-dev/src/chains/artifact-registry.ts` (PLAN-022-1)
   - Acceptance criteria: Producer emits artifact with extra field `extra_data: 'leak'`; consumer reads the artifact and the loaded payload has `extra_data` stripped. Producer emits valid `1.1` schema; consumer declares `1.0` and sees only `1.0` fields. Test fixtures cover both extra-field stripping and version-compat narrowing.
   - Estimated effort: 3h

2. **Implement capability-scoped artifact reads** -- The `ArtifactRegistry.read()` API requires a `consumerPlugin` parameter. The function checks that the artifact_type being read appears in `consumerPlugin.consumes[]`. If not, throws `CapabilityError`.
   - Files to modify: `plugins/autonomous-dev/src/chains/artifact-registry.ts`
   - Acceptance criteria: Consumer A declared `consumes: ['security-findings']`. A.read('security-findings', ...) succeeds. A.read('code-patches', ...) throws `CapabilityError`. Tests cover the truth table.
   - Estimated effort: 2.5h

3. **Implement HMAC artifact signing** -- Producer's `ArtifactRegistry.persist()` adds an HMAC-SHA256 over canonical-JSON of the artifact (excluding the hmac field), signed with `CHAIN_HMAC_KEY` (derived from a dedicated env var or generated on first run like `AUDIT_HMAC_KEY`). Consumer's `read()` verifies the HMAC before parsing.
   - Files to modify: `plugins/autonomous-dev/src/chains/artifact-registry.ts`
   - Acceptance criteria: Persist appends `_chain_hmac` field. Read verifies the HMAC; tampered artifact is rejected with `ArtifactTamperedError`. Missing HMAC field on a chain artifact is rejected. Tests cover valid, tampered (mutated field), and missing-HMAC artifacts.
   - Estimated effort: 3h

4. **Implement Ed25519 signing for privileged chains** -- When both producer and consumer are in `extensions.privileged_chains[]` (PLAN-022-2), the producer additionally signs the artifact with its plugin signing key (per PLAN-019-3's trusted-keys infrastructure). Consumer verifies the signature against the producer's public key.
   - Files to modify: `plugins/autonomous-dev/src/chains/artifact-registry.ts`, `plugins/autonomous-dev/src/hooks/signature-verifier.ts` (extend with `verifyArtifact()` method)
   - Acceptance criteria: For a privileged chain, artifact has `_chain_signature` field. Consumer verifies against the producer's public key in `~/.claude/trusted-keys/`. Tampered or wrong-key signature fails. For non-privileged chains, signing is skipped. Tests cover privileged + valid, privileged + tampered, non-privileged (skipped).
   - Estimated effort: 4h

5. **Implement sanitization at the artifact-content level** -- Add `sanitizeArtifact(artifactType, payload)` that runs after schema validation. For fields with `format: 'path'`, reject path traversal and absolute paths outside the request worktree. For fields with `format: 'uri'`, reject schemes outside `https://`. For fields without `format: 'shell-command'`, reject shell metacharacters in string values.
   - Files to modify: `plugins/autonomous-dev/src/chains/artifact-registry.ts`
   - Files to create: `plugins/autonomous-dev/src/chains/sanitizer.ts`
   - Acceptance criteria: Artifact with `path: '../../../etc/passwd'` is rejected. `path: '/absolute/outside/worktree'` is rejected. `uri: 'http://example.com'` is rejected (https-only). String field containing `;` or `|` is rejected unless format=shell-command. Tests enumerate each sanitization rule.
   - Estimated effort: 4h

6. **Implement chain audit log writer** -- Create `src/chains/audit-writer.ts` that emits HMAC-chained entries to `~/.autonomous-dev/chains-audit.log`. Reuses the audit-writer pattern from PLAN-019-4 but writes to a separate file with its own HMAC chain. Entry types: chain_started, plugin_invoked, plugin_completed, plugin_failed, artifact_emitted, approval_requested, approval_granted, approval_rejected, chain_completed, chain_failed.
   - Files to create: `plugins/autonomous-dev/src/chains/audit-writer.ts`
   - Acceptance criteria: Each entry includes `ts`, `type`, `chain_id`, `payload`, `prev_hmac`, `hmac`. HMAC chain is intact across 1000 entries. Concurrent writes are serialized. Daemon restart resumes from the last entry's `hmac` correctly. Tests verify chain integrity and concurrent-write safety.
   - Estimated effort: 3h

7. **Wire audit-writer into chain executor** -- Every event in the chain lifecycle emits an audit entry. Builds on PLAN-022-2's chain executor.
   - Files to modify: `plugins/autonomous-dev/src/chains/executor.ts`
   - Acceptance criteria: A successful 3-plugin chain produces ≥10 entries (start + 3 invoked + 3 completed + 3 artifact_emitted + completed). A failed chain produces failure entries. An approval-gated chain produces approval_requested + approval_granted/rejected entries. Tests verify entry counts and types per scenario.
   - Estimated effort: 2h

8. **Implement `chains audit verify` and `chains audit query`** -- `verify` walks the chain audit log and recomputes HMACs. `query` filters by chain_id, plugin_id, since-timestamp, event-type. Both have JSON output mode.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/chains-audit.ts`
   - Acceptance criteria: `chains audit verify` exits 0 on a clean log, 1 on tampered. `chains audit query --chain CH-123` returns all entries for that chain. `--since 2026-04-01T00:00:00Z` filters by time. Combined filters are AND. Tests cover all flags.
   - Estimated effort: 2h

9. **Adversarial tests for data-flow security** -- `tests/chains/test-security-attacks.test.ts` covering: producer emits extra field (must be stripped); producer emits artifact with path traversal (must be rejected); producer mutates artifact post-write (HMAC fails on read); consumer attempts to read artifact-type outside its declared `consumes` (capability error); privileged chain with missing Ed25519 signature (rejected).
   - Files to create: `plugins/autonomous-dev/tests/chains/test-security-attacks.test.ts`
   - Acceptance criteria: All five attack vectors are blocked. Each test asserts the specific error type expected. Tests run in <5s.
   - Estimated effort: 3h

10. **Unit tests for sanitizer, signing, audit-writer** -- `tests/chains/test-sanitizer.test.ts`, `test-artifact-signing.test.ts`, `test-chain-audit.test.ts` covering all paths from tasks 1-6, 8.
    - Files to create: three test files under `plugins/autonomous-dev/tests/chains/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on `sanitizer.ts`, `audit-writer.ts`, extended `artifact-registry.ts`. Tests are deterministic.
    - Estimated effort: 3h

11. **Integration test: full secured chain** -- `tests/integration/test-chain-security.test.ts` that runs a privileged chain end-to-end with all security layers: HMAC signing, Ed25519 signing, schema strictness, capability scoping, audit log emission. Then runs a malicious-producer fixture that attempts each attack vector and verifies all are blocked.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-chain-security.test.ts`
    - Acceptance criteria: Happy-path chain completes with all security checks passing. Each malicious-producer scenario is blocked at the documented layer. Audit log shows the security violations.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- Strict-schema consumer boundary pattern reusable for any future plugin that consumes artifacts from another plugin.
- Capability-scoped artifact reads pattern reusable for any future capability-driven access control.
- HMAC + Ed25519 dual-signing pattern reusable for any future signed-artifact context.
- Sanitization rules (`path`, `uri`, `shell-command` formats) reusable for any future user-input validation.
- Chain audit log shape consumed by future observability dashboards.

**Consumes from other plans:**
- **PLAN-022-1** (blocking): manifest schema, artifact registry, dependency graph.
- **PLAN-022-2** (blocking): trust integration, privileged-chains allowlist, approval gate.
- **PLAN-019-2** (existing on main): AJV pattern reused for strict-schema consumer boundary.
- **PLAN-019-3** (existing on main): `signature-verifier` extended for artifact signatures.
- **PLAN-019-4** (existing on main): `AuditWriter` pattern reused for chain audit log.

## Testing Strategy

- **Unit tests (task 10):** Sanitizer rules, signing/verification, audit-writer. ≥95% coverage.
- **Adversarial tests (task 9):** Five attack vectors, each with its own test case and expected error.
- **Integration test (task 11):** Full secured chain end-to-end + malicious-producer scenarios.
- **Audit log integrity:** Generate 10,000 chain events, verify HMAC chain end-to-end. Tamper at random positions and assert detection.
- **Performance:** HMAC verification overhead <1ms per artifact read. Ed25519 verification overhead <2ms per artifact read for privileged chains. Captured as a perf benchmark.
- **Manual smoke:** Real privileged chain (rule-set-enforcement → code-fixer with approval) with audit log inspection at each step.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sanitization rules are too restrictive, blocking legitimate artifact content (e.g., a code-patch contains shell metacharacters because it's literally a shell script) | High | Medium -- breaks valid use cases | Schema-declared `format: shell-command` allows shell metacharacters in those fields. Default-deny with opt-in to permissive formats per field. Documented in artifact schema authoring guide. |
| HMAC chain key (`CHAIN_HMAC_KEY`) is lost, breaking artifact verification on subsequent runs | Medium | High -- chains can't resume | Same recovery procedure as PLAN-019-4's `AUDIT_HMAC_KEY` loss: log a CRITICAL warning, regenerate, write a "key rotation" entry. Existing artifacts become unverifiable; documented in operator guide. |
| Ed25519 signing latency adds noticeable delay for privileged chains | Low | Low -- ~2ms per artifact | Negligible at chain scale (≤10 plugins). Documented in performance section. |
| Capability-scoped reads break legitimate cases where a plugin needs to inspect "downstream" artifacts (e.g., for cleanup) | Low | Low -- workaround via explicit consumes declaration | Plugins can declare `consumes` for any type they want to read, not just for chain participation. Documented as the canonical pattern. |
| Strict-schema stripping (`removeAdditional: 'all'`) silently drops fields the consumer wanted to read but didn't declare in its schema | Medium | Medium -- consumer logic missing data | Consumer schema is the contract. If a consumer wants more fields, it must declare them. `x-allow-extensions` keyword (PLAN-019-2) provides escape hatch. |
| Audit log file grows unbounded, eating disk | Medium | Medium -- daemon stops writing | Same rotation policy as PLAN-019-4: 100MB cap, rotate to `.1`, `.2`, ..., `.10`. Configurable via `chains.audit_log.max_size_mb`. |

## Definition of Done

- [ ] `ArtifactRegistry.read()` validates against the CONSUMER's schema, stripping extras
- [ ] `ArtifactRegistry.read()` enforces capability scoping; rejects artifacts outside declared consumes
- [ ] HMAC signing protects all chain artifacts; tampered artifacts are rejected
- [ ] Ed25519 signing layer activates for privileged chains
- [ ] Sanitizer enforces path / URI / shell-metacharacter rules with format-based opt-in
- [ ] Chain audit log writer maintains HMAC chain across all entries
- [ ] Every chain lifecycle event emits an audit entry
- [ ] `chains audit verify` and `chains audit query` CLI subcommands work with JSON output
- [ ] All five adversarial attack vectors are blocked at the documented layer
- [ ] Unit tests pass with ≥95% coverage on new modules
- [ ] Integration test demonstrates full secured chain + malicious-producer rejection
- [ ] HMAC verification overhead <1ms per artifact read; Ed25519 <2ms
- [ ] No regressions in PLAN-022-1/2 functionality
