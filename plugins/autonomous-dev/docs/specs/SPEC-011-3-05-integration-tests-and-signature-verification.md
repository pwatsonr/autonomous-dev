# SPEC-011-3-05: Integration Tests with Discord API Mocks and Signature Verification

## Metadata
- **Parent Plan**: PLAN-011-3
- **Tasks Covered**: Task 9 (Jest unit tests >90% coverage), Task 10 (E2E integration with real Discord guild)
- **Estimated effort**: 9 hours

## Description
Cover the Discord bot service with two test layers: (1) unit/integration tests using mocked discord.js Client and REST so the full lifecycle (start, register, dispatch, drain, reconnect) runs deterministically in CI; (2) an end-to-end test against a real Discord test guild that exercises the connection, command registration, an actual interaction, and graceful shutdown. Add interaction signature verification tests to confirm that any HTTP-mode webhooks (if/when introduced) reject forged payloads.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/__tests__/adapters/discord/discord_service.test.ts` | Create | Mocked-Client lifecycle suite (>90% coverage on `main.ts`) |
| `intake/__tests__/adapters/discord/signature_verification.test.ts` | Create | Ed25519 signature verification suite |
| `intake/__tests__/integration/discord_service_e2e.test.ts` | Create | Real-Discord E2E suite (gated by env var) |
| `intake/__tests__/helpers/discord_mocks.ts` | Create | Reusable mocks: Client, REST, Interaction factories |

## Implementation Details

### Test Helper — `discord_mocks.ts`

Export factories that produce strongly-typed test doubles:

```ts
export function makeMockClient(overrides?: Partial<Client>): jest.Mocked<Client>;

export function makeMockREST(): jest.Mocked<REST>;

export function makeChatInputInteraction(opts: {
  commandName: string;
  options?: Record<string, string | number | boolean>;
  guildId?: string;
  userId?: string;
}): jest.Mocked<ChatInputCommandInteraction>;

export function makeButtonInteraction(opts: {
  customId: string;
  guildId?: string;
  userId?: string;
}): jest.Mocked<ButtonInteraction>;

export function makeModalInteraction(opts: {
  customId: string;
  fields: Record<string, string>;
}): jest.Mocked<ModalSubmitInteraction>;
```

Each factory wires `.reply`, `.deferReply`, `.editReply`, `.followUp`, and `.deferUpdate` as `jest.fn()` returning resolved promises. Tests assert which method was called and with what payload.

The mock `Client` exposes a `__emit(event, ...args)` test-only method to fire gateway events synchronously.

### Lifecycle Suite — `discord_service.test.ts`

Group structure:

1. **Configuration validation**
   - Each row in the SPEC-011-3-01 validation table → 1 test asserting the exact error message.
   - Token redaction: any thrown error has `botToken` replaced with `[REDACTED]`.

2. **Startup**
   - `start()` resolves when `ready` fires within timeout.
   - `start()` rejects with `StartupError` and calls `client.destroy()` on ready timeout.
   - Slash commands registered via REST `put` to the correct route based on `guildId` presence.
   - Registration failure (e.g., 50001) surfaces the documented actionable message.

3. **Interaction dispatch**
   - ChatInput → `adapter.handleInteraction` called once.
   - Button with valid `customId` → `adapter.handleReply` called with shape `{replyType: 'button', action, requestId}`.
   - Button with malformed `customId` → ephemeral error reply, no adapter call.
   - Modal with valid fields → `adapter.handleReply` called with `{replyType: 'clarification', message}`.
   - Modal with empty / >4000 char field → ephemeral error, no adapter call.
   - Unknown interaction type → `discord_unhandled_interaction_type` log, no throw.

4. **Rate limiting**
   - 30 interactions in the same guild succeed; the 31st is rejected with the ephemeral message.
   - DMs (no `guildId`) share a single bucket (verified by alternating two DM users).
   - Buckets idle > 10 min are evicted (use `jest.useFakeTimers`).

5. **Error formatting**
   - One test per row of the `replyError` table in SPEC-011-3-04.
   - Internal errors do NOT leak `err.message` to `interaction.followUp` payload (asserted by string match).

6. **Graceful shutdown**
   - `stop()` called with no in-flight → resolves immediately, exit code 0.
   - `stop()` with one in-flight that completes within drain → in-flight count at exit is 0.
   - `stop()` with stuck in-flight → resolves at drain timeout, exit code 124.
   - SIGTERM and SIGINT both call `stop()`.

7. **Reconnection**
   - `shardDisconnect` triggers reconnect loop; sequence of `delayMs` matches `[1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]` (use fake timers + spy on `sleep`).
   - `shutdownRequested = true` mid-wait short-circuits the loop.
   - Close code 4004 → exit 3, no reconnect attempts.
   - 10 failed attempts → exit 2.

Coverage target: ≥ 90% line coverage on `intake/adapters/discord/main.ts`. Enforced via `jest --coverage --coverageThreshold='{"intake/adapters/discord/main.ts":{"lines":90}}'` in the CI script.

### Signature Verification Suite — `signature_verification.test.ts`

Discord HTTP webhook signatures use Ed25519 (`X-Signature-Ed25519`, `X-Signature-Timestamp` headers). Even if the current bot service uses gateway (WebSocket) and not HTTP webhooks, this test fixture protects future HTTP entry points.

Tests:

| Test | Setup | Expectation |
|------|-------|-------------|
| `valid_signature_passes` | Generate keypair; sign `${timestamp}${body}`; submit | `verifyDiscordSignature` returns `true` |
| `tampered_body_fails` | Sign valid body, then mutate body before verify | returns `false` |
| `wrong_timestamp_fails` | Sign with timestamp T; submit with timestamp T+1 | returns `false` |
| `wrong_public_key_fails` | Sign with key A; verify with key B | returns `false` |
| `missing_signature_header_fails` | Submit without `X-Signature-Ed25519` | returns `false`, no throw |
| `replay_attack_fails` | Replay valid signature 6 minutes after timestamp | returns `false` (window = 5 min) |

If `verifyDiscordSignature` does not yet exist in the codebase, this spec adds it as a small pure module at `intake/adapters/discord/signature_verifier.ts` using `tweetnacl` (already in the dependency tree, common for Discord HTTP). If `tweetnacl` is not present, use `node:crypto` Ed25519 (Node ≥ 16.x).

### E2E Suite — `discord_service_e2e.test.ts`

Gated by `RUN_DISCORD_E2E === '1'` and the presence of test-guild env vars. Skip with `test.skip` when not configured.

Required env vars:

```
DISCORD_TEST_BOT_TOKEN
DISCORD_TEST_APPLICATION_ID
DISCORD_TEST_GUILD_ID
DISCORD_TEST_CHANNEL_ID
```

Scenarios:

1. **Full startup → registration → shutdown**: instantiate service with real config; assert `start()` resolves; assert all 10 commands appear via `rest.get(applicationGuildCommands(...))`; call `stop()`; assert clean exit.
2. **Live interaction**: post a slash command via the test bot's HTTP API or via a control channel message; assert the adapter received an `IncomingCommand` with the expected shape.
3. **Reconnection from forced disconnect**: call `client.destroy()` mid-session; assert the reconnect loop fires and the next interaction succeeds.
4. **SIGTERM mid-flight**: dispatch a long-running interaction (mock the adapter to delay 2s); send SIGTERM; assert the in-flight completes and the process exits 0 within `drainMs`.

E2E tests have a 60-second timeout each and run serially (`testEnvironment: 'node'`, `--runInBand`).

## Acceptance Criteria

- [ ] `discord_service.test.ts` achieves ≥ 90% line coverage on `main.ts` (enforced by CI threshold)
- [ ] All seven test groups in the lifecycle suite pass deterministically (zero flakes across 100 runs)
- [ ] `discord_mocks.ts` exports the documented factories with correct types; `tsc --noEmit` clean
- [ ] All six signature verification scenarios pass with correct boolean outcomes
- [ ] Replay attack window is exactly 5 minutes (300 seconds); the test asserts boundary at 299s pass / 301s fail
- [ ] E2E suite is fully skipped when `RUN_DISCORD_E2E !== '1'`, with no `describe.skip` left enabled inadvertently
- [ ] When `RUN_DISCORD_E2E=1` and env vars are set, all four E2E scenarios pass against a real Discord test guild
- [ ] No test logs contain raw bot tokens (assert via post-test grep on the captured stderr)
- [ ] Test files have no `any` types except in mock-builder utility code

## Dependencies

- SPEC-011-3-01..04 — all behaviors under test are defined in those specs.
- `jest`, `@types/jest` — assumed in `devDependencies`.
- `tweetnacl` (or `node:crypto` Ed25519 fallback) for signature tests.
- For E2E: a Discord test guild owned by the test bot. Setup is documented in `contrib/README-test-guild.md` (out of scope for this spec; reference only).

## Notes

- The 90% coverage target excludes branch coverage to avoid penalizing defensive `if (!x) throw` guards. Branch coverage of ≥ 75% is a soft target, not enforced.
- The signature suite intentionally lives in this spec even though gateway-mode bots do not use webhook signatures. Future work may add HTTP interactions endpoints (e.g., for outage fallback), and we want the verifier and tests in place from day one.
- E2E tests require a real Discord application and guild. CI runs only when the operator provides credentials via repo secrets; PR-from-fork builds skip the suite entirely. This trade-off prefers safety (no token exposure) over universal coverage.
- The token-redaction grep assertion at the end of the test run is the last line of defense against accidental leakage in log output. If it fails, the test bundle MUST fail even if all other assertions passed.
