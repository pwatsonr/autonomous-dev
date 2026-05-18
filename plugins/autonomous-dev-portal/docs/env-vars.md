# Portal Environment Variables

This document is the canonical reference for environment variables that
affect `@autonomous-dev/portal` runtime behavior. Variables are grouped by
the SPEC / PRD that introduced them.

## Branding (PRD-018 / SPEC-035-1-04)

### `PORTAL_WORDMARK_BRACKETS`

| Property        | Value                                                                 |
|-----------------|-----------------------------------------------------------------------|
| Default         | `"1"`                                                                 |
| Accepted values | `"0"` \| `"1"`                                                        |
| Consumer        | `server/components/brand-wordmark.tsx` (`BrandWordmark`)              |

Renders the `[` `]` bracket motif around the wordmark. Set to `0` if
OQ-02 (wordmark IP) resolves REPLACE — operators can drop the brackets
without a redeploy and the rest of the brand surface (mark, color
tokens) stays intact.

The component reads the variable at render time so a process restart
is sufficient to apply a change; no rebuild is required.

## Security (PR #312)

### `PORTAL_TEST_MODE`

| Property        | Value                                                                 |
|-----------------|-----------------------------------------------------------------------|
| Default         | unset                                                                 |
| Accepted values | `"1"` \| `"true"` \| `"yes"` (case-insensitive) to enable; anything else leaves it off |
| Consumer        | `server/security/csrf-wiring.ts` (`isTestModeEnabled`)                |

Opt-in flag that allows the CSRF middleware to honor `X-Cypress-Test: 1`
as a bypass for end-to-end test runs. Read **once at startup**; a daemon
restart is required to change it in either direction.

**Never set this in production.** See
[`docs/security/CSRF-TEST-MODE-BYPASS.md`](./security/CSRF-TEST-MODE-BYPASS.md)
for the threat model, defense-in-depth posture, verification steps,
and per-test-runner setup instructions.
