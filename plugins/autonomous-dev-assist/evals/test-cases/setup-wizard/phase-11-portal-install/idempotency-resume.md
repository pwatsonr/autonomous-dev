---
phase: 11
case_type: idempotency-resume
expected_outcome: complete
sub_cases:
  - id: A
    description: existing portal.db, operator picks keep
    expected: install + account-create skipped; verify-accounts runs
  - id: B
    description: existing portal.db, operator picks wipe
    expected: portal.db unlinked; install + account-create + verify run
  - id: C
    description: phase killed mid-install (after cred_proxy_write_env)
    expected: re-run resumes at install step; PORTAL_SESSION_SECRET reused
  - id: D
    description: full re-run against complete state with valid probe account
    expected: probe emits already-complete; phase status=complete; no body
assertions:
  - id: A-1
    description: keep path skips install
    type: log-line
    pattern: '"step":"install","status":"skipped-keep"'
  - id: A-2
    description: wipe path unlinks portal.db before install
    type: file-absent-during-step
    path: ~/.autonomous-dev/portal.db
    step: pre-install
  - id: A-3
    description: mid-install resume reuses session secret
    type: count-equals
    pattern: '^PORTAL_SESSION_SECRET='
    target: secrets.env
    expected: 1
---

# Setup / Run / Expected
Four sub-cases per FR-21 sub-A through sub-D in SPEC-033-1-05.
