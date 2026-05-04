# SPEC-025-2-03: cred-proxy-runbook.md §4 Common Failures + §5 Recovery

## Metadata
- **Parent Plan**: PLAN-025-2
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-2 Task 3 (§4 Common failures, §5 Recovery)
- **Estimated effort**: 4 hours
- **Status**: Draft
- **Future location**: `plugins/autonomous-dev/docs/specs/SPEC-025-2-03-cred-proxy-runbook-failures-recovery.md`

## Description
Append §4 "Common failures" and §5 "Recovery" to `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`. Together these two sections form the operator's first-response reference for the four canonical cred-proxy failure modes:

1. **Permission denied on the Unix socket** — `EACCES` when the deploy worker tries to connect.
2. **Scoper missing** — `cred-proxy issue <cloud> ...` fails with "scoper not found".
3. **TTL expired mid-deploy** — auth failure ~15 minutes into a long deploy (the most-misdiagnosed failure).
4. **Audit-hash mismatch** — `cred-proxy doctor --verify-audit` reports a chain break.

§4 enumerates the four failures with detection signals (one to two sentences each on what the operator sees). §5 provides recovery for each, with **three verbatim prohibition phrases** that must appear unchanged so PLAN-025-3 eval `must_not_mention` patterns and PLAN-025-2's troubleshoot-scenario sibling content (SPEC-025-2-05) can assert against them:

- **"do not rotate root credentials"** (TTL expired mid-deploy recovery)
- **"do not chown the socket to root"** or **"do not chown to root"** (permission-denied recovery)
- **"do not delete the audit log"** (audit-hash-mismatch recovery)

The audit-hash-mismatch recovery directs the operator to **escalate** rather than attempt unilateral recovery (matches §9 escalation contract owned by SPEC-025-2-04).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` | Modify (append §4 and §5) | File created by SPEC-025-2-01. §3 layered in by SPEC-025-2-02. §6-§9 layered in by SPEC-025-2-04. |

## Implementation Details

### §4 Common failures

Append after §3.4 (the last subsection landed by SPEC-025-2-02):

```markdown
## 4. Common failures

The cred-proxy fails in four canonical ways. The detection signals below let you triage which failure mode applies before consulting §5 for the recovery procedure.

### 4.1 Permission denied on the Unix socket

The deploy worker (or any other client) cannot connect to `~/.autonomous-dev/cred-proxy/socket`. Symptom is `EACCES` or "Permission denied" on the connect call. Two root causes:

- **Socket mode is not `0600`.** Verify with `ls -l ~/.autonomous-dev/cred-proxy/socket`. The file should be `srw-------`.
- **Socket ownership does not match the running user.** Verify with `stat` (use `stat -f "%Sp %u %g"` on macOS, `stat -c "%a %u %g"` on Linux). The owner must match the user that runs both the daemon and the deploy worker.

### 4.2 Scoper missing

`cred-proxy issue <cloud> ...` fails with a "scoper not found" diagnostic, or `cred-proxy doctor` reports the requested cloud's scoper as missing. Detection: `ls ~/.autonomous-dev/cred-proxy/scopers/<cloud>` returns no such file. The scoper plugin has not been installed for that cloud.

### 4.3 TTL expired mid-deploy

A long-running deploy fails with an auth error (typically a 401, 403, or token-expired diagnostic from the cloud API) approximately 15 minutes after deploy start. The cred-proxy `audit.log` shows the issuance entry was issued well before the failure. Detection: `cred-proxy audit.log | tail` shows the issuance, and the elapsed time from issuance to failure exceeds `default_ttl_seconds` (default `900`).

This is the **most-misdiagnosed failure mode**. Operators routinely interpret the auth error as a credential compromise and rotate root credentials. That is the wrong action. See §5.3.

### 4.4 Audit-hash mismatch

`cred-proxy doctor --verify-audit` reports a chain-hash mismatch. Some entry in `~/.autonomous-dev/cred-proxy/audit.log` has a hash that does not match the previous-entry hash chained through the audit key. Detection: the verbatim diagnostic output of `cred-proxy doctor --verify-audit` includes "chain mismatch" or "audit chain broken" (exact phrasing per TDD-024 §10).

This is a **security-significant** event. The audit chain breaks for one of three reasons: (a) the audit log was edited or truncated outside the daemon; (b) the audit key changed mid-stream; (c) an actual integrity break worth investigating. In all three cases, the response is the same: **escalate**. Do not unilaterally "fix" the audit log. See §5.4 and §9.
```

**Required content (acceptance for §4):**

- All four subsections (§4.1, §4.2, §4.3, §4.4) present in order.
- §4.1 names both root causes (mode wrong; ownership wrong).
- §4.1 documents both `ls -l` and `stat` (with platform-aware variants) as detection commands.
- §4.3 cites `cred-proxy audit.log | tail` as the detection command.
- §4.3 calls out "most-misdiagnosed failure mode" or equivalent.
- §4.3 explicitly identifies the wrong action (rotating root credentials) before §5.3 documents the right action.
- §4.4 names the diagnostic command verbatim: `cred-proxy doctor --verify-audit`.
- §4.4 calls out that the response is escalation; do not unilaterally fix.

### §5 Recovery

Append after §4.4:

```markdown
## 5. Recovery

For each failure in §4, the recovery procedure below. Read the §4 detection signal first to confirm which failure applies — applying the wrong recovery makes the situation worse (especially for §5.3).

### 5.1 Permission denied on the Unix socket

If the socket mode is wrong:

```bash
chmod 0600 ~/.autonomous-dev/cred-proxy/socket
```

If the socket ownership is wrong, restart the cred-proxy daemon as the deploying user (the user that runs the deploy worker, **not** root):

```bash
cred-proxy stop
cred-proxy start
cred-proxy doctor
```

If the daemon is not running at all, start it:

```bash
cred-proxy start
```

**Do not chown the socket to root.** The cred-proxy daemon enforces ownership at startup; chown-to-root will cause the daemon to refuse to start (and even if you bypass that check, the deploy worker, which runs as a non-root user, will still get `EACCES`). The socket *must* be owned by the deploying user.

### 5.2 Scoper missing

Install the missing scoper plugin for the affected cloud, then restart the daemon and re-verify:

```bash
claude plugin install cred-proxy-scoper-<cloud>   # one of aws, gcp, azure, k8s
cred-proxy stop
cred-proxy start
cred-proxy doctor
```

`doctor` should now list the scoper as discoverable. Re-run the deploy.

If you do not actually deploy to that cloud, check that the deploy command's target was correct — a typo in `--cloud` can request a scoper you never installed.

### 5.3 TTL expired mid-deploy

The auth failure is **expected** for any deploy whose wall-clock duration exceeds `default_ttl_seconds`. There are two correct recovery paths:

- **Option A: Raise the TTL.** Edit `~/.autonomous-dev/cred-proxy/config.yaml` and increase `cred_proxy.default_ttl_seconds`. The practical upper bound for AWS STS chained roles is ~4 hours (14400 seconds); see §6 for the full TTL-tuning trade-off. After editing, restart the daemon (`cred-proxy stop && cred-proxy start`) and retry the deploy.
- **Option B: Restructure the deploy** into shorter steps that each complete within `default_ttl_seconds`. This is the preferred long-term fix for deploys whose duration grows over time.

**Do not rotate root credentials.** The auth failure is a TTL expiry, not a credential compromise. Rotating root credentials does not fix the underlying cause (the deploy still exceeds the TTL on the next attempt) and creates unnecessary downstream work (every other consumer of those credentials must be updated). The cred-proxy `audit.log` (§4.3 detection signal) confirms the issuance is legitimate.

### 5.4 Audit-hash mismatch

A chain-hash mismatch is a security-significant event. The recovery is **always escalation**, not a unilateral fix.

```bash
# Capture the diagnostic output for escalation:
cred-proxy doctor --verify-audit > /tmp/audit-mismatch-$(date +%s).log

# Stop the daemon to prevent further issuance until the mismatch is resolved:
cred-proxy stop
```

Then escalate per §9. The on-call security contact will:

- Compare the captured diagnostic against the operational audit-key rotation history.
- Determine whether the mismatch is a benign cause (audit-key rotation without re-keying the chain) or a security-significant cause (log tampering, integrity break).
- Decide on the recovery path (re-key the chain from a known-good entry; restore from a backup; investigate further).

**Do not delete the audit log.** Deleting the log destroys the only forensic record of what was issued and when. **Do not edit the audit log.** Editing the log makes the chain-hash mismatch worse and obscures the original cause. **Do not attempt unilateral recovery.** Escalate and let the security contact decide.
```

**Required content (acceptance for §5):**

- All four subsections (§5.1, §5.2, §5.3, §5.4) present in order.
- §5.1 contains the verbatim phrase **"Do not chown the socket to root"** (or **"do not chown to root"**) — chosen verbatim such that the eval-pattern `must_not_mention: chown root` tests for the *recommendation* to chown to root, NOT for the recommendation against doing so. See Notes.
- §5.1 documents three recovery branches (mode wrong; ownership wrong; daemon not running).
- §5.2 has the install command with the four-cloud `<cloud>` placeholder.
- §5.3 contains the verbatim phrase **"Do not rotate root credentials"** (or close, with verbatim "do not rotate root").
- §5.3 documents both Option A (raise TTL) and Option B (restructure deploy).
- §5.3 cites the practical upper bound from §6 (forward reference acceptable; SPEC-025-2-04 lands §6).
- §5.4 contains the verbatim phrase **"Do not delete the audit log"**.
- §5.4 contains the verbatim phrase **"Do not edit the audit log"** (or close paraphrase).
- §5.4 contains the verbatim phrase **"Do not attempt unilateral recovery"** (or close: "escalate; do not attempt unilateral recovery" matches the §9 contract).
- §5.4 directs to §9 for escalation contract.

### Lint and formatting

- `markdownlint` (existing config) must pass on the modified file.
- §4 and §5 use H2 (`## 4.`, `## 5.`); subsections use H3 (`### 4.1`, `### 5.1`, etc.).
- Code-block fences use `bash` for shell snippets.
- Each verbatim prohibition phrase appears in a sentence that is bolded as a whole or contains the phrase in bold (`**Do not chown the socket to root.**`). The bold convention is consistent across all three.

## Acceptance Criteria

- [ ] §4 Common failures appended after §3.4. All four subsections present: §4.1 (permission denied), §4.2 (scoper missing), §4.3 (TTL expired mid-deploy), §4.4 (audit-hash mismatch).
- [ ] §4.1 names both root causes (mode wrong; ownership wrong) and documents both `ls -l` and `stat` as detection commands with platform-aware `stat` variants.
- [ ] §4.3 calls out "most-misdiagnosed failure mode" or equivalent and identifies rotating root credentials as the wrong action.
- [ ] §4.3 cites `cred-proxy audit.log | tail` as the detection command.
- [ ] §4.4 names `cred-proxy doctor --verify-audit` as the diagnostic command and directs the response to escalation.
- [ ] §5 Recovery appended after §4.4. All four subsections present: §5.1, §5.2, §5.3, §5.4.
- [ ] §5.1 contains the verbatim phrase **"Do not chown the socket to root"** (or "do not chown to root") in bold.
- [ ] §5.1 documents three recovery branches: chmod 0600; restart as deploying user; cred-proxy start.
- [ ] §5.2 documents the `claude plugin install cred-proxy-scoper-<cloud>` command.
- [ ] §5.3 contains the verbatim phrase **"Do not rotate root credentials"** in bold.
- [ ] §5.3 documents both recovery branches (raise TTL, restructure deploy).
- [ ] §5.4 contains all three verbatim phrases in bold: "Do not delete the audit log", "Do not edit the audit log" (or close), "Do not attempt unilateral recovery" (or close).
- [ ] §5.4 directs the operator to §9 for the escalation contract.
- [ ] No documented command in §5 echoes a credential, audit key, or token to stdout.
- [ ] Existing §1, §2, §3 content (landed by SPEC-025-2-01 / -02) is byte-for-byte unchanged.
- [ ] All bash blocks fenced with `bash`.
- [ ] `markdownlint` exits 0 on the modified file.

## Dependencies

- **TDD-025 §6.8** — authoritative source for §4 (four failure modes) and §5 (recovery procedures).
- **TDD-025 §3.3** — failure-mode table; canonical source for the wrong-answer-cost mapping.
- **PLAN-025-2 Task 3** — explicit prohibition-phrase verbatim requirement.
- **SPEC-025-2-01** — creates the file. Hard precedence.
- **SPEC-025-2-02** — appends §3. Either order is fine relative to this spec, as both append below the SPEC-025-2-01 anchor.
- **SPEC-025-2-04** — lands §6-§9. Forward references from §5.3 (to §6 TTL upper bound) and §5.4 (to §9 escalation contract) are acceptable; SPEC-025-2-04 ships in the same PR.
- **SPEC-025-2-05** (sibling, soft): the troubleshoot-scenario specs use the same three verbatim prohibition phrases. Phrasing must match exactly between this spec's §5 and SPEC-025-2-05's scenarios.
- **PLAN-025-3** (forward, eval cases): PLAN-025-3's `must_not_mention` patterns assume these verbatim phrases exist in the runbook. Drift in phrasing would cause eval cases to falsely pass when assist hallucinates the wrong recovery.
- **No code dependencies** — documentation only.

## Notes

- The verbatim-prohibition contract is the most fragile part of this spec. Eval `must_not_mention` patterns key on the operator's *bad* recommendation (e.g., "rotate root", "chown root", "rm audit.log"). The runbook's *anti*-recommendation must use the same lexical surface (e.g., "do not rotate root") so that retrieval pulls the correct phrase to the assist's context window. If the implementer prefers gentler phrasing ("avoid rotating root credentials") it weakens the eval contract; the verbatim-bold form is required.
- The eval-pattern interaction is: when an operator asks "should I rotate root credentials?", the assist agent retrieves the runbook §5.3 text. The retrieved text contains the phrase "do not rotate root credentials" (in the recovery context). The eval `must_not_mention: rotate-root` pattern keys on the assist agent's *response* containing the recommendation; if the assist agent's response is "do not rotate root credentials" then the eval pattern *should not match* (because the recommendation is against the action). The eval framework (per TDD-025 §7) handles this by matching only on positive recommendations. The runbook's job is to surface the verbatim "do not rotate root" phrase so the assist agent can quote it directly. Drift to "avoid rotating root" weakens this.
- §5.4's three prohibitions ("do not delete", "do not edit", "do not attempt unilateral recovery") collectively form the audit-log integrity contract. SPEC-025-2-04's §9 escalation section will codify the same contract with explicit on-call paths.
- The 4-hour AWS STS practical upper bound in §5.3 is a forward reference to §6 (owned by SPEC-025-2-04). If §6 lands a different bound (e.g., the AWS limit changes), update §5.3 to match.
- The "chown to root will cause the daemon to refuse to start" text in §5.1 is an informed assumption based on TDD-024 §7 (cred-proxy daemon enforces ownership invariants at startup). At PR time, verify against TDD-024 §7's exact startup-check semantics; if the daemon merely warns rather than refusing, soften the text to "the daemon may refuse to start". OQ on this is closed in PLAN-025-2 by deferring to TDD-024.
- The §5.4 escalation procedure (capture diagnostic, stop daemon, escalate) is one of two intervention points where stopping the daemon is the correct first action — the other is §8 emergency revoke (owned by SPEC-025-2-04). The two are distinct: §5.4 is forensic preservation; §8 is active mitigation. Do not conflate.
- The §5.1 "even if you bypass that check" language is a deliberate signal that the daemon's ownership-enforcement is the *first* line of defense, not the only one. Operators tempted to chown-to-root and bypass the daemon check still hit `EACCES` in the deploy worker. The two-failure-mode framing is intentional.
