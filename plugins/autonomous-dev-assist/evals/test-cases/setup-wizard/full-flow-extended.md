---
case: full-flow-extended
description: |
  AMENDMENT-002 AC-07 gate (SPEC-033-4-03 FR-8..FR-12). Run all phases
  1..20 against a fresh checkout with operator-skip on 11/12/16 and
  operator-yes on 8/13/14/15. Assert wizard reaches phase 20 with the
  documented state summary and the deferral notice appears exactly once.
case_type: full-flow
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/ts-greenfield
mocks:
  - autonomous-dev cred-proxy provision/validate/revoke (mocked, never invokes TDD-024)
  - autonomous-dev plugin install (mocked success)
  - autonomous-dev firewall apply / rollback (mocked status=applied)
  - autonomous-dev deploy --dry-run (mocked structured plan)
  - autonomous-dev reviewer-chain dry-run (mocked counter only)
  - gh (github CLI) - canned fixture responses
  - daemon SIGHUP - counter only, no real send
operator_inputs:
  # Inline phases 1-7, 9, 10 use their pre-AMENDMENT defaults.
  # Skips:
  wizard.skip_phase_11: true
  wizard.skip_phase_12: true
  wizard.skip_phase_16: true
  # Phase 8 (canonical happy-path inputs):
  chat.channel_provider: discord
  chat.intake_channel: "#daemon-intake"
  # Phase 13 (canonical happy-path inputs):
  request_types.catalog: ["bug", "feature", "tech-debt"]
  # Phase 14 (canonical happy-path inputs):
  standards.path: ".autonomous-dev/standards.yaml"
  standards.bootstrap: true
  # Phase 15 (canonical happy-path inputs):
  reviewer_chains.specialists: ["security@1", "performance@2"]
assertions:
  - id: A-1
    description: wizard exits 0 at end of phase 20
    type: exit-code
    expected: 0
  - id: A-2
    description: deferral notice appears exactly once between phase 16 and phase 20
    type: regex-count
    target: stdout-transcript
    pattern: 'Phases 17-19 are deferred to the autonomous-dev-homelab repository\.'
    expected: 1
  - id: A-3
    description: phase 20 summary table contains 7 rows for phases 8/11/12/13/14/15/16
    type: regex-count
    target: stdout-transcript
    pattern: '^\| (08|11|12|13|14|15|16) \|'
    expected: 7
  - id: A-4
    description: phase 8 status complete
    type: state-key-equals
    key: phases.08.status
    expected: complete
  - id: A-5
    description: phase 11 status skipped
    type: state-key-equals
    key: phases.11.status
    expected: skipped
  - id: A-6
    description: phase 12 status skipped
    type: state-key-equals
    key: phases.12.status
    expected: skipped
  - id: A-7
    description: phase 13 status complete
    type: state-key-equals
    key: phases.13.status
    expected: complete
  - id: A-8
    description: phase 14 status complete
    type: state-key-equals
    key: phases.14.status
    expected: complete
  - id: A-9
    description: phase 15 status complete
    type: state-key-equals
    key: phases.15.status
    expected: complete
  - id: A-10
    description: phase 16 status skipped
    type: state-key-equals
    key: phases.16.status
    expected: skipped
  - id: A-11
    description: hint column for skipped/complete rows is empty
    type: regex-no-match
    target: stdout-transcript
    pattern: '^\| (08|13|14|15) \| [^|]+ \| complete \| [^| ]'
  - id: A-12
    description: hint for skipped phase 11 is empty
    type: regex-no-match
    target: stdout-transcript
    pattern: '^\| 11 \| [^|]+ \| skipped \| [^| ]'
  - id: A-13
    description: no inline phase 1-7, 9, 10 regression - daemon status command appears
    type: regex-match
    target: stdout-transcript
    pattern: 'autonomous-dev daemon status'
  - id: A-14
    description: zero credential-pattern matches across full transcript (AC-08 gate)
    type: credential-scan-clean
    target: stdout-transcript
  - id: A-15
    description: total wall-clock under 12 minute budget
    type: wall-clock-budget
    expected_max_seconds: 720
  - id: A-16
    description: deterministic replay - byte-identical state file (modulo timestamps and handles)
    type: replay-determinism
    state_file: ~/.autonomous-dev/wizard-state.json
    filter: 'del(.. | .timestamp?, .last_dry_run_at?, .cred_proxy_handle?, .started_at?, .completed_at?, .captured_at?)'
---

# AC-07 Full-Flow Extended E2E

## Setup

1. Materialize the `ts-greenfield` fixture as a fresh repo under a sandbox
   `~/.autonomous-dev/` directory.
2. Install the mock CLI shim (see `tests/setup-wizard/mocks/autonomous-dev`)
   on PATH ahead of the real CLI so cred-proxy / plugin / firewall / deploy
   calls are intercepted.
3. Pre-seed `wizard-state.json` such that phases 1-7 all show `status:
   complete` (the inline phases run as smoke checks that exercise the
   real bash, but their network-touching steps are mocked).

## Walk

1. Invoke `autonomous-dev` setup-wizard skill from start.
2. Inline phases 1-7 run normally with mocked external commands.
3. Orchestrator iterates `PHASE_REGISTRY=(08 11 12 13 14 15 16)`:
   - Phase 8: operator accepts; emits `complete`.
   - Phase 11: operator skips (skip predicate or explicit skip flag);
     emits `skipped`.
   - Phase 12: operator skips; emits `skipped`.
   - Phases 13/14/15: operator accepts; emits `complete`.
   - Phase 16: operator skips (or feature flag is off); emits `skipped`.
4. Orchestrator emits the phases-17-19 deferral notice exactly once.
5. Inline phases 9 and 10 run; phase 10 renders the per-phase summary
   table.
6. Wizard exits 0.

## Determinism

A second run in a fresh sandbox must produce a byte-identical state file
under the documented `jq` filter (timestamps and re-issued handle IDs
excluded). Any drift between runs auto-fails this case.

## Notes

- Real GitHub API, cloud APIs, Slack/Linear/Jira, and TDD-024 are all
  mocked. This case proves module composition and state-machine
  behavior; per-phase external integrations are validated by each
  phase's own eval suite.
- The wall-clock budget (12 min) accounts for phase 12's probe-PR
  poll-loop sleep ceiling even when mocked.
