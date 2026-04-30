# SPEC-021-2-02: Built-in Evaluators — sql-injection-detector + dependency-checker + pattern-grep

## Metadata
- **Parent Plan**: PLAN-021-2
- **Tasks Covered**: Task 3 (sql-injection-detector), Task 4 (dependency-checker), Task 5 (pattern-grep)
- **Estimated effort**: 9 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-2-02-sql-injection-dependency-pattern-grep.md`

## Description

Implement the remaining three built-in standards evaluators: `sql-injection-detector` (cross-language scan for unsafe string-format SQL — f-strings, `.format()`, concatenation, `String.format()`), `dependency-checker` (verifies a named dependency exists in the appropriate manifest, with optional dev-dep scoping), and `pattern-grep` (generic regex match for `uses_pattern` / `excludes_pattern` rules — the only built-in evaluator that runs user-supplied regex and therefore the only one that MUST route through the ReDoS sandbox introduced in SPEC-021-2-04). All three follow the same `BuiltinEvaluator` interface and shared types defined in SPEC-021-2-01.

This spec depends on the shared types and alias infrastructure delivered by SPEC-021-2-01. It also defines a forward-compatible interface to the ReDoS sandbox: `pattern-grep` calls `evaluateRegex(pattern, input)` from `src/standards/redos-sandbox.ts`, which is a stub here returning `RegExp.prototype.test` and is replaced by the real worker-thread sandbox in SPEC-021-2-04. This stub-and-replace pattern lets `pattern-grep` ship and be tested standalone, with the sandbox upgrade flipping a single import without changing semantics.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/standards/evaluators/sql-injection-detector.ts` | Create | Built-in: 10+ unsafe-pattern detectors across Py/JS/TS/Java |
| `plugins/autonomous-dev/src/standards/evaluators/dependency-checker.ts` | Create | Built-in: manifest dep lookup with dev/runtime distinction |
| `plugins/autonomous-dev/src/standards/evaluators/pattern-grep.ts` | Create | Built-in: routes user regex through ReDoS sandbox |
| `plugins/autonomous-dev/src/standards/redos-sandbox.ts` | Create (stub) | Stub `evaluateRegex(pattern, input, flags?)` — replaced in SPEC-021-2-04 |
| `plugins/autonomous-dev/tests/standards/evaluators/sql-injection-detector.test.ts` | Create | 10+ unsafe + 5+ safe across languages |
| `plugins/autonomous-dev/tests/standards/evaluators/dependency-checker.test.ts` | Create | Runtime + dev-deps + missing manifest |
| `plugins/autonomous-dev/tests/standards/evaluators/pattern-grep.test.ts` | Create | uses_pattern + excludes_pattern + sandbox-stub integration |
| `plugins/autonomous-dev/tests/standards/evaluators/fixtures/sql/` | Create | Source files containing each unsafe pattern + safe equivalents |

## Implementation Details

### `sql-injection-detector.ts`

**Args contract:** `{}` — this evaluator takes no arguments; it scans every file in `filePaths` for unsafe SQL string formation.

**Behavior:**
1. For each file in `filePaths`, infer language by extension:
   - `.py` → Python checks
   - `.ts`, `.tsx`, `.js`, `.jsx` → JS/TS checks
   - `.java`, `.kt`, `.scala` → JVM checks
   - Other extensions: skip silently.
2. Read file (UTF-8). On read error: skip and continue.
3. Apply language-specific pattern catalog. Each pattern is a static regex with a strong anchor (the literal substring `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, or `WHERE` — case-insensitive — to bound matches and avoid expensive backtracking on arbitrary text).
4. Each match yields one finding: `{file, line, severity: 'critical', message: '<pattern-name>: <one-line excerpt>'}`. Line is 1-based, computed from the byte offset.
5. Aggregate: `passed = findings.length === 0`.

**Pattern catalog (must include AT LEAST these 10 unsafe patterns):**

| ID | Language | Regex (anchor on SQL keyword) |
|----|----------|------------------------------|
| PY-FSTRING-1 | Python | `f["'].*\\b(SELECT|INSERT|UPDATE|DELETE|DROP)\\b.*\\{[^}]+\\}.*["']` |
| PY-FSTRING-2 | Python | `f["'].*\\bWHERE\\b.*\\{[^}]+\\}.*["']` |
| PY-FORMAT | Python | `["'].*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*["']\\.format\\(` |
| PY-PERCENT | Python | `["'].*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*\\%s.*["']\\s*\\%` |
| PY-CONCAT | Python | `["'].*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*["']\\s*\\+\\s*\\w+` |
| JS-TEMPLATE | JS/TS | `` `.*\\b(SELECT|INSERT|UPDATE|DELETE|DROP)\\b.*\\$\\{[^}]+\\}.*` `` |
| JS-CONCAT | JS/TS | `["'].*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*["']\\s*\\+\\s*\\w+` |
| JS-REPLACE | JS/TS | `["'].*\\b(SELECT|INSERT|UPDATE)\\b.*["']\\.replace\\(` |
| JAVA-FORMAT | JVM | `String\\.format\\s*\\(\\s*["'].*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*["']` |
| JAVA-CONCAT | JVM | `["'].*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*["']\\s*\\+\\s*\\w+` |
| JAVA-MSGFMT | JVM | `MessageFormat\\.format\\s*\\(\\s*["'].*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*["']` |

**Safe-pattern allowlist (must NOT match — covered by negative tests):**

- Parameterized queries: `cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))`
- ORM calls: `User.query.filter_by(id=user_id)`, `db.users.findOne({id})`
- `PreparedStatement.setString(1, userId)`
- Template literals containing only constants: `` `SELECT * FROM users WHERE deleted = false` ``

**ReDoS safety:** All patterns above are evaluator-controlled (not user-supplied). They are bounded by the SQL keyword anchor, which prevents arbitrary backtracking. Static analysis: each pattern is reviewed in code review for ReDoS risk; the test suite includes adversarial inputs (10KB random alphanumerics) for each detector and must complete in <100ms total. These pattern executions do NOT route through the ReDoS sandbox because they are trusted code; routing them would only add overhead.

### `dependency-checker.ts`

**Args contract:** `{ dependency_present: string, dev?: boolean }`. `dev` defaults to `false` (check runtime deps only). If `dev: true`, check both runtime and dev sections.

**Behavior:** Mirror `framework-detector` (SPEC-021-2-01) for manifest discovery and parsing, but:
- Match by literal name only (no alias resolution — the operator wrote the dep name explicitly).
- Match against `dependencies` (always) and `devDependencies` / `[tool.poetry.dev-dependencies]` / `[project.optional-dependencies.dev]` (only when `dev: true`).
- On match: `passed: true`.
- On miss: `passed: false` with finding `{file: <manifest>, line: 1, severity: 'major', message: 'dependency "${dependency_present}" not declared in <manifest> (${dev ? 'dev+runtime' : 'runtime'})'}`.
- On missing manifest: same as `framework-detector` — `{line: 0, severity: 'major', message: 'no dependency manifest found'}`.

### `pattern-grep.ts`

**Args contract:** `{ uses_pattern?: string, excludes_pattern?: string, flags?: string }`. Exactly one of `uses_pattern` or `excludes_pattern` MUST be provided (return `passed: false` with severity `major` and message `"pattern-grep requires uses_pattern or excludes_pattern"` if neither or both are provided).

**Behavior — `uses_pattern` mode:**
1. For each file in `filePaths`: read contents (skip on error).
2. Call `await evaluateRegex(uses_pattern, contents, flags ?? '')` from `redos-sandbox.ts`.
3. If the call throws (`SecurityError` for input >10KB, ReDoS timeout, etc.): record finding `{file, line: 0, severity: 'major', message: 'pattern-grep failed on <file>: <err.message>'}` and continue to next file. Do NOT abort — partial results are valuable.
4. After scanning all files: if at least one file matched → `passed: true`. Otherwise → `passed: false` with one summary finding `{file: '<workspace>', line: 0, severity: 'major', message: 'pattern "<pattern>" matched in 0 of <N> scanned files'}`.

**Behavior — `excludes_pattern` mode:** mirror image. `passed: true` only if NO file matched. Findings list each file that matched, with line number of the first match.

**ReDoS sandbox stub (`redos-sandbox.ts`) — replaced in SPEC-021-2-04:**

```typescript
// STUB IMPLEMENTATION — replaced by SPEC-021-2-04 with worker-thread sandbox.
// Do NOT use in production; this exists so pattern-grep can ship and be tested
// in isolation. The real implementation enforces 100ms timeout and 10KB input cap.
export interface RegexResult {
  matches: boolean;
  matchLine?: number;     // 1-based; first matching line
  timedOut?: boolean;
  error?: string;
}

export async function evaluateRegex(
  pattern: string,
  input: string,
  flags: string = '',
): Promise<RegexResult> {
  if (input.length > 10 * 1024) {
    throw new Error('SecurityError: input exceeds 10KB cap (stub)');
  }
  try {
    const re = new RegExp(pattern, flags);
    const match = re.exec(input);
    if (!match) return { matches: false };
    const lineIdx = input.slice(0, match.index).split('\n').length;
    return { matches: true, matchLine: lineIdx };
  } catch (err) {
    return { matches: false, error: (err as Error).message };
  }
}
```

This stub MUST emit a console warning (`console.warn('redos-sandbox stub in use — replace with SPEC-021-2-04')`) on first call so the gap is visible in CI logs. The warning state is module-scoped so it fires once per process.

## Acceptance Criteria

- [ ] Given a Python file containing `query = f"SELECT * FROM users WHERE id = {user_id}"`, `sql-injection-detector` returns `passed: false` with one finding of severity `critical` on the correct line.
- [ ] Given a Python file containing `cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))`, `sql-injection-detector` returns `passed: true, findings: []`.
- [ ] Given a TS file with `` const q = `SELECT * FROM users WHERE id = ${userId}` ``, `sql-injection-detector` returns `passed: false`.
- [ ] Given a Java file with `String sql = String.format("SELECT * FROM users WHERE id = %s", id)`, `sql-injection-detector` returns `passed: false`.
- [ ] `sql-injection-detector` test suite includes ≥ 10 unsafe-pattern fixtures (one per pattern ID) and ≥ 5 safe-pattern fixtures, all asserting the expected verdict.
- [ ] `sql-injection-detector` runs against a 10KB file of random alphanumerics in <100ms (regression test for backtracking).
- [ ] Given `package.json` with `"dependencies": { "axios": "^1.0" }`, `dependency-checker` with `{dependency_present: "axios"}` returns `passed: true`.
- [ ] Given `package.json` with `"devDependencies": { "jest": "^29" }` and `{dependency_present: "jest", dev: false}`, returns `passed: false` (runtime-only check).
- [ ] Given the same manifest with `{dependency_present: "jest", dev: true}`, returns `passed: true`.
- [ ] `dependency-checker` returns `passed: false` with finding line 0 when the manifest is missing.
- [ ] Given `pattern-grep` with `{uses_pattern: "TODO\\(\\w+\\)"}` and a file containing `// TODO(alice) ship this`, returns `passed: true`.
- [ ] Given `pattern-grep` with `{excludes_pattern: ".*\\.format\\(.*query"}` and one file containing `query.format(...)`, returns `passed: false` with one finding listing the offending file.
- [ ] Given `pattern-grep` with both `uses_pattern` and `excludes_pattern` (or neither), returns `passed: false` with the documented configuration-error message.
- [ ] Given `pattern-grep` with a file >10KB, the stub throws `SecurityError`; `pattern-grep` records the finding and continues to other files. Final result reflects only files that were scanned successfully.
- [ ] The first call to the stub `evaluateRegex` in a process emits exactly one console warning containing `'stub'`; subsequent calls emit none.
- [ ] Test coverage ≥ 95% for `sql-injection-detector.ts`, `dependency-checker.ts`, `pattern-grep.ts` (lines + branches).

## Dependencies

- **Blocked by**: SPEC-021-2-01 (provides `EvaluatorResult`, `Finding`, `EvaluatorContext`, `BuiltinEvaluator` types and the `aliases.ts` infrastructure used implicitly by manifest parsing).
- **Replaced by**: SPEC-021-2-04 swaps the `redos-sandbox.ts` stub for the worker-thread implementation. The exported `evaluateRegex` signature MUST stay identical or the swap breaks `pattern-grep`.
- **Consumed by**: SPEC-021-2-03 registers all three in the `EvaluatorRegistry`. SPEC-021-2-04's adversarial tests exercise `pattern-grep` end-to-end with the real ReDoS sandbox.
- **Runtime deps**: Same as SPEC-021-2-01 (`@iarna/toml` if pyproject.toml parsing is needed).

## Notes

- The SQL pattern catalog favors precision over recall. False positives on legitimate string-formatted SQL are noisy and erode trust in the rule. Each pattern requires a SQL keyword anchor before the unsafe construct; pattern reviews should reject any pattern that anchors only on `${` or `.format(` without a SQL verb.
- ORM calls (SQLAlchemy, Prisma, Sequelize) are intentionally invisible to this detector — they emit safe parameterized queries by construction. A future plan can add ORM-specific anti-patterns (e.g., raw query escape hatches) as a separate evaluator.
- The `dev` flag in `dependency-checker` is the simplest user-facing knob; richer scoping (peer deps, optional deps, workspace ranges) is deferred. The `applies_to` field on the rule itself (PLAN-021-1) covers most "scope this check to a subdir" use cases.
- The `pattern-grep` stub is intentionally weak (no real timeout) so the security gap is loud. CI MUST grep for `'redos-sandbox stub in use'` in the warning stream and fail the build if it appears AFTER SPEC-021-2-04 lands. Until then, the warning is informational and tests are allowed to emit it.
- The pattern-grep `flags` argument accepts only `[gimsuy]` characters; the stub passes them through unchecked, but SPEC-021-2-04's real implementation validates them strictly. Do not write tests that rely on invalid flags being accepted today — they will break when the sandbox lands.
