# Setup Wizard Bug Tracker

Bugs and friction encountered while running the autonomous-dev and homelab setup wizards on 2026-05-09. Each entry is a candidate for a follow-up fix PR after the wizards complete.

## Format

Each entry:
- **Wizard**: which wizard / phase
- **Symptom**: what went wrong (paste exact error if possible)
- **Workaround**: what we did to keep moving
- **Severity**: blocker / annoying / cosmetic
- **Suspected location**: file path or component

## Bugs

### B-1: Config perms not enforced on creation (V-017)
- **Wizard**: autonomous-dev-assist:setup-wizard, Phase 3
- **Symptom**: After adding a Discord webhook to `~/.claude/autonomous-dev.json`, validate emits `WARNING [V-017] file_permissions: Config file is group/world-readable and contains webhook URLs (got: 644)`
- **Workaround**: `chmod 600 ~/.claude/autonomous-dev.json`
- **Severity**: annoying (security-relevant — user-default umask leaves the file readable)
- **Suspected location**: wherever the wizard / config CLI writes to this file (the create/update path should `chmod 600` automatically when secrets are present)
- **Fix idea**: detect any `*_url`, `*_token`, `*_key`, `webhook_url` etc. in the config and auto-chmod 600 on save; OR make `autonomous-dev config init --global` always chmod 600

### B-4: Marketplace.json missing 5 sibling plugins
- **Wizard**: cross-plugin install (Phase 2 if it walked through all of them)
- **Symptom**: `.claude-plugin/marketplace.json` only listed `autonomous-dev` and `autonomous-dev-assist`. The 5 sibling plugins (portal + 4 deploy backends) were never installable via `claude plugin install <name>@autonomous-dev`.
- **Workaround**: added the 5 entries in PR #152.
- **Severity**: blocker (plugins were unreachable for end users)
- **Suspected location**: `.claude-plugin/marketplace.json`
- **Status**: FIXED in #152 (merged 2026-05-09). Worth a follow-up to add a CI check that all `plugins/*/plugin.json` files have a corresponding marketplace.json entry so this can't drift again.

### B-5: Plugin manifests have schema-incompatible userConfig + author=string
- **Wizard**: `claude plugin install` validation
- **Symptom**: All 5 sibling plugin manifests fail Claude Code's plugin validation:
  - All 5: `author: expected object, received string` — manifests have `"author": "autonomous-dev contributors"` but Claude Code expects `{name, url?}` object.
  - autonomous-dev-portal additionally: `userConfig.{port,sse_update_interval_seconds}.type: Invalid option ("integer" not allowed; only "string"|"number"|"boolean"|"directory"|"file")`; missing `title` field on every userConfig entry; `minimum`/`maximum`/`enum`/`items` keys not recognized; key `"portal.path_policy.allowed_roots"` rejected (dots in keys not allowed).
- **Workaround**: fix manifests (in-progress).
- **Severity**: blocker (none of the 5 plugins install)
- **Suspected location**: `plugins/{autonomous-dev-portal,autonomous-dev-deploy-{aws,gcp,azure,k8s}}/.claude-plugin/plugin.json`
- **Fix idea**: (1) convert `author` to object form across all manifests; (2) for portal, replace JSON Schema-style userConfig with the simpler Claude Code form (`type` ∈ {string,number,boolean,directory,file}, add `title`, drop unsupported keys, flatten dotted keys); (3) add a CI lint that runs `claude plugin install --dry-run` or equivalent against every plugin manifest in the repo.

### B-3: Wizard documents CLI subcommands that don't exist
- **Wizard**: autonomous-dev-assist:setup-wizard, Phases 5, 7, 9, 10
- **Symptom**: Phase 7 tells the user to run `autonomous-dev request submit --repo ... --description ...` and `autonomous-dev request status --repo ...`. Phase 5/10 reference `autonomous-dev cost`. Phase 10's quick-reference card references `autonomous-dev agent list` and `autonomous-dev observe`. None of these exist — the actual CLI only supports `install-daemon`, `daemon {start,stop,status}`, `kill-switch [reset]`, `circuit-breaker reset`, `config {init,show,validate}`.
- **Workaround**: requests must go through Discord/Slack adapters, or via the daemon's auto-pickup of state files; cost via direct sqlite query.
- **Severity**: BLOCKER for Phase 7 (first-request flow is impossible from the wizard as written)
- **Suspected location**: `plugins/autonomous-dev-assist/skills/setup-wizard/SKILL.md` (the wizard prompt) and/or `plugins/autonomous-dev/intake/cli/dispatcher.ts` (missing subcommands)
- **Fix idea**: either implement `request submit`, `request status`, `cost`, `agent list`, `observe` in the CLI, OR rewrite wizard Phases 5/7/9/10 to reflect the actual command surface (Discord/Slack adapters as primary entry points).

### B-2: Setup wizard expects skills in `plugins/autonomous-dev/skills/`
- **Wizard**: autonomous-dev-assist:setup-wizard, Phase 2 verification
- **Symptom**: The verification step counts agents/commands/skills in the autonomous-dev plugin. There are 0 skills (skills live in autonomous-dev-assist), so the count is "0 skills" — wording the wizard uses ("X agents, Y commands, and Z skills") makes this look like an installation problem when it isn't.
- **Workaround**: ignore the "0 skills" line.
- **Severity**: cosmetic
- **Fix idea**: either count skills across both autonomous-dev and autonomous-dev-assist together, or change wording to reflect that skills are in the assist plugin.
