# SPEC-011-1-04: Help Text, Bats Tests, and Jest Tests

## Metadata
- **Parent Plan**: PLAN-011-1
- **Tasks Covered**: Task 9 (help text and error UX), Task 10 (bash dispatcher tests), Task 11 (CLI adapter Jest tests)
- **Estimated effort**: 10.5 hours

## Description
Author the comprehensive help text exposed at every layer (top-level, request subcommand, per-subcommand) ensuring consistent format across both bash dispatcher and TS CLI adapter. Implement the bats test suite covering the bash dispatcher's validation, routing, TTY detection, and adversarial-input pass-through. Implement the Jest test suite covering the TS adapter's argument parsing, validation, IncomingCommand construction, and IntakeRouter integration with mocked dependencies.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `bin/autonomous-dev.sh` | Modify | Add `print_request_help` (already stubbed in SPEC-011-1-01); add per-subcommand help routing |
| `tests/bats/test_cli_dispatcher.bats` | Create | Bats test suite for the bash layer |
| `intake/adapters/cli_adapter.test.ts` | Create (extend) | Jest test suite for the TS adapter |
| `package.json` | Modify | Add `jest` test script + dev dependencies |

## Implementation Details

### Task 9: Help Text

#### Top-level help (already in SPEC-011-1-01 Task 1)

`autonomous-dev request --help` prints the full subcommand list (verbatim from SPEC-011-1-01).

#### Per-subcommand help

Each of the 10 subcommands supports `--help`. The bash dispatcher passes `--help` through to the Node adapter, which `commander.js` handles natively.

Example outputs:

`autonomous-dev request submit --help`:
```
Usage: autonomous-dev request submit <description> [options]

Submit a new request.

Arguments:
  description           Free-text description of the work

Options:
  --repo <repo>         Target repository (org/repo or absolute path)
  --priority <priority> Priority: high|normal|low (default: "normal")
  --deadline <iso8601>  Deadline (ISO 8601 timestamp)
  --type <type>         Request type (default: "feature")
  -h, --help            Display help for command
```

`autonomous-dev request status --help`:
```
Usage: autonomous-dev request status <request-id>

Show current status of a request.

Arguments:
  request-id   The request identifier (REQ-NNNNNN)

Options:
  -h, --help   Display help for command
```

#### Error message format

All errors follow the format:
```
ERROR: <one-line message>
```

Followed (when applicable) by:
```
Run 'autonomous-dev request <subcmd> --help' for usage.
```

The "Run ... --help" line is added only when the error is a USAGE error (missing arg, invalid format) — not for system errors (file not found, no node).

### Task 10: Bats Test Suite

File: `tests/bats/test_cli_dispatcher.bats`

```bash
#!/usr/bin/env bats

setup() {
  PLUGIN_DIR="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  DISPATCHER="${PLUGIN_DIR}/bin/autonomous-dev.sh"
}
```

#### Test groups (≥30 cases total)

**Group 1: `request` command routing (4 cases)**
- `@test "request command without args prints help"` — exit 0, stdout contains "Usage:"
- `@test "request --help prints help"` — exit 0
- `@test "request unknown-subcmd exits 1"` — exit 1, stderr contains "Unknown request subcommand"
- `@test "request submit routes to node delegate"` — mock node, verify it was invoked with argv `[submit, "..."]`

**Group 2: Request ID validation (10 cases)**
Use the test matrix from SPEC-011-1-01 Task 2 verbatim. Run via the `validate_request_id` function (sourced into the test harness).

**Group 3: Priority validation (5 cases)**
- `@test "priority high accepted"` — function returns 0
- `@test "priority normal accepted"` — function returns 0
- `@test "priority low accepted"` — function returns 0
- `@test "priority urgent rejected"` — exit 1, stderr contains "valid: high, normal, low"
- `@test "priority empty rejected"` — exit 1

**Group 4: TTY/color detection (6 cases)**
- `@test "NO_COLOR=1 disables color"` — set env, run `detect_color`, returns `0`
- `@test "no-color flag disables color"` — pass `--no-color`, returns `0`
- `@test "TERM=dumb disables color"` — set env, returns `0`
- `@test "non-TTY stdout disables color"` — pipe to `cat`, returns `0`
- `@test "TTY stdout enables color"` — needs script(1) wrapper or skip on CI
- `@test "no env vars enables color in TTY"` — same as above

**Group 5: Adversarial input pass-through (6 cases)**
For each adversarial input from SPEC-011-1-02, mock node with a wrapper that prints `process.argv`:
- `@test "command substitution treated as literal"` — argv contains literal `$(rm -rf /)`
- `@test "command chain treated as literal"` — argv contains literal `;rm -rf /`
- `@test "backtick treated as literal"` — argv contains literal backticks
- `@test "pipe treated as literal"` — argv contains literal `|`
- `@test "path traversal preserved"` — argv contains literal `../../../etc/passwd`
- `@test "newline preserved"` — argv contains literal `\n`

**Group 6: Subprocess error handling (3 cases)**
- `@test "missing node exits 2"` — temporarily PATH out node, exit 2
- `@test "missing cli_adapter.js exits 2"` — temporarily rename file, exit 2
- `@test "node nonzero exit propagates"` — mock node exiting 7, dispatcher exits 7

#### Test framework setup

Add to `package.json` scripts:
```json
{
  "test:bats": "bats tests/bats/"
}
```

CI matrix tests on macOS (bash 3.x baseline + 5.x via brew) and Linux (Ubuntu bash 5.x).

### Task 11: Jest Test Suite

File: `intake/adapters/cli_adapter.test.ts`

```typescript
import { jest } from '@jest/globals';
import { mockIntakeRouter } from '../core/__mocks__/router';
```

#### Test groups (≥40 cases total)

**Group 1: Subcommand registration (10 cases — one per subcommand)**
For each: invoke commander with valid args, verify `router.route` was called with the expected `IncomingCommand` shape.

**Group 2: IncomingCommand construction (10 cases)**
For each subcommand: verify `channelType: 'cli'`, `commandType` matches subcommand, `requestId` set when expected, `payload` matches expected shape, `source.operatorId` set.

**Group 3: Validator behavior (15 cases)**
- Deadline parser: 5 cases (valid future, valid Z, valid offset, past, malformed)
- Repo parser: 4 cases (org/repo, absolute existing, absolute missing, malformed)
- Type parser: 5 cases (each of 5 valid types) + 1 invalid case
- Priority: covered by bash; verify TS adapter trusts bash output

**Group 4: Error handling (5 cases)**
- `InvalidArgumentError` exits 1
- `CommanderError` exits with its `.exitCode`
- Other errors exit 2
- Stderr contains "ERROR: " prefix
- Help output is on stdout (not stderr)

#### Mocks and fixtures

`intake/core/__mocks__/router.ts`:
```typescript
export const mockIntakeRouter = {
  route: jest.fn(async (cmd) => ({ ok: true, message: 'mocked' })),
};
```

Fixtures live in `tests/fixtures/cli/`:
- `valid-iso-deadlines.json` — array of valid date strings
- `invalid-iso-deadlines.json` — array of invalid date strings + expected error fragments

### Add to `package.json`:

```json
{
  "scripts": {
    "test:cli": "jest intake/adapters/cli_adapter.test.ts",
    "test": "npm run test:cli && npm run test:bats"
  },
  "devDependencies": {
    "jest": "^29.x",
    "@types/jest": "^29.x",
    "ts-jest": "^29.x"
  }
}
```

## Acceptance Criteria

- [ ] `autonomous-dev request --help` shows the verbatim text from SPEC-011-1-01
- [ ] `autonomous-dev request submit --help` shows commander-generated help with all options
- [ ] All 10 subcommands have `--help` working
- [ ] Error messages follow the documented format (`ERROR: ...` + optional usage line)
- [ ] Bats suite has ≥30 test cases organized by the 6 groups
- [ ] Bats suite passes on macOS bash 5.x and Ubuntu bash 5.x
- [ ] Jest suite has ≥40 test cases organized by the 4 groups
- [ ] Jest suite passes with mocked IntakeRouter
- [ ] Coverage on `cli_adapter.ts` ≥90%
- [ ] CI runs both test suites; failures block merge

## Dependencies

- `bats` test framework — operator-installed via brew/apt; CI image includes it
- `jest` ^29.x + `ts-jest` ^29.x (dev deps)
- The completed implementations from SPEC-011-1-01, SPEC-011-1-02, SPEC-011-1-03

## Notes

- Bash 3.x compatibility (default macOS) is NOT a target — the dispatcher already requires bash 4+ per its strict-mode use.
- TTY-required test cases (Group 4 cases 5-6) skip on CI unless `script(1)` is available; documented as a known gap.
- The mocked `IntakeRouter` returns a sentinel result; tests do NOT exercise the router itself — that's TDD-008's responsibility.
- Adversarial-input tests (Group 5) are the security backstop. If shellcheck and these tests both pass, command injection is prevented.
- Help text format is owned by commander.js; we don't customize beyond what's in `.description()` and `.option()` calls. Future style changes are a separate concern.
