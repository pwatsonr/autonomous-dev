# server/auth/__tests__

Jest test suite for the portal's auth surface. Discovered by the
portal-local `jest.config.cjs` and run under the autonomous-dev plugin's
parent jest gate (PRD-016 G-02).

## Why both bun and jest

The portal ships `bun test` for everything else. These auth tests are
jest-only because PRD-016 G-02 requires `npx jest --runInBand` to be
the canonical CI gate. The two runners do not overlap on these files —
`bun test` ignores `__tests__/**/*.test.ts` here.

## Mocking strategy

See TDD-030 §5.4 (Option A) and §5.5:
- Tailscale daemon -> mock at the client interface boundary
- OAuth provider HTTP -> hand-rolled fetch mock
- Filesystem -> real fs in `mkdtempSync`
- Network -> real `http.createServer` bound to `127.0.0.1`
- Time -> `jest.useFakeTimers({ doNotFake: ['nextTick'] })`

## Coverage

`server/auth/**/*.ts` >= 90% line coverage, enforced via
`coverageThreshold` (SPEC-030-1-05). The gate is lines-only —
branches/functions/statements are not enforced (PRD-016 R-04 commits
only to lines).

## Final Coverage Numbers

These numbers are captured from CI on the merge commit. The threshold is
the floor we shipped at; the actual number is what the gate enforces.

| Module | Threshold | Notes |
|--------|-----------|-------|
| `cidr-utils.ts` | 90% | Pure functions; expected >= 95% |
| `pkce-utils.ts` | 90% | Pure crypto; expected >= 95% |
| `localhost-auth.ts` | 90% | |
| `network-binding.ts` | 90% | |
| `security/binding-enforcer.ts` | 90% | (Lives outside `server/auth/`; not under this glob) |
| `tailscale-client.ts` | 90% | Mocked at boundary |
| `tailscale-auth.ts` | 90% | |
| `oauth/oauth-auth.ts` | 90% | |
| `oauth/oauth-bootstrap.ts` | 90% | |
| `oauth/oauth-state.ts` | 90% | |
| `oauth/token-exchange.ts` | 90% | |
| `session/session-manager.ts` | 90% | |
| `session/session-cookie.ts` | 90% | |
| `session/file-session-store.ts` | 90% | |
| `security/csrf-protection.ts` | 90% (separately scoped) | CSRF middleware lives at `server/security/`, outside `server/auth/**` glob |

CI report: see the merge commit's coverage summary.

## Istanbul-ignore Rationale

If any `/* istanbul ignore next */` comments are added to production
auth code (per TDD-030 §5.3), record each one here with a one-line
justification. An empty section is a valid result.

| File | Line | Rationale |
|------|------|-----------|
| _(none)_ | — | — |

## Vulnerability Disclosure

No vulnerabilities were surfaced by PLAN-030-1 authoring. The CSRF
suite confirmed cross-origin POST rejection and Origin/Referer fence
behavior; the session suite confirmed idle/absolute timeout
separability and session-fixation defense; the OAuth suite confirmed
state replay rejection and typed token-exchange failure surfaces.

| Finding | Severity | Hotfix PR |
|---------|----------|-----------|
| _(none)_ | — | — |

