# SPEC-025-2-04: cred-proxy-runbook.md §6 TTL Tuning + §7 Audit Verification + §8 Emergency Revoke + §9 Escalation

## Metadata
- **Parent Plan**: PLAN-025-2
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-2 Task 4 (§6 TTL tuning, §7 Audit verification, §8 Emergency revoke, §9 Escalation)
- **Estimated effort**: 3 hours
- **Status**: Draft
- **Future location**: `plugins/autonomous-dev/docs/specs/SPEC-025-2-04-cred-proxy-runbook-ttl-audit-revoke-escalation.md`

## Description
Append the final four sections to `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`, closing the runbook out per TDD-025 §6.8:

- **§6 TTL tuning** — when to raise `default_ttl_seconds` (long deploys), when to lower (security-tightened environments), the practical upper bound (AWS STS chained-role 4-hour ceiling), and the trade-off between issuance frequency and exposure window.
- **§7 Audit-hash verification** — `cred-proxy doctor --verify-audit` workflow, what a clean run looks like, what a mismatch looks like, and the immediate response (do not delete the audit log; escalate per §9).
- **§8 Emergency revoke** — `cred-proxy revoke <token-id>` semantics, when to use it (suspected token compromise), and how to obtain the token-id from the audit log.
- **§9 Escalation** — the contract: audit-hash mismatch is **always** escalation. Never recover unilaterally. On-call security contact path.

§6 also documents OQ-1 (SIGHUP vs restart for config reload) as "assume restart" per the TDD's recommended-default. §7 reuses the verbatim prohibition phrase "do not delete the audit log" from §5.4 (mirror, not duplicate). §8 includes an explicit revoke command example. §9 codifies the escalation contract that §4.4, §5.4, and §7 all reference.

This spec closes out the runbook. After it lands, all nine sections are present and the file is "complete" for PLAN-025-2's deliverable scope.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` | Modify (append §6, §7, §8, §9) | File created by SPEC-025-2-01. Sections 1-5 landed by SPEC-025-2-01..03. |

## Implementation Details

### §6 TTL tuning

Append after §5.4:

```markdown
## 6. TTL tuning

The `default_ttl_seconds` config controls the lifetime of every credential the cred-proxy issues. The default of `900` (15 minutes) is calibrated for typical short-to-medium deploys with a low-exposure trade-off. Raise it for long deploys; lower it for security-tightened environments.

### 6.1 When to raise

If your deploys consistently exceed the TTL and you have already exhausted the option of restructuring them into shorter steps (§5.3 Option B), raise `default_ttl_seconds`. Edit `~/.autonomous-dev/cred-proxy/config.yaml`:

```yaml
cred_proxy:
  default_ttl_seconds: 3600   # 60 minutes; up from the default 900 (15 minutes)
```

Then restart the daemon:

```bash
cred-proxy stop
cred-proxy start
```

The cred-proxy daemon is **assumed to require a restart** for config reload. SIGHUP-for-reload is not a documented contract in TDD-024 §10; if your version supports it, the daemon's `man` page or `cred-proxy --help` will say so. Default to restart.

### 6.2 Practical upper bound

The hard upper bound depends on the cloud:

- **AWS STS** — `GetFederationToken` issues credentials valid up to **36 hours** for IAM users, but **chained-role assumption** (the more-common case) is capped at **1 hour** for direct chain and ~**4 hours** for the federated session. The pragmatic ceiling for AWS deploys is **14400 seconds (4 hours)**.
- **GCP OIDC** — short-lived tokens default to 1 hour; the practical ceiling for the cred-proxy is **3600 seconds**.
- **Azure access tokens** — typically 1 hour; the practical ceiling is **3600 seconds**.
- **K8s TokenRequest projection** — cluster-controlled; the cred-proxy will request `default_ttl_seconds` but the cluster may extend or cap. See §3.4.

Setting `default_ttl_seconds` higher than the cloud's hard cap will result in the cred-proxy issuing tokens at the cloud's cap, not your requested value. The audit log records the *issued* TTL, not the *requested* TTL.

### 6.3 When to lower

In security-tightened environments where the exposure window must be minimized, lower `default_ttl_seconds`. Practical floor is **60 seconds** (the cred-proxy's own re-issuance overhead becomes significant below this). Note that lowering raises the issuance frequency, which raises the load on the cloud's short-lived-token API and the size of `audit.log`.

### 6.4 Trade-off summary

| Direction | Pro | Con |
|-----------|-----|-----|
| Higher TTL | Fewer issuances; longer deploys complete | Larger exposure window if a token leaks |
| Lower TTL | Smaller exposure window | More issuances; larger audit log; higher API load |

Default `900` is the calibrated balance. Adjust only when you have a specific reason.
```

### §7 Audit-hash verification

```markdown
## 7. Audit-hash verification

The audit log (`~/.autonomous-dev/cred-proxy/audit.log`) is HMAC-chained: each entry's hash is computed over the entry's content **and** the previous entry's hash, keyed by the audit key (named in `audit_key_env`). A break in the chain indicates either a benign cause (audit-key rotation without re-keying) or a security-significant cause (log tampering, integrity break).

### 7.1 Routine verification

Run periodically (or as part of incident response):

```bash
cred-proxy doctor --verify-audit
```

A clean run reports the chain length, the hash of the last entry, and "chain verified" (or equivalent verbatim per TDD-024 §10). The command exits zero.

### 7.2 What a mismatch looks like

A mismatch reports the entry index where the chain breaks, the expected hash, and the actual hash. The command exits non-zero. Example output (illustrative; verify against TDD-024 §10):

```text
audit-chain mismatch at entry 47
  expected: 7a3f...e9b2
  actual:   c81d...0440
chain broken; do not edit or delete the log; escalate per runbook §9
```

### 7.3 Immediate response

A mismatch is **security-significant**. The immediate response:

1. **Do not delete the audit log.** Deletion destroys the only forensic record.
2. **Do not edit the audit log.** Editing makes the mismatch worse and obscures the cause.
3. Capture the diagnostic for escalation:

   ```bash
   cred-proxy doctor --verify-audit > /tmp/audit-mismatch-$(date +%s).log
   ```

4. Stop the daemon to prevent further issuance until resolved:

   ```bash
   cred-proxy stop
   ```

5. Escalate per §9.
```

### §8 Emergency revoke

```markdown
## 8. Emergency revoke

The `cred-proxy revoke <token-id>` subcommand immediately invalidates an outstanding token. Use it when you suspect a specific issued token has been compromised — for example, a process that should not have it has been observed using it, or the deploy worker holding the token has been confirmed compromised.

### 8.1 Obtaining the token-id

Token-ids are recorded in `audit.log`. To find a recent issuance:

```bash
cred-proxy audit.log | tail -20
```

Each entry records the token-id, cloud, scope, requesting process, and TTL. Identify the token-id of the suspected-compromised issuance.

### 8.2 Revoke

```bash
cred-proxy revoke <token-id>
```

The command exits zero on success. The daemon closes any FD currently held for that token-id and the cloud-side credential is invalidated (subject to the cloud's own propagation; STS is near-instant, K8s TokenRequest depends on cluster policy).

### 8.3 When *not* to use revoke

- **TTL expired naturally.** No revoke needed; the token is already invalid (§5.3).
- **Audit-hash mismatch on an *unrelated* token.** A mismatch is a chain-integrity event (§7), not a per-token revocation event. Escalate per §9.
- **Suspected scoper misconfiguration.** Reinstall and reconfigure the scoper (§5.2). Revoking individual tokens does not address the scoper itself.

If revoking everything is necessary (broad compromise scenario), `cred-proxy stop` invalidates *all* outstanding tokens and is the better option than iterating revokes.
```

### §9 Escalation

```markdown
## 9. Escalation

The cred-proxy escalation contract: **audit-hash mismatch is always escalation. Never recover unilaterally.** This section codifies the contract that §4.4, §5.4, and §7 all reference.

### 9.1 What requires escalation

- Audit-hash mismatch (§4.4 / §5.4 / §7) — always.
- Suspected token compromise where the impact is unclear (e.g., the deploy worker was running on a multi-tenant host).
- Persistent failure of `cred-proxy doctor` after applying §5.1 / §5.2 recovery, where the cause is not obvious.
- Any cred-proxy behaviour that does not match this runbook (the cred-proxy daemon is part of the trust boundary; unexpected behaviour is investigated, not patched-around).

### 9.2 What does not require escalation

- Routine TTL expiry (§5.3) — apply Option A or B.
- Permission-denied with a clear cause (mode wrong, ownership wrong) — apply §5.1.
- Scoper-not-installed — apply §5.2.
- Routine audit verification with no mismatch — no action needed.

### 9.3 How to escalate

1. **Stop the daemon** if not already stopped. (For audit-hash mismatch and suspected-compromise cases.)

   ```bash
   cred-proxy stop
   ```

2. **Capture all relevant diagnostics**:

   ```bash
   cred-proxy doctor > /tmp/cred-proxy-doctor-$(date +%s).log 2>&1
   cred-proxy doctor --verify-audit > /tmp/cred-proxy-audit-$(date +%s).log 2>&1
   cp ~/.autonomous-dev/cred-proxy/audit.log /tmp/audit-snapshot-$(date +%s).log
   ```

3. **Contact your on-call security contact** with the captured diagnostics. Do not paste audit-log contents into chat or email; transfer files via the channel your security team specifies.

4. **Do not attempt recovery** until the security contact directs it. The cred-proxy is part of the credential-issuance trust boundary; an out-of-contract recovery action can compromise the integrity of the audit log permanently.

### 9.4 Post-escalation

After the security contact resolves the issue, restart the daemon and re-verify:

```bash
cred-proxy start
cred-proxy doctor
cred-proxy doctor --verify-audit
```

A clean re-verification re-establishes the chain. The captured diagnostics from §9.3 are retained per your organization's incident-response retention policy.
```

### Lint and formatting

- `markdownlint` (existing config) must pass on the modified file.
- §6, §7, §8, §9 each use H2 (`## 6.`, etc.); subsections use H3.
- §6.4 uses a Markdown table for the trade-off summary.
- Code-block fences use `bash` for shell, `yaml` for config, `text` for the audit-mismatch illustrative output.
- Bold-formatted prohibition phrases reused verbatim from §5.4 (mirror): "Do not delete the audit log", "Do not edit the audit log".

## Acceptance Criteria

- [ ] §6 TTL tuning appended. Subsections §6.1 (when to raise), §6.2 (practical upper bound), §6.3 (when to lower), §6.4 (trade-off summary).
- [ ] §6.1 documents the config-edit + restart pattern. The "assume restart" guidance for OQ-1 is documented (SIGHUP not assumed).
- [ ] §6.2 documents the per-cloud upper bounds (AWS 4h pragmatic, GCP 1h, Azure 1h, K8s cluster-controlled with §3.4 cross-reference).
- [ ] §6.2 documents the `14400` seconds (4 hours) AWS pragmatic ceiling.
- [ ] §6.3 documents the practical floor (60 seconds) and the trade-off (more issuances; larger audit log).
- [ ] §6.4 contains a trade-off-summary table.
- [ ] §7 Audit-hash verification appended. Subsections §7.1 (routine verification), §7.2 (what a mismatch looks like), §7.3 (immediate response).
- [ ] §7.1 names `cred-proxy doctor --verify-audit` verbatim.
- [ ] §7.2 includes an illustrative mismatch output (fenced as `text`).
- [ ] §7.3 lists the five-step immediate-response procedure including verbatim "Do not delete the audit log" and "Do not edit the audit log" in bold.
- [ ] §7.3 directs to §9 for escalation.
- [ ] §8 Emergency revoke appended. Subsections §8.1 (obtaining token-id), §8.2 (revoke command), §8.3 (when not to use).
- [ ] §8.1 names `cred-proxy audit.log | tail -20` (or similar) as the canonical token-id-discovery command.
- [ ] §8.2 documents the `cred-proxy revoke <token-id>` command with explanation of behavior (FD close + cloud-side invalidation).
- [ ] §8.3 lists at least three "when not to use" cases (TTL expired naturally; audit-hash mismatch; scoper misconfiguration).
- [ ] §8.3 mentions `cred-proxy stop` as the alternative for broad compromise.
- [ ] §9 Escalation appended. Subsections §9.1 (what requires), §9.2 (what does not), §9.3 (how to escalate), §9.4 (post-escalation).
- [ ] §9 contains the verbatim contract phrase "audit-hash mismatch is always escalation" (or equivalent verbatim) and "Never recover unilaterally" (or equivalent verbatim).
- [ ] §9.3 documents the diagnostic-capture procedure (doctor + verify-audit + audit.log snapshot).
- [ ] §9.3 contains the directive "Do not attempt recovery" until the security contact directs.
- [ ] §9.4 documents the post-escalation re-verification (cred-proxy start + doctor + verify-audit).
- [ ] After this spec lands, the runbook contains all nine sections per TDD-025 §6.8.
- [ ] Existing §1-§5 content (landed by sibling specs) is byte-for-byte unchanged.
- [ ] All bash blocks fenced with `bash`; YAML blocks with `yaml`; illustrative output with `text`.
- [ ] `markdownlint` exits 0 on the modified file.

## Dependencies

- **TDD-025 §6.8** — authoritative for §6, §7, §8, §9 structure.
- **TDD-024 §10** — authoritative for cred-proxy CLI surface (`doctor --verify-audit`, `revoke`, daemon SIGHUP behaviour). Forward-reference for the exact verify-audit output text.
- **TDD-024 §8** — authoritative for per-cloud TTL caps (AWS 4h chained-role, GCP 1h OIDC, Azure 1h, K8s TokenRequest cluster-controlled).
- **PLAN-025-2 Task 4** — explicit content requirements for each section.
- **PLAN-025-2 OQ-1** — SIGHUP vs restart open question; closed in §6.1 as "assume restart".
- **PLAN-025-2 OQ-6** — practical TTL upper bound; closed in §6.2 with the per-cloud table.
- **SPEC-025-2-01** (sibling, hard precedence): creates the file. §6-§9 are appended below sibling-spec sections.
- **SPEC-025-2-03** (sibling, hard precedence): §5.4 references §9; this spec's §9 must use compatible escalation contract phrasing.
- **No code dependencies** — documentation only.

## Notes

- The §6.2 per-cloud TTL cap table is informed by AWS / GCP / Azure / K8s documentation. The exact numbers (4h AWS, 1h GCP/Azure) are defensible defaults but the implementer should verify against TDD-024 §8 cred-proxy-scoper-<cloud> sections at PR time and adjust if those sections specify different numbers.
- The §6.1 "assume restart" guidance closes OQ-1 by deferring to safe-default behaviour. If TDD-024 §10 documents SIGHUP-for-reload, this spec is updated at PR review time to reflect that.
- The §7.2 illustrative audit-mismatch output is a placeholder. The exact verbatim output of `cred-proxy doctor --verify-audit` is owned by TDD-024 §10. The illustrative text uses the canonical "chain mismatch" / "chain broken" phrasing that operators can search for. If TDD-024 §10's actual output diverges, this spec's example is updated at PR time.
- §8.3 deliberately enumerates *when not* to use revoke. The most common operator misuse is reaching for revoke when TTL expiry is the actual cause; the runbook's §5.3-then-§8 progression keeps that clear.
- The §9 escalation contract is the runbook's "trust boundary" statement. The cred-proxy daemon is part of the credential-issuance trust boundary; the runbook's job is to make clear which actions an operator can take unilaterally and which require security-team involvement. The §9.1 / §9.2 split codifies this.
- The §9.3 step "Do not paste audit-log contents into chat or email" is informed by FR-1539 (never echo secrets) generalized to the audit log itself. Audit-log entries do not contain raw credentials but they do contain HMAC-chain fragments and process metadata that an attacker could correlate. File-transfer through the security team's specified channel is the documented practice.
- The bold prohibition phrases in §7.3 mirror those in §5.4 verbatim. If the implementer changes one, change both — the eval `must_not_mention` patterns in PLAN-025-3 key on the verbatim phrases.
- The §8 revoke command's effect on K8s TokenRequest tokens is asymmetric: STS revokes near-instantly; K8s depends on cluster policy and the token may remain valid until its cluster-side expiry. This is documented in §3.4 and again in §8.2 (with the "cloud's own propagation" caveat).
- After this spec lands, PLAN-025-2 Task 4 is complete. The runbook has all nine sections. Subsequent specs in this batch (SPEC-025-2-05, SPEC-025-2-06) cover the troubleshoot scenarios and setup-wizard phases respectively.
