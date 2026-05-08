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
`coverageThreshold` once SPEC-030-1-05 lands.
