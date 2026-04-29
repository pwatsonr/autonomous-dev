# PLAN-024-3: Per-Process Egress Firewall + Trust Integration + Cost Estimation

## Metadata
- **Parent TDD**: TDD-024-cloud-backends-credential-proxy
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-024-1, PLAN-024-2]
- **Priority**: P0

## Objective
Complete the cloud backend security model by delivering: (1) a per-process egress firewall per TDD §8 that restricts each cloud-backend child process to its declared allowlist of API endpoints (Linux: nftables; macOS: pfctl); (2) trust integration per TDD §9 that gates each cloud backend's plugin registration on the privileged-backends allowlist plus agent-meta-reviewer audit; (3) cost estimation per TDD §10 with per-cloud heuristics that emit `estimated_cost_usd` for each `deploy()` call into PLAN-023-3's cost ledger. Together these layers ensure a malicious or buggy cloud-backend plugin cannot exfiltrate data to an attacker's host (egress firewall), cannot register without operator consent + security review (trust), and cannot run up unexpected cloud bills (cost estimation feeding caps).

## Scope
### In Scope
- Per-process egress firewall per TDD §8: Linux uses nftables to restrict child PID's outbound traffic to the cloud provider's API endpoints; macOS uses pfctl with similar rules. Other platforms (Windows): documented as unsupported, daemon refuses to launch privileged backends.
- Allowlist source: each cloud-backend plugin's `plugin.json` declares `egress_allowlist[]` with FQDNs (e.g., `ecs.us-east-1.amazonaws.com`, `*.googleapis.com`). FQDNs resolved to IP ranges at process spawn; rules applied per PID.
- DNS resolution refresh: a background loop re-resolves FQDNs every 5 minutes and updates rules (cloud IPs change frequently). Stale rules expire 1 hour after last seen.
- Linux nftables implementation per TDD §8: `nft add table ip autonomous-dev-egress`, per-PID chains via `meta cgroup` matching. Daemon runs as root or has CAP_NET_ADMIN.
- macOS pfctl implementation: per-UID anchor with `pf.conf` rules. Less granular than nftables but functionally equivalent for the allowlist use case.
- Linux fallback when nftables unavailable: documented warning; backend launches without egress restriction (operator opt-in via `extensions.allow_unfirewalled_backends: true`).
- Trust integration per TDD §9: every cloud-backend plugin must (a) appear in `extensions.privileged_backends[]` (set up by PLAN-024-2) and (b) have passed the agent-meta-reviewer (PLAN-019-3) check. Without both, registration is rejected.
- Cost estimation per TDD §10: each cloud backend implements `estimateDeployCost(params)` returning `{estimated_cost_usd, breakdown[], confidence}`. Estimation uses per-cloud heuristics (e.g., AWS ECS: `tasks * vcpu_hours * $0.04048` for Fargate). Confidence reflects how stable the estimate is (0.9 for fixed-price services, 0.5 for usage-based).
- Cost-estimate flow into PLAN-023-3's cost ledger: every cloud `deploy()` records the estimate; actuals (when known via cloud billing API) update the ledger entry post-deploy
- Integration with PLAN-023-3's cost-cap enforcement: pre-deploy check uses `estimated_cost_usd`; post-deploy reconciliation uses actuals for the next budget window
- CLI `autonomous-dev deploy estimate --env <env>` previews the estimated cost without deploying
- Unit tests for: egress firewall rule generation per platform, allowlist enforcement, cost estimation per cloud (validated against pricing fixtures)
- Integration test: spawn a privileged-backend child process; attempt to connect to a non-allowlisted endpoint; verify connection blocked

### Out of Scope
- Cloud backend implementations -- delivered by PLAN-024-1
- CredentialProxy implementation -- delivered by PLAN-024-2
- Trust validator and agent-meta-reviewer -- existing in PLAN-019-3
- Cost ledger and cost-cap enforcement -- delivered by PLAN-023-3 (this plan emits estimates and actuals; PLAN-023-3 does the aggregation and cap)
- Cloud-billing API integration for actuals (the cloud backend's `getActualCost(record)` method is a future enhancement; for v1, actuals are captured manually or via the cloud's own billing exports)
- Cross-cloud cost normalization (USD vs other currencies) — USD only for v1
- Service-mesh-level egress controls (the per-process firewall is process-bound, not service-bound)
- Plugin marketplace approval workflow

## Tasks

1. **Author egress allowlist schema** -- Extend the cloud-backend plugin manifest (PLAN-024-1) with `egress_allowlist[]` field. Each entry: FQDN string (with optional `*` wildcard prefix), optional `port` (default 443), optional `protocol` (default `tcp`).
   - Files to modify: `plugins/autonomous-dev/schemas/plugin-manifest-v2.json` (extend with `egress_allowlist`)
   - Acceptance criteria: AWS plugin manifest declares `egress_allowlist: ['ecs.*.amazonaws.com', 'ecr.*.amazonaws.com', 'sts.amazonaws.com']`. Schema validates. Wildcard FQDN handled correctly.
   - Estimated effort: 1.5h

2. **Implement Linux nftables firewall** -- Create `src/firewall/nftables.ts` with `applyRulesForPid(pid, allowlist)`. Resolves FQDNs to IPs, creates per-PID nftables rules using `meta cgroup` matching. Removes rules when the PID exits.
   - Files to create: `plugins/autonomous-dev/src/firewall/nftables.ts`
   - Acceptance criteria: For PID 12345 with allowlist `['ecs.us-east-1.amazonaws.com']`, nftables rules permit outbound traffic to the resolved IPs and reject others. PID exit triggers rule removal. Tests use a fixture daemon process and verify `nft list table` output.
   - Estimated effort: 6h

3. **Implement macOS pfctl firewall** -- Create `src/firewall/pfctl.ts` with the same interface. Uses per-UID anchor with `pf.conf` rules. Less granular than nftables (no per-PID), but per-UID works for spawned child processes that have a unique effective UID.
   - Files to create: `plugins/autonomous-dev/src/firewall/pfctl.ts`
   - Acceptance criteria: For UID 502 (the plugin child's effective UID) with allowlist, pfctl rules permit allowlisted traffic and reject others. Rules removed when the UID exits all processes. Tests on a macOS CI runner verify `pfctl -s rules` output.
   - Estimated effort: 5h

4. **Implement DNS refresh loop** -- Background timer re-resolves FQDNs every 5 minutes; updates rules as IPs change. Stale rules expire 1 hour after last seen.
   - Files to modify: `plugins/autonomous-dev/src/firewall/nftables.ts`, `pfctl.ts`
   - Acceptance criteria: A FQDN whose IP changes mid-deploy gets the new IP added to rules. The old IP remains for 1h then expires. Tests use mocked DNS responses.
   - Estimated effort: 3h

5. **Wire firewall into session-spawn for cloud backends** -- The session-spawner (PLAN-018-2 / PLAN-024-2) checks if the spawned backend declares `egress_allowlist`. If yes, applies the firewall after the child PID is known but before exec. On Linux without nftables, refuses to launch unless `allow_unfirewalled_backends: true`.
   - Files to modify: `plugins/autonomous-dev/src/sessions/session-spawner.ts`
   - Acceptance criteria: AWS backend spawned with allowlist gets nftables rules applied before its first network call. Without nftables on Linux, spawn fails with clear error pointing to the operator opt-in. Tests cover both paths.
   - Estimated effort: 3h

6. **Implement trust integration** -- Cloud-backend plugin registration goes through the existing PLAN-019-3 trust validator AND additionally checks the privileged-backends allowlist. The agent-meta-reviewer is invoked automatically because cloud backends declare `capabilities: ['network', 'privileged-env']` (which already triggers meta-review per PLAN-019-3).
   - Files to modify: `plugins/autonomous-dev/src/hooks/trust-validator.ts` (PLAN-019-3) — extend to also check `privileged_backends` for cloud-backend-typed plugins
   - Acceptance criteria: A cloud backend not in `privileged_backends` is rejected. With privileged_backends membership but failing meta-review, also rejected. Both passing → registered. Tests cover all three cases.
   - Estimated effort: 2h

7. **Implement per-cloud cost estimation** -- Each cloud backend gains an `estimateDeployCost(params)` method. AWS: ECS task count × vcpu hours × Fargate rate; ECR: storage GB × $0.10/month + push transfers. GCP: Cloud Run requests × $0.40/million + CPU/memory hours. Azure: Container Apps consumption metric × rate. K8s: variable (depends on cluster); reports $0 with confidence 0.0 (cluster cost is the operator's concern).
   - Files to modify: 4 backend files in `plugins/autonomous-dev-deploy-*/src/backend.ts`
   - Acceptance criteria: For an AWS deploy with 2 ECS tasks for 1 hour at 0.5 vCPU each, estimate is ~$0.04. For GCP with 1M Cloud Run requests, estimate is ~$0.40. K8s returns $0 with confidence 0.0 and a "cluster billing not estimated" note. Tests use pricing fixtures.
   - Estimated effort: 6h

8. **Wire cost estimates into deploy flow** -- The deploy orchestrator (PLAN-023-2/3) calls `estimateDeployCost(params)` before invoking `deploy()`. The estimate flows into the cost ledger entry (PLAN-023-3). Pre-deploy cost-cap check uses the estimate.
   - Files to modify: `plugins/autonomous-dev/src/deploy/orchestrator.ts` (existing in PLAN-023-2)
   - Acceptance criteria: Every cloud deploy emits a ledger entry with `estimated_cost_usd` populated. Daily cap pre-check uses the estimate. Test with a $50 estimate against a $100 daily cap allows deploy; against a $40 cap rejects with clear message.
   - Estimated effort: 2.5h

9. **Implement `deploy estimate` CLI** -- `autonomous-dev deploy estimate --env <env>` previews the cost estimate without deploying. JSON mode emits the breakdown.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/deploy-estimate.ts`
   - Acceptance criteria: `deploy estimate --env staging` shows the resolved backend, parameters, and cost estimate with breakdown. `--env prod` similarly. JSON mode emits structured data. Tests cover both modes.
   - Estimated effort: 1.5h

10. **Document threat model** -- Author `docs/security/cloud-backend-threat-model.md` per TDD §14 covering: privileged-plugin compromise (mitigation: trust + meta-review + privileged_backends + egress firewall + scoped creds), credential exfiltration (mitigation: 15-min TTL + cloud-side audit), excessive cloud spend (mitigation: cost estimates + per-env caps + daily cap), supply-chain attack on cloud SDK (mitigation: pinned versions + Dependabot review). Each threat has a documented mitigation chain.
    - Files to create: `plugins/autonomous-dev/docs/security/cloud-backend-threat-model.md`
    - Acceptance criteria: Document covers at least 6 threat scenarios with mitigation chains. Each mitigation references the specific PLAN that delivers it. Reviewed by an external security reviewer before merge.
    - Estimated effort: 4h

11. **Unit tests for firewall and cost estimation** -- `tests/firewall/test-nftables.test.ts`, `test-pfctl.test.ts`, `tests/deploy/test-cost-estimation.test.ts` covering all paths.
    - Files to create: three test files
    - Acceptance criteria: All tests pass. Coverage ≥90% on firewall and cost-estimation modules. Linux-specific tests skip on macOS and vice versa.
    - Estimated effort: 4h

12. **Integration test: egress firewall enforcement** -- `tests/integration/test-egress-blocked.test.ts` that spawns a fixture privileged backend with a tight allowlist (only `httpbin.org`), then has the backend attempt to connect to `evil.example.com`. Verifies the connection is blocked at the firewall layer.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-egress-blocked.test.ts`
    - Acceptance criteria: Fixture backend's connection to non-allowlisted host fails with `ECONNREFUSED` or `ETIMEDOUT` (depending on platform). Connection to allowlisted host succeeds. Test runs only on Linux/macOS in CI; Windows skipped.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- Per-process egress firewall pattern reusable for any future privileged child process beyond cloud backends.
- Cost estimation method on `DeploymentBackend` interface; future custom backends inherit this contract.
- Threat-model document as the canonical reference for the cloud subsystem's security posture.

**Consumes from other plans:**
- **PLAN-024-1** (blocking): cloud backends declare `egress_allowlist` and implement `estimateDeployCost`.
- **PLAN-024-2** (blocking): privileged-backends allowlist set up; this plan adds the additional checks.
- **PLAN-019-3** (existing on main): trust validator extended for cloud backends; agent-meta-reviewer invoked automatically per `capabilities` declaration.
- **PLAN-023-2** (existing on main): deploy orchestrator calls `estimateDeployCost` before invocation.
- **PLAN-023-3** (existing on main): cost ledger consumes estimates and actuals; cost-cap pre-check uses estimates.
- **PLAN-018-2** (existing on main): session-spawner extended to apply firewall before exec.

## Testing Strategy

- **Unit tests (task 11):** Firewall rule generation, allowlist enforcement, cost estimation per cloud. ≥90% coverage.
- **Integration test (task 12):** Real egress block on Linux/macOS using a fixture backend.
- **Negative tests:** Non-firewalled cloud backend on Linux without `allow_unfirewalled_backends` opt-in is rejected. Cost estimate exceeding daily cap rejects deploy. DNS refresh updates rules correctly.
- **Adversarial tests:** Backend attempts to exfiltrate data to an attacker host; verify blocked. Backend attempts to evade firewall via DNS over HTTPS (DoH); verify the FQDN is not in the allowlist so DoH-resolved IPs aren't allowed.
- **Performance:** Firewall rule application <100ms per backend spawn. Cost estimation <50ms per call.
- **Manual smoke:** Real cloud deploys with cost estimate validation against the cloud's billing console.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| nftables on some Linux distros doesn't support `meta cgroup` matching, forcing fallback to per-UID | Medium | Medium -- coarser-grained firewall | The fallback per-UID is functionally equivalent for the privileged-backend use case (each backend has a unique UID via `setuid` in the spawn helper). Documented as the supported configuration. |
| pfctl on macOS is being deprecated by Apple in favor of `nfilter` | High | Medium -- macOS support breaks in future macOS releases | Documented in operator guide. macOS support is best-effort; primary target is Linux for production deploys. Long-term: explore `nfilter` adoption when stable. |
| Cost estimate diverges significantly from actuals (e.g., 50% off) | High | Medium -- cap fires late or false-fails | Confidence score on each estimate (0-1) helps operators know when to trust. Backends update estimates with actuals when cloud-billing-API integration ships (future enhancement). Documented as a "best effort" feature. |
| Egress firewall has a bypass via shared filesystem (e.g., backend writes to `/tmp` and another process reads) | Low | Medium -- data exfiltration via FS | Out of scope for this plan; documented in the threat model. Future enhancement: per-process FS namespace via `unshare --mount`. PLAN-021-2's evaluator sandbox uses similar techniques; that pattern can extend to backends. |
| FQDN resolution returns an IP that's later reassigned to a different service (cloud IP rotation) | High | Low -- transient connectivity issues | DNS refresh loop catches this within 5 minutes. Documented as a known minor edge case. Backend retries with new IPs after refresh. |
| Daemon needs root or CAP_NET_ADMIN to apply nftables rules — adds operational complexity | High | Medium -- deployment friction | Documented in the operator guide. Recommended setup: dedicated user with CAP_NET_ADMIN granted via systemd unit file. Without privileges, cloud backends refuse to launch (per the `allow_unfirewalled_backends` guard). |

## Definition of Done

- [ ] `egress_allowlist[]` field in cloud plugin manifest schema
- [ ] Linux nftables firewall applies per-PID rules; tested on Ubuntu 22+
- [ ] macOS pfctl firewall applies per-UID rules; tested on macOS 13+
- [ ] DNS refresh loop updates rules every 5 minutes; expires stale rules after 1h
- [ ] Session-spawner applies firewall before exec; refuses to launch on Linux without nftables (unless opt-in)
- [ ] Trust validator gates cloud-backend registration on privileged-backends + meta-review
- [ ] All four cloud backends implement `estimateDeployCost` with breakdown and confidence
- [ ] Cost estimates flow into the cost ledger (PLAN-023-3)
- [ ] Pre-deploy cost-cap check uses estimates
- [ ] `deploy estimate --env <env>` CLI subcommand works with JSON output
- [ ] Threat model document covers ≥6 scenarios with mitigation chains
- [ ] Unit tests pass with ≥90% coverage
- [ ] Integration test demonstrates egress block of non-allowlisted host
- [ ] Firewall rule application <100ms per backend spawn
- [ ] Cost estimation <50ms per call
- [ ] Operator documentation explains CAP_NET_ADMIN setup, allowlist editing, and the threat model
- [ ] No regressions in PLAN-024-1/2 functionality
