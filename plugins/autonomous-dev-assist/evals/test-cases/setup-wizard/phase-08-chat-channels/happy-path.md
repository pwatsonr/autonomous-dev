---
phase: 8
case_type: happy-path
expected_outcome: complete
fixture_repo: tests/fixtures/setup-wizard/repos/local-only
fixture_token: tests/fixtures/setup-wizard/tokens/discord-happy.env
operator_inputs:
  enable_discord: y
  enable_slack: n
  discord_bot_token: fake-but-valid-bot-token-XXXXXXX
  discord_webhook_url: https://discord.com/api/webhooks/00/test
assertions:
  - id: A-1
    description: verify-line in wizard.log
    type: log-line
    pattern: '"phase":8,"step":"verify","status":"completed"'
  - id: A-2
    description: token-leak sweep across 4 streams
    type: regex-no-match
    pattern: 'fake-but-valid-bot-token-XXXXXXX'
    target: [stdout, stderr, wizard.log, transcript]
  - id: A-3
    description: SIGHUP delta = 1
    type: counter-delta
    target: daemon-hup-counter
    expected: 1
  - id: A-4
    description: intake.discord.enabled persisted
    type: config-equals
    key: intake.discord.enabled
    expected: true
  - id: A-5
    description: env-var-name pointer (not literal token)
    type: config-equals
    key: intake.discord.webhook_env
    expected: DISCORD_WEBHOOK_URL
---

# Setup
- Operator config: empty intake section.
- Fixture mocks: discord users.@me returns 200 + bot:true; webhook returns 204.

# Run
1. `autonomous-dev wizard --phase 8` against the fixture.
2. Operator enables Discord with valid token + webhook.

# Expected
- All 5 assertions pass.
- phases.08.status == "complete".
- secrets.env contains `DISCORD_BOT_TOKEN=…` and `DISCORD_WEBHOOK_URL=…` (mode 0600).
- Regex `fake-but-valid-bot-token-XXXXXXX` returns 0 matches against
  stdout, stderr, wizard.log, and the eval transcript.
