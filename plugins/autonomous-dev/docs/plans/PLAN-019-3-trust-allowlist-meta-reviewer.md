# PLAN-019-3: Plugin Trust, Allowlist & Agent-Meta-Reviewer Integration

## Metadata
- **Parent TDD**: TDD-019-extension-hook-system
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-019-1, PLAN-019-2]
- **Priority**: P0

## Objective
Deliver the trust enforcement layer that gates plugin execution: the operator-controlled allowlist in `~/.claude/autonomous-dev.json`, the three trust modes (`allowlist`, `permissive`, `strict`), cryptographic signature verification, the privileged-reviewer separate authorization, the multi-step validation order during plugin discovery and reload (per TDD §10.2), automatic agent-meta-reviewer invocation for high-privilege plugins (per TDD §10.3), and the runtime trust-state checks that block revoked plugins from executing. This plan ensures that no plugin can register or run without explicit operator approval, and that high-privilege plugins (writing outside `/tmp`, network access, child processes, privileged env vars, `block` failure mode for critical hooks) automatically trigger a security review before being trusted.

## Scope
### In Scope
- `extensions` config section in `~/.claude/autonomous-dev.json` per TDD §10.1: `allowlist[]`, `privileged_reviewers[]`, `trust_mode: allowlist|permissive|strict`, `signature_verification: bool`, `auto_update_allowed: bool`, `max_plugins_per_hook_point: number`, `global_resource_limits: {max_total_memory_mb, max_concurrent_executions, max_execution_time_seconds}`
- `TrustValidator` class at `src/hooks/trust-validator.ts` implementing the seven-step validation order from TDD §10.2: manifest syntax (delegates to PLAN-019-2), trust status check, signature verification, capability validation, agent-meta-reviewer audit, dependency resolution, registration
- Signature verification using Ed25519 keys (or RSA-PSS as fallback) per TDD §10.1: trusted signing keys live in `~/.claude/trusted-keys/`; manifests include a detached `hooks.json.sig`; verification is mandatory in `strict` mode, optional in `permissive`, off in `allowlist`-only mode
- `agent-meta-reviewer` invocation per TDD §10.3 for plugins matching ANY of: registers reviewer slot for `code-review` or `security-review`, declares `filesystem-write` outside `/tmp`, requests `network`, declares `privileged-env`, `allow_child_processes: true`, OR `failure_mode: block` on a critical hook point. The agent's verdict (PASS/FAIL with findings) is required to register the plugin.
- Runtime trust enforcement per TDD §10.4: every hook execution re-checks the plugin's trust status against the current config (so revocation takes effect immediately on next invocation, not just on reload)
- Resource budget enforcement: `global_resource_limits` are checked at registration (max plugins per hook point) and at execution (per-plugin memory and time caps via the sandbox layer; this plan defines the budgets but the actual enforcement is delegated to the sandbox plan)
- Audit log entries for every trust decision: registered, rejected (with reason), revoked, agent-meta-reviewer verdict
- CLI `autonomous-dev plugin trust <plugin-id>` and `autonomous-dev plugin revoke <plugin-id>` subcommands that update the config file (with backup) and trigger SIGUSR1 reload
- Unit tests for: each of the three trust modes, signature verification (valid/invalid/missing), agent-meta-reviewer trigger conditions (truth table from TDD §10.3), runtime revocation
- Integration test: install a fixture plugin requiring meta-review, verify the agent is invoked; install a fixture plugin signed with an untrusted key, verify rejection in strict mode

### Out of Scope
- The hook engine, registry, executor -- PLAN-019-1
- Schema validation pipeline -- PLAN-019-2
- Reviewer slot mechanics (multi-reviewer minimum, fingerprinting), sequential execution detail, audit log shape -- PLAN-019-4
- Sandbox runtime enforcement (worker_threads, capability isolation, resource caps) -- coordinated with PRD-001 sandbox plan; this plan defines the policies, the sandbox plan enforces them at runtime
- Plugin marketplace, key distribution, signing-as-a-service -- TDD-019 §17.4 open question, deferred
- Cross-plugin communication / message passing -- §17.2 open question, deferred
- Auto-update mechanism (`auto_update_allowed` is honored but auto-update logic itself is deferred)

## Tasks

1. **Extend config schema with `extensions` section** -- Update `~/.claude/autonomous-dev.json` schema (from PRD-007 / TDD-007) to include the `extensions` object per TDD §10.1. All fields have safe defaults: `trust_mode: 'allowlist'`, empty allowlists, `signature_verification: false`, `auto_update_allowed: false`, `max_plugins_per_hook_point: 5`, conservative resource limits.
   - Files to modify: `plugins/autonomous-dev/schemas/autonomous-dev-config.schema.json`, `plugins/autonomous-dev/config_defaults.json`
   - Acceptance criteria: A fresh `autonomous-dev config init --global` produces a config with the new `extensions` section. `autonomous-dev config validate` passes. Existing configs without the section are auto-upgraded with defaults on next save (forward compatibility). All defaults match TDD §10.1 documentation.
   - Estimated effort: 2h

2. **Author `TrustValidator` class** -- Create `src/hooks/trust-validator.ts` with a `validatePlugin(manifest)` method that runs the seven-step order from TDD §10.2 and returns `{trusted: bool, reason?: string, requiresMetaReview: bool}`. The class accepts a config snapshot at construction so it can be rerun against fresh config after SIGUSR1 reload.
   - Files to create: `plugins/autonomous-dev/src/hooks/trust-validator.ts`
   - Acceptance criteria: TypeScript compiles. Each of the seven steps is a separate private method that can be unit-tested in isolation. The class is pure (no side effects beyond logging); state lives in the registry. Order matches TDD §10.2 verbatim.
   - Estimated effort: 3h

3. **Implement allowlist mode** -- The trust check returns `trusted: true` only if `manifest.id` appears in `extensions.allowlist[]`. Plugins not on the allowlist are rejected with reason "not in allowlist".
   - Files to modify: `plugins/autonomous-dev/src/hooks/trust-validator.ts`
   - Acceptance criteria: With `trust_mode: 'allowlist'` and `allowlist: ['com.acme.foo']`, plugin `com.acme.foo` is trusted, plugin `com.acme.bar` is rejected with the documented reason. Empty allowlist rejects everything. Test cases enumerate the truth table.
   - Estimated effort: 1.5h

4. **Implement permissive mode** -- In `permissive` mode, signed plugins from any trusted signing key pass trust check (the allowlist is advisory). Unsigned plugins are still rejected unless `signature_verification: false`.
   - Files to modify: `plugins/autonomous-dev/src/hooks/trust-validator.ts`
   - Acceptance criteria: With `trust_mode: 'permissive'` and `signature_verification: true`, a signed plugin not on the allowlist is trusted. Unsigned plugin is rejected. With `signature_verification: false`, all plugins are trusted regardless of signature.
   - Estimated effort: 1.5h

5. **Implement strict mode** -- In `strict` mode, the plugin must be on the allowlist AND have a valid signature AND (for privileged reviewers) be on the `privileged_reviewers` allowlist. Failure of any check rejects.
   - Files to modify: `plugins/autonomous-dev/src/hooks/trust-validator.ts`
   - Acceptance criteria: With `trust_mode: 'strict'`, allowlisted + signed plugin passes. Allowlisted but unsigned plugin fails. Signed but not allowlisted fails. A plugin that registers a `code-review` reviewer slot but is not in `privileged_reviewers` fails with a specific reason. Truth table tests cover every combination.
   - Estimated effort: 2h

6. **Implement signature verification** -- Add `verifySignature(manifestPath, signaturePath, trustedKeys)` per TDD §10.1. Use `crypto.verify()` with Ed25519 (preferred) or RSA-PSS. Trusted public keys live as `.pub` files under `~/.claude/trusted-keys/`. The signature file is a sibling of `hooks.json` named `hooks.json.sig`.
   - Files to create: `plugins/autonomous-dev/src/hooks/signature-verifier.ts`
   - Acceptance criteria: A manifest signed with a key in `trusted-keys/` verifies. A manifest signed with an unknown key fails. A manifest with a corrupted signature fails. A manifest with no signature fails when `signature_verification: true`. Tests use fixture key pairs generated via `openssl genpkey`.
   - Estimated effort: 4h

7. **Implement agent-meta-reviewer trigger** -- Per TDD §10.3, after capability validation, check if the plugin matches ANY of the trigger conditions (reviewer slot for code/security review, fs write outside `/tmp`, network, privileged env, child processes, `failure_mode: block` on a critical hook point). If matched, invoke the `agent-meta-reviewer` agent with the manifest as input. The agent's verdict (PASS/FAIL) gates registration.
   - Files to modify: `plugins/autonomous-dev/src/hooks/trust-validator.ts`
   - Acceptance criteria: A plugin with `capabilities: ['network']` triggers meta-review. A plugin with only `capabilities: []` does not. The meta-reviewer is invoked via the existing agent-spawn helper (PLAN-005 / agent registry). The PASS verdict allows registration; FAIL blocks with the agent's findings recorded in the audit log. Test fixture plugins exercise each trigger condition.
   - Estimated effort: 4h

8. **Implement runtime trust enforcement** -- Modify `HookExecutor` (from PLAN-019-1) to call `trustValidator.isTrusted(plugin.id)` before each invocation. If trust has been revoked since the last reload, the hook is skipped and an audit entry is recorded. This catches operator revocations that haven't yet triggered a SIGUSR1 reload.
   - Files to modify: `plugins/autonomous-dev/src/hooks/executor.ts` (from PLAN-019-1)
   - Acceptance criteria: Adding a plugin to the allowlist, restarting the daemon, then removing it from the allowlist (without SIGUSR1) — the next hook invocation skips the plugin with a "trust revoked" log entry. Tests use a config-mutator helper to simulate revocation mid-test.
   - Estimated effort: 2h

9. **Implement `plugin trust` and `plugin revoke` CLI subcommands** -- Add `autonomous-dev plugin trust <id>` (adds to allowlist, optionally to `privileged_reviewers`) and `plugin revoke <id>` (removes from both lists). Both create a backup of the config file before mutation and trigger SIGUSR1 reload.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/plugin-trust.ts`
   - Acceptance criteria: `plugin trust com.acme.foo --privileged` adds the id to both lists. `plugin revoke com.acme.foo` removes from both. Config backup at `~/.claude/autonomous-dev.json.bak.<timestamp>` exists after each mutation. SIGUSR1 is sent on success. Both commands have JSON output mode.
   - Estimated effort: 2h

10. **Audit log integration** -- Every trust decision (registered, rejected with reason, runtime-revoked, meta-reviewer verdict) writes an entry to the audit log via the existing audit infrastructure (PLAN-019-4 will own the full audit log layout; this plan calls into the same writer). Entries include plugin id, version, decision, timestamp, reason.
    - Files to modify: `plugins/autonomous-dev/src/hooks/trust-validator.ts`, `plugins/autonomous-dev/src/hooks/executor.ts`
    - Acceptance criteria: Every trust path produces an audit entry. The entry shape conforms to the audit schema (placeholder until PLAN-019-4 finalizes it). Tests verify each path's entry.
    - Estimated effort: 2h

11. **Unit tests for trust modes, signature, meta-review trigger** -- `tests/hooks/test-trust-allowlist.test.ts`, `test-trust-permissive.test.ts`, `test-trust-strict.test.ts`, `test-signature.test.ts`, `test-meta-review-trigger.test.ts` covering all paths from tasks 3-7. Use fixture plugins and key pairs from `tests/fixtures/`.
    - Files to create: five test files under `plugins/autonomous-dev/tests/hooks/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on `trust-validator.ts` and `signature-verifier.ts`. Tests run in <10s total (Ed25519 is fast enough for unit-test scale).
    - Estimated effort: 4h

12. **Integration test: full discovery + trust + meta-review** -- `tests/integration/test-plugin-trust-flow.test.ts` that exercises the full pipeline: install three fixture plugins (one allowlisted + benign, one allowlisted + privileged triggering meta-review, one not allowlisted), start daemon, verify only plugins 1 and 2 register, verify plugin 2 went through meta-review, verify plugin 3 is rejected with a clear log entry.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-plugin-trust-flow.test.ts`
    - Acceptance criteria: Test passes deterministically (meta-reviewer is mocked to return PASS). All three audit log entries appear with correct decision values. Plugin 2's meta-review verdict is captured in the audit entry.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `TrustValidator` consumed by PLAN-019-4 (the executor's runtime check uses this).
- The `extensions` config section consumed by future tooling (e.g., portal page that displays trust state).
- Signature verification pattern (`~/.claude/trusted-keys/`, Ed25519, detached `.sig` files) reusable for any future signed-artifact use case.
- Audit-log entry shape used by PLAN-019-4's full audit infrastructure.
- `plugin trust` / `plugin revoke` CLI pattern for any future allowlist-style operator control.

**Consumes from other plans:**
- **PLAN-019-1** (blocking): `HookManifest`, `PluginDiscovery`, `HookRegistry`, `HookExecutor`. Trust validator runs as a step in discovery; runtime check runs in the executor.
- **PLAN-019-2** (blocking): `ValidationPipeline` for manifest syntax validation (the first step of TDD §10.2's seven-step order).
- TDD-005 / PLAN-005-X: existing agent-spawn helper for invoking the meta-reviewer.
- TDD-007 / PLAN-007-X: existing audit log infrastructure (this plan emits entries; PLAN-019-4 owns the full schema).

## Testing Strategy

- **Unit tests (task 11):** Each trust mode, signature verification, meta-review trigger truth table. ≥95% coverage.
- **Integration test (task 12):** Full discovery → trust → meta-review → registration flow with three fixture plugins.
- **Negative tests:** Rejection for each of the seven validation-order steps. Each rejection produces a specific audit entry.
- **Runtime revocation test:** Mutate config mid-flight, verify next hook invocation skips the revoked plugin without a daemon restart.
- **Manual smoke:** Sign a real fixture plugin with a generated Ed25519 key, install the public key in `~/.claude/trusted-keys/`, verify the plugin loads in `strict` mode.
- **Performance check:** Trust validation per plugin should complete in <50ms (Ed25519 verification is ~1ms; allowlist lookup is O(1)). Documented in the integration test.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Signature verification implementation has a subtle bug allowing unsigned/wrong-key plugins to pass | Low | Critical -- security hole | Use Node's built-in `crypto` module (`crypto.verify()`), no third-party crypto. Ed25519 is the modern default. Test suite includes adversarial fixtures: corrupted signature byte-by-byte, signature from wrong key, expired key (key removed from trusted-keys dir at verification time). |
| Agent-meta-reviewer is invoked during cold-start daemon boot, slowing startup unacceptably | Medium | Medium -- daemon takes minutes to come up | Meta-review is invoked only for high-privilege plugins (most fixtures don't trigger it). Results are cached in `~/.autonomous-dev/meta-review-cache/<plugin-id>-<version>.json` and reused if the manifest hasn't changed. Cache invalidation: any manifest version bump re-triggers review. Operators can pre-warm via `autonomous-dev plugin meta-review-prewarm`. |
| Runtime trust check on every invocation is too slow (50ms × 100 invocations/sec = 5s/sec overhead) | Medium | High -- significant perf hit | The check is O(1) hashmap lookup against the in-memory allowlist (NOT signature verification, which is amortized at registration time). Benchmark: 1µs per check. Documented in performance notes. |
| Operators add plugins to `privileged_reviewers` without going through meta-review | High | Medium -- privilege escalation | The meta-review trigger is INDEPENDENT of `privileged_reviewers` membership. Even an allowlisted, manually-trusted privileged plugin must pass meta-review. Documented in the trust-validator's JSDoc: "privileged_reviewers does NOT skip meta-review". |
| Config mutation race during SIGUSR1 reload corrupts the file | Low | High -- config lost | `plugin trust` / `plugin revoke` use atomic writes (temp file + rename). Backup is created before mutation. Documented recovery: restore from `~/.claude/autonomous-dev.json.bak.<timestamp>`. |
| Trusted-keys directory has permissive permissions, allowing local attacker to add keys | Medium | Critical -- attacker can sign their own malicious plugin | Daemon refuses to load if `~/.claude/trusted-keys/` is world-writable. Documented in the security section of the operator guide. CLI subcommand `autonomous-dev plugin keys add <pub.key>` sets correct perms (0700 on dir, 0600 on file). |

## Definition of Done

- [ ] `extensions` section added to config schema with documented defaults
- [ ] `TrustValidator` runs the seven-step order from TDD §10.2
- [ ] All three trust modes (`allowlist`, `permissive`, `strict`) work and have unit-test coverage of the truth table
- [ ] Signature verification accepts Ed25519 (or RSA-PSS) signatures from keys in `~/.claude/trusted-keys/`
- [ ] Agent-meta-reviewer is invoked for plugins matching any of the six trigger conditions in TDD §10.3
- [ ] Meta-review verdict (PASS/FAIL) gates plugin registration; cache prevents re-review on unchanged manifests
- [ ] Runtime trust check skips revoked plugins on next invocation without daemon restart
- [ ] `plugin trust` and `plugin revoke` CLI subcommands work and trigger SIGUSR1 reload
- [ ] Audit log entry is written for every trust decision
- [ ] Unit tests pass with ≥95% coverage on trust-validator and signature-verifier
- [ ] Integration test demonstrates full discovery → trust → meta-review → registration flow
- [ ] Daemon refuses to start if `~/.claude/trusted-keys/` has permissive permissions
- [ ] Trust validation per plugin completes in <50ms (excluding meta-review network round-trip)
- [ ] No regressions in PLAN-019-1 / PLAN-019-2 functionality
