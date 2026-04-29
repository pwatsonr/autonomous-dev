# SPEC-014-3-04: Adversarial Security Tests

## Metadata
- **Parent Plan**: PLAN-014-3
- **Tasks Covered**: TASK-010 (Security Integration Tests), partial TASK-011 (regression coverage for monitoring)
- **Estimated effort**: 5 hours

## Description
The validators, sandbox, and audit logger from SPEC-014-3-01 through -03 are only as good as the attack scenarios they survive. This spec defines the adversarial test suite: real-world traversal payloads exercised against `PathValidator`, on-disk symlink swaps that race `ToctouGuard`, catastrophic-backtracking patterns measured against the 100ms wall-clock cap, and tamper/rotate/gap scenarios for the HMAC chain. Tests run under Jest with a dedicated `test:security-adversarial` npm script and a 5-second per-test timeout. The suite is the regression contract — any future change that lets a known attack pass MUST be caught here before merge.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/security/path-traversal-adversarial.test.ts` | Create | PathValidator + GitVerifier attacks |
| `tests/security/toctou-race.test.ts` | Create | Symlink-swap race conditions |
| `tests/security/redos-catastrophic.test.ts` | Create | Catastrophic backtracking patterns |
| `tests/security/audit-tampering.test.ts` | Create | HMAC chain tamper / gap / rotation |
| `tests/security/fixtures/symlink-farm.ts` | Create | Helper to build symlink-escape directories |
| `tests/security/fixtures/redos-patterns.ts` | Create | Catalog of known catastrophic patterns |
| `package.json` | Modify | Add `test:security-adversarial` script |

## Implementation Details

### Setup Hooks

Each test file declares a `beforeAll` that:
- Resolves a temp directory via `fs.mkdtemp(path.join(os.tmpdir(), 'sec-test-'))`.
- Builds the `allowed_roots` policy pointing at the temp dir.
- Constructs the SUT (`PathValidator`, `RegexSandbox`, `AuditLogger` + `KeyManager`).

`afterAll` cleans the temp dir via `fs.rm(tmp, { recursive: true, force: true })`.

Test timeout per case: `jest.setTimeout(5000)`.

### `path-traversal-adversarial.test.ts`

Test the SPEC-014-3-01 `PathValidator` against a payload matrix:

| Payload | Expected outcome |
|---------|-----------------|
| `../../../etc/passwd` | `SecurityError`, message starts `"Path outside allowed roots"` |
| `/allowed/root/../../etc/passwd` | `SecurityError`, same |
| `/allowed/root/sub/../../../etc/passwd` | `SecurityError`, same |
| `/allowed-root2/file` (when only `/allowed/root` is in policy) | `SecurityError` (path-separator boundary) |
| `/allowed/root/legit.txt` | resolves to canonical path |
| `/allowed/root/./legit.txt` | resolves to canonical path |
| `\u002e\u002e/\u002e\u002e/etc/passwd` (Unicode `..`) | `SecurityError` |
| `%2e%2e%2fetc%2fpasswd` (URL-encoded, raw bytes) | `SecurityError` (path doesn't exist) |
| empty string `""` | `SecurityError("Invalid path input")` |
| 5000-byte string of `a`s | `SecurityError("Invalid path input")` (length cap) |
| `null` | `SecurityError("Invalid path input")` |

Symlink-escape sub-suite: build a chain `tmp/a -> tmp/b -> tmp/c -> /etc/passwd`. Validate `tmp/a` — MUST reject. Build a benign chain `tmp/a -> tmp/b -> tmp/inside.txt` where `tmp/inside.txt` is inside the allowed root — MUST resolve to the canonical real path of `inside.txt`.

GitVerifier sub-suite: 
- `isValidRepository(<empty dir>)` returns `false`.
- `isValidRepository(<git dir>)` returns `true` after `execFile('git', ['init'])` setup.
- `isValidRepository(<dir with malicious .git symlink to /etc>)` returns `false` (the access check passes but `git rev-parse` fails or returns invalid output).
- Stub `execFile` to delay 3000ms; verify the call returns `false` within 2200ms (timeout enforcement).

### `toctou-race.test.ts`

Test the SPEC-014-3-01 `ToctouGuard`:

1. **Symlink swap between open and read.**
   - Create `tmp/target.txt` containing "safe".
   - `fd = await guard.openSafe(tmp/target.txt)`.
   - In a `setTimeout(0)` handler: `unlink(tmp/target.txt); symlink('/etc/passwd', tmp/target.txt)`.
   - `await guard.readSafe(tmp/target.txt)` — MUST throw `SecurityError("File identity changed - possible TOCTOU attack")`.

2. **Direct symlink rejection.**
   - Create `tmp/safe.txt` and `tmp/link -> tmp/safe.txt`.
   - `guard.openSafe(tmp/link)` MUST reject with `SecurityError("Symlink at path - O_NOFOLLOW rejected")`.

3. **Concurrent open of same path.**
   - Issue 10 simultaneous `openSafe(tmp/race.txt)` calls.
   - Each call returns its own fd; the cache holds only the most recent (per spec: prior fd is closed). Verify exactly 9 of the original fds are closed via `fstat` returning `EBADF`.

4. **Long-held fd timeout.**
   - `fd = openSafe(tmp/long.txt)`.
   - Mock `Date.now` to advance 31000ms.
   - `readSafe` MUST throw `SecurityError("File descriptor held too long")`.

5. **Cleanup empties cache.**
   - Open 5 files, call `cleanup()`, verify the internal cache map is empty and all fds are closed.

### `redos-catastrophic.test.ts`

Catalog (in `fixtures/redos-patterns.ts`):

```
catastrophic = [
  { name: "exponential-plus",  pattern: "(a+)+$",                  input: "a".repeat(100) + "X" },
  { name: "exponential-star",  pattern: "(a*)*$",                  input: "a".repeat(100) + "X" },
  { name: "alt-overlap",       pattern: "(a|a)*$",                 input: "a".repeat(100) + "X" },
  { name: "nested-quant",      pattern: "(.*)*$",                  input: "a".repeat(200) + "!" },
  { name: "evil-email",        pattern: "^([a-zA-Z0-9])(([\\.\\-]?[a-zA-Z0-9]+)*)@(([a-zA-Z0-9])+(([\\.\\-]?[a-zA-Z0-9]+)*)([\\.][a-zA-Z]{2,3})+)$",
                                input: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" }
]
```

For each pattern:
- `start = Date.now(); result = await sandbox.test(pattern, input); elapsed = Date.now() - start`.
- Assert `result.timedOut === true`.
- Assert `elapsed <= 200` (100ms cap + 100ms total scheduling/grace headroom).

Boundary tests:
- `sandbox.test('.*', 'a'.repeat(10240))` succeeds with `matches: true` (at the 10KB cap).
- `sandbox.test('.*', 'a'.repeat(10241))` throws `SecurityError` with `"Input too large"` message.
- `sandbox.test('a'.repeat(513), 'foo')` throws `SecurityError("Pattern too long")`.
- `sandbox.test('hi', 'hi', 'qq')` throws `SecurityError("Invalid regex flags")`.

Concurrency:
- Fire 10 `sandbox.test(catastrophic[0].pattern, ...)` calls in parallel via `Promise.all`.
- All 10 MUST resolve `timedOut: true`, total wall-clock ≤ 500ms (single-pattern budget × concurrency factor with worker overhead).

Worker-leak check:
- Run a 100-iteration loop of catastrophic-pattern calls.
- After the loop, `await new Promise(r => setImmediate(r))` to flush.
- Assert `process._getActiveHandles().filter(h => h.constructor.name === 'Worker').length === 0`.

### `audit-tampering.test.ts`

Use SPEC-014-3-03 `AuditLogger`, `KeyManager`, `AuditVerifier`. All test logs live under the per-test temp dir.

1. **Modified entry detected.**
   - Create logger, write 3 entries.
   - Read log, parse line 1, change `details.foo` → `'tampered'`, write back.
   - `verifier.verifyLog(logPath)` returns `verified: false`, `invalidEntries.length === 3` (line 1 fails directly, lines 2-3 fail because their `previous_hmac` references the now-broken chain).

2. **Sequence gap detected.**
   - Write 5 entries.
   - Delete line 3, leaving lines 1, 2, 4, 5.
   - `verifyLog` returns `sequenceGaps: [{line: 3, expected: 3, actual: 4}]` and `verified: false`.

3. **Truncation detected (orphan tail).**
   - Write 5 entries, then truncate the file to half its length mid-line.
   - `verifyLog` returns `verified: false` with the truncated line in `invalidEntries` (JSON parse error).

4. **Key rotation crossing.**
   - Write 3 entries, call `keyManager.rotateKey()`, write 3 more entries (pre-`log({action: "key_rotation", ...})` is up to the implementation but the test verifies via `entry.key_id`).
   - `verifyLog` returns `verified: true`, `validEntries: 6`, `keyRotations.length` correlates with the rotation events.

5. **HMAC reordering attack.**
   - Swap entries 2 and 3 (write line 3 before line 2 in the file).
   - `verifyLog` MUST detect the break — line 3 will see an unexpected `previous_hmac`, line 2 will see a sequence gap.

6. **File permissions.**
   - After `await logger.initialize()`, `fs.stat(logPath).mode & 0o777` equals `0o600`.
   - After 10 `log()` calls, mode is still `0o600`.

7. **Secret leakage.**
   - `logger.log({action: 'auth.login', user: 'alice', resource: '/api', details: {token: 'sk-supersecretvalue1234'}, secrets: ['sk-supersecretvalue1234']})`.
   - Read the log line. Parse. Assert `details.token === '••••1234'` and the raw secret string does NOT appear anywhere in the file (grep the file content).

8. **Short secret rejected at redactor.**
   - `logger.log({..., details: {pwd: 'abc'}, secrets: ['abc']})`.
   - The redactor throws `SecurityError`; the logger catches it, replaces with `••••`, log line written without the raw value.

### Test Script Configuration

Add to `package.json`:

```
"scripts": {
  "test:security-adversarial": "jest --config jest.security.config.js --testPathPattern=tests/security",
  "test:security-integration": "jest --testPathPattern=tests/security/.*-integration"
}
```

Where `jest.security.config.js` sets `testTimeout: 5000`, `maxWorkers: 1` (avoids interference from concurrent worker_threads in regex tests), and `runInBand: true`.

## Acceptance Criteria

- [ ] `npm run test:security-adversarial` passes 100% of cases on macOS and Linux
- [ ] Path traversal: every payload in the 11-row matrix produces the expected outcome
- [ ] Symlink-escape chain test rejects with `SecurityError`
- [ ] Symlink-benign chain test resolves successfully
- [ ] GitVerifier 3000ms-stub test returns `false` within 2200ms
- [ ] TOCTOU symlink-swap test throws `"File identity changed"`
- [ ] TOCTOU long-held fd test throws `"File descriptor held too long"` after 30s mock-clock advance
- [ ] All 5 catastrophic regex patterns time out within ≤200ms wall-clock each
- [ ] 10 concurrent catastrophic regex calls all resolve `timedOut: true` within 500ms
- [ ] Worker-leak check shows 0 active Worker handles after 100-iteration loop
- [ ] Audit modify-entry test reports `verified: false` and at least one `invalidEntries` row
- [ ] Audit sequence-gap test reports exactly one entry in `sequenceGaps` with correct expected/actual
- [ ] Audit truncation test reports `verified: false`
- [ ] Audit key-rotation test reports `verified: true` across the rotation
- [ ] Audit reordering test reports `verified: false`
- [ ] Audit file mode is `0o600` after init and after 10 logs
- [ ] Secret-leakage test confirms raw token does not appear in log file content
- [ ] Whole suite completes in ≤ 60 seconds wall-clock
- [ ] `npm run lint:security` passes on all new test files

## Dependencies

- Implementations from SPEC-014-3-01 (PathValidator, GitVerifier, ToctouGuard).
- Implementation from SPEC-014-3-02 (RegexSandbox).
- Implementations from SPEC-014-3-03 (SecretRedactor, AuditLogger, KeyManager, AuditVerifier).
- Jest test framework (already in repo).
- POSIX symlink syscalls (test suite is platform-gated to `linux | darwin`; Windows is skipped).

## Notes

- **Mock-clock for 30-second test**: Use `jest.useFakeTimers()` and `jest.setSystemTime()` for the long-held-fd assertion. Do NOT actually wait 31s.
- **Worker-thread timing tolerance**: The 200ms ceiling for catastrophic-pattern timeout is intentionally generous (2× the 100ms cap) to absorb worker spawn cost on slow CI runners. If the budget is tightened it must be re-validated against representative CI hardware.
- **Symlink test fixtures need cleanup**: Always use the per-test temp dir from `fs.mkdtemp` so parallel test runs don't collide. Never write fixtures into the repo tree.
- **Why `maxWorkers: 1`**: The regex sandbox tests spawn worker threads aggressively. Running multiple Jest workers in parallel can exhaust the OS thread limit on small CI machines. Serialize the security suite specifically; other suites stay parallel.
- **Coverage signal vs. assertion**: This suite is about behavioral assertions, not line coverage. A test that imports a module and never asserts is worse than no test. Every `it(...)` block must end with at least one `expect(...)` against an observable outcome.
- **No "happy-path-only" tests**: Every test added here must encode an attack scenario or a boundary condition. Happy-path tests live in the unit suites of -01, -02, -03.
- **Future**: Once monitoring (TASK-011) lands, extend this suite with an "alert generation" check — verify that `100 path-traversal rejections in 60s` triggers the metrics signal. Out of scope for this spec.
