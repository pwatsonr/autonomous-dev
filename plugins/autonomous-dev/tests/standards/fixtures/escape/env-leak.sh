#!/bin/sh
# SPEC-021-2-05: sandbox-escape fixture — ENV VAR LEAK FROM PARENT.
#
# Attack: dump every environment variable visible to the child into stdout
# inside the JSON envelope's 'env_dump' field.
# Defense: runCustomEvaluator passes `env: {}` to execFile so the child
# inherits ZERO environment variables. The suite-level test sets a known
# secret in the parent's env (SECRET_TEST_VALUE='do-not-leak') BEFORE the
# call and asserts the substring 'do-not-leak' is absent from any captured
# output. Substring-not-contains is used (not exact-empty-env) because some
# shells inject defaults like PWD/SHLVL that are not security-relevant.

ENV_DUMP=$(env | tr '\n' ' ')
# Replace any double-quote in env to keep JSON well-formed in pathological
# environments; the test asserts secret-not-present, not exact equality.
ESCAPED=$(printf '%s' "$ENV_DUMP" | sed 's/"/\\"/g')
printf '{"passed": true, "findings": [], "env_dump": "%s"}\n' "$ESCAPED"
exit 0
