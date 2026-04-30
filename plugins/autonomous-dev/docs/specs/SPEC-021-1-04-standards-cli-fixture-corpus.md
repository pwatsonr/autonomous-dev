# SPEC-021-1-04: standards CLI Subcommands + Fixture Corpus

## Metadata
- **Parent Plan**: PLAN-021-1
- **Tasks Covered**: Task 7 (standards scan CLI), Task 8 (standards show + validate CLI), Task 9 (50+ standards fixtures), Task 10 (20 repo fixtures)
- **Estimated effort**: 12 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-1-04-standards-cli-fixture-corpus.md`
- **Depends on**: SPEC-021-1-01, SPEC-021-1-02, SPEC-021-1-03

## Description
Wire the standards substrate into the operator-facing CLI and ship the test fixture corpus that downstream specs (SPEC-021-1-05 tests, PLAN-021-2/021-3) consume.

Three subcommands under `autonomous-dev standards`:
- `standards scan [--repo <path>] [--diff] [--json]` — runs the AutoDetectionScanner; with `--diff` shows additions vs the existing `standards.yaml`.
- `standards show [--rule <id>] [--json]` — runs the InheritanceResolver across default/org/repo and prints resolved rules with source attribution.
- `standards validate <path>` — schema-checks a standards.yaml; exits 0 on success, 1 on errors.

Plus the corpus: ≥30 valid + ≥20 invalid standards fixtures and 20 repo fixtures with ground-truth `expected-detections.json` for scanner regression.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cli/commands/standards-scan.ts` | Create | `scan` subcommand handler |
| `plugins/autonomous-dev/src/cli/commands/standards-show.ts` | Create | `show` subcommand handler |
| `plugins/autonomous-dev/src/cli/commands/standards-validate.ts` | Create | `validate` subcommand handler |
| `plugins/autonomous-dev/src/cli/commands/standards-index.ts` | Create | Registers subcommands with the CLI dispatcher |
| `plugins/autonomous-dev/src/cli/index.ts` | Modify | Wire `standards` namespace |
| `plugins/autonomous-dev/standards/defaults.yaml` | Create | Empty defaults file (`version: "1"`, empty rules) |
| `plugins/autonomous-dev/tests/fixtures/standards/valid/*.yaml` | Create | ≥30 valid fixtures |
| `plugins/autonomous-dev/tests/fixtures/standards/invalid/*.yaml` | Create | ≥20 invalid fixtures |
| `plugins/autonomous-dev/tests/fixtures/standards/INDEX.md` | Create | Catalog mapping fixture → expected behavior |
| `plugins/autonomous-dev/tests/fixtures/repos/<name>/` | Create | 20 repo dirs, each with config + `expected-detections.json` |
| `plugins/autonomous-dev/tests/fixtures/repos/INDEX.md` | Create | Catalog mapping repo → language/framework |

## Implementation Details

### CLI: `standards scan`

```typescript
export async function standardsScanCommand(args: {
  repo?: string; diff?: boolean; json?: boolean;
}): Promise<number> {
  const repoPath = path.resolve(args.repo ?? process.cwd());
  const result = await new AutoDetectionScanner(repoPath).scan();

  let payload: unknown = result;
  if (args.diff) {
    const existing = await loadStandardsFile(path.join(repoPath, ".autonomous-dev/standards.yaml"));
    const existingIds = new Set(existing.artifact?.rules.map(r => r.id) ?? []);
    payload = { additions: result.detected.filter(d => !existingIds.has(d.rule.id)), warnings: result.warnings };
  }

  if (args.json) process.stdout.write(JSON.stringify(payload, null, 2));
  else printTable(payload);

  await writeInferredStandards(repoPath, result.detected);  // always side-effect the inferred file
  return 0;
}
```

Tabular output: 4 columns (`id`, `confidence`, `signal`, `evidence`), width-truncated to 80 cols with `...`.

### CLI: `standards show`

```typescript
export async function standardsShowCommand(args: { rule?: string; json?: boolean }): Promise<number> {
  const def = (await loadStandardsFile(BUILTIN_DEFAULTS_PATH)).artifact;
  const org = (await loadStandardsFile(path.join(homedir(), ".claude/autonomous-dev/standards.yaml"))).artifact;
  const repo = (await loadStandardsFile(path.join(process.cwd(), ".autonomous-dev/standards.yaml"))).artifact;
  const resolved = resolveStandards(def?.rules ?? [], org?.rules ?? [], repo?.rules ?? [], []);

  if (args.rule) {
    const r = resolved.rules.get(args.rule);
    if (!r) { process.stderr.write(`Rule not found: ${args.rule}\n`); return 1; }
    const out = { rule: r, source: resolved.source.get(args.rule) };
    process.stdout.write(args.json ? JSON.stringify(out, null, 2) : formatRuleDetail(out));
    return 0;
  }

  printResolvedTable([...resolved.rules.values()], resolved.source);  // id | severity | source | description
  return 0;
}
```

Missing org/repo files (loader returns `artifact: null`) are treated as empty rule sets, not errors.

### CLI: `standards validate`

```typescript
export async function standardsValidateCommand(args: { path: string }): Promise<number> {
  const result = await loadStandardsFile(args.path);
  if (result.errors.length === 0) {
    process.stdout.write(`OK: ${args.path} validates against standards-v1.json\n`);
    return 0;
  }
  for (const e of result.errors) {
    const prefix = e.type === "schema_error" ? `ERROR ${e.path}` : `ERROR (${e.type})`;
    process.stderr.write(`${prefix}: ${e.message}\n`);
  }
  return 1;
}
```

### Standards Fixtures (`tests/fixtures/standards/`)

**Valid fixtures** (≥30 required). Required coverage matrix:

| Category | Required fixtures |
|----------|-------------------|
| Severity coverage | `single-advisory.yaml`, `single-warn.yaml`, `single-blocking.yaml` |
| Immutability | `immutable-org-rule.yaml`, `mutable-default-rule.yaml` |
| Predicate variety | `all-predicate-types.yaml` (language, service_type, framework, implements, path_pattern) |
| Assertion variety | `all-assertion-types.yaml` (framework_match, exposes_endpoint, uses_pattern, excludes_pattern, dependency_present, custom_evaluator_args) |
| Bundle examples | `python-fastapi-bundle.yaml` (5 rules), `node-express-bundle.yaml` (5 rules) |
| Edge cases | `empty-rules.yaml`, `unicode-descriptions.yaml`, `edge-long-id.yaml`, `large-100-rules.yaml` (perf testing) |
| Filler | 15+ additional permutations of severity × predicate × assertion to reach 30 |

**Invalid fixtures** (≥20 required). Each has a header comment documenting the expected error type:

| Fixture | Expected error |
|---------|---------------|
| `missing-version.yaml`, `missing-metadata.yaml`, `missing-evaluator.yaml` | `schema_error` (required field) |
| `wrong-version.yaml` | `schema_error` (const mismatch on `version`) |
| `bad-id-no-namespace.yaml`, `bad-id-uppercase.yaml`, `bad-id-spaces.yaml` | `schema_error` (pattern mismatch) |
| `bad-severity.yaml` | `schema_error` (enum violation) |
| `empty-predicate.yaml`, `empty-assertion.yaml` | `schema_error` (minProperties) |
| `extra-toplevel-key.yaml`, `extra-rule-key.yaml` | `schema_error` (additionalProperties) |
| `non-iso-date.yaml` | `schema_error` (format violation) |
| `yaml-syntax-error.yaml` | `parse_error` |
| `yaml-rce-python-object.yaml`, `yaml-rce-js-function.yaml` | `parse_error` (rejected by FAILSAFE_SCHEMA) |
| `exceeds-1mb.yaml` | `size_exceeded` (generated at test setup, not committed) |
| 5+ additional permutations | various |

`INDEX.md` is a markdown table with columns `filename | category | description | expected behavior` consumed by SPEC-021-1-05 tests.

### Repo Fixtures (`tests/fixtures/repos/`)

20 repo directories (config files only — no full source trees):

| # | Name | Contents | Primary signal under test |
|---|------|----------|---------------------------|
| 1 | `python-fastapi/` | `requirements.txt` with fastapi, uvicorn | framework-dep |
| 2 | `python-flask/` | `requirements.txt` with flask | framework-dep |
| 3 | `python-django/` | `requirements.txt` with django | framework-dep |
| 4 | `python-pyproject-fastapi/` | `pyproject.toml` `[tool.poetry.dependencies]` with fastapi | framework-dep (pyproject path) |
| 5 | `node-express/` | `package.json` with express | framework-dep |
| 6 | `node-react/` | `package.json` with react, react-dom | framework-dep |
| 7 | `node-vue/` | `package.json` with vue@3 | framework-dep |
| 8 | `node-angular/` | `package.json` with @angular/core | framework-dep |
| 9 | `vanilla-js/` | `package.json` with no framework deps | negative case |
| 10 | `typescript-strict/` | `tsconfig.json` strict: true | tsconfig-strict |
| 11 | `typescript-non-strict/` | `tsconfig.json` strict: false | tsconfig-strict (negative) |
| 12 | `typescript-partial-strict/` | only `strictNullChecks` set | tsconfig-strict (partial) |
| 13 | `eslint-only/` | `.eslintrc.json` with 5 rules | linter-config |
| 14 | `prettier-only/` | `.prettierrc` (json) | formatter-config |
| 15 | `prettier-yaml/` | `.prettierrc.yaml` | formatter-config (variant) |
| 16 | `jest-configured/` | `jest.config.js` with testMatch | test-runner-pattern |
| 17 | `jest-via-package-json/` | `package.json` with `jest` field | test-runner-pattern (variant) |
| 18 | `readme-mentions-black/` | `README.md` mentions Black | readme-mention |
| 19 | `multi-signal/` | express + tsconfig strict + .eslintrc + .prettierrc | combined |
| 20 | `empty-repo/` | only `.gitkeep` | empty-input edge case |

Each dir contains `expected-detections.json`:

```json
{
  "expected": [{ "ruleId": "auto:python-fastapi", "confidence": 0.9, "signal": "framework-dep" }],
  "notExpected": ["auto:python-flask"]
}
```

`INDEX.md` documents each repo's purpose and category.

## Acceptance Criteria

### CLI
- [ ] `autonomous-dev standards scan` against a fixture repo prints a tabular list and writes `.autonomous-dev/standards.inferred.yaml`.
- [ ] `standards scan --json` emits valid JSON parseable by `jq -e .`.
- [ ] `standards scan --diff` shows only additions (rules in scanner output absent from existing standards.yaml).
- [ ] `standards show` (no args) prints all resolved rules in a 4-column table (id, severity, source, description).
- [ ] `standards show --rule <id>` prints full definition + source; exits 1 with a clear message if not found.
- [ ] `standards show --json` emits valid JSON.
- [ ] `standards show` treats missing org/repo files as empty rule sets (no error).
- [ ] `standards validate <valid.yaml>` exits 0 and prints `OK:` line.
- [ ] `standards validate <invalid.yaml>` exits 1 with one error line per problem and the schema path.
- [ ] All 20+ invalid fixtures fail under `standards validate` with the expected error type.
- [ ] All three subcommands appear in `autonomous-dev standards --help`.

### Fixture corpus
- [ ] `tests/fixtures/standards/valid/` contains ≥30 `.yaml` files; all validate clean.
- [ ] `tests/fixtures/standards/invalid/` contains ≥20 `.yaml` files; each fails with the documented error type.
- [ ] Valid fixtures cover all rows of the required-coverage matrix (severity, immutability, predicate variety, assertion variety, edge cases).
- [ ] Invalid fixtures cover all categories of schema error (required-field, pattern, enum, minProperties, additionalProperties, format) plus YAML safe-load rejections.
- [ ] `tests/fixtures/repos/` contains all 20 repo dirs from the matrix.
- [ ] Every repo fixture has `expected-detections.json` with `expected` and `notExpected` arrays.
- [ ] Both `INDEX.md` files exist and document every fixture.
- [ ] Total fixture corpus stays under 2MB combined.

## Dependencies

- SPEC-021-1-01, SPEC-021-1-02, SPEC-021-1-03 merged.
- Existing CLI dispatcher: `standards` namespace registers alongside other CLI verbs.
- No new runtime deps; reuse the dispatcher's existing CLI framework (commander or equivalent).

## Notes

- `standards/defaults.yaml` is empty in v1 (`version: "1"`, stub metadata, empty rules). PLAN-021-2 catalog work and PLAN-020-1 review baseline populate it. The empty file ensures the loader path does not error.
- `--diff` shows additions only, not removals/changes, because the scanner cannot distinguish "operator removed deliberately" from "scanner cannot detect this signal". Documented in the `--help` text per TDD-021 §9.
- Repo fixtures are config-only to keep the corpus small. Future signals (e.g., "used in 80%+ files") will need richer fixtures; deferred to v1.1.
- INDEX.md files double as test inventories: SPEC-021-1-05 iterates them to generate test cases, so adding a fixture automatically extends coverage.
- `exceeds-1mb.yaml` is generated at test setup, not committed as a 1MB+ binary. INDEX.md documents the generation script.
- These CLI commands are operator tooling; they do not require a Jira ticket or session context.
