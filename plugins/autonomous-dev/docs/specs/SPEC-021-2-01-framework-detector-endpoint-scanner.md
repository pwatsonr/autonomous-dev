# SPEC-021-2-01: Built-in Evaluators — framework-detector + endpoint-scanner

## Metadata
- **Parent Plan**: PLAN-021-2
- **Tasks Covered**: Task 1 (framework-detector), Task 2 (endpoint-scanner)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-2-01-framework-detector-endpoint-scanner.md`

## Description

Implement the first two built-in standards evaluators that ship as in-process TypeScript modules: `framework-detector` (inspects dependency manifests for declared frameworks, including alias resolution) and `endpoint-scanner` (greps source files for HTTP route declarations across Python, TypeScript/JavaScript, and Go). Both evaluators follow the standard interface — synchronous functions taking `(filePaths, args)` and returning `EvaluatorResult { passed, findings[] }` — and run entirely in-process (no subprocess sandbox needed; the sandbox is reserved for custom evaluators per SPEC-021-2-03). These evaluators are consumed via the `EvaluatorRegistry` (SPEC-021-2-03) and dispatched through `runEvaluator()` (SPEC-021-2-04). Manifest parsing must handle missing files, malformed JSON/TOML, and absent dependency sections gracefully — never throw, always return a structured result.

Both evaluators are stateless and deterministic: the same input produces the same output. They MUST NOT execute any user-supplied regex or shell commands; both are purely declarative scanners over parsed manifest data and string-based grep over file contents.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/standards/evaluators/framework-detector.ts` | Create | Built-in: inspects package.json / requirements.txt / pyproject.toml |
| `plugins/autonomous-dev/src/standards/evaluators/endpoint-scanner.ts` | Create | Built-in: language-aware HTTP route grep |
| `plugins/autonomous-dev/src/standards/evaluators/types.ts` | Create | Shared `EvaluatorResult`, `Finding`, `EvaluatorContext` types |
| `plugins/autonomous-dev/src/standards/evaluators/aliases.ts` | Create | Framework alias map (e.g. `next` → React-based) |
| `plugins/autonomous-dev/tests/standards/evaluators/framework-detector.test.ts` | Create | 5+ positive + 5+ negative + alias + missing-manifest cases |
| `plugins/autonomous-dev/tests/standards/evaluators/endpoint-scanner.test.ts` | Create | Python/TS/Go positive + negative cases |
| `plugins/autonomous-dev/tests/standards/evaluators/fixtures/` | Create | Sample manifests + source files used by both test suites |

## Implementation Details

### Shared Types (`types.ts`)

```typescript
export interface Finding {
  file: string;          // absolute or repo-relative path
  line: number;          // 1-based; 0 means "no specific line" (e.g. missing manifest)
  severity: 'critical' | 'major' | 'minor' | 'info';
  message: string;
  rule_id?: string;      // populated by runEvaluator orchestrator, not the evaluator
}

export interface EvaluatorResult {
  passed: boolean;
  findings: Finding[];
  duration_ms?: number;  // populated by runner, not the evaluator
}

export interface EvaluatorContext {
  workspaceRoot: string; // absolute path; evaluators MUST resolve relative paths against this
}

export type BuiltinEvaluator = (
  filePaths: string[],
  args: Record<string, unknown>,
  ctx: EvaluatorContext,
) => Promise<EvaluatorResult>;
```

All built-in evaluators are `async` even when they perform no I/O — the registry interface in SPEC-021-2-03 is uniformly Promise-returning so callers don't branch on built-in vs custom.

### `framework-detector.ts`

**Args contract:** `{ framework_match: string }` — the canonical framework name (e.g. `"fastapi"`, `"react"`, `"express"`, `"nextjs"`).

**Behavior:**
1. Resolve the canonical name via `aliases.ts` (e.g. `"next"` → `"nextjs"` which is itself associated with `"react"` as a peer).
2. Scan in the following manifest priority order until one is found in `ctx.workspaceRoot`:
   - `package.json` (Node)
   - `pyproject.toml` (Python — modern)
   - `requirements.txt` (Python — legacy)
3. If no manifest exists: return `passed: false` with one finding `{file: '<workspace>', line: 0, severity: 'major', message: 'no dependency manifest found in workspace root (looked for package.json, pyproject.toml, requirements.txt)'}`.
4. Parse the manifest:
   - `package.json`: read `dependencies` + `devDependencies`. Match either by canonical name or any alias in `aliases.ts`.
   - `pyproject.toml`: read `[project.dependencies]` (PEP 621) and `[tool.poetry.dependencies]`. Strip version specifiers (`fastapi>=0.100` → `fastapi`).
   - `requirements.txt`: split on newlines, strip comments (`#`), strip version (`fastapi==0.100` → `fastapi`).
5. If the framework or any alias appears: return `passed: true, findings: []`.
6. Otherwise: return `passed: false` with a finding pointing at the manifest line where dependencies start (line 1 if not determinable). Message: `"framework '${framework_match}' not declared in <manifest>"`.

**Error handling:** Malformed manifest must not throw. Catch parse errors, return `passed: false` with severity `major` and message `"failed to parse <manifest>: <err.message>"`.

**Alias map (aliases.ts) — initial contents:**

```typescript
export const FRAMEWORK_ALIASES: Record<string, string[]> = {
  // canonical → list of accepted alias names
  nextjs: ['next', 'next.js'],
  react: ['react', 'react-dom'],
  vue: ['vue', 'vuejs'],
  fastapi: ['fastapi'],
  flask: ['flask'],
  django: ['django'],
  express: ['express'],
  nestjs: ['nest', '@nestjs/core'],
};

// nextjs implies react (Next.js is React-based)
export const FRAMEWORK_IMPLIES: Record<string, string[]> = {
  nextjs: ['react'],
};
```

When `framework_match` is `"react"` and the manifest lists `next`, the detector resolves: `next` → canonical `nextjs` → implies `["react"]` → `react` matches → `passed: true`.

### `endpoint-scanner.ts`

**Args contract:** `{ exposes_endpoint: string }` — the endpoint path (e.g. `"/health"`, `"/api/v1/users"`).

**Behavior:**
1. Iterate `filePaths`. For each file, infer language by extension:
   - `.py` → Python
   - `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` → TypeScript/JavaScript
   - `.go` → Go
   - Other extensions: skip silently.
2. Read the file contents (UTF-8). If unreadable: skip and continue (no finding — this evaluator is concerned with route presence, not file health).
3. Apply language-specific patterns (each pattern is a fixed string — NO user input is interpolated; the endpoint path is escaped for regex use):

**Python patterns** (regex, escaped path interpolated):
- `@app\\.(get|post|put|delete|patch|route)\\(['"]<ENDPOINT>['"]`
- `@router\\.(get|post|put|delete|patch)\\(['"]<ENDPOINT>['"]`
- `@blueprint\\.(get|post|put|delete|patch|route)\\(['"]<ENDPOINT>['"]`

**TypeScript/JavaScript patterns:**
- `(app|router)\\.(get|post|put|delete|patch|use)\\(['"]<ENDPOINT>['"]`
- `\\.route\\(['"]<ENDPOINT>['"]\\)\\.(get|post|put|delete|patch)`

**Go patterns:**
- `(mux|router|r)\\.HandleFunc\\(['"]<ENDPOINT>['"]`
- `(mux|router|r)\\.(GET|POST|PUT|DELETE|PATCH)\\(['"]<ENDPOINT>['"]`  // chi/gin

4. The endpoint path MUST be escaped before insertion: `endpoint.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')`. This prevents accidental regex injection from user-supplied endpoint paths in the rule.
5. If any pattern matches in any file: return `passed: true, findings: []`.
6. If no match: return `passed: false` with a single finding `{file: '<workspace>', line: 0, severity: 'major', message: 'endpoint <ENDPOINT> not found in <N> scanned files'}`.

**Important:** the endpoint scanner runs its own `RegExp` constructions — but ALL patterns are evaluator-controlled (no user-supplied regex). The endpoint string is escaped, not used as a regex. Therefore this evaluator does NOT need to route through the ReDoS sandbox (SPEC-021-2-04). The `pattern-grep` evaluator (SPEC-021-2-02) is the one that takes user-supplied regex and MUST route through ReDoS.

## Acceptance Criteria

- [ ] Given `package.json` containing `"dependencies": { "fastapi": "^0.100" }`, `framework-detector` with `{framework_match: "fastapi"}` returns `passed: true, findings: []`.
- [ ] Given `package.json` containing only `"dependencies": { "flask": "^2.0" }`, `framework-detector` with `{framework_match: "fastapi"}` returns `passed: false` with one finding pointing at the manifest.
- [ ] Given a workspace with no `package.json`, no `requirements.txt`, no `pyproject.toml`, `framework-detector` returns `passed: false` with a finding `line: 0` and message containing `"no dependency manifest found"`.
- [ ] Given `package.json` with `"dependencies": { "next": "^14" }`, `framework-detector` with `{framework_match: "react"}` returns `passed: true` (alias + implication).
- [ ] Given a `pyproject.toml` with `[project.dependencies] fastapi = "^0.100"`, `framework-detector` with `{framework_match: "fastapi"}` returns `passed: true`.
- [ ] Given a malformed `package.json` (invalid JSON), `framework-detector` returns `passed: false` with severity `major` and message containing `"failed to parse"` — does NOT throw.
- [ ] Given a Python file containing `@app.get('/health')`, `endpoint-scanner` with `{exposes_endpoint: "/health"}` returns `passed: true`.
- [ ] Given a TypeScript file containing `app.get('/api/users', handler)`, `endpoint-scanner` with `{exposes_endpoint: "/api/users"}` returns `passed: true`.
- [ ] Given a Go file containing `mux.HandleFunc("/health", handler)`, `endpoint-scanner` with `{exposes_endpoint: "/health"}` returns `passed: true`.
- [ ] Given files in all three languages with NO matching route, `endpoint-scanner` returns `passed: false` with one finding mentioning the missing endpoint.
- [ ] Given an endpoint path containing regex metacharacters (e.g. `/api/v1/.well-known`), `endpoint-scanner` correctly escapes the metacharacters and matches only literal `.well-known`.
- [ ] Both evaluators are pure: invoking the same call twice with identical inputs returns identical outputs (verified by snapshot test).
- [ ] Test coverage ≥ 95% for both evaluator files (lines + branches), measured by the project's existing coverage tool.
- [ ] No file in this spec calls `runEvaluator`, the registry, or the sandbox — these evaluators are standalone modules.

## Dependencies

- **Blocked by**: PLAN-021-1 (provides `Rule` and `Predicate` types — although this spec only uses the `args` shape, not the full rule schema).
- **Consumed by**: SPEC-021-2-03 (registers these in the `EvaluatorRegistry`), SPEC-021-2-04 (`runEvaluator` dispatches to these), SPEC-021-2-05 (perf benchmarks measure throughput).
- **Runtime deps**: None new. `JSON.parse` is built-in. For `pyproject.toml` parsing, use `@iarna/toml` if it is already a project dependency; otherwise add it (lightweight, ~30KB, pure JS).
- **Sandbox**: not required. These evaluators run in the daemon process directly.

## Notes

- The endpoint-scanner deliberately uses naive regex (not an AST parser) because: (1) AST parsing for 3 languages adds heavy dependencies; (2) framework-specific decorators are regular enough that a regex catches >95% of cases; (3) false negatives are graded as `major` (not `critical`) because the operator can refine the rule. If the perf benchmarks (SPEC-021-2-05) reveal AST-grep would be faster on large codebases, swap the implementation in a follow-up — the public interface stays identical.
- The framework-detector intentionally does NOT recursively descend into subprojects (e.g. monorepo workspaces). It scans the workspace root only. Monorepo support is deferred; rules can be scoped via the `applies_to` field in the rule schema (PLAN-021-1) to target specific subdirectories.
- The alias map is intentionally small. Future additions should be PR-reviewed; an open-ended alias contribution mechanism is deferred until evaluator versioning is designed (TDD-021 §18).
- All `findings` returned by these evaluators omit the `rule_id` field — the orchestrator (`runEvaluator` in SPEC-021-2-04) injects the rule ID before returning the result to the caller.
