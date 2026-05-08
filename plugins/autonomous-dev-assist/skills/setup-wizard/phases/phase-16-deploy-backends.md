---
phase: 16
title: "Deployment backends"
amendment_001_phase: 16
amendment_002_phase: 16
tdd_anchors: [TDD-023, TDD-024]
prd_links: [PRD-014, PRD-015, PRD-017]
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  prior_envs_configured: true
  with_cloud_flag: true
skip_predicate: "skip-predicates.sh phase_16_skip_predicate"
skip_consequence: |
  Only `local` backend configured; daemon cannot deploy to dev/staging/prod.
idempotency_probe: "idempotency-checks.sh phase-16-probe"
output_state:
  config_keys_written:
    - deploy.envs.dev.backend
    - deploy.envs.dev.cred_proxy_handle
    - deploy.envs.dev.firewall_template
    - deploy.envs.dev.last_dry_run_at
    - deploy.envs.staging.backend
    - deploy.envs.staging.cred_proxy_handle
    - deploy.envs.staging.firewall_template
    - deploy.envs.staging.last_dry_run_at
    - deploy.envs.prod.backend
    - deploy.envs.prod.cred_proxy_handle
    - deploy.envs.prod.firewall_template
    - deploy.envs.prod.last_dry_run_at
  files_created: []
  external_resources_created:
    - "cred-proxy-handle:dev"
    - "cred-proxy-handle:staging"
    - "cred-proxy-handle:prod"
    - "firewall-allowlist:dev"
    - "firewall-allowlist:staging"
    - "firewall-allowlist:prod"
verification:
  - "Per-env: plugin installed at expected version"
  - "Per-env: cred_proxy_validate_handle returns ok"
  - "Per-env: firewall apply returned success"
  - "Per-env: cost-cap-enforcer estimate is finite"
  - "Final deploy --dry-run --env dev exits 0 with structured plan"
  - "Daemon SIGHUP issued"
  - "No credential pattern observed in stdout/stderr/log/transcript"
eval_set: "evals/test-cases/setup-wizard/phase-16-deploy-backends/"
---

# Phase 16 — Deployment backends (per-env iteration: dev → staging → prod)

This phase configures deployment backends per environment. For each
environment in fixed order (`dev` → `staging` → `prod`) it:

1. Prompts for backend choice from `{local, aws, gcp, azure, k8s}`.
2. Runs **every** operator input through `lib/credential-scanner.sh` BEFORE
   any state write (FR-9). First match aborts the phase.
3. For non-`local` backends: upserts the matching `autonomous-dev-deploy-*`
   plugin install, provisions a credential proxy **handle** (handle-only;
   credential bytes never enter the wizard process), validates the handle,
   applies a firewall allowlist template, and runs the cost-cap-enforcer
   dry-run.
4. After all envs are configured, runs a final `autonomous-dev deploy
   --dry-run --env dev` and asserts a structured plan response.

Per-env state is written transactionally; an env's failure does not
corrupt prior envs' already-written state. Cross-env rollback is handled
by `autonomous-dev wizard rollback --phase 16` (SPEC-033-4-04), NOT
inline.

## PRD cross-reference banner (FR-16)

Emitted exactly once before the plugin/firewall/deploy chain steps:

```
================================================================
NOTE: This phase configures deployment backends. The chain
orchestration that runs deploy steps live (post-merge) is documented
in PRD-015. The cost-cap-enforcer behavior on actual deploys is in
PRD-017 (FR-1701-1705).

PRD-015 reference: docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md
PRD-017 reference: docs/prds/PRD-017-cost-cap-enforcer.md

This phase performs DRY-RUN verification only; no cloud resources
are created.
================================================================
```

The banner names PRDs and links to them by relative repo path; it does
NOT inline PRD content. The eval `linked-prd-no-duplication.md` regex-scans
rendered output for ≥40-char verbatim sentence matches against PRD-015
and PRD-017; the banner sentences are intentionally short or are paths.

## Steps

### Step `intro-and-prd-banner`

Emit the FR-16 banner once. Set `WIZARD_PHASE_16_BANNER_EMITTED=1` to
guard against re-emit on resume.

### Step `iter-envs`

```bash
for env in dev staging prod; do
  _phase16_run_env "$env"
done
```

Per-env subroutine (see below) handles backend prompt, scanner gate,
plugin install, cred-proxy provision/validate, firewall apply, cost-cap
dry-run, and per-env state write.

### Step `prompt-backend` (per env)

Prompt the operator for one of `{local, aws, gcp, azure, k8s}`. Default
for the first env is `local`; subsequent envs default to the prior env's
choice.

```bash
read -r choice
# FR-9: scan operator input BEFORE any state write.
if ! bash "$LIB_DIR/credential-scanner.sh" "$choice"; then
  echo "[phase-16] credential pattern detected in operator input; aborting phase." >&2
  _phase16_set_status failed
  exit 1
fi
```

### Step `plugin-install` (per env, non-local only)

Upsert install. Skip when the installed version matches the available
version; on mismatch, prompt the operator:

```
currently installed: X.Y.Z; available: X.Y.Z+1; install? [y/N]
```

```bash
plugin="autonomous-dev-deploy-${backend}"
installed_version="$(autonomous-dev plugin info "$plugin" 2>/dev/null \
  | jq -r '.version // empty')"
# Probe what's available; mock returns available version on exit code 4.
install_out="$(autonomous-dev plugin install "$plugin" 2>&1)"; rc=$?
if (( rc == 0 )); then
  : # already at matching version OR newly installed
elif (( rc == 4 )); then
  # version-mismatch — prompt operator
  available="$(echo "$install_out" | jq -r '.available // empty')"
  current="$(echo "$install_out" | jq -r '.current // empty')"
  printf 'currently installed: %s; available: %s; install? [y/N] ' \
    "$current" "$available"
  read -r upgrade_choice
  if [[ "$upgrade_choice" == "y" || "$upgrade_choice" == "Y" ]]; then
    autonomous-dev plugin install "$plugin" --upgrade || _phase16_abort_env "$env"
  else
    _phase16_abort_env "$env"   # operator declined; per-env atomicity
  fi
else
  _phase16_abort_env "$env"
fi
```

### Step `cred-proxy-provision` (per env, non-local only)

Invoke `cred_proxy_provision` from `lib/cred-proxy-bridge.sh`. The wizard
process receives ONLY the opaque handle on stdout. Credential bytes are
entered via cred-proxy's own TTY context; they NEVER flow through the
wizard's stdin / pipes / state.

```bash
# shellcheck source=../lib/cred-proxy-bridge.sh
source "$LIB_DIR/cred-proxy-bridge.sh"
handle="$(cred_proxy_provision "$backend" "$env")" || _phase16_abort_env "$env"
# Defense in depth: handle shape check (also enforced inside the bridge).
if [[ ! "$handle" =~ ^cph_[A-Za-z0-9]{32}$ ]]; then
  echo "[phase-16] invalid handle shape returned by cred-proxy" >&2
  _phase16_abort_env "$env"
fi
```

### Step `cred-proxy-validate` (per env, non-local only)

```bash
status="$(cred_proxy_validate_handle "$handle")"
case "$status" in
  ok) ;;
  expired|unknown) _phase16_abort_env "$env" ;;
  *) _phase16_abort_env "$env" ;;
esac
```

### Step `firewall-apply` (per env, non-local only)

```bash
fw_resp="$(autonomous-dev firewall apply \
  --allowlist-template "${backend}-default" --env "$env")"
fw_status="$(echo "$fw_resp" | jq -r '.status // empty')"
case "$fw_status" in
  applied|idempotent) ;;   # both are success
  *) _phase16_abort_env "$env" ;;
esac
```

### Step `cost-cap-dry-run` (per env, non-local only)

```bash
cost_resp="$(autonomous-dev deploy --dry-run --env "$env" --estimate-only)"
cost="$(echo "$cost_resp" | jq -r '.estimated_monthly_cost_usd')"
# FR-14: must be a finite numeric.
if [[ "$cost" == "null" || -z "$cost" || ! "$cost" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "[phase-16] cost-cap-enforcer returned non-finite estimate; see PRD-017 FR-1701-1705." >&2
  _phase16_abort_env "$env"
fi
ceiling="$(jq -r '.deploy.cost_cap_monthly_usd_max // 50' "$AUTONOMOUS_DEV_CONFIG")"
if (( $(echo "$cost > $ceiling" | bc -l) )); then
  echo "[phase-16] cost estimate \$$cost exceeds ceiling \$$ceiling; see PRD-017." >&2
  _phase16_abort_env "$env"
fi
```

### Step `write-env-state` (per env)

Per-env atomicity: write the four config keys for THIS env only. On
abort, prior envs' state is untouched.

```bash
jq --arg env "$env" --arg backend "$backend" --arg handle "$handle" \
   --arg fw "${backend}-default" --arg ts "$(date -u +%FT%TZ)" \
   '.deploy.envs[$env] = {
      backend: $backend,
      cred_proxy_handle: $handle,
      firewall_template: $fw,
      last_dry_run_at: $ts
    }' "$AUTONOMOUS_DEV_CONFIG" > "$AUTONOMOUS_DEV_CONFIG.new"
mv "$AUTONOMOUS_DEV_CONFIG.new" "$AUTONOMOUS_DEV_CONFIG"
```

For `local` backends, the per-env block stores only the backend value;
`cred_proxy_handle` and `firewall_template` are empty strings.

### Step `final-dry-run`

After all envs are configured, run a final dry-run for `dev`:

```bash
final_resp="$(autonomous-dev deploy --dry-run --env dev)"
plan_steps="$(echo "$final_resp" | jq -r '.plan_steps // empty')"
if [[ -z "$plan_steps" ]]; then
  echo "[phase-16] final dry-run did not return a structured plan." >&2
  _phase16_set_status failed
  exit 1
fi
```

### Step `sighup-and-summary`

```bash
if [[ -z "${WIZARD_HEADLESS:-}" ]]; then
  pkill -HUP -f autonomous-dev-daemon || true
fi
_phase16_set_status complete
```

## Helper functions (sourced from this phase only)

```bash
_phase16_set_status() {
  local s="$1"
  jq --arg s "$s" '.phases["16"].status = $s' \
     "$WIZARD_STATE_FILE" > "$WIZARD_STATE_FILE.new"
  mv "$WIZARD_STATE_FILE.new" "$WIZARD_STATE_FILE"
}

# Per-env atomicity: env-N abort does NOT touch env<N already-written state.
_phase16_abort_env() {
  local env="$1"
  echo "[phase-16] aborting at env=$env; prior envs preserved." >&2
  _phase16_set_status failed
  exit 1
}
```

## Eval cases

Six cases live under `evals/test-cases/setup-wizard/phase-16-deploy-backends/`:

| File                              | Purpose                                              |
|-----------------------------------|------------------------------------------------------|
| `happy-path.md`                   | dev=aws + staging/prod=local; full success           |
| `skip-with-consequence.md`        | `wizard.skip_phase_16=true`; FR-4 verbatim emitted   |
| `error-recovery.md`               | 4 sub-cases: net-fail / version-mismatch / cred-proxy fail / dry-run fail |
| `idempotency-resume.md`           | 4 sub-cases: plugin skip / handle keep-vs-rotate / firewall no-op / dry-run always re-runs |
| `linked-prd-no-duplication.md`    | regex-scan: 0 ≥40-char verbatim PRD-015/017 matches  |
| `credential-leak.md`              | 6 family injections + post-run scanner sweep (AC-08) |

## Cross-references

- `_phase-contract.md` — front-matter schema.
- `lib/cred-proxy-bridge.sh` — provision/validate/revoke wrappers (handle-only).
- `lib/credential-scanner.sh` — six-family scanner used uniformly on EVERY operator input.
- SPEC-033-4-04 — `autonomous-dev wizard rollback --phase 16` reverts the
  12 config keys, revokes 3 cred-proxy handles, rolls back 3 firewall
  allowlists. Snapshot capture happens automatically at phase entry.
- TDD-025 prior-art (cloud + cred-proxy bootstrap content from earlier
  phase 16 module) is preserved upstream of the per-env iteration above
  for operator reference; the operative state-writing flow is the
  per-env loop in this module.

## Phase-numbering integration walk

This module sits at phase 16 in the modular orchestrator's
`PHASE_REGISTRY=(08 11 12 13 14 15 16)`. Phases 1-10 are byte-for-byte
unchanged. The phase runs only when the operator opts in (default-skip
via `wizard.skip_phase_16=true` or `wizard.phase_16_module_enabled=false`).
