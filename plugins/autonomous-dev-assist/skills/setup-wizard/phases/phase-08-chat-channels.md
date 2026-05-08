---
phase: 8
title: "Chat channels (Discord/Slack)"
amendment_001_phase: 8
tdd_anchors: [TDD-008, TDD-011]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  existing_intake_config: true
skip_predicate: "skip-predicates.sh is_cli_only_mode"
skip_consequence: |
  You will only be able to submit requests via the CLI.
  Notifications will go to terminal only.
idempotency_probe: "idempotency-checks.sh phase-08-probe"
output_state:
  config_keys_written:
    - intake.discord.enabled
    - intake.discord.webhook_env
    - intake.slack.enabled
    - intake.slack.token_env
    - intake.slack.channel_id
  files_created: []
  external_resources_created: []
verification:
  - "Discord users.@me returns 200 with bot:true (if enabled)"
  - "Slack auth.test returns ok:true (if enabled)"
  - "Probe message delivered to each enabled channel"
  - "Daemon SIGHUP issued"
eval_set: "evals/test-cases/setup-wizard/phase-08-chat-channels/"
---

# Phase 8 — Chat channels (Discord/Slack)

This phase wires the operator's Discord and/or Slack workspaces into
autonomous-dev's intake layer (TDD-008 / TDD-011). Tokens are collected via
`read -s` (no terminal echo) and are written ONLY to
`~/.autonomous-dev/secrets.env` (mode 0600); config keys hold env-var-name
**pointers**, never the literal token.

## Steps

### Step `intro`

Banner:

```
================================================================
   Phase 8: Chat channels (Discord/Slack)
================================================================
This phase is OPTIONAL. At least one channel must be enabled, OR
you may explicitly skip the phase. Skipping leaves you with CLI-only
intake (consequence: no notifications outside the terminal).
```

### Step `collect-providers`

Prompt for each provider (default N):

```
Enable Discord? [y/N]
Enable Slack?   [y/N]
```

If both N: ask "Skip phase 8 entirely? [y/N]".
- Yes → mark phase skipped, emit the verbatim `skip_consequence`, return.
- No  → re-prompt (re-prompt up to 3 times). On exhaustion, abort with
  "At least one chat channel must be enabled, or the phase must be skipped."

### Step `collect-discord` (only if Discord enabled)

```bash
set +x
IFS= read -rs -p "Discord bot token: " disc_tok ; echo
IFS= read -rs -p "Discord webhook URL: " disc_hook ; echo
```

### Step `collect-slack` (only if Slack enabled)

```bash
set +x
IFS= read -rs -p "Slack bot token (xoxb-…): " slack_tok ; echo
[[ "$slack_tok" =~ ^xoxb- ]] || { echo "Token must start with xoxb-"; exit 1; }
read -p "Slack channel ID: " slack_channel
```

### Step `validate`

Discord:

```bash
curl -fsS -H "Authorization: Bot $disc_tok" \
  https://discord.com/api/v10/users/@me | jq -e '.bot == true' >/dev/null
```

Slack:

```bash
curl -fsS -H "Authorization: Bearer $slack_tok" \
  https://slack.com/api/auth.test | jq -e '.ok == true' >/dev/null
```

On 401: emit `Your existing <provider> token failed validation; please re-enter`
and re-prompt.

### Step `probe-message`

Send `autonomous-dev wizard verification` to each enabled channel; assert
2xx.

### Step `write-secrets`

```bash
source "$PLUGIN_DIR/skills/setup-wizard/lib/cred-proxy-bridge.sh"
[[ -n "${disc_tok:-}" ]] && cred_proxy_write_env DISCORD_BOT_TOKEN "$disc_tok"
[[ -n "${disc_hook:-}" ]] && cred_proxy_write_env DISCORD_WEBHOOK_URL "$disc_hook"
[[ -n "${slack_tok:-}" ]] && cred_proxy_write_env SLACK_BOT_TOKEN "$slack_tok"
unset disc_tok disc_hook slack_tok
```

### Step `write-config`

Write env-var-name pointers (NEVER the literal token):

```bash
jq '.intake.discord.enabled = '"$disc_enabled"'
  | .intake.discord.webhook_env = "DISCORD_WEBHOOK_URL"
  | .intake.slack.enabled = '"$slack_enabled"'
  | .intake.slack.token_env = "SLACK_BOT_TOKEN"
  | .intake.slack.channel_id = "'"$slack_channel"'"' \
  ~/.autonomous-dev/config.json > ~/.autonomous-dev/config.json.tmp
mv ~/.autonomous-dev/config.json.tmp ~/.autonomous-dev/config.json
```

### Step `sighup`

```bash
[[ -f ~/.autonomous-dev/daemon.pid ]] \
  && kill -HUP "$(cat ~/.autonomous-dev/daemon.pid)" \
  || true
```

(Skipped in headless eval via fixture flag `WIZARD_HEADLESS=1`.)

### Step `verify`

Poll daemon's intake-status endpoint (or read its log) for the new adapters.
Bounded ≤ 10s.

## Resume contract

The orchestrator's `WIZARD_RESUME_STEP` env var jumps to the named step.
On resume after a 401-failed token, re-enter `collect-discord` /
`collect-slack`; existing valid token entries in `secrets.env` are reused.

## Implementation notes

- `IFS= read -rs` avoids backslash interpretation and echo.
- After `cred_proxy_write_env`, `unset` the secret bash variable.
- The probe-message body includes a per-install UUID so re-runs identify
  their own probes (avoids duplicate notifications).
