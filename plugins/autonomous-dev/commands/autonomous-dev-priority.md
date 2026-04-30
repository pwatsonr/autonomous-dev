---
name: autonomous-dev-priority
description: Change priority of an autonomous-dev request (high|normal|low)
arguments:
  - name: request_id
    type: string
    required: true
    description: REQ-NNNNNN identifier
  - name: priority
    type: enum
    required: true
    enum: [high, normal, low]
allowed_tools:
  - Bash(bash:*)
---

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_shared/bridge_proxy.sh
source "${SCRIPT_DIR}/_shared/bridge_proxy.sh"
bridge_proxy_invoke "priority" "$@"
```
