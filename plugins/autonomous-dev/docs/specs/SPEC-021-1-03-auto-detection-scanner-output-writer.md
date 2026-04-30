# SPEC-021-1-03: AutoDetectionScanner + Scanner Output Writer

## Metadata
- **Parent Plan**: PLAN-021-1
- **Tasks Covered**: Task 5 (AutoDetectionScanner), Task 6 (scanner output writer)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-1-03-auto-detection-scanner-output-writer.md`
- **Depends on**: SPEC-021-1-01 (types), SPEC-021-1-02 (loader for valid-YAML round-trip checks in tests)

## Description
Build the auto-detection pipeline that scans a repository for known signals (linter configs, framework deps, formatter configs, test runners, tsconfig, README mentions) and emits `DetectedRule[]` annotated with confidence scores and evidence. Operators run the scanner against an unfamiliar repo to bootstrap a `standards.yaml` instead of writing one by hand.

The scanner is "best effort" by design: it surfaces signals, the operator promotes them. Output is written to `<repo>/.autonomous-dev/standards.inferred.yaml` with confidence/evidence as YAML comments alongside each rule. The inferred file validates against `standards-v1.json` after stripping comments — operators can copy individual rules into the canonical `standards.yaml`.

This spec ships:
- `AutoDetectionScanner` class in `auto-detection.ts` covering 6 distinct signal types per TDD-021 §9.
- `writeInferredStandards(repoPath, detected[])` writer that emits comment-annotated YAML deterministically.
- The confidence rubric implementation (0.9 / 0.85 / 0.8 / 0.7 / 0.6 / 0.4 per signal type).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/standards/auto-detection.ts` | Create | Scanner class + 6 signal handlers + output writer |
| `plugins/autonomous-dev/src/standards/auto-detection-types.ts` | Create | `DetectedRule`, `Signal`, `ScanResult` types |
| `plugins/autonomous-dev/src/standards/index.ts` | Modify | Re-export scanner and types |
| `plugins/autonomous-dev/package.json` | Modify | Add `glob@^10.0.0` for file pattern enumeration |

## Implementation Details

### Types (`auto-detection-types.ts`)

```typescript
import type { Rule } from "./types";

export interface DetectedRule {
  rule: Rule;                  // synthesized rule (id starts with "auto:")
  confidence: number;          // 0.0 .. 1.0
  evidence: string[];          // file paths (relative to repo root) supporting detection
  signal: SignalKind;          // which detector produced this
}

export type SignalKind =
  | "framework-dep"            // package.json / requirements.txt deps
  | "linter-config"            // .eslintrc.json
  | "formatter-config"         // .prettierrc
  | "tsconfig-strict"          // tsconfig.json compilerOptions.strict
  | "test-runner-pattern"      // jest.config.js testMatch
  | "readme-mention";          // README.md text mention

export interface ScanResult {
  detected: DetectedRule[];
  warnings: string[];          // soft warnings (e.g., "package.json has no deps key")
}
```

### Scanner (`auto-detection.ts`)

```typescript
export class AutoDetectionScanner {
  constructor(private readonly repoPath: string) {}

  async scan(): Promise<ScanResult> {
    const detected: DetectedRule[] = [];
    const warnings: string[] = [];

    detected.push(...await this.detectFrameworkDeps());     // signals from package.json + requirements.txt + pyproject.toml
    detected.push(...await this.detectLinterConfig());      // .eslintrc.json (and .yml variants)
    detected.push(...await this.detectFormatterConfig());   // .prettierrc (json/yaml/js)
    detected.push(...await this.detectTsconfigStrict());    // tsconfig.json
    detected.push(...await this.detectTestRunnerPattern()); // jest.config.{js,json,ts}
    detected.push(...await this.detectReadmeMentions());    // README.md grep for known tools

    return { detected, warnings };
  }

  // ... per-signal handlers (private async methods)
}
```

### Confidence Rubric (per TDD-021 §9)

| Signal | Confidence | Trigger |
|--------|-----------|---------|
| Framework dep in package.json/requirements.txt | 0.9 | Explicit dependency entry |
| Linter config rule | 0.9 | Rule listed in `.eslintrc.json` `rules` |
| Prettier config present | 0.9 | `.prettierrc` (any extension) exists |
| tsconfig strict mode | 0.85 | `compilerOptions.strict: true` |
| Used in 80%+ files | 0.8 | (reserved for v1.1; not implemented here) |
| Jest testMatch pattern | 0.7 | `testMatch` configured |
| README mention | 0.6 | Tool name appears in README.md as standalone token |
| Single example | 0.4 | (reserved for v1.1; not implemented here) |

### Per-signal detection details

**Framework deps** — Read `package.json`, `requirements.txt`, and `pyproject.toml`. Check against a known map:

```typescript
const FRAMEWORK_MAP: Record<string, { id: string; description: string }> = {
  "fastapi":   { id: "auto:python-fastapi",  description: "Detected FastAPI dependency" },
  "flask":     { id: "auto:python-flask",    description: "Detected Flask dependency" },
  "django":    { id: "auto:python-django",   description: "Detected Django dependency" },
  "express":   { id: "auto:node-express",    description: "Detected Express dependency" },
  "react":     { id: "auto:js-react",        description: "Detected React dependency" },
  "vue":       { id: "auto:js-vue",          description: "Detected Vue dependency" },
  "@angular/core": { id: "auto:js-angular",  description: "Detected Angular dependency" },
};
```

**Linter config** — If `.eslintrc.json` exists, emit `auto:eslint-configured` (confidence 0.9). For each top-level rule, emit `auto:eslint-<rule-name>` (kebab-cased) with confidence 0.9. Cap at 50 rules to avoid pathological output.

**Formatter** — If any `.prettierrc*` file exists, emit a single `auto:prettier-formatting` rule (confidence 0.9).

**tsconfig** — If `tsconfig.json` exists and `compilerOptions.strict === true`, emit `auto:typescript-strict-mode` (0.85). If only specific strict flags (e.g., `strictNullChecks`) are set, emit individual rules.

**Jest** — If a `jest.config.{js,ts,json,mjs,cjs}` or `package.json#jest` exists, emit `auto:test-file-pattern` with the `testMatch` pattern in `requires.uses_pattern` (0.7).

**README mentions** — Grep README.md (case-insensitive, word-boundary) for known tool names: `Black`, `isort`, `mypy`, `pytest`, `RuboCop`, `Standard`. For each match, emit `auto:readme-mentions-<tool>` (0.6).

### Output Writer

```typescript
export async function writeInferredStandards(
  repoPath: string,
  detected: DetectedRule[]
): Promise<{ path: string; bytes: number }> {
  const outPath = path.join(repoPath, ".autonomous-dev", "standards.inferred.yaml");
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // Sort detected rules deterministically by rule.id
  const sorted = [...detected].sort((a, b) => a.rule.id.localeCompare(b.rule.id));

  const lines: string[] = [];
  lines.push("# This file is auto-generated by `autonomous-dev standards scan`.");
  lines.push("# Review each rule and promote to standards.yaml after operator review.");
  lines.push("# Confidence and evidence are documented as comments next to each rule.");
  lines.push("");
  lines.push("version: \"1\"");
  lines.push("metadata:");
  lines.push("  name: \"Inferred Standards\"");
  lines.push("  description: \"Auto-detected from repo signals; not yet promoted.\"");
  lines.push("  owner: \"auto-detection-scanner\"");
  lines.push(`  last_updated: \"${new Date().toISOString().slice(0, 10)}\"`);
  lines.push("rules:");

  for (const d of sorted) {
    lines.push(`  # confidence: ${d.confidence.toFixed(2)}`);
    lines.push(`  # evidence: ${JSON.stringify(d.evidence)}`);
    lines.push(`  # signal: ${d.signal}`);
    // emit the rule as a YAML list item via js-yaml dump (block style, indent 2)
    const dumped = yaml.dump([d.rule], { indent: 2, lineWidth: 100, sortKeys: true });
    lines.push(...dumped.split("\n").map(l => l.length ? `  ${l}` : l));
  }

  const content = lines.join("\n");
  await fs.writeFile(outPath, content, "utf8");
  return { path: outPath, bytes: Buffer.byteLength(content) };
}
```

Determinism: sort detected by `rule.id`; sort YAML keys; format `last_updated` as date-only (not full timestamp) so two runs in the same UTC day produce byte-identical output.

## Acceptance Criteria

### Scanner
- [ ] Against a fixture FastAPI repo (`tests/fixtures/repos/python-fastapi/`), `scan()` returns `auto:python-fastapi` with confidence 0.9 and evidence `["requirements.txt"]` (or `["package.json"]` for Node-side).
- [ ] Against a fixture React repo, `scan()` returns `auto:js-react` with confidence 0.9.
- [ ] Against a no-config repo (only README.md, no package.json), `scan()` returns `[]` (or only readme-mention rules at 0.6).
- [ ] Scanner handles missing files gracefully — a repo without `package.json` does not throw; the framework-dep handler returns `[]`.
- [ ] Scanner handles malformed JSON in `package.json` — emits a warning, does not throw, continues other detections.
- [ ] At least 6 distinct signals are exercised across the test fixtures (framework-dep, linter-config, formatter-config, tsconfig-strict, test-runner-pattern, readme-mention).
- [ ] Linter rule cap: a `.eslintrc.json` with 100 rules emits at most 50 `auto:eslint-*` rules (with a warning about the cap).
- [ ] All synthesized rule IDs match the namespace pattern `^[a-z0-9-]+:[a-z0-9-]+$` (verified by re-validating each emitted rule against `standards-v1.json` minus the catalog reference).

### Writer
- [ ] `writeInferredStandards()` creates `<repo>/.autonomous-dev/standards.inferred.yaml`.
- [ ] Output starts with the documented 3-line header comment block.
- [ ] Each rule is preceded by `# confidence:`, `# evidence:`, and `# signal:` comments.
- [ ] Output (after stripping `#` comments) parses as valid YAML and validates against `standards-v1.json` (verified via SPEC-021-1-02 loader).
- [ ] Re-running the writer on identical input produces byte-identical output (determinism check via SHA-256 hash compare).
- [ ] Sorting the detected list before write: rules appear in alphabetical ID order in the output file.
- [ ] Writing to a path with a missing parent dir creates the dir (`mkdir -p` semantics).

## Dependencies

- SPEC-021-1-01 (types).
- SPEC-021-1-02 (loader, used in tests for round-trip validation of writer output).
- Runtime: `glob@^10.0.0` for `.prettierrc*` enumeration; `js-yaml` (already added in SPEC-021-1-02) for output serialization.

## Notes

- The "used in 80%+ files" and "single example" rubric tiers are marked reserved for v1.1. They require AST-aware scanning (e.g., counting React imports across `.tsx` files) which is more invasive than this spec scopes. Documented in `auto-detection.ts` JSDoc with a link to the future plan.
- The scanner deliberately does not promote any inferred rule to `standards.yaml` on its own — that requires operator review per TDD-021 §9. Auto-promotion is dangerous because false positives become enforced rules that fail builds for legitimate code.
- The 50-rule eslint cap exists because `.eslintrc.json` with `eslint:recommended + plugin:react/recommended + plugin:typescript-eslint/recommended-strict` can balloon to 200+ rules; promoting all of them to `standards.yaml` would drown the operator in noise.
- Comment placement (above each rule, not inline) is chosen for YAML round-trip stability: inline comments are fragile across YAML serializers, but block comments above a node are universally preserved when stripped.
- The synthesized `Rule.evaluator` field is set to `framework-detector` for framework-dep signals, `pattern-grep` for readme-mention, etc. — referencing the catalog PLAN-021-2 will ship. v1 documents that the inferred file's `evaluator` strings may not yet be valid until PLAN-021-2 lands; the operator can edit them when promoting.
- The writer emits `last_updated` as `YYYY-MM-DD` (not full timestamp) so two scanner runs on the same day produce identical output. This trades sub-day churn detection for determinism, which the operator review workflow prefers.
