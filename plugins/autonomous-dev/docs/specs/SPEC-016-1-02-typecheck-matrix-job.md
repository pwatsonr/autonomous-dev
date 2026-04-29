# SPEC-016-1-02: TypeScript typecheck Matrix Job

## Metadata
- **Parent Plan**: PLAN-016-1
- **Tasks Covered**: Task 3 (typecheck matrix job with 2x2 OS/Node, npm cache, tsbuildinfo cache)
- **Estimated effort**: 4 hours

## Description

Add the `typecheck` job to `.github/workflows/ci.yml`. The job runs `npx tsc --noEmit --incremental` against the autonomous-dev plugin sources across a 2x2 matrix (`os: [ubuntu-latest, macos-latest]` x `node-version: [18, 20]`), gated on the `typescript` filter output from `SPEC-016-1-01`. Two cache layers keep wall-clock time within the NFR-1001 budget: `actions/setup-node@v4` caches the npm download cache, and `actions/cache@v4` caches the `tsconfig.tsbuildinfo` incremental build artifact.

The job MUST report each matrix leg independently (`fail-fast: false`) so a Node 18 macOS regression does not mask a Node 20 ubuntu success.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `.github/workflows/ci.yml` | Append the `typecheck` job to the existing `jobs:` block |

## Implementation Details

### Job Definition

Append the following job after the `paths-filter` job created in SPEC-016-1-01.

```yaml
  typecheck:
    name: Typecheck (${{ matrix.os }}, Node ${{ matrix.node-version }})
    needs: paths-filter
    if: needs.paths-filter.outputs.typescript == 'true'
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node-version: [18, 20]
    defaults:
      run:
        working-directory: plugins/autonomous-dev
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
          cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'

      - name: Restore tsbuildinfo cache
        uses: actions/cache@v4
        with:
          path: plugins/autonomous-dev/tsconfig.tsbuildinfo
          key: tsbuildinfo-${{ runner.os }}-node${{ matrix.node-version }}-${{ hashFiles('plugins/autonomous-dev/src/**/*.ts', 'plugins/autonomous-dev/tsconfig*.json') }}
          restore-keys: |
            tsbuildinfo-${{ runner.os }}-node${{ matrix.node-version }}-

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npx tsc --noEmit --incremental
```

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `needs: paths-filter` | Required to consume the `typescript` filter output. Without `needs`, the `if:` evaluator cannot read `needs.paths-filter.outputs.*`. |
| `if: needs.paths-filter.outputs.typescript == 'true'` | Skips all four matrix legs when no TypeScript files changed (e.g., a markdown-only PR). The string comparison with `'true'` matches the dorny/paths-filter output format. |
| 2x2 matrix (Linux+macOS, Node 18+20) | Validates LTS support (Node 18) and current LTS (Node 20) on the two OS targets autonomous-dev officially supports. Windows is intentionally excluded (TDD-016 Section 4 risk register). |
| `fail-fast: false` | Independent leg reporting. A Node 18 type error must not abort the Node 20 leg before its results are visible. |
| `defaults.run.working-directory` | Avoids repeating `working-directory: plugins/autonomous-dev` on every step. Plugin sources live in a subdirectory; tests and tsc must run from that root. |
| `actions/setup-node@v4` with `cache: 'npm'` | Caches `~/.npm` keyed by the lockfile hash. Restoration is automatic. |
| `cache-dependency-path` pinned to the plugin lockfile | Stabilizes the cache key across matrix legs so all four legs share a single npm cache entry. |
| `actions/cache@v4` for `tsconfig.tsbuildinfo` | Incremental builds need the `.tsbuildinfo` file from a prior run. Cache key includes runner OS, Node version, and the hash of all `.ts` sources plus `tsconfig*.json`. |
| `restore-keys` fallback | When the exact key misses (e.g., a single TS file changed), restore the most recent compatible build info. tsc invalidates entries that no longer match. |
| `npm ci` | Deterministic install from `package-lock.json`. Fails fast if the lockfile is out of sync. |
| `npx tsc --noEmit --incremental` | `--noEmit` skips JS output (typecheck only). `--incremental` writes `.tsbuildinfo` for the next run to consume. |

### Cache Key Strategy

- **Exact-key hit**: Source unchanged from a prior run on the same OS+Node. tsc reads `.tsbuildinfo` and exits in seconds.
- **Restore-key hit**: Sources changed; `.tsbuildinfo` from a previous run is restored. tsc invalidates stale entries and recompiles only changed files.
- **Cache miss (cold)**: First run on a new branch or after cache eviction. tsc performs a full build, then writes `.tsbuildinfo` for caching at job end.

The cache scope is per-branch by default (GitHub Actions cache scoping). PRs against `main` can read caches written by `main` builds, which warms cold runs.

### Validation Notes

- The `if:` condition must use single-quoted `'true'` (string) -- `dorny/paths-filter@v3` outputs are strings, not booleans.
- The cache step MUST come BEFORE `npm ci` so that the build info is restored before any subsequent tsc invocation. (npm install does not touch `tsbuildinfo`, but ordering remains correct for clarity.)
- `actions/setup-node@v4` automatically caches based on the hash of files under `cache-dependency-path`. Setting it explicitly avoids surprises if a future contributor moves the lockfile.
- `npx tsc` resolves through the npm-installed `typescript` dependency. Confirm `package.json` already lists `typescript` under `devDependencies` (precondition; do not add it here).

### Edge Cases

- **Missing `tsconfig.json`**: tsc fails with a clear error. The job fails fast; no false positive.
- **Type error in a file not under `src/` or `tests/`**: TypeScript root files matter only if `tsconfig.json` includes them. Default plugin tsconfig scopes to `src/` and `tests/`. Any leak will be caught by the same `npx tsc --noEmit` invocation.
- **Cache corruption**: `.tsbuildinfo` is internally checksummed by tsc. A corrupt file is silently regenerated; the job still passes (only loses the incremental speedup).
- **Concurrent matrix legs writing the same cache**: `actions/cache@v4` writes are keyed per leg via the `runner.os` and `matrix.node-version` axes, preventing collisions.
- **Network flake during `npm ci`**: The job fails. No retry is added here; flakes are rare with the npm cache warm.

## Acceptance Criteria

1. [ ] `.github/workflows/ci.yml` contains a `typecheck` job under `jobs:`.
2. [ ] Job has `needs: paths-filter`.
3. [ ] Job's `if:` condition is `needs.paths-filter.outputs.typescript == 'true'` (or stricter expressions equivalent to it).
4. [ ] `strategy.fail-fast` is `false`.
5. [ ] `strategy.matrix.os` is `[ubuntu-latest, macos-latest]`.
6. [ ] `strategy.matrix.node-version` is `[18, 20]`.
7. [ ] `runs-on` is `${{ matrix.os }}`.
8. [ ] `defaults.run.working-directory` is `plugins/autonomous-dev`.
9. [ ] First step is `actions/checkout@v4`.
10. [ ] Setup-node step uses `actions/setup-node@v4` with `node-version: ${{ matrix.node-version }}`, `cache: 'npm'`, and `cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'`.
11. [ ] Cache step uses `actions/cache@v4` with `path: plugins/autonomous-dev/tsconfig.tsbuildinfo`.
12. [ ] Cache key includes `runner.os`, `matrix.node-version`, and `hashFiles('plugins/autonomous-dev/src/**/*.ts', 'plugins/autonomous-dev/tsconfig*.json')`.
13. [ ] `restore-keys` is set to `tsbuildinfo-${{ runner.os }}-node${{ matrix.node-version }}-` (prefix match).
14. [ ] Job runs `npm ci` and `npx tsc --noEmit --incremental`.
15. [ ] When the `typescript` filter is `false`, all four matrix legs are skipped.
16. [ ] Introducing a type error in any `src/**/*.ts` file fails the corresponding leg with a non-zero exit code.
17. [ ] `actionlint` reports zero errors against the modified `ci.yml`.

## Test Cases

1. **test_typecheck_job_exists** -- `yq '.jobs.typecheck'` is non-null.
2. **test_typecheck_needs_paths_filter** -- `yq '.jobs.typecheck.needs'` returns `paths-filter`.
3. **test_typecheck_if_guard** -- `yq '.jobs.typecheck.if'` matches `needs.paths-filter.outputs.typescript == 'true'`.
4. **test_typecheck_fail_fast_false** -- `yq '.jobs.typecheck.strategy."fail-fast"'` is `false`.
5. **test_typecheck_matrix_os** -- `yq '.jobs.typecheck.strategy.matrix.os'` returns `["ubuntu-latest", "macos-latest"]`.
6. **test_typecheck_matrix_node** -- `yq '.jobs.typecheck.strategy.matrix."node-version"'` returns `[18, 20]`.
7. **test_typecheck_working_dir** -- `yq '.jobs.typecheck.defaults.run."working-directory"'` returns `plugins/autonomous-dev`.
8. **test_typecheck_setup_node_cache_path** -- The setup-node step's `cache-dependency-path` is `plugins/autonomous-dev/package-lock.json`.
9. **test_typecheck_tsbuildinfo_cache_path** -- The `actions/cache@v4` step's `path` is `plugins/autonomous-dev/tsconfig.tsbuildinfo`.
10. **test_typecheck_cache_key_uses_hashfiles** -- The cache key string contains `hashFiles('plugins/autonomous-dev/src/**/*.ts', 'plugins/autonomous-dev/tsconfig*.json')`.
11. **test_typecheck_runs_tsc_noemit_incremental** -- The job has a step whose `run` value contains `npx tsc --noEmit --incremental`.
12. **test_typecheck_skipped_on_no_ts_changes** (CI-observable) -- A PR touching only `README.md` shows the `typecheck` job as `skipped` for all four legs.
13. **test_typecheck_fails_on_type_error** (CI-observable) -- A PR introducing `const x: string = 42;` fails all four legs with the same tsc error message.
14. **test_typecheck_warm_cache_speedup** (CI-observable) -- A second consecutive PR push showing identical `src/` content has a `typecheck` leg wall time at least 30% shorter than the cold run for the same leg.
15. **test_actionlint_clean_after_modify** -- `actionlint` exits 0 against the updated `ci.yml`.

## Dependencies

- **Blocked by**: SPEC-016-1-01 (the `paths-filter` job and `typescript` filter output must exist before the `if:` guard can reference them).
- **Blocks**: SPEC-016-1-04 (smoke test PR exercises the full matrix and measures wall-clock time against NFR-1001).
- **External**: `plugins/autonomous-dev/package.json` must list `typescript` under `devDependencies`. `plugins/autonomous-dev/package-lock.json` must exist and be in sync. `plugins/autonomous-dev/tsconfig.json` must exist and emit `.tsbuildinfo` (the default for `--incremental`).

## Notes

- This job is the most expensive job in `ci.yml` after the `test` job. Cache hit rate is the dominant lever for staying within NFR-1001's 8-minute budget.
- `actions/setup-node@v4` will warn about a missing lockfile if `cache-dependency-path` does not match a real file. Verify locally before pushing.
- The 2x2 matrix yields four parallel runners; total wall time is bounded by the slowest leg (typically macOS Node 18 due to slower runner pools).
- A future optimization (out of scope) is to skip Node 18 once the project drops Node 18 support.
- Do NOT add `continue-on-error: true` to any leg. A failing leg must surface as a failed required check.
- This job MUST NOT be modified by sibling specs without coordinating with PLAN-016-1's owner.
