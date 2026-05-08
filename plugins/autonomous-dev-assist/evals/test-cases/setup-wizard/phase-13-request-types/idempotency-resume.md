---
phase: 13
case_type: idempotency-resume
expected_outcome: complete
sub_cases:
  - id: A
    description: kill-mid-prompt resume; hotfix already enabled
    setup:
      - run wizard --phase 13
      - SIGTERM after operator enables hotfix, before exploration prompt
      - wizard-checkpoint.json records phases.13.in-progress with current step
    re_run:
      - phase resumes via WIZARD_RESUME_STEP
      - hotfix already-enabled (not re-prompted)
      - exploration prompt shown
    expected:
      - re_prompt_for_hotfix: false
      - exploration_prompt_emitted: true
  - id: B
    description: hook re-add no-op (idempotent on (point, path) collision)
    setup:
      - hook hooks.code-pre-write.policy-check is already in config
      - registered with daemon at the same handler_path
    operator_inputs:
      add_same_hook: y
      confirmation: "yes"
    expected:
      - hooks_add_returns: "already registered with same handler_path"
      - hooks_registry_size_delta: 0
      - phase_exit_status: complete
  - id: C
    description: full re-run already-complete; module body not entered
    setup:
      - wizard-state.json shows phases.13.status=complete
      - all catalog entries either explicitly disabled or fully configured
      - all stored hooks match registered hooks
    expected:
      - phase_13_probe_emits: already-complete
      - module_body_entered: false
      - per_type_prompts_shown: 0
---

# Setup
- Sub-A: drive the phase to mid-prompt (after hotfix enabled, before
  exploration); send SIGTERM; capture checkpoint state. Re-run.
- Sub-B: pre-populate config + daemon with same hook; re-add identical
  (point, path) pair.
- Sub-C: full prior-completion fixture state.

# Run
- `autonomous-dev wizard --phase 13` per sub-case.

# Expected
- Sub-A: orchestrator resumes from the checkpointed step; hotfix is
  not re-prompted; exploration prompt is reached.
- Sub-B: `autonomous-dev hooks add` returns "already registered with
  same handler_path"; phase treats as success; hooks-registry size
  unchanged; phase exits complete.
- Sub-C: `phase-13-probe` emits "already-complete"; module body not
  executed; orchestrator marks `phases.13.status=complete`; transcript
  shows zero per-type prompts.
