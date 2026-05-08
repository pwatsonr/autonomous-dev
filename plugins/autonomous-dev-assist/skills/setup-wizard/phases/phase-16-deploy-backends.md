---
phase: 16
title: "Deploy backends, cred-proxy, and firewall (optional)"
amendment_002_phase: 16
tdd_anchors: [TDD-024, TDD-025]
prd_links: [PRD-015]
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  with_cloud_flag: true
skip_predicate: "skip-predicates.sh phase_16_default_skip"
skip_consequence: |
  No cloud-backend plugins, scopers, or cred-proxy bootstrap performed.
  Cloud deploys remain unavailable; the wizard's existing 10-phase flow
  is sufficient for non-cloud workflows. Re-run with `--with-cloud` to
  enter this phase.
idempotency_probe: "idempotency-checks.sh phase-16-probe"
output_state:
  config_keys_written:
    - cloud.selected
    - cred_proxy.audit_key_env
    - cred_proxy.default_ttl_seconds
    - cred_proxy.socket_path
  files_created:
    - "~/.autonomous-dev/cred-proxy/audit-key"
    - "~/.autonomous-dev/cred-proxy/config.yaml"
  external_resources_created: []
verification:
  - "cred-proxy doctor exits 0 for each chosen cloud"
  - "cred-proxy doctor --verify-audit exits 0 (chain advances after test issuance)"
  - "Socket mode is 0600 and owner UID matches operator UID"
  - "audit_key_env field contains an env-var NAME, not the key value"
eval_set: "evals/test-cases/setup-wizard/phase-16-deploy-backends/"
---

# Phase 16 — Deploy backends, cred-proxy, and firewall (optional)

This phase covers PRD-015's cloud + credential-proxy operator-onboarding
surface. It is **default-skip**: operators who do not pass `--with-cloud`
to `quickstart` see no change in the wizard's existing 10-phase flow.
When entered, this phase walks two cohesive groups of steps:

- **Phase 16-A: Cloud backend selection.** Verify per-cloud
  `autonomous-dev-deploy-<cloud>` plugin install, cloud-CLI on PATH, and
  root-credential reachability (per PRD-015 R-3: check, do not install).
- **Phase 16-B: Credential-proxy bootstrap.** Verify per-cloud
  `cred-proxy-scoper-<cloud>` plugin install; walk through `cred-proxy
  start` and `cred-proxy doctor`; auto-verify socket permissions; install
  the audit key without echoing it (FR-1539); test issuance and verify
  the audit chain advances.

The firewall sub-phase (referenced in TDD-024 §11 and TDD-025 §11.4) is
owned by TDD-028 and is layered into this same module by a future spec.

## Steps

### Step `intro`

Banner:

```
================================================================
   Phase 16: Deploy backends, cred-proxy, firewall (OPTIONAL)
================================================================
Default: SKIP. Enter only if you passed `--with-cloud` to quickstart
or you explicitly opt in here. Without it, the wizard's existing
10-phase flow is sufficient for non-cloud workflows.
```

If the operator did not pass `--with-cloud` and does not opt in
explicitly, mark phase skipped, emit `skip_consequence`, return.

## Phase 16-A: Cloud backend selection

**Goal.** Identify the cloud(s) the operator targets, verify the
per-cloud `autonomous-dev-deploy-<cloud>` plugin is installed, verify
the cloud's CLI is on PATH, and verify root credentials are reachable.
The phase does **not** install plugins or modify credentials; per
PRD-015 R-3 the wizard checks and surfaces install commands but does
not run them.

### Step `prompt-clouds`

Present the operator with the four-option choice (multi-select):

```text
Which cloud(s) do you target?
  [ ] gcp     (autonomous-dev-deploy-gcp)
  [ ] aws     (autonomous-dev-deploy-aws)
  [ ] azure   (autonomous-dev-deploy-azure)
  [ ] k8s     (autonomous-dev-deploy-k8s)
```

If the operator selects nothing, exit phase 16 cleanly with a note that
`--with-cloud` was passed but no clouds were selected. Write
`cloud.selected = []` to wizard-state.

### Step `verify-plugin-install`

For each chosen `<cloud>`:

```bash
ls plugins/autonomous-dev-deploy-<cloud>/
```

If the directory does not exist, emit the install command and exit
phase 16 cleanly:

```text
Plugin autonomous-dev-deploy-<cloud> is not installed. Install it with:

    claude plugin install autonomous-dev-deploy-<cloud>

Then re-run quickstart --with-cloud.
```

The wizard does **not** invoke `claude plugin install` itself
(PRD-015 R-3).

### Step `verify-cloud-cli`

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

If `command -v` returns non-zero, emit the install instruction (link to
the cloud's official install docs) and exit phase 16 cleanly. Do not
attempt to install the CLI.

### Step `verify-root-creds`

For each chosen cloud, run the per-cloud reachability check. **Do not
store, echo, or log the output** — only the exit code matters.

| Cloud | Reachability check                                              |
|-------|-----------------------------------------------------------------|
| gcp   | `gcloud auth list --format=value(account) > /dev/null 2>&1`     |
| aws   | `aws sts get-caller-identity > /dev/null 2>&1`                  |
| azure | `az account show > /dev/null 2>&1`                              |
| k8s   | `kubectl auth can-i get pods --all-namespaces > /dev/null 2>&1` |

Each check exits zero on success. On failure, surface a generic "Could
not reach <cloud> root credentials; verify your <CLI> session is
active" message — **do not** include the underlying error text (which
may contain credential fragments).

**Phase 16-A exit criterion.** All chosen clouds have: plugin
installed, CLI on PATH, root credentials reachable. Operator proceeds
to Phase 16-B. Write `cloud.selected = [<list>]` to wizard-state.

## Phase 16-B: Credential proxy bootstrap

**Goal.** Verify each chosen cloud's scoper plugin is installed; walk
the operator through starting the cred-proxy daemon and running its
diagnostic; auto-verify socket permissions; install the audit key
without echoing it; verify a test issuance succeeds.

### Step `verify-scoper-install`

For each `<cloud>` chosen in 16-A:

```bash
ls ~/.autonomous-dev/cred-proxy/scopers/<cloud>/   # OR plugins/cred-proxy-scoper-<cloud>/
```

If the directory does not exist, emit the install command and exit
phase 16 cleanly:

```text
Scoper cred-proxy-scoper-<cloud> is not installed. Install it with:

    claude plugin install cred-proxy-scoper-<cloud>

Then re-run quickstart --with-cloud.
```

The wizard does **not** invoke `claude plugin install` itself
(PRD-015 R-3).

### Step `cred-proxy-start`

```bash
cred-proxy start
```

If the daemon is already running, `start` exits zero with a note. If it
fails to start (port-in-use, ownership conflict, etc.), surface the
diagnostic and exit phase 16.

### Step `cred-proxy-doctor`

```bash
cred-proxy doctor
```

`doctor` exits zero on a clean run and reports: socket exists with mode
`0600`; ownership matches running user; per-cloud scopers discoverable;
root credentials reachable. If `doctor` reports a problem, refer the
operator to `instructions/cred-proxy-runbook.md` §5 (recovery).

### Step `verify-socket-perms`

Use the platform-aware `stat` invocation (same as `commands/assist.md`
Step 2 Bash):

```bash
if [[ "$(uname)" == "Darwin" ]]; then
  stat -f "%Sp %u %g" ~/.autonomous-dev/cred-proxy/socket
else
  stat -c "%a %u %g" ~/.autonomous-dev/cred-proxy/socket
fi
```

Confirm: mode is `0600` (`srw-------` on macOS, `600` on Linux); owner
UID matches the operator's UID. If either is wrong, refer to runbook
§5.1.

### Step `install-audit-key`

If the operator's shell environment does not have
`CRED_PROXY_AUDIT_KEY` exported, walk through generating and installing
it. **Never echo the audit-key value to stdout.** The wizard does not
modify the operator's shell rc itself — it surfaces the line to add.
The operator is the agent that completes the install, ensuring the
operator owns the change.

The wizard's recommended pattern (file-based, atomic, no stdout
exposure):

```bash
( umask 0177; openssl rand -hex 32 > ~/.autonomous-dev/cred-proxy/audit-key )
chmod 0600 ~/.autonomous-dev/cred-proxy/audit-key
```

Then prompt the operator to add the export to their shell rc
(`~/.bashrc`, `~/.zshrc`):

```bash
# Add to your shell rc:
export CRED_PROXY_AUDIT_KEY="$(cat ~/.autonomous-dev/cred-proxy/audit-key)"
```

And to ensure `~/.autonomous-dev/cred-proxy/config.yaml` references the
env-var by name:

```yaml
cred_proxy:
  audit_key_env: CRED_PROXY_AUDIT_KEY   # the NAME of the env var, not the key
```

If the operator prefers an interactive (no file) pattern, document the
alternative:

```bash
read -s -p "Audit key: " CRED_PROXY_AUDIT_KEY
export CRED_PROXY_AUDIT_KEY
```

Both patterns satisfy the FR-1539 never-echo contract.

### Step `test-issuance`

For one of the chosen clouds, perform a test issuance:

```bash
cred-proxy issue <cloud> "<minimal-scope>"   # e.g., aws "ec2:DescribeInstances"
```

If `cred-proxy issue` supports `--dry-run`, prefer it (no live
cloud-side issuance). If it does not, the live-issuance path is
acceptable for the wizard — the issued credential expires in 15 minutes
and the audit log records the event.

### Step `verify-audit`

Verify the audit-log entry appears:

```bash
cred-proxy doctor --verify-audit
```

The chain hash should advance by one. A clean exit confirms the
bootstrap succeeded.

**Phase 16-B exit criterion.** `cred-proxy doctor` and `cred-proxy
doctor --verify-audit` both exit zero. The audit key is installed and
the env-var export is documented (the operator may need to re-source
their shell rc before the next phase). At least one test issuance
succeeded for one chosen cloud.

## See also

- `instructions/cred-proxy-runbook.md` §2 (bootstrap), §3 (per-cloud
  scoper installation), §6 (TTL tuning).
- `skills/config-guide/SKILL.md` Section 21: cred_proxy (config schema).
- `skills/help/SKILL.md` Cloud Backends + Credential Proxy sections.

## Phase-numbering integration walk

This module sits at phase 16 in the modular orchestrator's
`PHASE_REGISTRY=(08 11 12 13 14 15 16)` (per
`skills/setup-wizard/SKILL.md` Phase Modules section). Phases 1-10 are
byte-for-byte unchanged; this phase runs only when the operator opts in
or passes `--with-cloud`. Future TDD-028 (firewall) and TDD-026
(`--with-cloud` flag wiring) extend this module with additional steps;
phase numbering does not collide because all cloud + cred-proxy +
firewall content is namespaced under phase 16.
