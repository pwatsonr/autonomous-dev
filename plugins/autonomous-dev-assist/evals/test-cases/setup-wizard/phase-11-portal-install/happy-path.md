---
phase: 11
case_type: happy-path
expected_outcome: complete
operator_inputs:
  wizard.portal_install_opt_in: "true"
  port: 8788
  bind: 127.0.0.1
  admin_password: WizardTest!Password-XYZ123
assertions:
  - id: A-1
    description: /healthz 200 within 10s
    type: http-200-poll
    url: http://127.0.0.1:8788/healthz
    poll_count: 5
    poll_interval_s: 2
  - id: A-2
    description: /api/auth/login admin returns ok:true
    type: http-json
    url: http://127.0.0.1:8788/api/auth/login
    expected: '{"ok": true}'
  - id: A-3
    description: portal.bind_address default 127.0.0.1
    type: config-equals
    key: portal.bind_address
    expected: 127.0.0.1
  - id: A-4
    description: plaintext password no-leak (4 streams)
    type: regex-no-match
    pattern: 'WizardTest!Password-XYZ123'
    target: [stdout, stderr, wizard.log, transcript]
  - id: A-5
    description: bcrypt cost 12
    type: regex-match
    pattern: '^\$2[ab]\$12\$'
    target: portal-account-hash
---

# Setup
- Operator opts in via `wizard.portal_install_opt_in=true`.
- Default port 8788, default bind 127.0.0.1.

# Run
- `autonomous-dev wizard --phase 11`.
- Operator supplies admin password `WizardTest!Password-XYZ123`.

# Expected
- Portal binary installs; /healthz responds 200 within 10s with matching build_id.
- Both admin login probes return ok:true.
- bcrypt hash prefix `$2a$12$` or `$2b$12$`.
- Plaintext password appears 0 times across the 4 streams.
