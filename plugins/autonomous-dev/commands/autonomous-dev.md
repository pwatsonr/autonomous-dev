---
name: autonomous-dev
description: Run any autonomous-dev CLI subcommand from Claude Code (org, project, repo, request, daemon, ...)
arguments:
  - name: args
    type: string
    required: true
    description: Subcommand and its args, e.g. "org ingest pwatson-space" | "project infer" | "repo list --project plex" | "daemon status"
allowed_tools:
  - Bash(autonomous-dev:*)
  - Bash(bash:*)
---

```bash
#!/usr/bin/env bash
set -euo pipefail
# Thin passthrough to the autonomous-dev CLI so any subcommand is reachable as a
# slash command from inside Claude Code, e.g.:
#   /autonomous-dev org ingest pwatson-space
#   /autonomous-dev project infer
#   /autonomous-dev repo list --project plex
AUTODEV="$(command -v autonomous-dev || echo "${HOME}/.local/bin/autonomous-dev")"
exec "${AUTODEV}" "$@"
```
