# ONBOARD — Trigger Activation & Deploy Guide (#596, #583)

Operator guide to turning the built-and-tested `/autodev` trigger system into
**working inbound triggers**. As of the Phase 6 activation work, the inbound
adapters, the real bot notifier, the watch-tick scheduler, and the security
controls are all **built + tested**; what remains is operator provisioning
(bot apps/tokens) and starting the listener process.

## What ships built + tested (no live credentials needed to build)

- **Inbound mapping** — `/autodev repo <id> <task>` (and `project`) is a real
  command in both adapters. Discord registers it as a slash command
  (`intake/adapters/discord/discord_commands.ts`); Slack handles it in
  `mapSlashCommandPayload` and it's in `slack-app-manifest.yaml`. Both produce
  `commandName:'trigger'` with `args:[scopeType, scopeId, task]` and
  `flags.messageId` set from the **signature-verified platform id** (Discord's
  token-authenticated `interaction.id`; Slack's HMAC-verified `trigger_id`) — the
  idempotency key, so a retried/forged webhook can't double-enqueue.
- **Handler + watch** — `TriggerHandler` (registered on `intake_router`):
  idempotency → sanitize → scope-resolve → per-scope authz → **per-user rate
  limit** → enqueue (writes the `state.json` the daemon runs) → record. The
  watch (`trigger_watch.ts` + `watch_tick.ts`) drives CI-green-for-3-days
  stabilization.
- **Real notifier** — `bot_notifier.ts` posts status back to the origin channel
  via the bot REST API (Discord `POST /channels/:id/messages`, Slack
  `chat.postMessage`), wired into the watch-tick from env tokens.
- **Auto-issue on failure** — `issue_filer.ts` opens (or dedup-comments) a
  GitHub issue on a terminal failure; wired into the watch-tick (pipeline-failed
  / regressed / expired) and available to the daemon via
  `triggers file-failure-issue` + an opt-in bash hook.
- **Security** — prompt-injection filtering is wired into the router (catches
  the corpus incl. possessive forms, no false positives on clean dev requests);
  a per-requester trigger rate limit caps `$`-spending floods; the daemon cost
  caps remain the hard backstop.
- **Watch-tick timer** — `templates/com.autonomous-dev.watch-tick.plist.template`
  (a launchd timer that survives upgrades — it points at the stable wrapper).

## Operator provisioning (deploy-time)

Inbound triggers do **not** fire until these exist. The built logic is dormant
and harmless without them.

### Secrets are ENV VARS (not a file)

The adapters read tokens from the process environment — there is no
`secrets/triggers.json` reader. Provide them to the listener process and the
watch-tick timer (and `chmod 600` any plist that embeds them):

| Env var | Used by | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | inbound + notifier | bot token |
| `DISCORD_APPLICATION_ID` | inbound | application id |
| `DISCORD_GUILD_ID` | inbound | guild to register `/autodev` in |
| `SLACK_BOT_TOKEN` | inbound + notifier | `chat:write`, `commands` |
| `SLACK_SIGNING_SECRET` | inbound (HTTP mode) | HMAC verify |
| `SLACK_APP_TOKEN` | inbound (Socket Mode) | `xapp-…` |

Config (`~/.claude/autonomous-dev.json`) selects enabled platforms:
`{ "triggers": { "enabled": ["discord", "slack"] } }`. Secrets are never logged,
echoed, or committed.

### Discord (Gateway — no public endpoint needed)

The Discord adapter connects **outbound over the Gateway WebSocket** (it is
token-authenticated; there is **no** inbound HTTP endpoint and no Ed25519
request-signature step — that older design is not how this adapter works).

1. Create a Discord **Application** + **Bot**; note the **bot token**,
   **application id**, and your **guild id**.
2. Bot scopes: `applications.commands` + `bot` (send messages in the target
   channels).
3. The `/autodev` slash command is registered automatically at startup
   (`registerCommands` PUTs the guild commands), so no manual command setup.

### Slack (Socket Mode recommended for a local daemon)

For a local/homelab daemon with no public HTTPS ingress, use **Socket Mode**
(outbound WebSocket; set `SLACK_APP_TOKEN`). If you have public ingress, HTTP
mode works too (the HMAC verifier + `/slack/commands` endpoint are built).

1. Create a Slack **App** (import `intake/adapters/slack/slack-app-manifest.yaml`
   — it now includes `/autodev`).
2. Note the **Signing Secret**, add a **Bot token** (`chat:write`, `commands`),
   and (Socket Mode) an **App token**.

## Start the listener process

The inbound listener is **built** — `autonomous-dev triggers serve`. It reuses
the same router the CLI builds (`initRouter()` — Repository, AuthzEngine, rate
limiter, injection rules, and the registered TriggerHandler), then starts
whichever platforms have a bot token in the environment:

- **Discord** if `DISCORD_BOT_TOKEN` is set (Gateway; also needs
  `DISCORD_APPLICATION_ID` + `DISCORD_GUILD_ID`).
- **Slack** if `SLACK_BOT_TOKEN` is set (Socket Mode when `SLACK_APP_TOKEN` is
  also set, else HTTP).

With **no** tokens it prints `no platforms enabled` and exits 0 (a safe smoke
test). Best-effort: one platform failing to start doesn't kill the other;
SIGTERM/SIGINT drain both. It's bun-run glue validated offline (constructor
wiring + import resolution + the no-token smoke); the **true** validation is your
first live run with real tokens.

Run it as a long-lived process alongside the daemon using the ready-made
KeepAlive unit `templates/com.autonomous-dev.triggers-serve.plist.template`:
substitute the `{{…}}` placeholders, fill in the bot tokens, `chmod 600` (it
holds secrets), copy to `~/Library/LaunchAgents/`, then `launchctl bootstrap
gui/$(id -u) <path>`. It points at the stable `~/.local/bin/autonomous-dev`
wrapper so it survives upgrades, and `KeepAlive { SuccessfulExit: false }`
restarts it on a crash but NOT on the clean no-token exit. The first `/autodev`
in a channel the bot is in should enqueue a run (visible via `autonomous-dev
request list` + the portal) and reply with an accept-ack.

## Schedule the watch-tick

Install `templates/com.autonomous-dev.watch-tick.plist.template`: substitute the
`{{…}}` placeholders, fill the bot tokens, `chmod 600`, copy to
`~/Library/LaunchAgents/`, and `launchctl bootstrap gui/$(id -u) <path>`. It runs
`autonomous-dev triggers watch-tick` every 10 minutes — detecting completions,
advancing the stabilization watch, posting status to chat, and auto-filing
failure issues. (Alternatively, add the one-line invocation to
`supervisor-loop.sh` before the idle-backoff sleep.)

## Optional: failure issues for submitted (non-triggered) requests

Triggered requests already auto-file via the watch-tick. To also file on
**submitted**-request pipeline failures, set `AUTODEV_FAILURE_ISSUES=1` (and
optionally `AUTODEV_SYSTEM_ISSUE_REPO=<owner/name>` as the fallback for
unresolvable repos) in the daemon's environment — the opt-in hook in
`handle_phase_failure` files best-effort, backgrounded, deduped.

## Audit events (free-string, via the activity log)

Not added to the closed `src/audit/types.ts AuditEventType`. Emitted via the
injected audit sink (production: the request activity log): `trigger_enqueued`,
`trigger_accepted`, `trigger_done`, `trigger_failed`, `trigger_report_failed`,
`trigger_report_skipped`, `watch_stable`, `watch_regressed`, `watch_expired`.

## Documented fast-follows
- **`hasRevert`** (OQ-1's no-reverts signal): needs git-history analysis;
  CI-green-for-N-days is the primary signal and works without it.
- **Project fan-out**: a project resolving to >1 repo is rejected
  (`AMBIGUOUS_SCOPE`) in v1.
- **Phase-transition reporting**: v1 reports accepted + terminal; per-phase
  updates are a fast-follow.
- **Merged-branch checks**: `gh pr checks <branch>` needs the PR open; if it
  merges + deletes the branch the watch reads `unknown` until the hard cap.
  Tracking merged-commit check-runs is a fast-follow.
