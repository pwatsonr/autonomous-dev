# SPEC-025-1-01: help/SKILL.md Cloud Backends and Credential Proxy Sections

## Metadata
- **Parent Plan**: PLAN-025-1
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-1 Task 1 (Cloud Backends H2), Task 2 (Credential Proxy H2)
- **Estimated effort**: 8 hours (4h + 4h)
- **Status**: Draft
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-025-1-01-help-skill-cloud-backends-and-credential-proxy.md`

## Description
Append two new H2 sections to `plugins/autonomous-dev-assist/skills/help/SKILL.md`: **"Cloud Backends"** (per TDD-025 §6.1) listing the four `autonomous-dev-deploy-{gcp,aws,azure,k8s}` plugins, their backends, and their tooling; and **"Credential Proxy"** (per TDD-025 §6.2) explaining the six `cred-proxy` CLI subcommands, the four scopers, the 15-minute TTL contract, the per-issuance HMAC-chained audit log, and SCM_RIGHTS file-descriptor passing in plain English.

Both sections are **strictly additive**. Existing sections are byte-for-byte unchanged. The Credential Proxy section's audit-log warning text matches the chains-audit warning style verbatim so that PLAN-025-3's eval cases (e.g., `credproxy-concept-scm-001`) can assert against canonical phrasing. The SCM_RIGHTS subsection is exactly two sentences and uses the phrases "file-descriptor passing" and "Unix socket" verbatim.

This spec ships only documentation. Markdown lint (the existing `markdownlint` config used elsewhere in `plugins/autonomous-dev-assist/`) must pass on the modified file. No behavioural validation lives here; PLAN-025-3 owns the eval suite that exercises the assist agent against this content.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/skills/help/SKILL.md` | Modify (append two H2 sections after the last existing top-level section) | Additive only; no rewrites |

## Implementation Details

### Section 1: "Cloud Backends" (PLAN-025-1 Task 1)

Append the following H2 block after the current last top-level section in `help/SKILL.md`. Subsections per TDD-025 §6.1.

```markdown
## Cloud Backends

The `autonomous-dev-deploy-*` plugin family provides cloud-specific deploy backends. Each plugin registers a backend with the deploy framework and is independently installable.

### What are the cloud backends?

Four plugins, one per cloud, each declaring `provides: deploy-backend` and a `backend-name`. The deploy framework's `BackendRegistry` discovers them at daemon start; `deploy backends` lists installed backends.

### Installation

Install per cloud with the marketplace command:

    claude plugin install autonomous-dev-deploy-gcp
    claude plugin install autonomous-dev-deploy-aws
    claude plugin install autonomous-dev-deploy-azure
    claude plugin install autonomous-dev-deploy-k8s

Operators install only the clouds they target. No cloud is installed by default.

### Capability declarations

| Plugin                          | Backend  | Targets                              | Tool dependency |
|---------------------------------|----------|--------------------------------------|-----------------|
| `autonomous-dev-deploy-gcp`     | `gcp`    | GCE, Cloud Run, GKE                  | `gcloud`        |
| `autonomous-dev-deploy-aws`     | `aws`    | EC2, ECS, EKS, Lambda                | `aws`           |
| `autonomous-dev-deploy-azure`   | `azure`  | App Service, AKS                     | `az`            |
| `autonomous-dev-deploy-k8s`     | `k8s`    | Generic Kubernetes (any provider)    | `kubectl`       |

### Egress allowlist defaults

Each cloud-backend plugin declares an `egress-allowlist-defaults` field in its manifest (e.g., `*.googleapis.com`, `*.gcr.io` for GCP). The egress firewall enforces these defaults when enabled. See TDD-028 for the firewall runtime.

### See also

- Deploy runbook: `plugins/autonomous-dev-assist/instructions/deploy-runbook.md`
- Credential Proxy section below
```

**Required content checks (acceptance):**

- Heading `## Cloud Backends` exists exactly once.
- All four plugin names appear verbatim and in the order `gcp`, `aws`, `azure`, `k8s`.
- The capability table contains four rows.
- The Installation subsection uses the `claude plugin install autonomous-dev-deploy-<cloud>` syntax verbatim.
- The Egress allowlist subsection is one paragraph and contains the literal text `TDD-028`.
- The "See also" subsection links to the Credential Proxy section (anchor `#credential-proxy` or rendered link text matching).

### Section 2: "Credential Proxy" (PLAN-025-1 Task 2)

Append immediately after the Cloud Backends section. Seven subsections per TDD-025 §6.2.

```markdown
## Credential Proxy

The credential proxy issues short-lived, scope-narrowed credentials to the deploy framework so root credentials never reach the deploy worker process.

### What is the credential proxy?

A daemon listening on a Unix-domain socket at `~/.autonomous-dev/cred-proxy/socket` (mode `0600`, owner-only). The deploy worker requests a scoped credential; the proxy invokes the per-cloud scoper to mint a short-lived token; the token is passed to the worker via SCM_RIGHTS file-descriptor passing. The worker never sees root credentials.

### The six CLI subcommands

| Subcommand                           | Purpose                                                              |
|--------------------------------------|----------------------------------------------------------------------|
| `cred-proxy start`                   | Launch the proxy daemon                                              |
| `cred-proxy stop`                    | Stop the daemon (revokes outstanding tokens)                         |
| `cred-proxy status`                  | Daemon health and active token count                                 |
| `cred-proxy doctor`                  | Diagnostic: socket perms, scoper presence, root-cred reachability    |
| `cred-proxy issue <cloud> <scope>`   | Manual token issuance (typically for testing)                        |
| `cred-proxy revoke <token-id>`       | Emergency revoke                                                     |

### The four scopers

Each cloud has its own scoper plugin (installed independently of the cloud-backend plugin):

- `cred-proxy-scoper-aws` — translates root credentials to STS short-term credentials with IAM-policy-narrowed scope.
- `cred-proxy-scoper-gcp` — translates a service-account keyfile to a short-lived OIDC token.
- `cred-proxy-scoper-azure` — uses `az account get-access-token --resource <scope>`.
- `cred-proxy-scoper-k8s` — projects a service-account token via the TokenRequest API.

### TTL and auto-revoke

The default TTL is **15 minutes** (`900` seconds). On expiry, the proxy closes the deploy worker's file descriptor immediately; the worker's next API call against the cloud fails with the cloud's standard auth-expired error. Long-running deploys must either raise `default_ttl_seconds` (see the `cred_proxy` config-guide section) or restructure into shorter steps.

### The per-issuance audit hash

Every issuance writes an HMAC-chained entry to `~/.autonomous-dev/cred-proxy/audit.log` recording token-id, cloud, scope, requester process, TTL, and chain-hash. Verify the chain with `cred-proxy doctor --verify-audit`. **Do not delete the audit log.** Deletion breaks the chain and forfeits forensic capability.

### SCM_RIGHTS in plain English

SCM_RIGHTS is the Unix socket mechanism for file-descriptor passing between processes via the socket's ancillary-data channel. The deploy worker receives an open file descriptor it can read tokens from but cannot use to recover root credentials.

### See also

- Credential proxy runbook: `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md`
- Configuration: `cred_proxy` section in `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`
```

**Required content checks (acceptance):**

- Heading `## Credential Proxy` exists exactly once.
- All six CLI subcommands appear in the table in the order shown above.
- All four scoper plugin names appear: `cred-proxy-scoper-aws`, `cred-proxy-scoper-gcp`, `cred-proxy-scoper-azure`, `cred-proxy-scoper-k8s`.
- The TTL subsection contains both `15 minutes` and `900` (seconds form), and explains immediate FD-close on expiry.
- The audit-hash subsection contains the bold sentence `**Do not delete the audit log.**` verbatim. This phrasing matches the chains-audit warning style used in `help/SKILL.md`'s existing chains section; the linter check is that the `**Do not delete the audit log.**` literal is present.
- The SCM_RIGHTS subsection is exactly two sentences and contains the phrases `file-descriptor passing` and `Unix socket` verbatim. (PLAN-025-3 case `credproxy-concept-scm-001` asserts these.)
- The "See also" subsection contains a link with target `instructions/cred-proxy-runbook.md` (which is a forward reference to PLAN-025-2's deliverable; the markdown lint config permits forward refs).

### Heading-anchor and lint considerations

- `markdownlint` (existing config) must pass. The two new H2 headings (`Cloud Backends`, `Credential Proxy`) do not collide with any existing top-level heading on `main`. Each subsection uses H3 (`###`).
- "See also" subsections use H3. There may be other "See also" H3s elsewhere in the file (existing pattern); the linter config already tolerates this. If a duplicate-anchor warning appears at lint time, append a contextual suffix (e.g., `### See also (Credential Proxy)`); the spec author's first attempt should keep it as `### See also` and only suffix if lint fails.
- All commands are wrapped in fenced code blocks (no leading 4-space prefixes) where the file's existing convention uses them; if the existing convention uses indented blocks, follow that. (Implementer: read the current file first to confirm convention.)

### Forward references

The Credential Proxy "See also" links to two paths that may not yet exist on `main`:

- `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` — created by PLAN-025-2 / SPEC-025-2-01.
- The `cred_proxy` H2 in `config-guide/SKILL.md` — created by SPEC-025-1-02.

These are intentional forward references. The link text uses the canonical filenames agreed in those plans. PLAN-025-1 Task 8 (covered in SPEC-025-1-04) audits link resolution.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/skills/help/SKILL.md` contains a new H2 section `## Cloud Backends` with exactly the five subsections listed (What are the cloud backends?; Installation; Capability declarations; Egress allowlist defaults; See also).
- [ ] The Cloud Backends capability-declarations table has four rows with the exact plugin names, backends, target lists, and tool deps shown above.
- [ ] The Cloud Backends Egress-allowlist subsection mentions `TDD-028` verbatim.
- [ ] `plugins/autonomous-dev-assist/skills/help/SKILL.md` contains a new H2 section `## Credential Proxy` with exactly seven subsections (What is the credential proxy?; The six CLI subcommands; The four scopers; TTL and auto-revoke; The per-issuance audit hash; SCM_RIGHTS in plain English; See also).
- [ ] The CLI-subcommands table contains all six subcommands (`start`, `stop`, `status`, `doctor`, `issue <cloud> <scope>`, `revoke <token-id>`) verbatim.
- [ ] All four scopers (`cred-proxy-scoper-aws`, `cred-proxy-scoper-gcp`, `cred-proxy-scoper-azure`, `cred-proxy-scoper-k8s`) appear by name.
- [ ] The TTL subsection contains both the literals `15 minutes` and `900` (in seconds form, e.g., `900` seconds).
- [ ] The audit-hash subsection contains the bold sentence `**Do not delete the audit log.**` verbatim.
- [ ] The SCM_RIGHTS subsection is exactly two sentences and contains the phrases `file-descriptor passing` and `Unix socket`.
- [ ] All sections existing on `main` before this spec are byte-for-byte unchanged. (Verify with `git diff main -- plugins/autonomous-dev-assist/skills/help/SKILL.md`: only added lines, no removed or modified lines.)
- [ ] `markdownlint` (existing `.markdownlint*` config in the repo) exits 0 on the modified file.
- [ ] No occurrences of the literal `{{` or `}}` template-token sentinels remain in the file.
- [ ] All "See also" links use the canonical filenames listed in the Forward references subsection above.

## Dependencies

- **TDD-025 §6.1, §6.2** — authoritative source for subsection ordering and required content.
- **TDD-024 §6** — authoritative source for cloud-backend plugin metadata (names, services, tool dependencies).
- **TDD-024 §7-§10** — authoritative source for cred-proxy CLI surface, scoper names, TTL semantics, audit-log format.
- **TDD-022 §14** — chains audit-log section provides the warning-style template (the bold `**Do not delete the audit log.**` sentence is reused verbatim).
- **No code dependencies** — documentation only.
- **Forward references** to SPEC-025-1-02 (`config-guide` cred_proxy section) and SPEC-025-2-01 (cred-proxy-runbook). Link audit happens in SPEC-025-1-04.

## Notes

- This spec is the foundation for the entire PLAN-025-1 / PLAN-025-2 / PLAN-025-3 cascade. Downstream specs and eval cases assert against literal phrasing in the Credential Proxy section. Drift from the verbatim literals listed under Acceptance Criteria will cause downstream eval failures.
- The two-sentence SCM_RIGHTS budget is a deliberate trade-off (TDD-025 §11.2). Operators wanting depth get the runbook (SPEC-025-2-01); the SKILL section stays diagnosis-grade.
- The implementer must read the current `help/SKILL.md` to identify the last existing top-level section before appending. Do not interleave with existing sections; always append at the end.
- The `claude plugin install` command lines should match the file's existing code-block convention (fenced ``` blocks with no language tag, or indented four-space, whichever is the existing pattern). Read first, match second.
- If `markdownlint` flags a duplicate heading slug for `### See also`, suffix with parenthetical disambiguation as documented above. Do not rename existing "See also" subsections.
