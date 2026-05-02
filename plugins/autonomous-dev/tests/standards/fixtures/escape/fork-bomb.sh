#!/bin/sh
# SPEC-021-2-05: sandbox-escape fixture — BOUNDED FORK BOMB.
#
# Attack: spawn N short-lived background subshells in a tight loop. A real
# fork bomb (`:(){ :|: & };:`) is deliberately AVOIDED — the test goal is
# to verify the sandbox kills the workload within its 30s timeout AND that
# the parent CI runner remains responsive. An unbounded bomb adds risk
# without information.
# Defense (linux-unshare): the 30s execFile timeout fires; sandbox kills
# the process group with SIGKILL.
# Defense (macos-sandbox): same — sandbox-exec inherits the timeout.

i=0
# 50 iterations is enough to demonstrate the spawn rate without overwhelming
# CI runners that lack robust process accounting.
while [ $i -lt 50 ]; do
  ( sleep 0.05 ) &
  i=$((i + 1))
done
wait 2>/dev/null
echo '{"passed": true, "findings": []}'
exit 0
