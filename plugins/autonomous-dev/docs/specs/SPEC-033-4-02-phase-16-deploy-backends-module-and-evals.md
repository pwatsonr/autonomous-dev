# SPEC-033-4-02: Phase 16 Module — Deployment Backends + Eval Set (Six Cases)

## Metadata
- **Parent Plan**: PLAN-033-4
- **Parent TDD**: TDD-033 §6.7, §9.4
- **Parent PRD**: AMENDMENT-002 §4.7, AC-05, AC-08
- **Tasks Covered**: PLAN-033-4 Tasks 3, 4
- **Estimated effort**: 3 days
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-02

## 1. Summary

Author the phase 16 module that configures deployment backends per
environment (`local`/`aws`/`gcp`/`azure`/`k8s` for dev/staging/prod),
installing the corresponding `autonomous-dev-deploy-*` plugin,
provisioning credentials via the TDD-024 cred-proxy (handle-only;
credential bytes never enter the wizard), applying the egress firewall
allowlist, running the cost-cap-enforcer dry-run, and verifying via
`autonomous-dev deploy --dry-run`. The phase enforces TDD-033 §6.7's
critical security invariant: every operator input is run through the
SPEC-033-4-01 credential-pattern scanner BEFORE any state write; first
match aborts the phase. Six eval cases cover happy / skip / error /
idempotency / linked-PRD-no-duplication / credential-leak.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                  | Task |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | A markdown file at `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-16-deploy-backends.md` MUST exist with valid front-matter per `_phase-contract.md`. | T3   |
| FR-2  | Front-matter MUST set `phase: 16`, `title: "Deployment backends"`, `amendment_001_phase: 16`, `tdd_anchors: [TDD-023, TDD-024]`, `prd_links: [PRD-014, PRD-015, PRD-017]`, `required_inputs.phases_complete: [1,2,3,4,5,6,7]`. | T3   |
| FR-3  | Front-matter MUST set `skip_predicate: "skip-predicates.sh phase_16_skip_predicate"` where the wrapper exits 0 only when `wizard.skip_phase_16=true` (default false). | T3   |
| FR-4  | `skip_consequence` MUST contain the verbatim text "Only `local` backend configured; daemon cannot deploy to dev/staging/prod." | T3   |
| FR-5  | Front-matter MUST set `idempotency_probe: "idempotency-checks.sh phase-16-probe"` where the wrapper checks per env: plugin installed at matching version, cred-proxy handle present and `cred_proxy_validate_handle == ok`, firewall allowlist applied with current template, last `deploy --dry-run` within 7 days. | T3   |
| FR-6  | Front-matter `output_state.config_keys_written` MUST include: `deploy.envs.dev.backend`, `deploy.envs.dev.cred_proxy_handle`, `deploy.envs.dev.firewall_template`, `deploy.envs.dev.last_dry_run_at`, and the same four keys for `staging` and `prod`. | T3   |
| FR-7  | Front-matter `output_state.external_resources_created` MUST list `cred-proxy-handle:<env>` and `firewall-allowlist:<env>` for each non-`local` env, used by the rollback CLI (SPEC-033-4-04) for revocation. | T3   |
| FR-8  | The phase MUST iterate per env in fixed order `dev → staging → prod`. For each env: prompt backend choice from `{local, aws, gcp, azure, k8s}`. Default for first env is `local`; subsequent envs default to the prior env's choice. | T3   |
| FR-9  | EVERY operator input field (backend choice, env name confirmations, any free-form input) MUST be passed through `lib/credential-scanner.sh::scan_for_credential` BEFORE any state write or any subsequent step. On match: emit the scanner diagnostic to stderr, set `phases.16.status="failed"`, abort the phase WITHOUT writing any config keys, and exit 1. | T3   |
| FR-10 | For each non-`local` backend, the phase MUST run `autonomous-dev plugin install autonomous-dev-deploy-{aws|gcp|azure|k8s}` with upsert semantics: skip if already installed at matching version; on version mismatch, prompt operator with `currently installed: X.Y.Z; available: X.Y.Z+1; install? [y/N]`. | T3   |
| FR-11 | For each non-`local` backend, the phase MUST invoke `cred_proxy_provision <backend> <env>` (SPEC-033-4-01). The wizard MUST receive ONLY the opaque handle on stdout. The phase MUST NOT prompt for, display, or log any credential text. The credential entry happens in cred-proxy's own TTY context (FR-2 of SPEC-033-4-01). | T3   |
| FR-12 | After provisioning, the phase MUST invoke `cred_proxy_validate_handle <handle>`; on `expired` or `unknown`, abort the phase with diagnostic; on `ok` continue. | T3   |
| FR-13 | For each non-`local` backend, the phase MUST run `autonomous-dev firewall apply --allowlist-template <provider>-default --env <env>`. Re-applying with the same template is a no-op (verified by capturing the CLI's structured response). | T3   |
| FR-14 | The phase MUST run `autonomous-dev deploy --dry-run --env <env> --estimate-only` and parse the cost-cap-enforcer output. The output MUST be a finite numeric cost estimate; if unbounded or missing, the phase aborts with a diagnostic referencing PRD-017 FR-1701-1705. | T3   |
| FR-15 | The phase MUST run a final `autonomous-dev deploy --dry-run --env dev` and assert exit 0 with structured plan output (parseable JSON when `--json` flag is supported). The dry-run MUST NOT create any cloud resource. | T3   |
| FR-16 | A PRD-015 cross-reference banner MUST emit BEFORE the plugin/firewall/deploy chain steps, naming PRD-015 (chain orchestration) and PRD-017 (cost cap). The banner MUST link to those PRDs by relative repo path; the phase MUST NOT inline the PRD content. | T3   |
| FR-17 | The phase MUST issue exactly one SIGHUP to the daemon at phase end (skipped in headless eval). | T3   |
| FR-18 | An eval directory at `plugins/autonomous-dev-assist/evals/test-cases/setup-wizard/phase-16-deploy-backends/` MUST contain six cases: `happy-path.md`, `skip-with-consequence.md`, `error-recovery.md`, `idempotency-resume.md`, `linked-prd-no-duplication.md`, `credential-leak.md`. | T4   |
| FR-19 | `happy-path.md`: dev backend = aws; plugin install succeeds at matching version; cred-proxy returns handle (assert handle matches `^cph_[A-Za-z0-9]{32}$` and contains zero credential characters); firewall apply succeeds with `aws-default` template; cost-cap dry-run reports a finite number under documented ceiling (default $50/mo); final `deploy --dry-run` exits 0 with structured plan; state written with all four keys for dev; staging/prod set to local; SIGHUP delta=1; phases.16.status==complete. | T4   |
| FR-20 | `skip-with-consequence.md`: `wizard.skip_phase_16=true`; FR-4 verbatim consequence text emitted; only `deploy.envs.<env>.backend=local` written; no plugin install; no cred-proxy invocation; SIGHUP delta=0; phases.16.status==skipped. | T4   |
| FR-21 | `error-recovery.md` MUST cover four sub-cases: (a) plugin install network failure → diagnostic + abort; partial state recoverable on re-run; (b) plugin version mismatch → operator declines upgrade → phase aborts cleanly; (c) cred-proxy provision returns non-zero → handle NOT written; phase aborts before firewall step; no firewall or deploy state written; (d) `deploy --dry-run` returns non-zero → phase aborts; state for the failing env left unwritten; prior envs already-written are NOT rolled back (per-env atomicity). | T4   |
| FR-22 | `idempotency-resume.md` MUST cover four sub-cases: (a) plugin already installed at matching version → skip install; (b) cred-proxy handle present and validate==ok → operator confirms keep vs rotate; on keep, no rotation; on rotate, prior handle revoked via `cred_proxy_revoke` then re-provisioned; (c) firewall already applied with same template → no-op (CLI structured response indicates idempotent); (d) `deploy --dry-run` is always re-run (no skip); idempotency not predicated on dry-run cache. | T4   |
| FR-23 | `linked-prd-no-duplication.md` MUST regex-scan rendered phase 16 output for ≥40-char verbatim sentences also appearing in PRD-015 or PRD-017 chain content. Zero matches required per AMENDMENT-002 AC-05. | T4   |
| FR-24 | `credential-leak.md` MUST inject candidate credentials (one each from families a-f of SPEC-033-4-01 FR-9) into operator input prompts. For EACH injection: assert phase exits with `[credential-scanner] match: family=<x>` diagnostic BEFORE any config key write; assert no credential bytes appear in stdout, wizard.log, or eval transcript. Additionally, across the entire happy-path eval transcript, run `credential-scanner.sh` as a post-run sweep and assert zero matches in any captured stream (including cred-proxy bridge stdout). | T4   |
| FR-25 | The six-case suite MUST achieve ≥ 90% pass rate per TDD-033 §9.3. `credential-leak.md` is mandatory and AUTO-FAILS the entire suite on any leak (no partial credit). | T4   |
| FR-26 | The phase module MUST NOT call any function from `lib/cred-proxy-bridge.sh` other than `cred_proxy_provision`, `cred_proxy_validate_handle`, `cred_proxy_revoke`. (SPEC-033-1-02's `cred_proxy_read_handle` is removed in SPEC-033-4-01; calling it is a build error.) | T3   |

## 3. Non-Functional Requirements

| Requirement                                  | Target                                                                | Measurement Method                                      |
|----------------------------------------------|-----------------------------------------------------------------------|---------------------------------------------------------|
| Eval pass rate (suite-wide)                  | ≥ 90% (with credential-leak as auto-fail gate)                        | eval framework score                                    |
| Credential leak                              | 0 across all eval transcripts (any case)                              | `credential-scanner.sh` post-run sweep                  |
| Cost-cap dry-run estimate is bounded         | finite numeric ≤ documented ceiling ($50/mo default)                  | parse cost-cap-enforcer JSON output in eval             |
| Final dry-run wall-clock                     | < 60s with mocked deploy backend                                      | eval framework duration                                  |
| No cloud resources created                   | 0 real cloud API calls in any eval (fully mocked)                     | mock backend invocation counter                         |
| Per-env atomicity                            | env N failure does not corrupt env M<N already-written state          | bats kill-mid-env test asserts prior env state intact   |
| PRD-no-duplication                           | 0 verbatim ≥40-char sentence matches against PRD-015 / PRD-017 content | regex scan in eval                                      |
| Phase total runtime (happy)                  | < 4 min wall clock (3 envs × ~60s estimate)                            | eval framework duration                                  |

## 4. Technical Approach

**File: `plugins/autonomous-dev-assist/skills/setup-wizard/phases/phase-16-deploy-backends.md`**

```yaml
---
phase: 16
title: "Deployment backends"
amendment_001_phase: 16
tdd_anchors: [TDD-023, TDD-024]
prd_links: [PRD-014, PRD-015, PRD-017]
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  prior_envs_configured: true
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
```

**Phase-16 idempotency probe** (`idempotency-checks.sh phase-16-probe`):

```
For each env in [dev, staging, prod]:
  - If config_key deploy.envs.<env>.backend not present → start-fresh
  - If backend == "local" → already-complete for this env
  - Else:
    - plugin_installed_with_version <plugin-name> ?
    - cred_proxy_validate_handle <handle> == ok ?
    - firewall_template_currently_applied(<env>) == config'd template ?
    - last_dry_run_at within 7 days ?
  - If all four → already-complete; if any false → resume-from:<step>
```

**Module body steps:**

| Step name              | Behavior                                                                                                  |
|------------------------|-----------------------------------------------------------------------------------------------------------|
| `intro-and-prd-banner` | FR-16 banner naming PRD-015 and PRD-017. Emitted exactly once.                                             |
| `iter-envs`            | Loop dev → staging → prod. For each env, run inner steps below.                                           |
| `prompt-backend`       | Prompt backend choice. Apply credential scanner (FR-9) to input. On match → abort.                          |
| `plugin-install`       | If non-local: upsert install per FR-10. Skip on matching version; prompt on mismatch.                       |
| `cred-proxy-provision` | If non-local: invoke SPEC-033-4-01 `cred_proxy_provision`. Receive handle on stdout (no credential bytes). |
| `cred-proxy-validate`  | Invoke `cred_proxy_validate_handle`. On non-`ok`, abort the env (per-env atomicity per FR-21d).            |
| `firewall-apply`       | Run `firewall apply` with `<provider>-default` template. Capture structured response.                       |
| `cost-cap-dry-run`     | Run `deploy --dry-run --estimate-only`. Parse for finite numeric cost.                                       |
| `write-env-state`      | Write the four config keys for THIS env. Per-env atomicity: previous envs' state untouched on failure.    |
| `final-dry-run`        | After all envs: `deploy --dry-run --env dev`. Assert exit 0 + structured plan.                              |
| `sighup-and-summary`   | SIGHUP daemon (skipped in headless); print verification line per TDD-033 §10.5.                            |

**PRD cross-reference banner shape (FR-16):**

```
================================================================
NOTE: This phase configures deployment backends. The chain
orchestration that runs deploy steps live (post-merge) is documented
in PRD-015. The cost-cap-enforcer behavior on actual deploys is in
PRD-017 (FR-1701-1705).

PRD-015 reference: docs/prds/PRD-015-ci-cd-pipeline-and-chain-orchestration.md
PRD-017 reference: docs/prd/PRD-017-cost-cap-enforcer.md

This phase performs DRY-RUN verification only; no cloud resources
are created.
================================================================
```

The eval `linked-prd-no-duplication.md` regex-scans the rendered phase
output for ≥40-char verbatim sentence matches against the linked PRDs;
the banner above is allowed by virtue of being shorter than 40 chars
per sentence and naming the PRDs rather than restating their content.

**Eval set design:**

`happy-path.md`:
- Inputs: dev=aws (with mock plugin + mock cred-proxy + mock firewall + mock deploy CLI); staging=local; prod=local.
- Assertions: plugin install invoked once for aws; cred-proxy provision invoked once with `--backend aws --env dev`; handle shape regex; firewall `aws-default` applied; cost estimate is finite under $50/mo; final dry-run exits 0 with `{"plan_steps": [...], ...}`; all four config keys for dev present; staging/prod = local with empty handle/template; SIGHUP delta=1; status=complete; post-run scanner sweep over transcript reports zero matches.

`skip-with-consequence.md`:
- Inputs: `wizard.skip_phase_16=true`.
- Assertions: FR-4 verbatim text emitted; per-env state shows `backend=local` (default); no plugin install; no cred-proxy; SIGHUP delta=0; status=skipped.

`error-recovery.md`:
- Sub-A: mock plugin install returns 1 (network) → diagnostic + abort; only intro banner state present; re-run resumes at plugin-install for the failing env.
- Sub-B: plugin version mismatch + operator declines upgrade → phase aborts; status=failed for the env; prior envs (none in this case) untouched.
- Sub-C: cred-proxy provision exits 1 → handle not written; firewall and deploy steps NOT invoked; per-env state for the failing env not written.
- Sub-D: final `deploy --dry-run` returns 1 → status=failed; prior per-env writes (e.g. dev success) remain intact (per-env atomicity).

`idempotency-resume.md`:
- Sub-A: plugin pre-installed at matching version → install skipped (mock counter delta=0).
- Sub-B: handle valid → keep prompt; on keep, no rotation; on rotate, prior handle revoked then re-provisioned (mock revoke counter=1, provision counter=1).
- Sub-C: firewall same-template re-apply → CLI returns idempotent marker; no-op.
- Sub-D: dry-run is always re-invoked (mock counter increments).

`linked-prd-no-duplication.md`:
- Render phase 16 output (banner + prompts + verification line).
- Tokenize sentences (split on `.` / `\n\n`).
- For each sentence ≥ 40 chars, grep for verbatim presence in `docs/prds/PRD-015-*.md` and `docs/prd/PRD-017-*.md`.
- Assertion: zero matches.

`credential-leak.md` (AMENDMENT-002 AC-08 anchor):
- Six injections, one per family from SPEC-033-4-01 FR-9.
- For each: drive the wizard to the `prompt-backend` step; supply the candidate credential as input; assert:
  1. Scanner diagnostic on stderr with correct family.
  2. Phase exits 1 BEFORE any config key write (`deploy.envs.*` keys absent).
  3. Phase status set to `failed`.
  4. No credential bytes anywhere in captured stdout/stderr/wizard.log/transcript (post-run sweep with `credential-scanner.sh`).
- Final assertion: across the happy-path eval (all 3 envs configured), the post-run scanner sweep over the entire combined transcript (including cred-proxy bridge stdout, plugin install logs, firewall response, dry-run JSON) reports zero matches.

**bats test plan (for the module itself, separate from eval):**

| Test ID  | Scenario                                                                | Assert                                                          |
|----------|--------------------------------------------------------------------------|-----------------------------------------------------------------|
| P16-101  | Front-matter parse                                                       | yq returns expected values                                      |
| P16-201  | Skip via flag                                                            | predicate true; FR-4 consequence emitted                        |
| P16-301  | Iteration order dev→staging→prod                                         | mock prompts captured in correct order                          |
| P16-401  | Operator input runs through scanner                                      | malicious input → phase aborts before any plugin call           |
| P16-501  | Plugin install upsert: matching version skipped                          | mock plugin counter delta=0                                     |
| P16-502  | Plugin install upsert: version mismatch prompts                          | confirmation prompt emitted                                     |
| P16-601  | Cred-proxy handle shape validated                                        | non-cph_ output → phase aborts                                  |
| P16-701  | Firewall same-template re-apply no-op                                    | CLI idempotent response → no state churn                        |
| P16-801  | Cost-cap-enforcer reports finite                                         | numeric parse succeeds; non-numeric → abort                     |
| P16-901  | Final dry-run exit 0 + structured plan                                   | JSON parse succeeds                                             |
| P16-A01  | Per-env atomicity                                                        | env-2 failure leaves env-1 state intact                         |
| P16-B01  | PRD banner emitted exactly once                                          | regex match count == 1                                          |
| P16-C01  | SIGHUP delta=1 on success, 0 on skip                                     | mock daemon counter                                             |

## 5. Interfaces and Dependencies

**Consumed:**
- SPEC-033-1-01: orchestrator phase contract.
- SPEC-033-1-02: idempotency-check helper library (extended in this SPEC's probe wrapper).
- SPEC-033-4-01: `cred-proxy-bridge.sh` full + `credential-scanner.sh`.
- TDD-023: deployment-backend framework.
- TDD-024: cred-proxy + egress firewall + cost estimation primitives.
- PRD-014: bundled vs plugin-based backend split, multi-env model, `local` default.
- PRD-015: chain-level guidance (linked, never inlined).
- PRD-017: cost-cap-enforcer (FR-1701-1705).
- `autonomous-dev plugin install`, `autonomous-dev firewall apply`, `autonomous-dev deploy --dry-run` CLI surfaces.

**Produced:**
- `phases/phase-16-deploy-backends.md`.
- `phase_16_skip_predicate` helper (≤ 10 LOC).
- `phase-16-probe` idempotency wrapper (≤ 80 LOC; per-env iteration).
- Six eval case files.

**Mocks for tests:**
- Mock cred-proxy (from SPEC-033-4-01 fixtures).
- Mock `autonomous-dev plugin install` shim (parameterizable: success / version-mismatch / network-fail).
- Mock `autonomous-dev firewall apply` shim (returns idempotent / applied JSON markers).
- Mock `autonomous-dev deploy --dry-run` shim (returns canned cost JSON + canned plan JSON).

## 6. Acceptance Criteria

### Front-matter contract (FR-1, FR-2, FR-6, FR-7)

```
Given phases/phase-16-deploy-backends.md
When parsed by yq
Then phase=16 and tdd_anchors == ["TDD-023","TDD-024"]
And prd_links == ["PRD-014","PRD-015","PRD-017"]
And output_state.config_keys_written contains 12 entries (4 per env × 3 envs)
And output_state.external_resources_created contains 6 entries
```

### Skip-with-consequence (FR-3, FR-4, FR-20)

```
Given wizard.skip_phase_16 == true
When phase 16 enters
Then predicate exits 0
And FR-4 verbatim consequence text emitted
And phases.16.status == "skipped"
And no plugin install invoked
And no cred-proxy invocation
And SIGHUP delta == 0
```

### Credential scanner gates EVERY input (FR-9, FR-24)

```
Given operator input "AKIAIOSFODNN7EXAMPLE" at the backend prompt
When phase 16 processes the input
Then scan_for_credential exits 1
And the phase aborts BEFORE any deploy.envs.* key is written
And phases.16.status == "failed"
And no credential bytes appear in stdout/stderr/wizard.log/transcript
```

### Cred-proxy handle-only contract (FR-11)

```
Given the operator chooses backend=aws for env=dev
When the cred-proxy-provision step runs
Then cred_proxy_provision aws dev is invoked as a subprocess
And only a single line matching ^cph_[A-Za-z0-9]{32}$ is captured by the wizard
And no credential characters appear anywhere in the wizard's process output
```

### Per-env atomicity (FR-21d, NFR atomicity)

```
Given dev backend configured successfully (state written)
And staging backend final dry-run fails
When the phase aborts
Then deploy.envs.dev.* config keys are present and unchanged
And deploy.envs.staging.* config keys are absent (not partially written)
And deploy.envs.prod.* config keys are absent
```

### Cost-cap dry-run finite (FR-14, NFR cost-cap)

```
Given the cost-cap-enforcer mock returns {"estimated_monthly_cost_usd": 12.34}
When cost-cap-dry-run step runs
Then the parsed cost is 12.34
And the value is below the documented ceiling (default $50/mo)
And the phase proceeds to final-dry-run

Given the mock returns {"estimated_monthly_cost_usd": null}
Then the phase aborts with a diagnostic referencing PRD-017 FR-1701-1705
```

### Final dry-run structured plan (FR-15)

```
Given the deploy mock returns {"plan_steps":[...]} with exit 0
When final-dry-run runs
Then the JSON is parseable
And no cloud resources were created (mock cloud-API counter == 0)
```

### Idempotency: plugin already installed at matching version (FR-22a)

```
Given the plugin probe reports version match
When plugin-install step runs
Then no install command is invoked (mock plugin counter delta == 0)
```

### Idempotency: handle rotate (FR-22b)

```
Given an existing valid cred-proxy handle and operator chooses "rotate"
When cred-proxy-provision step runs
Then cred_proxy_revoke is invoked once on the prior handle
And cred_proxy_provision is invoked once for the new handle
And the new handle is written to deploy.envs.<env>.cred_proxy_handle
```

### PRD-no-duplication eval (FR-23, NFR fr-23)

```
Given the rendered phase 16 output is captured
When sentences ≥ 40 chars are extracted
Then zero verbatim matches are found in PRD-015 or PRD-017 content
```

### Credential-leak eval auto-fail (FR-24, FR-25)

```
Given any one of the six credential families is injected at any input prompt
When the eval runs
Then the credential-leak.md case asserts FR-24 (a)-(d)
And on any leak, the entire eval suite is marked auto-failed (no partial credit)

Given the happy-path eval runs to completion
When credential-scanner.sh is run as a post-run sweep over the combined transcript
Then zero matches are reported across all six families
```

### Eval pass rate (FR-25, NFR pass)

```
Given the six eval cases run via the eval framework
Then the suite-wide pass rate is ≥ 90%
And credential-leak.md is mandatory (its failure auto-fails the suite)
```

### CI lint: only phase-16 calls cred_proxy_* (FR-26)

```
Given any other phase file calls cred_proxy_provision / cred_proxy_validate_handle / cred_proxy_revoke
When the SPEC-033-4-01 lint runs
Then it exits 1 with a diagnostic naming the offending file
```

## 7. Test Requirements

- bats `tests/setup-wizard/phase-16.bats` — see P16-101 through P16-C01 above.
- Eval cases under `evals/test-cases/setup-wizard/phase-16-deploy-backends/`:
  six files; each conforms to TDD-033 §9.4 eval frame.
- Mock plugin / firewall / deploy CLI shims under `tests/setup-wizard/mocks/`.
- Re-use cred-proxy mocks from SPEC-033-4-01.
- Eval framework hook: post-run scanner sweep configurable per case (always on for credential-leak; also on for happy-path).

## 8. Implementation Notes

- The credential-pattern scanner (SPEC-033-4-01) is invoked at every
  operator input, including backend choice (where a "credential as
  backend name" is implausible but the invariant must hold uniformly).
  Avoid hand-coding exemptions; treat scanner as a uniform pre-write
  gate.
- The plugin install upsert relies on `autonomous-dev plugin info <name>`
  returning current installed version. If that CLI surface differs,
  adapt the version-comparison logic; document in implementation notes.
- The cost-cap ceiling ($50/mo default) is a config in PRD-017; do not
  hardcode in the phase. Read from `deploy.cost_cap_monthly_usd_max`
  config key; default 50 if unset.
- The eval `linked-prd-no-duplication.md` tokenizer is a simple
  sentence splitter; handle YAML and code-fence blocks specially
  (those are technical content; allow verbatim cross-reference of file
  paths and config key names which are short).
- "Per-env atomicity" means individual env state is written
  transactionally; cross-env rollback (full phase rollback) is
  handled by SPEC-033-4-04's wizard-rollback CLI, NOT inline.
- The phase MUST NOT call `cred_proxy_read_handle` (removed in
  SPEC-033-4-01); this is enforced both by linker (function doesn't
  exist) and by FR-26 lint.
- Phase 16 is the first phase to write `output_state.external_resources_created`;
  the wizard-rollback CLI (SPEC-033-4-04) consumes this field to
  enumerate revocation targets.

## 9. Rollout Considerations

- Feature flag `wizard.phase_16_module_enabled` defaults to `false`
  initially per TDD-033 §8.2 Stage 4 gate. SPEC-033-4-04 documents the
  flip to `true` after security review sign-off.
- Stage 4 canary (SPEC-033-4-04 STAGE-4-CANARY.md) gates the default
  flip on: ≥ 90% suite pass + zero leaks + cred-proxy bridge security
  review + composition tests green.
- Rollback: `autonomous-dev wizard rollback --phase 16` (SPEC-033-4-04)
  reverts the 12 config keys, revokes the 3 cred-proxy handles, and
  rolls back the 3 firewall allowlists.

## 10. Effort Estimate

| Activity                                                               | Estimate |
|------------------------------------------------------------------------|----------|
| Front-matter + module body + step orchestration                        | 0.75 day |
| Idempotency probe wrapper (per-env, multi-condition)                   | 0.25 day |
| Skip-predicate wrapper                                                 | 0.05 day |
| PRD cross-reference banner                                             | 0.1 day  |
| Eval cases: happy-path                                                 | 0.25 day |
| Eval cases: skip / error-recovery (4 sub-cases)                        | 0.4 day  |
| Eval cases: idempotency-resume (4 sub-cases)                           | 0.4 day  |
| Eval cases: linked-prd-no-duplication                                  | 0.15 day |
| Eval cases: credential-leak (six families + sweep)                     | 0.3 day  |
| bats tests for the module                                              | 0.25 day |
| Mock CLIs (plugin/firewall/deploy)                                     | 0.1 day  |
| **Total**                                                              | **3 day** |
