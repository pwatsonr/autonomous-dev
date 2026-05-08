---
phase: 11
case_type: skip-with-consequence
expected_outcome: skipped
operator_inputs:
  wizard.portal_install_opt_in: unset
assertions:
  - id: A-1
    description: verbatim consequence text
    type: regex-match
    pattern: 'No browser pipeline view; CLI status remains'
    target: stdout
  - id: A-2
    description: phases.11.status == skipped
    type: state-equals
    key: phases.11.status
    expected: skipped
  - id: A-3
    description: portal.db not created
    type: file-absent
    path: ~/.autonomous-dev/portal.db
  - id: A-4
    description: portal.enabled == false
    type: config-equals
    key: portal.enabled
    expected: false
---

# Setup
- `wizard.portal_install_opt_in` unset (default-skip).

# Run
- `autonomous-dev wizard --phase 11`.

# Expected
- portal_install_default_skip exits 0; verbatim consequence emitted; phase
  status = "skipped"; no portal.db on disk.
