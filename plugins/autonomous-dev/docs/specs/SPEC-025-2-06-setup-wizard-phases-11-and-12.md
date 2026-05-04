# SPEC-025-2-06: setup-wizard/SKILL.md Phase 11 (Cloud) + Phase 12 (Cred-Proxy) + Integration Walk

## Metadata
- **Parent Plan**: PLAN-025-2
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-2 Task 7 (Phase 11 cloud backend selection), Task 8 (Phase 12 cred-proxy bootstrap), Task 9 (phase-numbering integration walk)
- **Estimated effort**: 7 hours (3h + 3h + 1h)
- **Status**: Draft
- **Future location**: `plugins/autonomous-dev/docs/specs/SPEC-025-2-06-setup-wizard-phases-11-and-12.md`

## Description
Append two new phases to `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` per TDD-025 §6.7:

- **Phase 11: Cloud backend selection (optional).** Per FR-1516 and PRD-015 R-3 ("check, don't install"). Prompts the operator for which cloud(s) they target; checks per-cloud plugin install (`ls plugins/autonomous-dev-deploy-<cloud>/`); checks cloud-CLI presence (`command -v gcloud / aws / az / kubectl`); checks root-credential reachability (`gcloud auth list`, `aws sts get-caller-identity`, `az account show`, `kubectl auth can-i get pods --all-namespaces`) without storing or echoing the output.
- **Phase 12: Credential proxy bootstrap (optional).** Per FR-1516 and FR-1539 (never echo secrets). Per-cloud scoper-plugin install check; walks the operator through `cred-proxy start` and `cred-proxy doctor`; auto-verifies socket permissions using the platform-aware `stat` from SPEC-025-1-03; sets `audit_key_env` if not already set using a never-echoing pattern (file-based or `read -s`); test-issuance with `cred-proxy issue <cloud> <minimal-scope>` and verification via `cred-proxy doctor --verify-audit`.

Plus the integration walk (Task 9): manual end-to-end review confirming existing phases 1-10 are byte-for-byte unchanged, the optional-marker convention is uniform, and the phase-numbering does not collide with future TDD-026 / TDD-028 phases (13, 14).

After this spec lands, PLAN-025-2 is complete. The setup-wizard runs phases 1-10 unchanged for operators without `--with-cloud`; phases 11 and 12 run only when `--with-cloud` is passed (the flag itself is owned by TDD-026 §6.7).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` | Modify (append Phase 11 and Phase 12) | Strictly additive; existing 10 phases byte-for-byte unchanged. |

## Implementation Details

### Implementer's first action: read the existing wizard

The implementer must first read `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` to determine:

- The exact heading style for phase headers (likely `### Phase N: <title>` based on PLAN-025-2 acceptance criteria, but verify).
- Whether existing phases use a "Goal" / "Steps" / "Exit criterion" sub-structure or a less-formal flow.
- The convention for marking optional content (PLAN-025-2 references FR-1516 but the on-disk convention may be `(optional)` in the heading, an "Optional:" prefix, or a callout block).
- Whether code blocks use `bash` fences or generic.
- The "See also" / cross-reference convention.

Match the existing format precisely. The phases below assume `### Phase N: <title> (optional)` heading style with H4 subsections; adjust if the file's actual convention differs.

### Phase 11: Cloud backend selection (optional)

Append after the existing Phase 10. Required content:

```markdown
### Phase 11: Cloud backend selection (optional)

> Run only if you passed `--with-cloud` to `quickstart`. The flag itself is parsed by `commands/quickstart.md`. Operators without cloud deploys can skip this phase entirely; phases 1-10 are sufficient for non-cloud workflows.

**Goal.** Identify the cloud(s) the operator targets, verify the per-cloud `autonomous-dev-deploy-<cloud>` plugin is installed, verify the cloud's CLI is on PATH, and verify root credentials are reachable. The phase does **not** install plugins or modify credentials; per PRD-015 R-3 the wizard checks and surfaces install commands but does not run them.

#### Step 11.1 — Prompt for cloud(s)

Present the operator with the four-option choice (multi-select):

```text
Which cloud(s) do you target?
  [ ] gcp     (autonomous-dev-deploy-gcp)
  [ ] aws     (autonomous-dev-deploy-aws)
  [ ] azure   (autonomous-dev-deploy-azure)
  [ ] k8s     (autonomous-dev-deploy-k8s)
```

If the operator selects nothing, exit Phase 11 cleanly with a note that `--with-cloud` was passed but no clouds were selected.

#### Step 11.2 — Verify plugin install (per chosen cloud)

For each chosen `<cloud>`:

```bash
ls plugins/autonomous-dev-deploy-<cloud>/
```

If the directory does not exist, emit the install command and exit Phase 11 cleanly:

```text
Plugin autonomous-dev-deploy-<cloud> is not installed. Install it with:

    claude plugin install autonomous-dev-deploy-<cloud>

Then re-run quickstart --with-cloud.
```

The wizard does **not** invoke `claude plugin install` itself (PRD-015 R-3).

#### Step 11.3 — Verify cloud CLI is on PATH

For each chosen cloud, the corresponding CLI must be discoverable:

| Cloud | CLI command  |
|-------|--------------|
| gcp   | `gcloud`     |
| aws   | `aws`        |
| azure | `az`         |
| k8s   | `kubectl`    |

```bash
command -v gcloud   # for gcp
command -v aws      # for aws
command -v az       # for azure
command -v kubectl  # for k8s
```

If `command -v` returns non-zero, emit the install instruction (link to the cloud's official install docs) and exit Phase 11 cleanly. Do not attempt to install the CLI.

#### Step 11.4 — Verify root-credential reachability

For each chosen cloud, run the per-cloud reachability check. **Do not store, echo, or log the output** — only the exit code matters.

| Cloud | Reachability check                                       |
|-------|----------------------------------------------------------|
| gcp   | `gcloud auth list --format=value(account) > /dev/null 2>&1` |
| aws   | `aws sts get-caller-identity > /dev/null 2>&1`           |
| azure | `az account show > /dev/null 2>&1`                       |
| k8s   | `kubectl auth can-i get pods --all-namespaces > /dev/null 2>&1` |

Each check exits zero on success. On failure, surface a generic "Could not reach <cloud> root credentials; verify your <CLI> session is active" message — **do not** include the underlying error text (which may contain credential fragments).

#### Phase 11 exit criterion

All chosen clouds have: plugin installed, CLI on PATH, root credentials reachable. Operator proceeds to Phase 12 if any cloud was chosen; if none, the wizard ends here.

**See also.** `instructions/cred-proxy-runbook.md` (per-cloud scoper installation), `commands/assist.md` (Glob and Bash discovery for the chosen-cloud plugins).
```

**Required content (acceptance for Phase 11):**

- Heading: `### Phase 11: Cloud backend selection (optional)` (verbatim).
- Intro callout/blockquote stating "Run only if you passed `--with-cloud`" (or close paraphrase).
- Step 11.1 prompt covers all four clouds (gcp, aws, azure, k8s) with the canonical plugin name in parentheses.
- Step 11.2 documents the `ls plugins/autonomous-dev-deploy-<cloud>/` check and the `claude plugin install autonomous-dev-deploy-<cloud>` install command. The wizard does **not** invoke the install (PRD-015 R-3 explicit).
- Step 11.3 lists all four CLI commands (`gcloud`, `aws`, `az`, `kubectl`) with `command -v`.
- Step 11.4 lists the four reachability checks with output redirected to `/dev/null` (no storage; no echo).
- Step 11.4's failure-message guidance explicitly says "do not include the underlying error text" or equivalent (avoiding credential leakage in error reports).
- Phase 11 exit criterion documented.
- "See also" footer references runbook and `commands/assist.md`.

### Phase 12: Credential proxy bootstrap (optional)

Append after Phase 11. Required content:

```markdown
### Phase 12: Credential proxy bootstrap (optional)

> Required only if you completed Phase 11. Phase 12 bootstraps the cred-proxy daemon and the per-cloud scoper plugins for the cloud(s) chosen in Phase 11.

**Goal.** Verify each chosen cloud's scoper plugin is installed; walk the operator through starting the cred-proxy daemon and running its diagnostic; auto-verify socket permissions; install the audit key without echoing it; verify a test issuance succeeds.

#### Step 12.1 — Verify scoper-plugin install (per chosen cloud)

For each `<cloud>` chosen in Phase 11:

```bash
ls ~/.autonomous-dev/cred-proxy/scopers/<cloud>/   # OR plugins/cred-proxy-scoper-<cloud>/
```

If the directory does not exist, emit the install command and exit Phase 12 cleanly:

```text
Scoper cred-proxy-scoper-<cloud> is not installed. Install it with:

    claude plugin install cred-proxy-scoper-<cloud>

Then re-run quickstart --with-cloud.
```

The wizard does **not** invoke `claude plugin install` itself (PRD-015 R-3).

#### Step 12.2 — Start the cred-proxy daemon

```bash
cred-proxy start
```

If the daemon is already running, `start` exits zero with a note. If it fails to start (port-in-use, ownership conflict, etc.), surface the diagnostic and exit Phase 12.

#### Step 12.3 — Run cred-proxy doctor

```bash
cred-proxy doctor
```

`doctor` exits zero on a clean run and reports: socket exists with mode 0600; ownership matches running user; per-cloud scopers discoverable; root credentials reachable. If `doctor` reports a problem, refer the operator to `instructions/cred-proxy-runbook.md` §5 (recovery).

#### Step 12.4 — Auto-verify socket permissions

Use the platform-aware `stat` invocation (same as `commands/assist.md` Step 2 Bash):

```bash
if [[ "$(uname)" == "Darwin" ]]; then
  stat -f "%Sp %u %g" ~/.autonomous-dev/cred-proxy/socket
else
  stat -c "%a %u %g" ~/.autonomous-dev/cred-proxy/socket
fi
```

Confirm: mode is `0600` (`srw-------` on macOS, `600` on Linux); owner UID matches the operator's UID. If either is wrong, refer to runbook §5.1.

#### Step 12.5 — Install the audit key (if not already set)

If the operator's shell environment does not have `CRED_PROXY_AUDIT_KEY` exported, walk through generating and installing it. **Never echo the audit-key value to stdout.**

The wizard's recommended pattern (file-based, atomic, no stdout exposure):

```bash
( umask 0177; openssl rand -hex 32 > ~/.autonomous-dev/cred-proxy/audit-key )
chmod 0600 ~/.autonomous-dev/cred-proxy/audit-key
```

Then prompt the operator to add the export to their shell rc (`~/.bashrc`, `~/.zshrc`):

```bash
# Add to your shell rc:
export CRED_PROXY_AUDIT_KEY="$(cat ~/.autonomous-dev/cred-proxy/audit-key)"
```

And to ensure `~/.autonomous-dev/cred-proxy/config.yaml` references the env-var by name:

```yaml
cred_proxy:
  audit_key_env: CRED_PROXY_AUDIT_KEY   # the NAME of the env var, not the key
```

The wizard does not write to the operator's shell rc itself — it surfaces the line to add. The operator is the agent that completes the install, ensuring the operator owns the change.

If the operator prefers an interactive (no file) pattern, document the alternative:

```bash
read -s -p "Audit key: " CRED_PROXY_AUDIT_KEY
export CRED_PROXY_AUDIT_KEY
```

#### Step 12.6 — Test issuance and audit verification

For one of the chosen clouds, perform a test issuance:

```bash
cred-proxy issue <cloud> "<minimal-scope>"   # e.g., aws "ec2:DescribeInstances"
```

If `cred-proxy issue` supports `--dry-run`, prefer it (no live cloud-side issuance). If it does not, the live-issuance path is acceptable for the wizard — the issued credential expires in 15 minutes and the audit log records the event.

Verify the audit-log entry appears:

```bash
cred-proxy doctor --verify-audit
```

The chain hash should advance by one. A clean exit confirms the bootstrap succeeded.

#### Phase 12 exit criterion

`cred-proxy doctor` and `cred-proxy doctor --verify-audit` both exit zero. The audit key is installed and the env-var export is documented (the operator may need to re-source their shell rc before the next phase). At least one test issuance succeeded for one chosen cloud.

**See also.** `instructions/cred-proxy-runbook.md` §2 (bootstrap), §3 (per-cloud scoper installation), `skills/config-guide/SKILL.md` `cred_proxy` section (config schema).
```

**Required content (acceptance for Phase 12):**

- Heading: `### Phase 12: Credential proxy bootstrap (optional)` (verbatim).
- Intro callout/blockquote stating "Required only if you completed Phase 11" (or close paraphrase).
- Step 12.1 documents the scoper-plugin install check and emits `claude plugin install cred-proxy-scoper-<cloud>` (does not invoke).
- Step 12.2 documents `cred-proxy start`.
- Step 12.3 documents `cred-proxy doctor`.
- Step 12.4 documents the platform-aware `stat` invocation and verifies mode `0600` + owner UID.
- Step 12.5 documents the audit-key generation and install **without echoing the key value**. Both the file-based pattern and the `read -s` alternative are documented.
- Step 12.5 documents the `audit_key_env: CRED_PROXY_AUDIT_KEY` config with the inline "the NAME of the env var, not the key" comment.
- Step 12.5 explicitly states the wizard does not modify the operator's shell rc itself (operator agency).
- Step 12.6 documents the test issuance with `--dry-run` preferred + live fallback documented.
- Step 12.6 documents `cred-proxy doctor --verify-audit` as the post-issuance check.
- Phase 12 exit criterion: `cred-proxy doctor` and `cred-proxy doctor --verify-audit` both exit zero.
- "See also" footer references runbook §2 and §3 plus `config-guide/SKILL.md` `cred_proxy` section.
- **No documented command in Phase 12 echoes the audit key, root credentials, or scoper-issued tokens to stdout.** This is the FR-1539 contract.

### Phase-numbering integration walk (Task 9)

After Phase 11 and Phase 12 are appended, walk the entire `setup-wizard/SKILL.md` end-to-end:

1. **Verify phases 1-10 are byte-for-byte unchanged.** Run `git diff main -- plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` and confirm only added lines (no modifications, no deletions in the existing-phase region).

2. **Verify the optional-marker convention is uniform.** If any existing phase is marked optional, confirm Phase 11 and Phase 12 use the same marker style (e.g., `(optional)` in the heading vs. an "Optional:" prefix block).

3. **Verify cross-references resolve.** All "See also" links in Phase 11 and Phase 12 should resolve to extant files (or be documented forward references — runbook is delivered by SPEC-025-2-01..04 in the same batch).

4. **Verify phase-numbering does not collide with future phases.** Phase 13 (firewall, TDD-028) and Phase 14 (dry-run deploy, TDD-026) are owned by sibling TDDs and not delivered here. The numbering 11 and 12 is reserved for this TDD; 13 and 14 are reserved for siblings. If TDD-026 / TDD-028 plans land before this PR merges, verify their phase numbering does not conflict.

5. **If a `setup-wizard-questions.yaml` regression suite exists** (per TDD-025 §11.4 trade-off), confirm it still passes. If it does not exist, document this as a forward dependency and **do not block merge** — the regression suite is a future deliverable.

The integration walk is a manual review-time check. The output is either "phase-numbering audit passed; X items reviewed" appended to the PR description, or a small follow-up commit fixing any inconsistencies (with message format `fix(docs): wizard phase consistency <details>`).

### Lint and formatting

- `markdownlint` (existing config) must pass on the modified file.
- Heading hierarchy: H3 for phase headers (`### Phase 11:`); H4 for steps within a phase (`#### Step 11.1`).
- Code-block fences use `bash` for shell, `yaml` for config, `text` for prompt mock-ups.
- Blockquote (`>`) used for the phase-intro "Run only if you passed --with-cloud" callouts.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` contains a new `### Phase 11: Cloud backend selection (optional)` heading after the existing Phase 10.
- [ ] Phase 11 has the four-step structure: 11.1 (prompt for clouds), 11.2 (plugin install verify), 11.3 (CLI on PATH), 11.4 (root-credential reachability).
- [ ] Phase 11 lists all four cloud plugins (`autonomous-dev-deploy-{gcp,aws,azure,k8s}`) and all four CLI commands (`gcloud`, `aws`, `az`, `kubectl`).
- [ ] Phase 11.2 emits the install command (`claude plugin install autonomous-dev-deploy-<cloud>`) without invoking it (PRD-015 R-3).
- [ ] Phase 11.4 redirects all reachability-check output to `/dev/null` and explicitly forbids including the underlying error text in failure messages.
- [ ] `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` contains a new `### Phase 12: Credential proxy bootstrap (optional)` heading after Phase 11.
- [ ] Phase 12 has the six-step structure: 12.1 (scoper install verify), 12.2 (cred-proxy start), 12.3 (cred-proxy doctor), 12.4 (auto-verify socket perms), 12.5 (install audit key), 12.6 (test issuance + verify-audit).
- [ ] Phase 12.1 emits the install command (`claude plugin install cred-proxy-scoper-<cloud>`) without invoking it.
- [ ] Phase 12.4 includes the platform-aware `stat` invocation (`stat -f` for macOS, `stat -c` for Linux) inside a `uname` conditional.
- [ ] Phase 12.5 audit-key handling: file-based pattern documented (`umask 0177; openssl rand > file`); `read -s` alternative documented; `audit_key_env: CRED_PROXY_AUDIT_KEY` config example with verbatim "the NAME of the env var, not the key" inline comment.
- [ ] Phase 12.5 explicitly states the wizard does not modify the operator's shell rc itself.
- [ ] No command in Phase 12 echoes the audit key value to stdout. (Manual review.)
- [ ] Phase 12.6 prefers `--dry-run` for test issuance with documented live-issuance fallback (per OQ-5).
- [ ] Phase 12.6 documents `cred-proxy doctor --verify-audit` as the post-issuance check.
- [ ] Phase 11 and Phase 12 each have a "Goal" intro and an exit criterion.
- [ ] Phase 11 and Phase 12 each have a "See also" footer with cross-references to the runbook and config-guide.
- [ ] Existing phases 1-10 are byte-for-byte unchanged. Verified with `git diff main -- plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` (only added lines).
- [ ] Optional-marker convention is uniform with any existing-phase optional markers.
- [ ] All bash blocks fenced with `bash`; YAML with `yaml`; mock-ups with `text`.
- [ ] `markdownlint` exits 0 on the modified file.
- [ ] Phase-numbering integration audit (Task 9) executed; result documented in PR description ("phase-numbering audit passed" or list of fixes).

## Dependencies

- **TDD-025 §6.7** — authoritative for Phase 11 and Phase 12 structure.
- **PRD-015 R-3** — authoritative for "check, don't install" wizard contract.
- **FR-1516** — authoritative for the optional-phase marker convention.
- **FR-1539** — authoritative for the never-echo-secrets rule in Phase 12.
- **PLAN-025-2 Tasks 7, 8, 9** — explicit content and integration-audit requirements.
- **SPEC-025-1-03** (sibling, soft): the platform-aware `stat` invocation in Phase 12.4 must match the same idiom shipped in `commands/assist.md` Step 2 Bash. Coordination on the canonical idiom.
- **SPEC-025-2-01..04** (siblings, soft): the runbook §2, §3, §5, §6 references in Phase 11 and Phase 12 "See also" footers. Forward references acceptable.
- **SPEC-025-1-02** (sibling, soft): the config-guide `cred_proxy` reference in Phase 12.5 (audit-key step). Forward reference acceptable.
- **TDD-026** (future): owns the `--with-cloud` flag and Phase 14 (dry-run deploy). The Phase 11 intro "passed `--with-cloud` to `quickstart`" is a forward reference; the flag itself is not delivered by this spec.
- **TDD-028** (future): owns Phase 13 (firewall). Phase-numbering coordination at merge time.
- **No code dependencies** — documentation only.

## Notes

- Phase 11 and Phase 12 are explicitly **optional** per FR-1516. Operators who do not pass `--with-cloud` to `quickstart` see no change in their wizard experience. This is the migration-safety contract: the wizard's existing 10-phase flow is preserved byte-for-byte.
- Phase 12.5's never-echoing pattern is the same one documented in cred-proxy-runbook.md §2.3 (delivered by SPEC-025-2-01). The two surfaces should byte-match for the audit-key generation idiom. Drift would invite an operator to use the wizard's pattern in one place and the runbook's in another with subtly different security properties.
- The `--dry-run` preference in Phase 12.6 is conditional on cred-proxy supporting it (OQ-5). If TDD-024 §10 documents `--dry-run`, the wizard prefers it; otherwise the live-issuance path is the default. The implementer should re-check at PR time and update the spec if needed.
- The `read -s` alternative in Phase 12.5 is documented for environments without `openssl` (rare but plausible on minimal containers used for autonomous-dev development workstations). Both patterns satisfy the never-echo contract.
- The phase-numbering integration walk (Task 9) is the closing verification step for PLAN-025-2. If TDD-026 / TDD-028 sibling plans land their wizard phases (13, 14) before this PR merges, the integration walk catches any numbering drift. The orchestrator owns merge order per TDD-025 §11.4.
- The wizard's failure mode in Phase 11 / Phase 12 is **clean exit with an actionable diagnostic**, not a partial/half-installed state. If any check fails, the wizard exits with a clear "Install X then re-run quickstart --with-cloud" message. This is the PRD-015 R-3 mitigation generalized.
- The "Step N.M" subsection numbering style (e.g., "Step 11.1") matches the runbook's "§2.1" / "§3.1.1" style for consistency across the documentation surface. If the existing wizard uses a different convention (e.g., bare "1.", "2." within a phase), match the existing convention.
- After this spec lands, PLAN-025-2 is complete: runbook (SPEC-025-2-01..04) + troubleshoot scenarios (SPEC-025-2-05) + wizard phases (this spec) all in place. The remaining gap to TDD-025's full deliverable is PLAN-025-3 (eval suite + regression run), which is owned by a future plan/spec.
