# Auto-update: how "merged to main" becomes "installed daemon updated"

For a long time the installed daemon drifted behind `main`: code was merged (and
sometimes hand-copied into the version cache) but the **version number was never
bumped**, so `main`, the marketplace, and the plugin cache all sat at one version
forever. The daemon's built-in upgrader is version-driven — it upgrades to the
newest version **in the local plugin cache** — so with no new version anywhere,
it correctly did nothing. This document describes the pipeline that closes that
gap end-to-end.

## The chain

```
merge to main ─▶ auto-release.yml ─▶ v<x> tag ─▶ release.yml ─▶ published version
                 (bump + tag)                     (GitHub Release + marketplace)
                                                          │
   installed daemon ◀── daemon upgrader ◀── plugin cache ◀── plugin-updater timer
   (repointed to <x>)   (stage_upgrade)      (new <x> dir)   (self-update: fetch)
```

### Repo side — `.github/workflows/auto-release.yml`
Runs every 6h (and on manual dispatch). If `main` has advanced with real
(non-`release:`) commits since the last `v*` tag, it patch-bumps the two manifest
files (`.claude-plugin/marketplace.json` + `plugins/autonomous-dev/.claude-plugin/plugin.json`),
commits `release: v<x>` to `main`, and pushes a `v<x>` tag. The existing
`release.yml` then publishes the GitHub Release. Loop-safe: schedule/dispatch
only (a pushed bump-commit can't re-trigger it), and it skips when the only new
commits are `release:` commits.

The bump logic is `scripts/ci/next-version.sh` (unit-tested in
`tests/bats/next_version.bats`).

### Machine side — `autonomous-dev self-update` + the `plugin-updater` timer
The daemon's upgrader only upgrades to the newest version already in the cache;
it never fetches. `bin/plugin-self-update.sh` (exposed as `autonomous-dev
self-update`) is the fetch:

1. `claude plugin marketplace update` — refresh the marketplace clone
2. `claude plugin update autonomous-dev@autonomous-dev` — pull the new version into the cache
3. repoint the CLI wrapper (`~/.local/bin/autonomous-dev`) to the newest cached version

The daemon's own upgrader (`check_upgrade_available` → `stage_upgrade`) then
repoints the launchd **service** on its next tick. It is **independent of the
kill-switch** — updating installed code is not running pipeline work, so the
system stays current even while the loop is halted.

## Enabling the machine-side timer (operator, one-time)

```sh
tmpl="$(autonomous-dev config show --plugin-dir)/templates/com.autonomous-dev.plugin-updater.plist.template"
out="$HOME/Library/LaunchAgents/com.autonomous-dev.plugin-updater.plist"
sed -e "s#{{USER_HOME}}#$HOME#g" \
    -e "s#{{DAEMON_HOME}}#$HOME/.autonomous-dev#g" \
    -e "s#{{EXTRA_PATH_DIRS}}#$HOME/.local/bin:#g" \
    "$tmpl" > "$out"
launchctl bootstrap "gui/$(id -u)" "$out"
```

Verify: `tail -f ~/.autonomous-dev/logs/plugin-updater.log`. Run once by hand
anytime with `autonomous-dev self-update`.

## Manual release (fallback)

If you ever need to cut a release by hand: bump the two version fields, merge,
then `claude plugin marketplace update && claude plugin update autonomous-dev@autonomous-dev`.
The `self-update` command does the last two steps for you.
