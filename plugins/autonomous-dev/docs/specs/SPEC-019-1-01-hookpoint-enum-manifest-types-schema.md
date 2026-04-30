# SPEC-019-1-01: HookPoint Enum, HookManifest Types, and JSON Schema

## Metadata
- **Parent Plan**: PLAN-019-1
- **Tasks Covered**: Task 1 (HookPoint enum + HookManifest types), Task 2 (hook-manifest-v1.json schema)
- **Estimated effort**: 4 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-1-01-hookpoint-enum-manifest-types-schema.md`

## Description
Define the foundational TypeScript types and JSON Schema that every other piece of the hook engine consumes. This spec establishes the canonical name list of the 10 hook points from TDD-019 §9, the in-memory shape of a parsed plugin manifest, the failure-mode taxonomy, the capability flag set used by sandbox isolation, and the on-disk JSON Schema (Draft 2020-12) that `PluginDiscovery` will validate against. No runtime behavior, no I/O, no class instances — pure type and schema declarations.

The types declared here are imported by SPEC-019-1-02 (discovery), SPEC-019-1-03 (registry + executor), SPEC-019-1-04 (CLI + reload), and SPEC-019-1-05 (tests), and by sibling plans PLAN-019-2/3/4. The schema is consumed by SPEC-019-1-02 to validate manifests at scan time.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/types.ts` | Create | HookPoint enum, HookManifest, HookEntry, FailureMode, Capability |
| `plugins/autonomous-dev/schemas/hook-manifest-v1.json` | Create | JSON Schema Draft 2020-12 for HookManifest |
| `plugins/autonomous-dev/src/hooks/index.ts` | Create | Barrel re-export of types for downstream consumers |

## Implementation Details

### `src/hooks/types.ts`

```ts
/**
 * The 10 hook points the autonomous-dev daemon emits.
 * See TDD-019 §9 for the canonical catalog and lifecycle semantics.
 */
export enum HookPoint {
  IntakePreValidate = 'intake-pre-validate',
  PrdPreAuthor = 'prd-pre-author',
  TddPreAuthor = 'tdd-pre-author',
  CodePreWrite = 'code-pre-write',
  CodePostWrite = 'code-post-write',
  ReviewPreScore = 'review-pre-score',
  ReviewPostScore = 'review-post-score',
  DeployPre = 'deploy-pre',
  DeployPost = 'deploy-post',
  RuleEvaluation = 'rule-evaluation',
}

/** Behavior when a hook returns a non-OK result or throws. */
export enum FailureMode {
  Block = 'block',   // halt the lifecycle stage
  Warn = 'warn',     // log and continue
  Ignore = 'ignore', // silently continue
}

/** Capability flags requested by a hook (enforced by future sandbox layer). */
export type Capability =
  | 'filesystem-write'
  | 'network'
  | 'child-processes'
  | 'privileged-env';

export interface HookEntry {
  /** Stable identifier within the plugin (kebab-case). */
  id: string;
  hook_point: HookPoint;
  /** Path relative to plugin root, e.g. `./hooks/validate.js`. */
  entry_point: string;
  /** Higher numbers run first. Stable sort preserves insertion order on ties. */
  priority: number;
  failure_mode: FailureMode;
  /** Optional reviewer-slot binding (semantics in PLAN-019-4). */
  reviewer_slot?: string;
  /** Other plugin ids this hook depends on. */
  dependencies?: string[];
  /** Capabilities the hook requests; sandbox enforces in a future plan. */
  capabilities?: Capability[];
}

export interface HookManifest {
  /** Globally unique plugin id (kebab-case). */
  id: string;
  name: string;
  /** Semver string. */
  version: string;
  hooks: HookEntry[];
}
```

JSDoc on each type must reference TDD-019 §9 (hook-point catalog) and §13.1 (manifest fields).

### `schemas/hook-manifest-v1.json`

Draft 2020-12 schema. `additionalProperties: false` at every object level. Required top-level fields: `id`, `name`, `version`, `hooks`. Required hook-entry fields: `id`, `hook_point`, `entry_point`, `priority`, `failure_mode`. Patterns:
- `id` (top-level and per-hook): `^[a-z][a-z0-9-]*$` (kebab-case, no leading digit, no underscores).
- `version`: standard semver regex (e.g. `^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$`).
- `hook_point`: enum of the 10 string values from `HookPoint`.
- `failure_mode`: enum `["block", "warn", "ignore"]`.
- `priority`: integer, range `0..1000` inclusive.
- `capabilities[]`: items enum of the 4 capability strings.
- `entry_point`: pattern `^\./.+\.(js|cjs|mjs)$` (relative path, JS file).

Include an `examples` array with one fully-populated valid manifest (id `example-validator`, one hook at `intake-pre-validate`, priority 100, failure_mode `warn`).

### `src/hooks/index.ts`

```ts
export * from './types';
```

(Discovery, registry, executor exports added by their respective specs.)

## Acceptance Criteria

- [ ] `src/hooks/types.ts` compiles under `tsc --strict --noEmit` with zero errors.
- [ ] `HookPoint` enum exports exactly 10 members; the string values match the kebab-case names in TDD-019 §9.
- [ ] `FailureMode` enum exports exactly 3 members: `Block`, `Warn`, `Ignore`.
- [ ] `Capability` union type exports exactly 4 string literals.
- [ ] `HookEntry` declares all required fields (`id`, `hook_point`, `entry_point`, `priority`, `failure_mode`) as non-optional and the documented optional fields (`reviewer_slot`, `dependencies`, `capabilities`) as optional.
- [ ] `HookManifest` declares `id`, `name`, `version`, `hooks` as non-optional.
- [ ] JSDoc on `HookPoint` references `TDD-019 §9`; JSDoc on `HookManifest` references `TDD-019 §13.1`.
- [ ] `schemas/hook-manifest-v1.json` parses cleanly (`jq -e . schemas/hook-manifest-v1.json` exit 0).
- [ ] Schema's top-level `$schema` is `https://json-schema.org/draft/2020-12/schema`.
- [ ] Schema validates the embedded `examples[0]` manifest (round-trip test).
- [ ] Schema rejects a manifest missing `id` with an error pointing at `/required`.
- [ ] Schema rejects `failure_mode: "panic"` with an enum error.
- [ ] Schema rejects an extra top-level field (e.g. `author`) due to `additionalProperties: false`.
- [ ] Schema rejects a `priority` of `1500` (out of 0..1000 range).
- [ ] Schema rejects a `version` of `1.0` (not semver).
- [ ] `src/hooks/index.ts` re-exports all named exports from `./types`.

## Dependencies

- TypeScript ≥ 5.0 with `strict: true` in `tsconfig.json` (already in repo per PLAN-001-1).
- No new npm packages (schema is hand-written JSON; AJV is introduced by PLAN-019-2).
- TDD-019 §9 (hook-point catalog) and §13.1 (manifest fields) — read-only references.

## Notes

- The schema lives under `schemas/` (not `src/`) so it can be shipped as a static asset and consumed by external tooling (e.g., editor JSON-schema validation in plugin authors' IDEs).
- `priority` range `0..1000` is chosen so plugins can space themselves comfortably; reserved bands (0..99 system, 100..899 user, 900..1000 emergency) will be documented in a follow-up but are not enforced by this schema.
- `entry_point` is restricted to relative JS paths to keep PLAN-019-1 in-process; future plans (sandbox, TS plugin support) will widen this pattern.
- `dependencies` are declared but not resolved by this plan; PLAN-019-3 (trust) and PLAN-019-4 (execution) consume them.
- The `Capability` set is closed-world here so the type checker can flag typos in plugin authors' manifests; new capabilities require a schema bump (`hook-manifest-v2.json`).
