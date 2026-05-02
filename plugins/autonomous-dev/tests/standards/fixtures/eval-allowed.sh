#!/bin/sh
# SPEC-021-2-03: trivial allowlisted evaluator fixture.
# Emits the canonical {passed, findings} JSON envelope and exits 0.
echo '{"passed": true, "findings": []}'
exit 0
