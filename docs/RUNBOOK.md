# Operator Runbook — autonomous-dev

This runbook covers non-routine operator procedures for the autonomous-dev daemon.

---

## Un-cancelling a request (REQ-000059)

When a request is cancelled via `request cancel <REQ-ID> --yes`, the daemon writes
a `cancelled.tombstone` sentinel file inside the request directory. Every reconciliation
and recovery path checks for this file and skips the request entirely, preventing it
from being resurrected by orphan-reconciliation, checkpoint recovery, or portal-marker
reconciliation. The tombstone is the sticky guarantee that a cancelled request stays
cancelled across daemon restarts.

To un-cancel a request (operator-only — bypasses the sticky-cancel guard):

```bash
# UN-CANCEL a request (operator only — bypasses the sticky-cancel guard)
REQ=REQ-NNNNNN
REPO=/path/to/repo
rm -f "${REPO}/.autonomous-dev/requests/${REQ}/cancelled.tombstone"
jq '.status = "queued"' "${REPO}/.autonomous-dev/requests/${REQ}/state.json" \
  > "${REPO}/.autonomous-dev/requests/${REQ}/state.json.tmp" \
  && mv "${REPO}/.autonomous-dev/requests/${REQ}/state.json.tmp" \
        "${REPO}/.autonomous-dev/requests/${REQ}/state.json"
sqlite3 ~/.autonomous-dev/intake.db \
  "UPDATE requests SET status='queued' WHERE request_id='${REQ}';"
```

See also: TDD open question §12.2 (un-cancel safety and audit-trail considerations).

---
