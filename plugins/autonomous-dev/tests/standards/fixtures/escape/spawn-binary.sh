#!/bin/sh
# SPEC-021-2-05: sandbox-escape fixture — CHILD-PROCESS SPAWN OF UNRELATED BINARY.
#
# Attack: spawn arbitrary binaries (`id`, `whoami`, `uname`) and embed their
# output in stdout. A successful spawn confirms the sandbox does NOT block
# process creation — it is allowed by both the linux-unshare and
# macos-sandbox profiles (the latter explicitly grants `(allow process-exec)`).
# This fixture documents that EXPECTED behavior so the suite-level test can
# assert the captured `whoami` value is benign (not root, not a CI secret).
# It also confirms the sandbox keeps the child OUT of the parent's process
# graph — the suite asserts the parent process remains responsive.

UNAME=$(uname 2>/dev/null || echo "unknown")
WHOAMI=$(whoami 2>/dev/null || echo "unknown")
printf '{"passed": true, "findings": [], "uname": "%s", "whoami": "%s"}\n' "$UNAME" "$WHOAMI"
exit 0
