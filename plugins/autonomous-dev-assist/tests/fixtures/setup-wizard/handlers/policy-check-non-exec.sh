#!/usr/bin/env bash
# Fixture handler with NO execute bit (chmod 644). Used by phase-13
# error-recovery sub-case A to drive `autonomous-dev hooks add` into
# a non-zero exit (TDD-019 contract: handler must be executable).
echo "you should not see this — the handler should not have run"
exit 0
