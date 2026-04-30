---
name: autonomous-dev-submit
description: Submit a new autonomous-dev request (returns REQ-NNNNNN identifier)
arguments:
  - name: description
    type: string
    required: true
    description: Free-form request description
  - name: priority
    type: enum
    required: false
    enum: [high, normal, low]
    default: normal
  - name: repo
    type: string
    required: false
    description: Repository slug, e.g. owner/repo
  - name: deadline
    type: string
    required: false
    description: ISO-8601 deadline (optional)
allowed_tools:
  - Bash(bash:*)
---

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_shared/bridge_proxy.sh
source "${SCRIPT_DIR}/_shared/bridge_proxy.sh"
bridge_proxy_invoke "submit" "$@"
```
