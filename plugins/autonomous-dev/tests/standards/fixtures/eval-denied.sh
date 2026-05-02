#!/bin/sh
# SPEC-021-2-03: identical evaluator NOT in allowlist (used to test
# SecurityError path). Exists on disk only so tests can construct an
# absolute path; runCustomEvaluator MUST refuse to spawn it.
echo '{"passed": true, "findings": []}'
exit 0
