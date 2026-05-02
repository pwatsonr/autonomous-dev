---
name: submit-bug
description: Submit a structured bug report to autonomous-dev (collects all BugReport fields)
arguments:
  - name: title
    type: string
    required: true
    description: Short bug title (1-200 chars)
  - name: description
    type: string
    required: true
    description: Free-text bug description (1-4000 chars)
  - name: repro_step
    type: string
    required: true
    description: A single reproduction step (repeat with '|' for multiple, e.g. "step 1|step 2|step 3")
  - name: expected
    type: string
    required: true
    description: Expected behavior (1-2000 chars)
  - name: actual
    type: string
    required: true
    description: Actual behavior (1-2000 chars)
  - name: error_message
    type: string
    required: false
    description: Optional verbatim error/stack (repeat with '|' for multiple)
  - name: severity
    type: enum
    required: false
    enum: [low, medium, high, critical]
    default: medium
  - name: repo
    type: string
    required: false
    description: Repository slug, e.g. owner/repo
  - name: priority
    type: enum
    required: false
    enum: [high, normal, low]
    default: normal
allowed_tools:
  - Bash(bash:*)
---

# Submit Bug Report

Walk the user through collecting every required field of `BugReport`
(see `schemas/bug-report.json`). After all required fields are
collected, invoke the CLI in non-interactive mode:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_shared/bridge_proxy.sh
source "${SCRIPT_DIR}/_shared/bridge_proxy.sh"
bridge_proxy_invoke "submit-bug" "$@"
```

The bridge proxy translates the captured arguments into the equivalent
`autonomous-dev request submit-bug --non-interactive` invocation,
expanding `|`-delimited `repro_step` and `error_message` arguments into
the CLI's repeatable `--repro-step`/`--error-message` flags. The CLI
performs the canonical AJV-shaped validation; any missing or malformed
field is rejected with `Error: bug report validation failed:` and the
slash command surfaces the stderr to the operator.
