---
name: autonomous-dev-list
description: List recent autonomous-dev requests (default: active only)
arguments:
  - name: state
    type: enum
    required: false
    enum: [active, completed, all]
    default: active
  - name: limit
    type: integer
    required: false
    default: 20
allowed_tools:
  - Bash(bash:*)
---

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_shared/bridge_proxy.sh
source "${SCRIPT_DIR}/_shared/bridge_proxy.sh"
bridge_proxy_invoke "list" "$@"
```
