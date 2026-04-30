---
name: autonomous-dev-pause
description: Pause an autonomous-dev request
arguments:
  - name: request_id
    type: string
    required: true
    description: REQ-NNNNNN identifier
allowed_tools:
  - Bash(bash:*)
---

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_shared/bridge_proxy.sh
source "${SCRIPT_DIR}/_shared/bridge_proxy.sh"
bridge_proxy_invoke "pause" "$@"
```
