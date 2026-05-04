# SPEC-030-3-02: `bin/reload-plugins.js` Operator Entry Point

## Metadata
- **Parent Plan**: PLAN-030-3 (TDD-019 plugin-reload CLI closeout)
- **Parent TDD**: TDD-030 §7.2, §7.3
- **Tasks Covered**: TASK-002 (bin/reload-plugins.js + bin map + chmod)
- **Estimated effort**: 0.25 day
- **Depends on**: SPEC-030-3-01 (dispatcher exists) merged
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-3-02-reload-plugins-bin-wrapper.md`

## Description

Create the operator-facing entry point for the plugin-reload CLI: a single shebang Node script at `plugins/autonomous-dev/bin/reload-plugins.js` that imports the dispatcher (SPEC-030-3-01) and maps its return value to `process.exit`.

Per TDD-030 §7.2 and PRD-016 FR-1660, this script is the **only** place `process.exit` is permitted in PLAN-030-3 (FR-1660 forbids `process.exit` under `**/tests/**` only — `bin/` is permitted). The script is intentionally tiny (~20 lines) so the testable logic stays in the dispatcher.

The `package.json`'s `bin` map gains a `"reload-plugins"` entry per TDD-030 OQ-30-05 → Yes, so users who install the plugin via npm get a `reload-plugins` command on their `PATH`.

The executable bit is preserved across checkouts via `.gitattributes` (preferred) plus a defensive `npm prepare` hook. Both belt and braces because Windows checkouts strip the bit.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/bin/reload-plugins.js` | Create | Shebang Node script; imports `dispatch` from compiled `intake/cli/dispatcher.js` |
| `plugins/autonomous-dev/package.json` | Modify | Add `"bin": { "reload-plugins": "./bin/reload-plugins.js" }` (or extend existing `bin` block) |
| `plugins/autonomous-dev/.gitattributes` | Create or extend | Add `bin/reload-plugins.js text eol=lf` and ensure executable mode |
| `plugins/autonomous-dev/bin/reload-plugins.test.ts` | Create | One smoke test: spawn the script with no args, expect exit 2 + usage on stderr |

If `package.json` already has a `bin` block, **merge** the new entry rather than overwriting. If `.gitattributes` already exists, append the new line — do not rewrite the file.

## Implementation Details

### `bin/reload-plugins.js`

```js
#!/usr/bin/env node
// reload-plugins: operator entry point for `plugin reload <name>`.
// All testable logic lives in intake/cli/dispatcher.ts.
// Per PRD-016 FR-1660, this is the ONLY file in PLAN-030-3 that calls process.exit.

'use strict';

// The dispatcher is shipped as compiled JS by the package's build step.
// During development the .ts source compiles to dist/cjs/intake/cli/dispatcher.js
// (or whatever the existing build emits — verify before merging).
const path = require('node:path');
const { dispatch } = require(path.join(__dirname, '..', 'intake', 'cli', 'dispatcher.js'));

dispatch(process.argv.slice(2))
  .then((code) => {
    // Cap exit codes to the documented contract {0, 1, 2}.
    const safe = code === 0 || code === 1 || code === 2 ? code : 2;
    process.exit(safe);
  })
  .catch((err) => {
    // Defense-in-depth: any uncaught throw maps to exit 2.
    // The dispatcher already catches its own throws; this branch only fires
    // if the require()/import itself fails.
    // eslint-disable-next-line no-console
    console.error(`reload-plugins: fatal error: ${err && err.message ? err.message : String(err)}`);
    process.exit(2);
  });
```

Notes on the import path:
- The repo's existing build pipeline emits `.ts` files to `.js`. The exact output dir (`dist/`, `lib/`, or in-place compilation) is project-dependent. Read the `package.json` `main`/`build` scripts before authoring the require path.
- If the project ships TypeScript directly via a `loader` (e.g., `tsx`, `ts-node`), the shebang line becomes `#!/usr/bin/env -S node --loader tsx` (or similar) and the import becomes `intake/cli/dispatcher.ts`. **Verify which mode the repo uses** before authoring; default to compiled CJS if unsure.

### `package.json` `bin` map

```json
{
  "name": "@autonomous-dev/plugin",
  "bin": {
    "reload-plugins": "./bin/reload-plugins.js"
  }
}
```

If `bin` is already an object with other entries, merge:

```json
{
  "bin": {
    "existing-cmd": "./bin/existing.js",
    "reload-plugins": "./bin/reload-plugins.js"
  }
}
```

If `bin` is a string (single-command shorthand), convert to an object containing both the existing string-form value and the new entry.

### `.gitattributes`

Append (or create with) this single line:

```
bin/reload-plugins.js text eol=lf
```

Git's `text eol=lf` ensures consistent line endings; the executable mode itself is preserved by Git's index (`100755` vs `100644`) once `chmod +x bin/reload-plugins.js` is run before the first commit.

For Windows checkouts the bit is lost. The defensive `npm prepare` script in `package.json` handles that:

```json
{
  "scripts": {
    "prepare": "node -e \"try{require('fs').chmodSync('./bin/reload-plugins.js', 0o755)}catch{}\""
  }
}
```

If `prepare` already exists, **chain** the new chmod onto it with `&&`. Use the inlined `node -e` form so no shell-specific syntax (e.g., `chmod +x`) is needed — that command works identically on Linux, macOS, and Git-Bash on Windows. Do NOT use raw `chmod +x` (Windows `cmd.exe` lacks it).

### `bin/reload-plugins.test.ts`

```ts
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'bin', 'reload-plugins.js');

describe('bin/reload-plugins.js', () => {
  it('exits 2 with a usage string when invoked with no arguments', () => {
    const result = spawnSync('node', [SCRIPT], { encoding: 'utf-8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage:/);
  });

  it('exits 2 with usage on an unknown command', () => {
    const result = spawnSync('node', [SCRIPT, 'foo', 'bar'], { encoding: 'utf-8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage:/);
  });
});
```

Constraints:
- The test spawns `node <script>` rather than relying on the executable bit so it runs identically on Windows.
- The test does NOT call `process.exit` itself (PRD-016 FR-1660).
- Each `it()` ≤ 1500 ms (cold-start `node` is ~300 ms on most hosts).
- The test does NOT spawn a daemon — that is the integration test's job (SPEC-030-3-03).

## Acceptance Criteria

- AC-1: `plugins/autonomous-dev/bin/reload-plugins.js` exists, begins with `#!/usr/bin/env node`, and is < 30 lines including comments.
- AC-2: The script imports `dispatch` from the dispatcher's compiled output (or the `.ts` source if the project ships TS directly).
- AC-3: The script calls `dispatch(process.argv.slice(2))`, awaits its result, and calls `process.exit(code)` with the result clamped to `{0, 1, 2}`.
- AC-4: An uncaught `require()`/import error maps to `process.exit(2)` and writes a one-line message to stderr.
- AC-5: `git ls-files --stage bin/reload-plugins.js` reports mode `100755` after the script is committed (verified locally before the first push) **OR** `package.json#scripts.prepare` runs `chmod 0o755` on the file at install time.
- AC-6: `plugins/autonomous-dev/package.json` declares `bin["reload-plugins"] = "./bin/reload-plugins.js"`. If a previous `bin` block existed, the new entry is merged in, not replacing it.
- AC-7: `.gitattributes` contains the line `bin/reload-plugins.js text eol=lf`.
- AC-8: `node ./bin/reload-plugins.js` (no args) exits 2 and writes a string containing `Usage:` to stderr.
- AC-9: `node ./bin/reload-plugins.js foo bar` exits 2 and writes `Usage:` to stderr.
- AC-10: `bin/reload-plugins.test.ts` runs under `npx jest --runInBand` and both `it()` cases pass within 1500 ms each.
- AC-11: `grep -E "process\\.exit" bin/reload-plugins.js` returns exactly two hits (the success path and the catch path). `grep -RE "process\\.exit" plugins/autonomous-dev/bin/` returns only those two hits across the bin/ tree.
- AC-12: `tsc --noEmit` from the autonomous-dev plugin still passes (the new `.test.ts` and `package.json` changes do not break compilation).
- AC-13: After `npm install` from a fresh clone, the `prepare` hook makes the script executable (verify: `stat -c '%a' bin/reload-plugins.js` returns `755`). On Windows this is acceptable to be `644` because the user invokes via `node bin/reload-plugins.js` or via the `npm bin` shim.

### Given/When/Then

```
Given the bin/reload-plugins.js wrapper exists and the dispatcher returns 0
When the script is invoked as `node bin/reload-plugins.js plugin reload my-plugin`
Then the process exits with code 0
And no error is written to stderr

Given the bin/reload-plugins.js wrapper exists
When the script is invoked with no arguments
Then the process exits with code 2
And stderr contains the substring "Usage:"

Given the bin/reload-plugins.js wrapper exists
When the script is invoked with an unknown command (`foo bar`)
Then the process exits with code 2
And stderr contains the substring "Usage:"

Given the package is installed via npm
When the user runs `reload-plugins` from a shell with `node_modules/.bin` on PATH
Then the wrapper script executes (the bin entry resolves correctly)
And the same exit-code contract applies
```

## Test Requirements

The single test file `bin/reload-plugins.test.ts`:
1. Passes under `npx jest --runInBand`.
2. Spawns `node <script>` (does NOT rely on the executable bit, for Windows compatibility).
3. Asserts on `result.status` (exit code) and `result.stderr` (usage string).
4. Does NOT call `process.exit` (PRD-016 FR-1660).
5. Each `it()` budget: ≤ 1500 ms.

## Implementation Notes

- **Compiled-vs-source import path**: this is the spec's biggest unknown. Read the autonomous-dev plugin's `package.json` `main`, `module`, and `exports` fields, plus any `tsconfig.json`'s `outDir`, BEFORE authoring the require path in the wrapper. If the package ships compiled JS, point at the compiled file. If it ships TS via a runtime loader, point at the `.ts` source and adjust the shebang line.
- **`process.exit` count**: AC-11 says exactly two hits in `bin/reload-plugins.js`. If the implementer factors out a helper (`exit(code)`), the count rule still applies to the file as a whole.
- **Exit-code clamping**: AC-3's clamping to `{0,1,2}` is defensive — the dispatcher's contract already guarantees this set, but a future bug in the dispatcher should not produce `process.exit(127)` from this wrapper.
- **No daemon spawn in the test**: the integration test in SPEC-030-3-03 is the only place a daemon is started. This file's tests are about argv routing only.
- **`.gitattributes` line ordering**: append at the end of the file, do not rewrite. If a prior maintainer added rules, those are intentional.
- **`prepare` script chaining**: if `package.json#scripts.prepare` already exists for, say, husky setup, chain with ` && ` rather than replacing it. A wholesale replacement risks breaking unrelated tooling.
- **Windows-friendly chmod**: the `node -e "..chmodSync.."` form works without a POSIX shell. Do NOT use `chmod +x` directly — `cmd.exe` lacks it.

## Rollout Considerations

- **Forward**: after merge and a release, `npm i @autonomous-dev/plugin` puts `reload-plugins` on the user's `PATH`. No user is expected to depend on this CLI today (PLAN-030-3 §10.2), so there is no compatibility constraint.
- **Rollback**: `git revert` the merge commit. The script and bin entry vanish; existing daemons keep running unaffected.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Compiled-vs-source import path wrong | Medium | High (script crashes on first run) | Read `package.json` `main`/`exports` BEFORE authoring; the `.test.ts` smoke test catches this in CI |
| Executable bit lost on Windows checkout | Medium | Low | `.gitattributes` + `prepare`-hook chmod belt-and-braces; tests spawn `node <script>` directly |
| `npm prepare` already exists and is destructively replaced | Low | Medium | Chain with `&&`; reviewer compares pre/post script value |
| Exit code clamping accidentally hides a real dispatcher bug | Low | Low | The clamp is defense-in-depth; primary contract is enforced by SPEC-030-3-01 unit tests |
| `bin` map collision with another plugin's `reload-plugins` command | Low | Low | The name is namespaced by the package; `npx -p @autonomous-dev/plugin reload-plugins` is the unambiguous form |
| Test spawn time > 1500 ms on cold CI hosts | Low | Low | Use `runInBand` to avoid concurrent node-spawn pressure; bump to 3000 ms with a PR note if observed |
| Operators expect `--help` flag (we only produce usage on bad input) | Low | Low | Out of scope; PLAN-030-3 ships exactly the §7.3 contract — `--help` is a follow-up |
