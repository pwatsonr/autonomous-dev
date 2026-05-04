# SPEC-025-2-05: troubleshoot/SKILL.md cred-proxy Scenarios — Permission Denied + TTL Expired

## Metadata
- **Parent Plan**: PLAN-025-2
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-2 Task 5 (permission-denied scenario), Task 6 (TTL-expired-mid-deploy scenario)
- **Estimated effort**: 4 hours (2h + 2h)
- **Status**: Draft
- **Future location**: `plugins/autonomous-dev/docs/specs/SPEC-025-2-05-troubleshoot-scenarios-permission-and-ttl.md`

## Description
Append two new scenarios to `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md` per TDD-025 §6.4:

1. **Scenario 1: "`cred-proxy: permission denied on Unix socket`."** Diagnosis path (`ls -l socket`, `stat`, `cred-proxy status`, `cred-proxy doctor`) and recovery (chmod 0600 / restart as deploying user / `cred-proxy start`). Includes the verbatim **"Do not chown the socket to root"** prohibition in bold.

2. **Scenario 2: "My deploy died at the 15-minute mark with an auth error."** Diagnosis (`cred-proxy audit.log | tail` to confirm TTL) and recovery (raise `default_ttl_seconds` or restructure the deploy). Includes the verbatim **"Do not rotate root credentials. The auth failure is a TTL expiry, not a credential compromise."** prohibition in bold.

The two scenarios are operator-facing surfaces of the cred-proxy-runbook §5.1 and §5.3 recovery procedures (delivered by SPEC-025-2-03). The scenarios use the same verbatim prohibition phrasings so PLAN-025-3's `must_not_mention` eval patterns line up across both surfaces. The scenario titles match what an operator would actually type into `/autonomous-dev-assist:assist`, which is what the assist agent's retrieval logic keys on.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md` | Modify (append two scenarios) | Additive; existing scenarios are byte-for-byte unchanged. |

## Implementation Details

The implementer must first read `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md` to determine the existing scenario format. The file uses scenario blocks where each scenario has a heading, a "Symptom" / "Diagnosis" / "Recovery" structure (or close variant), and is appended to the end of the file (or to a designated cred-proxy subsection if one exists per the chains-and-deploy precedent). The two new scenarios match the existing format precisely — column widths, heading style, code-block conventions.

If the existing format uses an H2 per scenario, follow that. If it uses an H3 nested under a category H2 (e.g., `## Cred-proxy scenarios`), nest both new scenarios under a `## Cred-proxy` H2 (creating it if it does not exist). The format-discovery is the implementer's first step.

### Scenario 1: permission-denied on Unix socket

```markdown
## `cred-proxy: permission denied on Unix socket`

**Symptom.** The deploy worker (or any other client of the cred-proxy) reports "Permission denied" or `EACCES` when connecting to `~/.autonomous-dev/cred-proxy/socket`. Deploys fail before any cloud API is called.

**Diagnosis.** Walk the four checks in order:

1. Verify the socket mode is `0600`:

   ```bash
   ls -l ~/.autonomous-dev/cred-proxy/socket
   ```

   The mode line should read `srw-------`. Any other mode is the cause.

2. Verify socket ownership matches the running user (use platform-aware `stat`):

   ```bash
   # macOS:
   stat -f "%Sp %u %g" ~/.autonomous-dev/cred-proxy/socket
   # Linux:
   stat -c "%a %u %g" ~/.autonomous-dev/cred-proxy/socket
   ```

   The owner UID must match the user that runs both the cred-proxy daemon and the deploy worker.

3. Verify the daemon is running:

   ```bash
   cred-proxy status
   ```

   Non-zero exit means the daemon is not running.

4. Run the full diagnostic:

   ```bash
   cred-proxy doctor
   ```

   `doctor` reports socket permissions, scoper presence, and root-credential reachability in one call. Use as the canonical first-response.

**Recovery.**

- If the socket mode is wrong: `chmod 0600 ~/.autonomous-dev/cred-proxy/socket`.
- If ownership is wrong: restart the cred-proxy daemon as the deploying user (the user that runs the deploy worker, **not** root):

  ```bash
  cred-proxy stop
  cred-proxy start
  cred-proxy doctor
  ```

- If the daemon is not running: `cred-proxy start`.

**Do not chown the socket to root.** The cred-proxy daemon enforces ownership at startup and chown-to-root will cause it to refuse to start. Even if the daemon ownership check were bypassed, the deploy worker (running as a non-root user) would still get `EACCES`. The socket *must* be owned by the deploying user.

**See also.** `instructions/cred-proxy-runbook.md` §4.1 (failure detection) and §5.1 (recovery procedure).
```

**Required content (acceptance for Scenario 1):**

- The scenario heading is the verbatim title `cred-proxy: permission denied on Unix socket` (used as eval `expected_topic` in PLAN-025-3).
- The Diagnosis section has all four checks in order: `ls -l`, platform-aware `stat`, `cred-proxy status`, `cred-proxy doctor`.
- The platform-aware `stat` block names both `stat -f "%Sp %u %g"` (macOS) and `stat -c "%a %u %g"` (Linux).
- The Recovery section has all three branches: chmod 0600; restart as deploying user; cred-proxy start.
- The verbatim phrase **"Do not chown the socket to root"** appears in bold.
- The scenario references the runbook §4.1 and §5.1 in a "See also" footer.

### Scenario 2: TTL expired mid-deploy

```markdown
## My deploy died at the 15-minute mark with an auth error

**Symptom.** A long-running deploy fails with an authentication error (typically a 401, 403, or "token expired" diagnostic from the cloud API) approximately 15 minutes after the deploy started. The cloud-side credential validation reports the token is expired.

**Diagnosis.** TTL expiry mid-deploy is the most common explanation for a 15-minute-mark auth failure. The cred-proxy issues credentials with a default TTL of `900` seconds (15 minutes); deploys that exceed this duration will see the credential expire mid-flight.

Confirm by inspecting the audit log:

```bash
cred-proxy audit.log | tail
```

The most recent issuance entry shows the token-id, cloud, scope, and the issued TTL. If the elapsed time from issuance to your auth failure is approximately equal to (or exceeds) the issued TTL, this is a TTL expiry, not a credential compromise.

**Recovery.** Two options, both correct:

- **Option A: Raise the TTL.** Edit `~/.autonomous-dev/cred-proxy/config.yaml` and increase `cred_proxy.default_ttl_seconds`. The practical upper bound is cloud-dependent (AWS pragmatic ceiling: 14400 seconds / 4 hours; GCP and Azure: ~3600 seconds / 1 hour). After editing, restart the daemon (`cred-proxy stop && cred-proxy start`) and retry the deploy. See runbook §6 for the full TTL-tuning trade-off.
- **Option B: Restructure the deploy** into shorter steps that each complete within `default_ttl_seconds`. This is the preferred long-term fix for deploys whose duration grows over time.

**Do not rotate root credentials. The auth failure is a TTL expiry, not a credential compromise.** Rotating root credentials does not fix the underlying cause (the deploy still exceeds the TTL on the next attempt) and creates unnecessary downstream work for every other consumer of those credentials. The cred-proxy `audit.log` confirms the issuance is legitimate.

**See also.** `instructions/cred-proxy-runbook.md` §4.3 (failure detection), §5.3 (recovery procedure), §6 (TTL tuning).
```

**Required content (acceptance for Scenario 2):**

- The scenario heading is the verbatim title `My deploy died at the 15-minute mark with an auth error` (used as eval `expected_topic` in PLAN-025-3; phrased as an operator's verbatim ask).
- The Diagnosis section names `cred-proxy audit.log | tail` as the canonical detection command.
- The Diagnosis explicitly states this is "the most common explanation" or equivalent (signaling to the assist agent's retrieval that this is the high-probability hit).
- The Recovery section has both Option A (raise TTL) and Option B (restructure).
- Option A documents the per-cloud upper bound (AWS 14400 / 4 hours; GCP and Azure ~3600).
- The verbatim phrase **"Do not rotate root credentials. The auth failure is a TTL expiry, not a credential compromise."** appears in bold (or with the "Do not rotate root credentials" portion in bold and the explanation following).
- The scenario references the runbook §4.3, §5.3, and §6 in a "See also" footer.
- The Recovery text **does not contain** any of the eval-trigger phrases for `must_not_mention`: no `aws iam create-access-key`, no `gcloud iam service-accounts keys create`, no `rotate-root` *as a recommendation*. (The phrase "Do not rotate root credentials" is acceptable because it is a prohibition, not a recommendation; eval framework distinguishes per TDD-025 §7.)

### Lint and formatting

- `markdownlint` (existing config) must pass on the modified file.
- Existing scenarios are byte-for-byte unchanged.
- The two new scenarios appear at the end of the file (or under a `## Cred-proxy` category H2 if the existing format uses one).
- Code-block fences use `bash` for shell.
- Bold-formatted prohibition phrases match the verbatim text in cred-proxy-runbook.md §5.1 (for "Do not chown the socket to root") and §5.3 (for "Do not rotate root credentials"). Phrasings must be byte-identical between the two surfaces.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md` contains a new scenario with the heading `cred-proxy: permission denied on Unix socket` (verbatim).
- [ ] Scenario 1 has a Symptom section, a Diagnosis section with four ordered checks, and a Recovery section with three branches.
- [ ] Scenario 1 Diagnosis names: `ls -l ~/.autonomous-dev/cred-proxy/socket`, platform-aware `stat -f` / `stat -c`, `cred-proxy status`, `cred-proxy doctor`.
- [ ] Scenario 1 contains the verbatim phrase **"Do not chown the socket to root"** in bold.
- [ ] Scenario 1 references runbook §4.1 and §5.1 in a "See also" footer.
- [ ] `plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md` contains a new scenario with the heading `My deploy died at the 15-minute mark with an auth error` (verbatim).
- [ ] Scenario 2 Diagnosis names `cred-proxy audit.log | tail` as the detection command.
- [ ] Scenario 2 Recovery documents both Option A (raise TTL) and Option B (restructure deploy).
- [ ] Scenario 2 Option A documents the per-cloud upper bounds (AWS 14400 / 4h; GCP/Azure ~3600 / 1h).
- [ ] Scenario 2 contains the verbatim bold phrase **"Do not rotate root credentials. The auth failure is a TTL expiry, not a credential compromise."** (or "Do not rotate root credentials" in bold with the explanation in the same paragraph).
- [ ] Scenario 2 references runbook §4.3, §5.3, and §6 in a "See also" footer.
- [ ] Scenario 2's Recovery text does not contain `aws iam create-access-key`, `gcloud iam service-accounts keys create`, or any *positive recommendation* of root-credential rotation (the prohibition phrase "do not rotate root" is acceptable; the rotation commands themselves must not appear as recommended actions).
- [ ] Existing scenarios in `troubleshoot/SKILL.md` are byte-for-byte unchanged.
- [ ] All bash blocks fenced with `bash`.
- [ ] `markdownlint` exits 0 on the modified file.
- [ ] Verbatim cross-surface phrasing audit: the prohibition phrases in this spec's Scenario 1 and Scenario 2 byte-match the corresponding prohibition phrases in cred-proxy-runbook.md §5.1 and §5.3 (delivered by SPEC-025-2-03).

## Dependencies

- **TDD-025 §6.4** — authoritative for the two scenario shapes.
- **TDD-025 §3.3** — failure-mode table (informs the symptom/diagnosis/recovery structure).
- **PLAN-025-2 Task 5/6** — explicit content requirements.
- **SPEC-025-2-03** (sibling, hard for verbatim consistency): the cred-proxy-runbook.md §5.1 and §5.3 prohibition phrases must byte-match Scenario 1's and Scenario 2's. If SPEC-025-2-03's phrasing is approved first, this spec mirrors it; if reviewers tweak the phrasing in either spec, both must be updated together.
- **SPEC-025-2-04** (sibling, soft): runbook §6 (TTL tuning) is referenced from Scenario 2's Option A. Forward reference acceptable.
- **PLAN-025-3** (forward, eval cases): the scenario titles are used as eval `expected_topic` values; the prohibition phrases are mirrored by `must_not_mention` patterns. Drift between this spec and PLAN-025-3 weakens eval scoring.
- **No code dependencies** — documentation only.

## Notes

- The scenario titles are deliberately phrased as operators would type them into the assist agent. "cred-proxy: permission denied on Unix socket" mirrors the actual error string operators paste; "My deploy died at the 15-minute mark with an auth error" mirrors the natural-language framing operators use when the cred-proxy concept is not yet front-of-mind. Eval cases in PLAN-025-3 use these titles as `expected_topic`.
- The verbatim cross-surface phrasing audit is the most fragile review-time check. Reviewers should run a `grep -n "Do not chown the socket to root" plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md plugins/autonomous-dev-assist/skills/troubleshoot/SKILL.md` and confirm both files contain the phrase exactly. Same for "Do not rotate root credentials" and "Do not delete the audit log".
- The Scenario 2 explicit framing "this is the most common explanation" is a deliberate retrieval-time signal. The assist agent's classifier uses term-frequency-style heuristics over the retrieved corpus; flagging the most-likely interpretation makes the assist agent's response more directive (and reduces the risk of the assist agent listing TTL expiry as one of N possibilities, leaving the operator unsure).
- The Scenario 2 Recovery does *not* document the actual `aws iam create-access-key` command or any other cred-rotation command, even as a "do not run this" example. Including them, even as anti-recommendations, increases the risk of an assist hallucination quoting them out of context. The phrase "do not rotate root" is sufficient; it does not require examples.
- The scenario format (Symptom / Diagnosis / Recovery / See also) is informed by the chains-and-deploy precedent in the existing troubleshoot/SKILL.md. If the existing format uses different headings (e.g., "Issue" / "Triage" / "Fix"), adopt the existing format. Format consistency across scenarios matters for both retrieval and operator readability.
- The implementer's first action is to read the current `troubleshoot/SKILL.md` to determine: (a) whether scenarios are H2 or H3 entries; (b) whether there is an existing `## Cred-proxy` category H2 to nest under (likely no, since this is the first cred-proxy content) or to create; (c) the exact subsection-heading conventions ("Symptom" vs. "Issue"); (d) whether bash fences are used or generic ` ``` ` is the existing convention.
- The "See also" footers point to forward references (the runbook is delivered by SPEC-025-2-01..04). Forward references are acceptable per the same convention used in PLAN-025-1's specs (audited by SPEC-025-1-04).
