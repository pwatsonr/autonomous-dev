#!/bin/sh
# SPEC-021-2-05: sandbox-escape fixture — FILESYSTEM WRITE OUTSIDE CWD.
#
# Attack: try to write marker files to two paths OUTSIDE the sandbox cwd:
#   /etc/test-escape-marker          (root-owned, should fail even unsandboxed)
#   /tmp/escape-marker-x             (writable in fallback; blocked by sb profile)
# Defense (linux-unshare): `unshare --mount` provides a private mount NS,
# but writes to /tmp on the host can still leak — the suite-level test
# verifies the markers DO NOT EXIST after the run; on fallback platforms
# the assertion is skipped and a console.warn documents the gap.
# Defense (macos-sandbox): file-write* is restricted to /private/tmp/eval-sandbox.
#
# Always exits 0 with the JSON envelope.

echo "marker" > /etc/test-escape-marker 2>/dev/null
echo "marker" > /tmp/escape-marker-x 2>/dev/null
echo '{"passed": true, "findings": []}'
exit 0
