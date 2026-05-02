#!/bin/sh
# SPEC-021-2-05: sandbox-escape fixture — SIGNAL INJECTION AT PARENT.
#
# Attack: attempt to send SIGTERM/SIGKILL to PID 1 (the host's init) AND to
# PPID (the parent jest worker). Both should fail because:
#   - In `unshare --pid` mode (not enabled by current sandbox), the child's
#     view of PID 1 is itself.
#   - Without --pid, the kernel rejects unprivileged signals to PID 1.
#   - On macOS sandbox-exec, `signal` is restricted to `(target self)`.
#
# The fixture reports whether either kill succeeded. The suite-level test
# asserts kill_init=false AND kill_parent=false so any escape is caught.

KILL_INIT=false
KILL_PARENT=false

# kill -0 only checks signaling permission without delivering anything fatal.
# Using -0 keeps the test deterministic: success means we COULD have signaled.
if kill -0 1 2>/dev/null; then
  KILL_INIT=true
fi
if [ -n "$PPID" ] && kill -0 "$PPID" 2>/dev/null; then
  KILL_PARENT=true
fi

printf '{"passed": true, "findings": [], "kill_init": %s, "kill_parent": %s}\n' "$KILL_INIT" "$KILL_PARENT"
exit 0
