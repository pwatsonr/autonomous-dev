# SPEC-025-1-02: config-guide/SKILL.md `cred_proxy` Section

## Metadata
- **Parent Plan**: PLAN-025-1
- **Parent TDD**: TDD-025-assist-cloud-credproxy-surface
- **Tasks Covered**: PLAN-025-1 Task 3 (`cred_proxy` config-guide section)
- **Estimated effort**: 4 hours
- **Status**: Draft
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-025-1-02-config-guide-cred-proxy-section.md`

## Description
Append a new H2 `## cred_proxy` section to `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` documenting the cred-proxy config block per TDD-025 §5.2 + §6.3. The section documents every field of the cred-proxy YAML block (`socket_path`, `default_ttl_seconds`, `audit_log`, `audit_key_env`, `scopers`, `max_concurrent_tokens`), provides a complete copy-pasteable example, and includes a "Common pitfalls" subsection that explicitly warns against the three highest-stakes mistakes (committing the audit key; chmod-ing the socket as root; running `cred-proxy start` as root).

The section is **strictly additive**. The example YAML must round-trip through a standard YAML parser. The `audit_key_env` documentation must say verbatim that the field stores the *name* of an environment variable, not the key itself — this is the highest-stakes documentation contract in the spec because misreading it leads directly to credential commits.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` | Modify (append one H2 section after the last existing top-level section) | Additive only |

## Implementation Details

### Section: `cred_proxy`

Append the following H2 block after the current last top-level section in `config-guide/SKILL.md`. Subsections per TDD-025 §5.2 + §6.3.

```markdown
## cred_proxy

Configuration for the credential proxy daemon. The proxy issues short-lived, scope-narrowed credentials to the deploy framework so root credentials never reach the deploy worker process. See the **Credential Proxy** section in `skills/help/SKILL.md` for the operator overview and `instructions/cred-proxy-runbook.md` for the deep walkthrough.

### Example

```yaml
cred_proxy:
  socket_path: ~/.autonomous-dev/cred-proxy/socket
  default_ttl_seconds: 900            # 15 minutes
  audit_log: ~/.autonomous-dev/cred-proxy/audit.log
  audit_key_env: CRED_PROXY_AUDIT_KEY  # env var NAME, not the key itself
  scopers:
    aws:   ~/.autonomous-dev/cred-proxy/scopers/aws
    gcp:   ~/.autonomous-dev/cred-proxy/scopers/gcp
    azure: ~/.autonomous-dev/cred-proxy/scopers/azure
    k8s:   ~/.autonomous-dev/cred-proxy/scopers/k8s
  max_concurrent_tokens: 32
```

### Field reference

#### `socket_path` (string, required)

Path to the Unix-domain socket the proxy listens on. The proxy enforces mode `0600` (owner-only read/write) on this socket at startup. Default: `~/.autonomous-dev/cred-proxy/socket`. Do not chmod this socket manually; the proxy re-applies the permission on every restart and bootstraps it on first run.

#### `default_ttl_seconds` (integer, required)

Default TTL applied to every issued credential, in seconds. Default: `900` (15 minutes). On expiry, the proxy closes the deploy worker's file descriptor immediately. Raise this value for long-running deploys; the practical upper bound is the upstream cloud cap (e.g., AWS STS chained-role tops out at ~4 hours). See `cred-proxy-runbook.md` §6 for tuning guidance.

#### `audit_log` (string, required)

Path to the HMAC-chained audit log. Every issuance writes a chained entry recording token-id, cloud, scope, requester process, TTL, and chain-hash. Verify with `cred-proxy doctor --verify-audit`. Default: `~/.autonomous-dev/cred-proxy/audit.log`. **Do not delete this file.** Deletion breaks the chain and forfeits forensic capability.

#### `audit_key_env` (string, required)

Stores the *name* of an environment variable, not the key itself. The proxy reads the named variable at startup to obtain the HMAC key. Worked example:

```bash
# Generate a 256-bit key and export it from your shell rc, NOT into your config:
export CRED_PROXY_AUDIT_KEY="$(openssl rand -hex 32)"
```

```yaml
# Then reference the env var by NAME in the config:
audit_key_env: CRED_PROXY_AUDIT_KEY
```

If you put the raw key into the YAML, the key will end up in any repo or backup that includes the config file. Pasting a real HMAC key into this field is the single highest-stakes mistake in cred-proxy configuration. See "Common pitfalls" below.

#### `scopers` (map, required)

Per-cloud scoper plugin install paths. The proxy looks up the scoper by cloud name (`aws`, `gcp`, `azure`, `k8s`) and invokes it to translate root credentials into a scoped short-lived token. Each path corresponds to a separately installed scoper plugin (`cred-proxy-scoper-aws`, etc.). Omit clouds you do not target.

#### `max_concurrent_tokens` (integer, optional, default `32`)

Upper bound on simultaneously outstanding tokens. New issuance requests above this cap block until a TTL expiry frees a slot. Raise for high-parallelism deploy fleets; lower for security-tightened environments.

### Common pitfalls

- **Do not commit the audit key.** The `audit_key_env` field stores an environment variable *name*; the actual key lives in your shell environment or a `0600` file outside the repo. Add `~/.autonomous-dev/cred-proxy/audit-key` (if you store the key in a file) to `.gitignore`. Never paste the raw key into the YAML.
- **Do not chmod the socket as root.** The proxy enforces mode `0600` on its own socket. Running `sudo chmod` or `sudo chown` on the socket breaks the ownership invariant and triggers the permission-denied failure mode. If you see permission errors, restart the proxy as the deploying user instead.
- **Do not run `cred-proxy start` as root.** The proxy is designed to run as the deploying user. Running it as root makes every issued credential reachable by any process running as that user and breaks the per-process audit-log requester-process attribution.

### See also

- `cred-proxy` overview: `skills/help/SKILL.md` Credential Proxy section
- Deep walkthrough: `instructions/cred-proxy-runbook.md`
```

**Required content checks (acceptance):**

- The YAML example block parses with a standard YAML parser (no syntax errors). The implementer should verify by piping the example through `python3 -c 'import yaml,sys; yaml.safe_load(sys.stdin)'` or `node -e 'require("js-yaml").load(require("fs").readFileSync(0,"utf8"))'` before committing.
- The `default_ttl_seconds` value is the integer `900` (not `15m`, not `15`, not a string).
- The `audit_key_env` documentation contains the literal phrase `name of an environment variable, not the key itself` (or a phrase that contains `name`, `environment variable`, and `not the key`). The exact phrasing per TDD-025 §5.2 is "stores the *name* of an environment variable, not the key itself" — the implementer should use that phrasing verbatim where possible to maximize alignment with PLAN-025-3 evals.
- The Common-pitfalls subsection has at least three bullets and contains the literal phrases `Do not commit the audit key`, `Do not chmod the socket as root`, and `Do not run cred-proxy start as root` (or close paraphrases that retain the directive verbs).
- All four scoper paths are listed in the `scopers` map: `aws`, `gcp`, `azure`, `k8s`.
- The `socket_path` field reference mentions mode `0600` explicitly.

### Heading and lint considerations

- `markdownlint` (existing config) must pass on the modified file.
- The H2 heading is lowercase (`## cred_proxy`) to match the YAML field name and the existing convention in `config-guide/SKILL.md` (other field-reference H2s in the file use the field name directly; the implementer should read the file first to confirm). If existing convention is title-case, switch to `## Credential Proxy Configuration`.
- The fenced YAML and Bash code blocks use language tags (` ```yaml `, ` ```bash `) for syntax-highlighting in rendered Markdown.
- "See also" subsection uses H3 (`### See also`); the linter config tolerates duplicate slugs across the file (existing pattern). If lint flags it, suffix with `### See also (cred_proxy)`.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev-assist/skills/config-guide/SKILL.md` contains a new H2 `## cred_proxy` section appended after the last pre-existing top-level section.
- [ ] The section contains an `### Example` subsection with a fenced YAML block whose content matches the field shape shown above.
- [ ] The example YAML block parses without error via `python3 -c 'import yaml,sys; yaml.safe_load(sys.stdin)'`. (Manual verification step; document the verification in the PR description.)
- [ ] The example uses `default_ttl_seconds: 900` (integer, not `15m` or `"900"` string).
- [ ] The example uses `audit_key_env: CRED_PROXY_AUDIT_KEY` (a value that is itself a valid env-var-name) and the inline comment `# env var NAME, not the key itself` (or close paraphrase).
- [ ] The `### Field reference` subsection documents every field present in the example: `socket_path`, `default_ttl_seconds`, `audit_log`, `audit_key_env`, `scopers`, `max_concurrent_tokens`.
- [ ] The `socket_path` field reference contains the literal `0600`.
- [ ] The `audit_key_env` field reference contains the literal phrase `name of an environment variable, not the key itself` (or includes all three keywords `name`, `environment variable`, `not the key`).
- [ ] The `audit_key_env` field reference contains a worked example using `openssl rand -hex 32` and showing `export CRED_PROXY_AUDIT_KEY=...` separated from the YAML reference `audit_key_env: CRED_PROXY_AUDIT_KEY`.
- [ ] The `audit_log` field reference contains the literal `Do not delete this file` (or `Do not delete the audit log`) in bold or as a directive sentence.
- [ ] The `### Common pitfalls` subsection contains at least three bullets, including:
  - `Do not commit the audit key`
  - `Do not chmod the socket as root`
  - `Do not run cred-proxy start as root` (or close paraphrase)
- [ ] All four scoper paths are listed in the `scopers` map example: `aws`, `gcp`, `azure`, `k8s`.
- [ ] All sections existing on `main` before this spec are byte-for-byte unchanged. (Verify with `git diff main -- plugins/autonomous-dev-assist/skills/config-guide/SKILL.md`: only added lines.)
- [ ] `markdownlint` exits 0 on the modified file.
- [ ] All "See also" links use canonical filenames (`skills/help/SKILL.md`, `instructions/cred-proxy-runbook.md`).

## Dependencies

- **TDD-025 §5.2** — authoritative source for the YAML schema (field names, defaults, env-var-name convention).
- **TDD-025 §6.3** — authoritative source for required subsections (Example, Field reference, Common pitfalls, See also).
- **TDD-024 §10** — authoritative source for the upstream TTL cap referenced from `default_ttl_seconds`.
- **SPEC-025-1-01** (sibling, soft): the help/SKILL.md Credential Proxy section is referenced by "See also" but does not need to land first; this spec's link works as a forward reference if SPEC-025-1-01 has not yet merged.
- **SPEC-025-2-01** (forward reference): the `cred-proxy-runbook.md` is referenced by "See also" and §6 of the runbook is referenced from `default_ttl_seconds`. Forward link is intentional; PLAN-025-1 Task 8 (SPEC-025-1-04) audits resolution.
- **No code dependencies** — documentation only.

## Notes

- The `audit_key_env` documentation is the single highest-stakes line in this spec. The reviewer must hand-check the phrasing against TDD-025 §5.2 verbatim. Drift here causes operator credential leaks.
- The TDD's §5.2 example uses `audit_key_env: CRED_PROXY_AUDIT_KEY_ENV` (the env-var name has an `_ENV` suffix). This spec uses `CRED_PROXY_AUDIT_KEY` (no `_ENV` suffix) to match the bash export example, which is the more natural shell convention. The functional contract (the value is a name, not a key) is identical. The implementer may switch to `CRED_PROXY_AUDIT_KEY_ENV` if they prefer to mirror the TDD literal; both are acceptable as long as the export example matches the reference (i.e., if the field value is `CRED_PROXY_AUDIT_KEY_ENV`, the export must be `export CRED_PROXY_AUDIT_KEY_ENV=...`).
- The implementer must read the current `config-guide/SKILL.md` to confirm: (1) the existing H2-heading convention (lowercase field names vs. title case); (2) whether existing field-reference subsections use H3 or H4 for individual fields; (3) the existing fenced-code-block convention (language tags or no). Match the existing conventions; the example above uses H3 + H4 + language tags, which is the most common modern pattern.
- The Common-pitfalls subsection is the operator-facing complement to PLAN-025-2's runbook §5 prohibitions. The phrasing of the three "Do not" directives should align with the runbook §5 phrasing where possible to maximize PLAN-025-3 eval `must_not_mention` coverage.
- This spec's YAML example is also referenced by PLAN-025-2's setup-wizard Phase 12 (SPEC-025-2-04) when the wizard walks the operator through `audit_key_env` configuration. Drift in the field shape will break the wizard's instructions.
