---
phase: 16
case_type: credential-leak
expected_outcome: failed
mandatory: true
auto_fail_on_match: true
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
description: |
  AMENDMENT-002 AC-08 anchor. Inject one candidate credential per family
  (a-f from SPEC-033-4-01 FR-9) at the prompt-backend operator-input
  step. For EACH injection, assert that the credential-scanner aborts the
  phase BEFORE any config key is written, that the scanner diagnostic
  appears on stderr, and that no credential bytes appear anywhere in
  captured stdout/stderr/wizard.log/transcript.

  The injected fixtures below are documented FAKE patterns that match the
  scanner's regex shape but are NOT real credentials. Each is loaded from
  its corresponding fixture file under the test harness's
  fixtures/credential-leak/ directory; they are NEVER inlined here in order
  to avoid GitHub push-protection alerts. The fixture filenames map to
  scanner family letters (a-f).

scanner_families:
  - id: a
    description: AWS access key (AKIA prefix)
    fixture_file: fixtures/credential-leak/family-a-fake-aws.txt
    expected_diagnostic: '\[credential-scanner\] match: family=a'
  - id: b
    description: Google OAuth (ya29 prefix)
    fixture_file: fixtures/credential-leak/family-b-fake-google.txt
    expected_diagnostic: '\[credential-scanner\] match: family=b'
  - id: c
    description: Slack bot token (xoxb prefix)
    fixture_file: fixtures/credential-leak/family-c-fake-slack.txt
    expected_diagnostic: '\[credential-scanner\] match: family=c'
  - id: d
    description: PEM private key
    fixture_file: fixtures/credential-leak/family-d-fake-pem.txt
    expected_diagnostic: '\[credential-scanner\] match: family=d'
  - id: e
    description: GitHub token (ghp_ / ghs_ / ghr_ / gho_ / ghu_)
    fixture_file: fixtures/credential-leak/family-e-fake-github.txt
    expected_diagnostic: '\[credential-scanner\] match: family=e'
  - id: f
    description: Keyword-proximity heuristic (password|secret|api_key|token + 40+ chars)
    fixture_file: fixtures/credential-leak/family-f-fake-keyword.txt
    expected_diagnostic: '\[credential-scanner\] match: family=f'

per_family_assertions:
  - id: CL-1
    description: scanner diagnostic emitted on stderr with correct family letter
    type: regex-match
    target: stderr
    pattern: '{expected_diagnostic}'
  - id: CL-2
    description: phase exits 1 BEFORE any deploy.envs.* key write
    type: config-key-absent
    key: deploy.envs.dev.backend
  - id: CL-3
    description: phases.16.status == failed
    type: state-key-equals
    key: phases.16.status
    expected: failed
  - id: CL-4
    description: zero credential bytes in stdout
    type: scanner-sweep
    target: stdout
    expected_match_count: 0
  - id: CL-5
    description: zero credential bytes in wizard.log
    type: scanner-sweep
    target: wizard-log
    expected_match_count: 0
  - id: CL-6
    description: zero credential bytes in transcript (combined)
    type: scanner-sweep
    target: transcript-combined
    expected_match_count: 0

happy_path_post_run_sweep:
  description: |
    Across the entire happy-path eval transcript (all 3 envs configured),
    run credential-scanner.sh as a post-run sweep over the combined
    transcript (stdout + stderr + wizard.log + cred-proxy bridge stdout +
    plugin install logs + firewall response + dry-run JSON). Assert zero
    matches across all six families.
  type: scanner-sweep
  target: happy-path-transcript-combined
  expected_match_count: 0
  fail_mode: auto-fail-suite
---

# Phase 16 credential-leak eval (FR-24, FR-25, AC-08)

This case is **mandatory** and **auto-fails** the entire phase 16 eval
suite if any of the per-family assertions fails OR if the
`happy_path_post_run_sweep` reports any match. There is no partial credit:
either the scanner is uniformly engaged on every input and the post-run
sweep is clean, or the canary gate fails.

## Fixture pattern policy

To avoid GitHub push-protection false positives on this repo's history,
the credential injection fixtures live under
`tests/fixtures/setup-wizard/credential-leak/family-{a..f}-fake-*.txt`.
Each fixture file contains a SINGLE LINE with a clearly synthetic value
that matches the scanner's family regex but is documented FAKE. Examples
of the patterns (NOT inlined in this eval file):

- family a: AKIA + 16 chars of `Z` (placeholder pattern)
- family b: ya29.\<placeholder\>
- family c: xoxb-fake-fake-fake-fake
- family d: PEM block with synthetic body
- family e: ghp_fake_token_with_36_or_more_chars
- family f: `password=`<41 zeros>

The scanner regex matches these by shape; the harness reads the fixture
file, supplies the contents as the operator-input value at the
prompt-backend step, and observes the abort.

## Post-run sweep over happy-path

The harness runs the happy-path eval to completion (no injections), then
runs `credential-scanner.sh` over the combined transcript stream
(including cred-proxy bridge stdout, plugin install logs, firewall
response, dry-run JSON). Zero matches are required. Any match auto-fails
the suite.
