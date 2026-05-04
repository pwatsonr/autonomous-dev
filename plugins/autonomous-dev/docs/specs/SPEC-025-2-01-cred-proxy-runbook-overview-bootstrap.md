# SPEC-025-2-01: cred-proxy-runbook.md §1 Overview + §2 Bootstrap

## Metadata
- **Parent Plan**: PLAN-025-2
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-2 Task 1 (§1 Overview, §2 Bootstrap)
- **Estimated effort**: 4 hours
- **Status**: Draft
- **Future location**: `plugins/autonomous-dev/docs/specs/SPEC-025-2-01-cred-proxy-runbook-overview-bootstrap.md`

## Description
Create the new file `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` and author the first two of its nine sections per TDD-025 §6.8: §1 Overview (architecture in operator terms — SCM_RIGHTS, scopers, TTL, audit log) and §2 Bootstrap (`cred-proxy start`, `cred-proxy doctor`, audit-key env-var setup using never-echo-secrets patterns).

This spec creates the file and ships only sections 1-2. Sections 3-9 are layered in by SPEC-025-2-02, SPEC-025-2-03, and SPEC-025-2-04. The file's top-level title, table-of-contents (anchor list), and metadata block are owned by this spec because they are part of the file scaffolding.

The §2 Bootstrap audit-key generation **must never echo the key value to stdout** (FR-1539). The recommended pattern stores the key in a file (`~/.autonomous-dev/cred-proxy/audit-key`, mode `0600`) and exports it from a shell rc via `export CRED_PROXY_AUDIT_KEY="$(cat ~/.autonomous-dev/cred-proxy/audit-key)"`. Alternative pattern uses `read -s` to read the key without echo. Command-line invocations that echo the key (`echo "$CRED_PROXY_AUDIT_KEY"`, `cat audit-key`) are explicitly forbidden in the documented commands.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` | **Create** | New file. Title, TOC, §1, §2 only. §3-§9 layered in by sibling specs. |

## Implementation Details

### File scaffolding (top of file)

```markdown
# Credential Proxy Runbook

This runbook covers operating the credential proxy day-to-day: bootstrap, scoper installation per cloud, common failures, recovery, TTL tuning, audit-hash verification, and emergency revoke. It is the deep operator reference behind the `Credential Proxy` section in `skills/help/SKILL.md` and the `cred_proxy` section in `skills/config-guide/SKILL.md`.

## Sections

1. [Overview](#1-overview)
2. [Bootstrap](#2-bootstrap)
3. [Scoper installation per cloud](#3-scoper-installation-per-cloud)
4. [Common failures](#4-common-failures)
5. [Recovery](#5-recovery)
6. [TTL tuning](#6-ttl-tuning)
7. [Audit-hash verification](#7-audit-hash-verification)
8. [Emergency revoke](#8-emergency-revoke)
9. [Escalation](#9-escalation)

## See also

- `skills/help/SKILL.md` "Credential Proxy" section — operator-facing intro
- `skills/config-guide/SKILL.md` `cred_proxy` section — config schema
- `skills/troubleshoot/SKILL.md` — diagnostic scenarios
```

The TOC anchor list **must include all nine entries** even though only §1 and §2 ship in this spec. Sibling specs (SPEC-025-2-02..04) append their sections beneath the placeholders. The TOC anchors are stable canonical filenames so forward links from sibling content resolve.

### Section 1: Overview

Append after the file scaffolding. Required content:

```markdown
## 1. Overview

The credential proxy is a small daemon that issues short-lived, scope-narrowed credentials to deploy workers without ever exposing your root credentials to the deploying process. Architecturally:

- Your shell holds **root credentials** (AWS profile, GCP service-account keyfile, Azure session, K8s kubeconfig).
- The cred-proxy daemon reads those root credentials in its own process.
- When a deploy worker requests a credential, the proxy invokes a **per-cloud scoper plugin** (`cred-proxy-scoper-aws`, `cred-proxy-scoper-gcp`, `cred-proxy-scoper-azure`, `cred-proxy-scoper-k8s`) which calls the cloud's short-lived-token API (AWS STS, GCP OIDC, Azure access-token, K8s TokenRequest) to mint a credential narrowed to the requested scope.
- The proxy passes the resulting credential **as a file descriptor** to the deploy worker over a Unix-domain socket using the `SCM_RIGHTS` ancillary-data channel. The deploy worker never sees your root credentials.
- Each issuance is logged to `~/.autonomous-dev/cred-proxy/audit.log` as an HMAC-chained entry. The chain key is held in an environment variable named by the `audit_key_env` config field (the field stores the *name* of the env var, not the key itself).
- Each issued credential expires automatically at TTL end (default 900 seconds = 15 minutes); on expiry the proxy closes the deploy-worker FD, immediately revoking access.

```text
operator's shell environment (root creds: AWS_PROFILE, GCP keyfile, etc.)
        |
        v
+-----------------------------------------+
| cred-proxy daemon                       |
|   listens on ~/.autonomous-dev/         |
|           cred-proxy/socket             |
|   (mode 0600, owner-only)               |
+-----------------+-----------------------+
                  | SCM_RIGHTS (file descriptor passing)
                  v
+-----------------------------------------+
| deploy worker (autonomous-dev daemon)   |
|   receives scoped FD                    |
|   never sees root creds                 |
|   credential expires at TTL end (15m)   |
+-----------------------------------------+
```

The scoper-as-isolation-layer pattern means a compromised deploy worker can hold at worst a 15-minute, scope-narrowed token — not your root credentials.
```

**Required content (acceptance):**

- The four scoper plugin names appear verbatim: `cred-proxy-scoper-aws`, `cred-proxy-scoper-gcp`, `cred-proxy-scoper-azure`, `cred-proxy-scoper-k8s`.
- The phrase "file descriptor passing" appears verbatim (PLAN-025-3 eval `credproxy-concept-scm-001` asserts on this phrase).
- The phrase "Unix-domain socket" or "Unix socket" appears verbatim (same eval case).
- The literal `900` (or "900 seconds") and the phrase "15 minutes" both appear, tied to the default TTL.
- The literal `audit_key_env` and the explicit clarification that the field stores the *name* of an env var, not the key itself, appears.
- The architecture diagram is rendered as a fenced code block with language `text` (matches TDD §3.2 ASCII diagram conventions).
- The `0600` socket mode is called out.

### Section 2: Bootstrap

Append after §1. Required content:

```markdown
## 2. Bootstrap

This section walks the first-time bootstrap of the cred-proxy on a fresh operator workstation. After completing it, you will have a running daemon, a verified socket, an installed audit key, and a passing `cred-proxy doctor`.

### 2.1 Start the daemon

```bash
cred-proxy start
```

The daemon forks and listens on `~/.autonomous-dev/cred-proxy/socket` with mode `0600`. The daemon enforces ownership at startup; if the socket already exists with the wrong owner, `start` exits non-zero with a diagnostic. **Do not run `cred-proxy start` as root.** The daemon must run as the same user that runs deploys.

### 2.2 Run the diagnostic

```bash
cred-proxy doctor
```

`doctor` checks: socket exists with mode `0600`; socket ownership matches the running user; daemon is responsive on the socket; per-cloud scoper plugins are discoverable at `~/.autonomous-dev/cred-proxy/scopers/<cloud>`; root credentials are reachable for each installed cloud (without storing or echoing them). A clean `doctor` is the precondition for the rest of bootstrap.

### 2.3 Generate and install the audit key

The audit key is the HMAC chain key for `audit.log`. It must be installed in your shell environment so the daemon can read it on next start. **Never echo the audit key to stdout.** Use the file-based pattern:

```bash
# Generate a 32-byte hex key into an owner-only file. The redirect avoids stdout exposure.
( umask 0177; openssl rand -hex 32 > ~/.autonomous-dev/cred-proxy/audit-key )

# Verify mode (the umask above sets 0600). Re-apply explicitly if needed.
chmod 0600 ~/.autonomous-dev/cred-proxy/audit-key
```

Add the export to your shell rc (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
# In your shell rc:
export CRED_PROXY_AUDIT_KEY="$(cat ~/.autonomous-dev/cred-proxy/audit-key)"
```

Then in `~/.autonomous-dev/cred-proxy/config.yaml` set:

```yaml
cred_proxy:
  audit_key_env: CRED_PROXY_AUDIT_KEY   # the NAME of the env var, not the key
```

**Alternative pattern.** If you prefer not to keep the key in a file, you can prompt for it interactively without echo:

```bash
read -s -p "Audit key: " CRED_PROXY_AUDIT_KEY
export CRED_PROXY_AUDIT_KEY
```

Either pattern is acceptable; both keep the key out of shell scrollback.

### 2.4 Restart and re-verify

```bash
cred-proxy stop
cred-proxy start
cred-proxy doctor
```

After the restart, `doctor` should report the audit key is loaded (the chain hash advances when an issuance occurs).

### 2.5 What to commit

Commit `~/.autonomous-dev/cred-proxy/config.yaml` to your dotfiles repo if you wish, **but never commit `~/.autonomous-dev/cred-proxy/audit-key`**. Add it to your dotfiles `.gitignore`:

```text
.autonomous-dev/cred-proxy/audit-key
.autonomous-dev/cred-proxy/audit.log
.autonomous-dev/cred-proxy/socket
```
```

**Required content (acceptance):**

- §2 has subsections 2.1 through 2.5 in order.
- Every documented command for handling the audit key is non-echoing: `openssl rand ... > file` (no stdout), `read -s` (silent read), `export VAR="$(cat file)"` (no echo). No documented command is `echo "$CRED_PROXY_AUDIT_KEY"`, `cat audit-key` (without redirect), or similar.
- The `umask 0177` + redirect pattern (or equivalent owner-only-creation pattern) is documented.
- The phrase "Do not run `cred-proxy start` as root" or equivalent appears verbatim.
- The `audit_key_env: CRED_PROXY_AUDIT_KEY` example with the inline comment "the NAME of the env var, not the key" (or close paraphrase) appears.
- The `.gitignore` recommendation lists `audit-key`, `audit.log`, and `socket`.
- All bash blocks are fenced with `bash` (or `sh`) language hints.

### Lint and formatting

- `markdownlint` (existing config) must pass on the new file.
- Heading hierarchy: H1 title; H2 for §1, §2 (and the placeholder TOC); H3 for subsections (§2.1 etc.); H4 reserved for sibling-spec deeper subsections if needed.
- Code-block fences use language hints: `bash` for shell, `yaml` for config blocks, `text` for ASCII diagrams.
- The architecture diagram uses ASCII characters only (`+`, `-`, `|`, `v`, `>`); no Unicode box-drawing characters (some markdown renderers mishandle them).

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/instructions/cred-proxy-runbook.md` exists as a new file.
- [ ] The file's H1 title is `# Credential Proxy Runbook`.
- [ ] The file contains a "Sections" table of contents listing all nine sections (even though §3-§9 are placeholders for sibling specs).
- [ ] §1 Overview is present with the architecture diagram and the operator-language explanation of the scoper-as-isolation-layer pattern.
- [ ] §1 names all four scopers verbatim: `cred-proxy-scoper-aws`, `cred-proxy-scoper-gcp`, `cred-proxy-scoper-azure`, `cred-proxy-scoper-k8s`.
- [ ] §1 contains the phrases "file descriptor passing" and "Unix-domain socket" (or "Unix socket") verbatim.
- [ ] §1 calls out the `900`-second / 15-minute default TTL.
- [ ] §1 explains `audit_key_env` stores the *name* of an env var, not the key.
- [ ] §1 calls out the socket mode `0600`.
- [ ] §2 Bootstrap has subsections §2.1 (start daemon), §2.2 (doctor), §2.3 (generate/install audit key), §2.4 (restart and re-verify), §2.5 (what to commit / .gitignore).
- [ ] No documented command in §2 echoes the audit key to stdout. (Manual review: every shell snippet vetted; redirects, `read -s`, indirect var refs only.)
- [ ] §2.1 contains the directive "Do not run `cred-proxy start` as root" (or equivalent verbatim phrasing).
- [ ] §2.3 documents at least the file-based pattern (`openssl rand ... > file` + `chmod 0600` + `export VAR="$(cat file)"`); the `read -s` alternative is also documented.
- [ ] §2.5 lists `audit-key`, `audit.log`, and `socket` in the `.gitignore` recommendation.
- [ ] All bash code blocks are fenced with `bash` (or `sh`); all YAML blocks fenced with `yaml`; ASCII diagrams fenced with `text`.
- [ ] The architecture diagram uses ASCII-only characters (no Unicode box-drawing).
- [ ] `markdownlint` exits 0 on the new file.
- [ ] The "See also" subsection at the top references `skills/help/SKILL.md`, `skills/config-guide/SKILL.md`, and `skills/troubleshoot/SKILL.md` by relative path or canonical name.

## Dependencies

- **TDD-025 §6.8** — authoritative source for the runbook's nine-section structure.
- **TDD-025 §3.2** — architecture diagram source (this spec's §1 mirrors it in operator terms).
- **TDD-024 §7-§10** — cred-proxy semantics, TTL bounds, scoper interface, audit-log format. The runbook expands these in operator terms.
- **PLAN-025-1 / SPEC-025-1-01** (sibling, hard precedence): the `help/SKILL.md` "Credential Proxy" section is the brief operator-facing intro. The runbook is the deep reference. The "See also" link from this spec back to the SKILL section depends on SPEC-025-1-01 being merged. Forward reference is acceptable because both ship in the same TDD-025 batch.
- **PLAN-025-1 / SPEC-025-1-02** (sibling, soft): the `config-guide/SKILL.md` `cred_proxy` section is referenced from the audit-key step's `audit_key_env` callout. Forward reference acceptable.
- **SPEC-025-2-02, SPEC-025-2-03, SPEC-025-2-04** (siblings, layered): these specs append §3, §4-§5, and §6-§9 respectively. This spec's TOC includes their anchor placeholders so the file's structure is consistent on first commit.
- **FR-1539** — never-echo-secrets rule. Authoritative for §2.3.
- **No code dependencies** — documentation only.

## Notes

- The file is **created** in this spec but is not "complete" until SPEC-025-2-02..04 land. Reviewers reading the file mid-batch will see placeholder-anchored TOC entries pointing to sections that don't yet exist. This is expected and acceptable; the placeholders use canonical anchor names per TDD §6.8 so sibling specs don't have to alter the TOC.
- The §1 architecture diagram is a verbatim ASCII reproduction of TDD §3.2's diagram. Updates to that diagram (if TDD-024 §7 changes the architecture) belong in a follow-up TDD-025 amendment, not in this spec's PR.
- The §2.3 audit-key file path (`~/.autonomous-dev/cred-proxy/audit-key`) is **not** documented in TDD-025 §5.2 (the TDD only documents `audit_log`). This spec introduces the `audit-key` filename as a recommended convention. If TDD-024 §10 specifies a different canonical filename, this spec is updated at PR review time. The convention is otherwise defensible: same directory as `audit.log`; `0600` permissions; never-committed.
- The `umask 0177` + redirect pattern in §2.3 is the recommended way to create a file with `0600` permissions atomically (vs. creating with default `0644` and then `chmod`-ing, which has a small race window). If the implementer prefers the chmod-after pattern, document that the race window is negligible for a one-time bootstrap step.
- The `read -s` alternative is documented for operators on systems without `openssl` available (rare but plausible on minimal containers).
- The "Do not run `cred-proxy start` as root" phrasing is one of the verbatim prohibition phrases referenced by PLAN-025-2 sibling specs. SPEC-025-2-03 documents the matching "do not chown to root" prohibition for the recovery flow. The phrasings are deliberately mirrored.
- The TOC at the top is a navigation aid for operators reading the file in raw Markdown; it is not strictly required by the markdown-lint config but matches the existing convention in `instructions/deploy-runbook.md` (when that file lands per TDD-026).
