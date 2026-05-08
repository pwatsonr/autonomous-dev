---
phase: 11
title: "Web portal install (optional)"
amendment_001_phase: 11
tdd_anchors: [TDD-013, TDD-014, TDD-015]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7,8,9,10]
  config_keys: []
optional_inputs:
  existing_portal_db: true
  port_override: true
  bind_override: true
skip_predicate: "skip-predicates.sh portal_install_default_skip"
skip_consequence: |
  No browser pipeline view; CLI status remains via `autonomous-dev status`.
idempotency_probe: "idempotency-checks.sh phase-11-probe"
output_state:
  config_keys_written:
    - portal.enabled
    - portal.port
    - portal.bind_address
    - portal.base_url
    - portal.session_secret_env
    - portal.daemon_managed
  files_created:
    - "~/.autonomous-dev/portal.db"
  external_resources_created: []
verification:
  - "/healthz returns 200 with matching build_id within 10s"
  - "/api/auth/login admin returns ok:true"
  - "/api/auth/login non-admin returns ok:true (if non-admin configured)"
  - "Daemon reports portal as managed child"
eval_set: "evals/test-cases/setup-wizard/phase-11-portal-install/"
---

# Phase 11 — Web portal install (optional)

This phase is **default-skip** (most operators are CLI-only). It installs
the autonomous-dev portal as a managed daemon child (TDD-013/014/015).

## Steps

### Step `intro` + `confirm-opt-in`

```
================================================================
   Phase 11: Web portal install (OPTIONAL)
================================================================
Default: SKIP. Most operators do not need the portal. Without it,
CLI status remains available via `autonomous-dev status`.

Install portal? [y/N] (default: N)
```

On N → mark phase skipped, emit `skip_consequence`, return.

### Step `collect-network`

- port (default 8788)
- bind address (default 127.0.0.1)
- base URL (default `http://127.0.0.1:8788`)

### Step `confirm-public-bind`

If bind=`0.0.0.0`, REQUIRE the literal string `yes-confirm-public-bind`
(any other input → re-prompt up to 3 times, then abort).

### Step `collect-session-secret`

Prompt "auto-generate session secret? [Y/n]". Default Y → `openssl rand -hex 32`.

### Step `db-decision`

If `~/.autonomous-dev/portal.db` exists, prompt keep/wipe; record in
`wizard-checkpoint.json`.

### Step `collect-admin` / `collect-non-admin`

`read -s` password; bcrypt-hash via `htpasswd -bnBC 12` (cost 12); `unset`
plaintext immediately.

### Step `install`

```bash
cred_proxy_write_env PORTAL_SESSION_SECRET "$secret"
unset secret
autonomous-dev portal install \
  --port "$PORT" --bind "$BIND" --base-url "$BASE_URL" \
  --db ~/.autonomous-dev/portal.db \
  --session-secret-env PORTAL_SESSION_SECRET
```

### Step `account-create`

`autonomous-dev portal account create --username "$U" --password-hash "$HASH" [--admin]`

### Step `register-daemon-child`

Write `portal.daemon_managed=true`; SIGHUP daemon.

### Step `healthz-poll`

Poll `http://$BIND:$PORT/healthz` 5 × 2s. Assert response `build_id` matches
`$(autonomous-dev portal --build-id)`.

### Step `verify-accounts`

POST `/api/auth/login` for admin (and non-admin if configured); assert
HTTP 200 + `ok:true`.

### Step `write-config`

Write the six output_state keys.

## Defense-in-depth

- `set +x` at top of every step touching a password.
- `htpasswd` invoked with password via stdin heredoc, not argv.
- `--password-hash` flag (NOT `--password`) so daemon never sees plaintext.
- 10s `/healthz` ceiling per TDD-033 §6.2 (override via `WIZARD_HEALTHZ_TIMEOUT_SECONDS`).
