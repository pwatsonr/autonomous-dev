---
name: autodev
description: Submit a build request to the autonomous-dev daemon (editor-side trigger; mirrors the Discord /autodev)
arguments:
  - name: request
    type: string
    required: true
    description: Quoted description plus optional flags, e.g. "add a /health endpoint" --repo pwatson-space/plex-ingestion-service --type feature
allowed_tools:
  - Bash(autonomous-dev:*)
  - Bash(bash:*)
---

```bash
#!/usr/bin/env bash
set -euo pipefail
# Editor-side trigger into the autonomous-dev request pipeline — the Claude Code
# mirror of the Discord /autodev trigger. Args pass straight through to
# `request submit`, so quote the description and append flags as on the CLI:
#   /autodev "add a /health endpoint" --repo owner/repo --type feature
AUTODEV="$(command -v autonomous-dev || echo "${HOME}/.local/bin/autonomous-dev")"
exec "${AUTODEV}" request submit "$@"
```
