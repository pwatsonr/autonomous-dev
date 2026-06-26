# ONBOARD Phase 4 — Trigger Activation & Deploy Guide (#596)

This is the operator's guide to turning the **daemon-side trigger logic** (which
ships with this release) into **working inbound triggers**. The logic is built
and tested with no live credentials; activating it requires provisioning the
Discord/Slack apps + tokens and wiring two integration points.

## What ships in this release (daemon-side, tested)

All under `plugins/autonomous-dev/intake/triggers/` (63+ unit tests):

| Module | Responsibility |
|--------|----------------|
| `scoped_command.ts` | parse `/{autodev} {project\|repo} {scope-id} {task}` |
| `scope_resolution.ts` | resolve the scope against P0 ownership |
| `scope_authz.ts` | per-scope authorization (composes the intake `AuthzEngine`) |
| `trigger_handler.ts` | the `trigger` command handler on `intake_router` (sanitize → resolve → authz → enqueue → dedupe → record) |
| `trigger_store.ts` | restart-safe idempotency + tracking records (`~/.autonomous-dev/state/triggers/triggers.json`) |
| `trigger_reporter.ts` | status back to origin (best-effort) + audit fallback |
| `trigger_watch.ts` | CI-green-for-N-days stabilization watch (OQ-1: N=3, cap 14d) |
| `checks_client.ts` | `gh`-backed CI status for the watch |

A scoped command that reaches the router today is fully handled: it enqueues a
normal pipeline request (so R1 + the allowlist apply unchanged), dedupes
retries, and records the trigger for reporting + the watch.

## What the OPERATOR must provision (deploy-time)

Inbound triggers do **not** fire until these exist. The daemon-side logic is
live and harmless without them.

### Discord
1. Create a Discord **Application** (developer portal).
2. Note the **Public Key** (Ed25519) — the intake Discord adapter verifies
   request signatures with it.
3. Create a **Bot** and note its **token** (for posting status back to channels).
4. Register the **`/autodev` slash command** (global or per-guild) with a single
   string option carrying `{project|repo} {scope-id} {task}`.
5. Set the **Interactions Endpoint URL** to the daemon's inbound ingress (the
   existing `intake/adapters/discord` HTTP surface; expose via tunnel — it binds
   loopback).

### Slack
1. Create a Slack **App**.
2. Note the **Signing Secret** — the intake Slack adapter verifies the
   `X-Slack-Signature` + timestamp (5-min replay window) with it.
3. Add a **Bot token** (`chat:write` scope, `commands`).
4. Add the **`/autodev` slash command** pointing its Request URL at the daemon's
   inbound ingress (`intake/adapters/slack` server).

### Secrets + config
Store secrets `0600` under `~/.autonomous-dev/secrets/triggers.json` (or via env
per the existing `intake/adapters/slack/slack_verifier.ts` pattern):

```json
{
  "discord": { "public_key": "…", "bot_token": "…" },
  "slack":   { "signing_secret": "…", "bot_token": "…" }
}
```

Config (`~/.claude/autonomous-dev.json`) selects enabled platforms:

```json
{ "triggers": { "enabled": ["discord", "slack"] } }
```

Secrets are never logged, echoed, or committed (mirrors the Neo4j credential
handling).

## Two integration points wired at activation

1. **Inbound routing** — the existing `intake/adapters/{discord,slack}` servers
   verify signatures + ack within 3 s; they construct an `IncomingCommand` for
   the `trigger` command. They must set `commandName: 'trigger'`, the `args`
   `[scopeType, scopeId, ...task]`, and a stable `flags.messageId` (the platform
   interaction/message id — the idempotency key) + the origin fields on
   `command.source` (`platformChannelId`, `userId`). The router then dispatches
   to `TriggerHandler` (already registered).
2. **The watch tick** — `autonomous-dev triggers watch-tick` is BUILT
   (`bin/triggers-cli.ts`). One tick: completion-detection over `enqueued`
   triggers (reads each request's `state.json` at
   `<repo.path>/.autonomous-dev/requests/<id>/state.json` → done → start the
   watch + report done; failed → report failed), then `advanceWatches` over the
   active watches (CI via `gh pr checks`). The watch branch is
   `autonomous/<requestId>` (the pipeline's PR-branch convention). Two
   activation steps remain:
   - **Periodic invocation** — invoke `autonomous-dev triggers watch-tick` each
     daemon iteration. Add it to `bin/supervisor-loop.sh` just before the
     idle-backoff sleep (best-effort: `… triggers watch-tick >/dev/null 2>&1 ||
     true`), or run it from a launchd/cron timer. (Deferred from the build to
     avoid an untested edit to the daemon's core loop.)
   - **The notifier** — the bin currently uses a logging stub
     (`logNotifier`); swap it for the real Discord/Slack bot-post (origin
     channel) once tokens exist. This is the one credential-bearing piece.
   Caveat: `gh pr checks <branch>` needs the PR to still be open; if the
   pipeline merges + deletes the branch, the checks read `unknown` and the watch
   holds until the hard cap. Tracking the merged-commit checks
   (`gh api repos/<repo>/commits/<sha>/check-runs`) is a fast-follow.

## Audit events (free-string, via the activity log)

Per the Phase-2 decoupled-audit precedent, these are NOT added to the closed
`src/audit/types.ts AuditEventType` (which is for trust/kill/escalation
decisions). They are emitted via the injected audit sink (production: the
request activity log):

`trigger_enqueued`, `trigger_accepted`, `trigger_done`, `trigger_failed`,
`trigger_report_failed`, `trigger_report_skipped`, `watch_stable`,
`watch_regressed`, `watch_expired`.

## Documented fast-follows
- **`hasRevert` reinforcement** (OQ-1's no-reverts signal): needs git-history
  analysis of a revert commit referencing the change. `checks_client.ts` sets
  only `state` today; CI-green-for-N-days is the primary signal and works
  without it.
- **Project fan-out**: a project-scoped trigger that resolves to >1 repo is
  rejected (`AMBIGUOUS_SCOPE`) in v1; fan-out across a project is a later option.
- **Phase-transition reporting**: v1 reports accepted + terminal; per-phase
  updates are a fast-follow once the reporter subscribes to pipeline phase events.
