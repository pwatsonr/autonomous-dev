# SPEC-021-1-05: Unit + Integration Tests for Standards Substrate

## Metadata
- **Parent Plan**: PLAN-021-1
- **Tasks Covered**: Task 11 (unit tests for resolver/loader/scanner), Task 12 (end-to-end integration test)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-1-05-unit-integration-tests.md`
- **Depends on**: SPEC-021-1-01 through SPEC-021-1-04 (production code + fixture corpus)

## Description
Lock the standards substrate with a comprehensive test suite: three unit test files (resolver, loader, scanner) driven from the SPEC-021-1-04 fixture corpus, plus one integration test exercising end-to-end load → resolve → assert across all four levels (default → org → repo → request) including the immutability scenario.

Coverage targets: ≥95% line coverage on `resolver.ts`, `loader.ts`, `auto-detection.ts`. Auto-detection precision target ≥80% per signal type, computed across the 20 repo fixtures and reported as a CI artifact. The full suite must run deterministically in under 30 seconds.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/standards/test-resolver.test.ts` | Create | 8 TDD §14 scenarios + 4 edge cases |
| `plugins/autonomous-dev/tests/standards/test-loader.test.ts` | Create | INDEX.md-driven valid/invalid + safe-load + IO |
| `plugins/autonomous-dev/tests/standards/test-auto-detection.test.ts` | Create | Per-signal correctness + writer determinism + precision report |
| `plugins/autonomous-dev/tests/standards/precision-report.ts` | Create | Helper computing per-signal precision across 20 repo fixtures |
| `plugins/autonomous-dev/scripts/parse-fixtures-index.ts` | Create | Parses INDEX.md tables → JSON for test consumption |
| `plugins/autonomous-dev/tests/integration/test-standards-flow.test.ts` | Create | End-to-end load + resolve + immutability + admin override |
| `plugins/autonomous-dev/tests/fixtures/integration/*` | Create | 7 integration fixtures (defaults, org, repo, expected-resolved, immutable variants, request override) |
| `plugins/autonomous-dev/vitest.config.ts` | Modify | Coverage thresholds for the three target files |

## Implementation Details

### Resolver tests

Required test cases (each `it` block):

| ID | Scenario |
|----|----------|
| S1 | Defaults only — every rule sourced as `default` |
| S2 | Org overrides default — same id, source becomes `org` |
| S3 | Repo overrides org (mutable) — same id, source becomes `repo` |
| S4 | Repo cannot override immutable org rule — throws `ValidationError` with rule id in message |
| S5 | Per-request override without admin — throws `AuthorizationError` |
| S6 | Per-request override with admin (mocked) — applied, source `request` |
| S7 | Rule unique to org level — appears with source `org` |
| S8 | Rule unique to repo level — appears with source `repo` |
| E1 | All four levels empty — returns empty maps without throw |
| E2 | Duplicate IDs within a single level — last-write-wins |
| E3 | 1000+100+50 rule resolution — median elapsed < 50ms across 5 runs (`performance.now()`) |
| E4 | Immutable flag at default level — does not block org override (defaults always mutable) |

### Loader tests

INDEX.md-driven generation: a `beforeAll` hook runs `parseFixturesIndex.ts` to produce `INDEX.md.parsed.json`, then `describe.each` iterates entries.

```typescript
describe.each(validFixtures)("loads %s clean", (fixture) => {
  it("returns artifact, no errors", async () => {
    const r = await loadStandardsFile(fixture.path);
    expect(r.errors).toEqual([]);
    expect(r.artifact).not.toBeNull();
  });
});

describe.each(invalidFixtures)("rejects %s", (fixture) => {
  it(`returns ${fixture.expectedErrorType}`, async () => {
    const r = await loadStandardsFile(fixture.path);
    expect(r.artifact).toBeNull();
    expect(r.errors[0].type).toBe(fixture.expectedErrorType);
  });
});
```

Plus security and IO blocks:

| Block | Cases |
|-------|-------|
| Security | Rejects `!!python/object` via FAILSAFE_SCHEMA; rejects `!!js/function`; rejects file > 1MB without reading contents (verified via `vi.spyOn(fs, "readFile")`) |
| IO | Returns `io_error` for non-existent path; returns `io_error` for permission-denied path (fixture chmod 000); multiple schema errors all surface in `errors[]` (not just first) |

### Auto-detection tests

Per-signal correctness (one `it` per row):

| Signal target | Test |
|---------------|------|
| framework-dep (Python) | Detects fastapi from `requirements.txt`; detects fastapi from `pyproject.toml` |
| framework-dep (Node) | Detects react, vue, express, angular from `package.json` |
| linter-config | Detects `auto:eslint-configured` and per-rule `auto:eslint-<rule>` (≤50 rules) |
| formatter-config | Detects `.prettierrc` json, yaml, js variants |
| tsconfig-strict | Full strict; partial strict (only `strictNullChecks`) |
| test-runner-pattern | `jest.config.js` testMatch; `package.json#jest` field |
| readme-mention | Black, isort, mypy, pytest mentions trigger 0.6 confidence |
| Negative | empty-repo fixture returns `[]`; malformed `package.json` warns (does not throw); missing files do not throw |

Writer determinism (4 cases): byte-identical across two runs on same input; alphabetical sort by `rule.id`; comments (`# confidence:`, `# evidence:`, `# signal:`) above each rule; output (after stripping `#` lines) round-trips through `loadStandardsFile`.

Precision report (1 case):

```typescript
it("per-signal precision ≥ 0.80 across 20 repo fixtures", async () => {
  const report = await computePrecisionReport();
  await fs.writeFile("tests/standards/precision-report.json", JSON.stringify(report, null, 2));
  for (const [signal, precision] of Object.entries(report)) {
    expect(precision, `signal=${signal}`).toBeGreaterThanOrEqual(0.80);
  }
});
```

`precision-report.ts` definition:

```typescript
// For each repo in tests/fixtures/repos/<name>/:
//   load expected-detections.json → expected[], notExpected[]
//   run AutoDetectionScanner against the repo
//   classify each detected: TP if id in expected; FP if id in notExpected (or absent from both)
// precision_per_signal = TP_signal / (TP_signal + FP_signal)
// Returns Record<SignalKind, number>
```

The report file is uploaded as a CI artifact for forensic inspection on regressions.

### Integration test

Three `it` blocks in `test-standards-flow.test.ts`:

```typescript
it("end-to-end: load default + org + repo, resolve, match expected", async () => {
  const def = (await loadStandardsFile("tests/fixtures/integration/defaults.yaml")).artifact!;
  const org = (await loadStandardsFile("tests/fixtures/integration/org-standards.yaml")).artifact!;
  const repo = (await loadStandardsFile("tests/fixtures/integration/repo-standards.yaml")).artifact!;
  const resolved = resolveStandards(def.rules, org.rules, repo.rules, []);
  const expected = JSON.parse(await readFile("tests/fixtures/integration/expected-resolved.json", "utf8"));
  for (const exp of expected) {
    expect(resolved.rules.get(exp.id)).toBeDefined();
    expect(resolved.source.get(exp.id)).toBe(exp.source);
  }
});

it("immutability: repo override of immutable org rule throws", async () => {
  const def = (await loadStandardsFile("tests/fixtures/integration/defaults.yaml")).artifact!;
  const org = (await loadStandardsFile("tests/fixtures/integration/org-immutable-rule.yaml")).artifact!;
  const repo = (await loadStandardsFile("tests/fixtures/integration/repo-attempts-override.yaml")).artifact!;
  expect(() => resolveStandards(def.rules, org.rules, repo.rules, []))
    .toThrowError(/immutable.*cannot be overridden/i);
});

it("admin per-request: rejected without admin, accepted with mock", async () => {
  const def = (await loadStandardsFile("tests/fixtures/integration/defaults.yaml")).artifact!;
  const req = (await loadStandardsFile("tests/fixtures/integration/request-overrides.yaml")).artifact!;
  expect(() => resolveStandards(def.rules, [], [], req.rules)).toThrowError(/admin/i);

  const spy = vi.spyOn(authModule, "isAdminRequest").mockReturnValue(true);
  const resolved = resolveStandards(def.rules, [], [], req.rules);
  for (const r of req.rules) expect(resolved.source.get(r.id)).toBe("request");
  spy.mockRestore();
});
```

Integration fixtures (`tests/fixtures/integration/`): `defaults.yaml`, `org-standards.yaml`, `repo-standards.yaml`, `expected-resolved.json`, `org-immutable-rule.yaml`, `repo-attempts-override.yaml`, `request-overrides.yaml`.

### Coverage configuration (`vitest.config.ts`)

```typescript
coverage: {
  thresholds: {
    "src/standards/resolver.ts":       { lines: 95, branches: 95, functions: 100, statements: 95 },
    "src/standards/loader.ts":         { lines: 95, branches: 95, functions: 100, statements: 95 },
    "src/standards/auto-detection.ts": { lines: 95, branches: 90, functions: 100, statements: 95 }
  }
}
```

CI fails if any threshold is missed.

## Acceptance Criteria

### Resolver tests
- [ ] All 8 TDD §14 scenarios (S1-S8) have a passing test.
- [ ] All 4 edge cases (E1-E4) have a passing test.
- [ ] E3 perf test: 1150-rule resolution measured < 50ms median across 5 runs.
- [ ] Coverage on `resolver.ts` ≥95% lines, ≥95% branches.

### Loader tests
- [ ] Every valid fixture in `tests/fixtures/standards/valid/` has a passing test (INDEX.md-driven).
- [ ] Every invalid fixture has a passing test asserting the documented error type.
- [ ] All 3 security tests pass (`!!python/object`, `!!js/function`, 1MB cap before-read).
- [ ] All 3 IO tests pass (missing file, permission denied, multiple-error surface).
- [ ] Coverage on `loader.ts` ≥95% lines, ≥95% branches.

### Auto-detection tests
- [ ] All per-signal correctness rows have a passing test (≥14 cases).
- [ ] All 4 writer determinism tests pass.
- [ ] Precision report runs across all 20 repo fixtures and emits `precision-report.json`.
- [ ] Every signal kind has precision ≥ 0.80.
- [ ] Coverage on `auto-detection.ts` ≥95% lines, ≥90% branches.

### Integration test
- [ ] End-to-end load + resolve + assert against expected JSON passes.
- [ ] Immutability throw scenario passes.
- [ ] Admin per-request scenario passes (rejected-without-admin and accepted-with-mock).
- [ ] All 7 integration fixtures exist and parse cleanly.

### Suite-wide
- [ ] Total suite (4 test files) completes in < 30s on a 2024 dev machine.
- [ ] Tests are deterministic: 10 consecutive `vitest run` invocations pass with no flakes.
- [ ] No tests are skipped (`.skip` / `xit` forbidden).
- [ ] Vitest coverage thresholds enforced; CI fails on regression.

## Dependencies

- SPEC-021-1-01 through SPEC-021-1-04 merged.
- Test runner: existing `vitest` setup in the plugin.
- No new runtime deps. `vi.spyOn` from vitest is used for the admin auth mock.

## Notes

- INDEX.md-driven tests mean adding a new fixture automatically extends coverage. The parser (`scripts/parse-fixtures-index.ts`, ~30 lines) is intentionally simple; documented in `tests/standards/README.md`.
- The precision report is part of the test suite (not a separate CI step) because the ≥0.80 target is an acceptance criterion, not a separate quality gate. Regression fails locally and in CI identically.
- The 30-second budget is a soft expectation enforced by review, not a hard timeout assertion. If it slips, optimize before adding more tests.
- Determinism requires the scanner to not depend on filesystem traversal order; verified by the "10 consecutive runs" check. Any flake is a P0 bug to fix before merge.
- Branch coverage on `auto-detection.ts` is set at 90% (not 95%) because a few defensive branches (e.g., glob errors that are hard to provoke without invasive mocking) are pragmatically unreachable. 90% is the deliberate floor.
- The integration test deliberately exercises the library API (loader + resolver), not the CLI — CLI smoke tests live in SPEC-021-1-04's command files. This separation keeps each spec's tests focused.
