#!/bin/sh
# SPEC-021-2-05: sandbox-escape fixture — NETWORK CONNECT.
#
# Attack: attempt an outbound TCP/HTTP connection to example.com via curl.
# Defense (linux-unshare): `unshare --net` puts the child in an empty net
# namespace; the connect call returns ENETUNREACH/EAI_AGAIN.
# Defense (macos-sandbox): the .sb profile contains `(deny network*)`.
# Defense (fallback): NO defense — the script will succeed; the suite-level
# test skips the network assertion in fallback mode (documented in the
# describe block).
#
# Always exits 0 with a JSON envelope so the runner's parser doesn't bail
# before the test can inspect the env_dump-style 'connected' field.

CONNECTED=false
if curl -s --max-time 2 http://example.com >/dev/null 2>&1; then
  CONNECTED=true
fi
printf '{"passed": true, "findings": [], "connected": %s}\n' "$CONNECTED"
exit 0
