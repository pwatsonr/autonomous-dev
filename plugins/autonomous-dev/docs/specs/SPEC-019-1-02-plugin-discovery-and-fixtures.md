# SPEC-019-1-02: PluginDiscovery Class and Fixture Plugins

## Metadata
- **Parent Plan**: PLAN-019-1
- **Tasks Covered**: Task 3 (PluginDiscovery class), Task 8 (fixture plugins for tests)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-1-02-plugin-discovery-and-fixtures.md`

## Description
Implement the boot-time plugin discovery layer that walks `~/.claude/plugins/*/hooks.json`, parses each manifest, validates it structurally against the schema from SPEC-019-1-01, and returns a list of `{plugin, errors[]}` results. Trust enforcement, signature verification, and the full AJV validation pipeline are layered on by sibling plans (PLAN-019-2/3); this spec is structural validation only. Also produce three fixture plugin trees that downstream specs (registry, executor, integration test) consume.

Discovery is intentionally one-level deep (`<rootDir>/<plugin>/hooks.json`) to bound the search and avoid surprises. Symlinks to plugin directories are followed (so `npm link` works for plugin authors), but symlinks inside the manifest's parent directory are NOT followed when reading `entry_point` files (defense-in-depth against malicious plugins linking into `/etc`).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/hooks/discovery.ts` | Create | PluginDiscovery class |
| `plugins/autonomous-dev/src/hooks/index.ts` | Modify | Add `export * from './discovery';` |
| `plugins/autonomous-dev/tests/fixtures/plugins/simple/hooks.json` | Create | Valid manifest, 1 hook |
| `plugins/autonomous-dev/tests/fixtures/plugins/simple/hook.js` | Create | Echo entry-point |
| `plugins/autonomous-dev/tests/fixtures/plugins/multi-hook/hooks.json` | Create | Valid manifest, 3 hooks at priorities 100/50/75 |
| `plugins/autonomous-dev/tests/fixtures/plugins/multi-hook/hooks/{a,b,c}.js` | Create | Three echo entry-points |
| `plugins/autonomous-dev/tests/fixtures/plugins/malformed/hooks.json` | Create | Missing required `id` field |

## Implementation Details

### `src/hooks/discovery.ts`

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HookManifest } from './types';

export interface DiscoveryError {
  /** Absolute path to the offending manifest. */
  manifestPath: string;
  /** Machine code. */
  code: 'PARSE_ERROR' | 'SCHEMA_ERROR' | 'IO_ERROR';
  /** Human message. */
  message: string;
  /** Optional JSON Pointer into the manifest (e.g. `/hooks/0/priority`). */
  pointer?: string;
}

export interface DiscoveryResult {
  manifestPath: string;
  manifest?: HookManifest;
  errors: DiscoveryError[];
}

export class PluginDiscovery {
  constructor(private readonly schemaValidator: (m: unknown) => DiscoveryError[]) {}

  /** Walk `<rootDir>/<plugin>/hooks.json`, one level deep. */
  async scan(rootDir: string): Promise<DiscoveryResult[]> { /* ... */ }

  async parseManifest(manifestPath: string): Promise<DiscoveryResult> { /* ... */ }

  validateManifest(raw: unknown, manifestPath: string): DiscoveryError[] {
    return this.schemaValidator(raw);
  }
}
```

Behavior contract:

1. `scan(rootDir)`:
   - `await fs.readdir(rootDir, { withFileTypes: true })` — entries that are directories (or symlinks to directories) are candidates.
   - For each candidate, build `path.join(rootDir, name, 'hooks.json')` and stat it. If it does not exist, skip silently (a directory without `hooks.json` is not a plugin, not an error).
   - Read all candidate manifests concurrently via `Promise.all` for performance (50-plugin scan must complete in < 100ms on local SSD).
   - Returns `DiscoveryResult[]` — one per candidate manifest, in stable lexicographic order of plugin directory name.
2. `parseManifest(manifestPath)`:
   - Reads the file with UTF-8 encoding.
   - `JSON.parse` failure → returns a single `PARSE_ERROR` with the parser's error message (no `manifest` field).
   - Success → calls `validateManifest`. If there are no errors, the result includes `manifest` typed as `HookManifest`.
3. `validateManifest(raw, manifestPath)`:
   - Delegates to the injected `schemaValidator`. The validator is a function so this spec does NOT depend on AJV; PLAN-019-2 wires AJV in. For SPEC-019-1-05's tests, a hand-rolled minimal validator (checks required top-level fields) is acceptable and is provided by the test harness.

Defensive rules:
- Path canonicalization: `path.resolve(rootDir, name)` must remain a child of `path.resolve(rootDir)`. Reject (with `IO_ERROR`) any candidate whose canonical path escapes `rootDir`.
- Directory entry name validation: skip names starting with `.` (hidden), skip files (only directories/symlinks).
- Unicode plugin names: pass through untouched. Filesystem APIs already handle UTF-8.
- The scanner itself does NOT recurse into the plugin directory beyond reading `hooks.json` — that is, it does not require, eval, or otherwise execute plugin code. Execution lives in SPEC-019-1-03.

Logging contract: use `console.info` for now (will be wired through PLAN-001-3's logger when that lands). Emit one INFO line per discovered plugin (success or failure), formatted: `discovery: <pluginId|UNKNOWN> @ <manifestPath> -> <ok|N errors>`.

### Fixture Plugin: `simple/`

`hooks.json`:
```json
{
  "id": "simple",
  "name": "Simple Test Plugin",
  "version": "1.0.0",
  "hooks": [
    { "id": "echo", "hook_point": "intake-pre-validate", "entry_point": "./hook.js", "priority": 100, "failure_mode": "warn" }
  ]
}
```

`hook.js`:
```js
module.exports = function echo(context) {
  return { ok: true, fixture: 'simple', received: context };
};
```

### Fixture Plugin: `multi-hook/`

`hooks.json` declares 3 hooks at the same `hook_point` (`code-pre-write`) with priorities `100`, `50`, `75` (in that declaration order — discovery does not reorder; ordering is the registry's job per SPEC-019-1-03). Each hook's `entry_point` is `./hooks/a.js`, `./hooks/b.js`, `./hooks/c.js` respectively. Each entry-point echoes a `marker` field so tests can assert call order:

```js
module.exports = function(context) {
  return { ok: true, fixture: 'multi-hook', marker: 'a', received: context };
};
```

### Fixture Plugin: `malformed/`

`hooks.json` is structurally invalid in exactly one way: the top-level `id` field is missing. All other required fields are present. This produces a single, predictable schema error that SPEC-019-1-05's tests can lock in.

```json
{
  "name": "Malformed",
  "version": "1.0.0",
  "hooks": []
}
```

No `entry_point` JS file exists for malformed (validation fails before any reference would be resolved).

## Acceptance Criteria

- [ ] `PluginDiscovery.scan('<dir>')` returns `DiscoveryResult[]` length 3 when given a directory containing `simple/`, `multi-hook/`, `malformed/`.
- [ ] `simple` and `multi-hook` results have `manifest` populated and `errors` empty.
- [ ] `malformed` result has `manifest` undefined and `errors.length === 1` with `code === 'SCHEMA_ERROR'` and `pointer === '/id'` (or equivalent locator referencing the missing field).
- [ ] Scan completes in < 100ms for a fixture directory containing 50 valid plugins (perf benchmark, p95 on local SSD).
- [ ] Scan with a non-existent `rootDir` resolves to `[]` (not a thrown error). A log line at INFO records the missing root.
- [ ] Symlink in `rootDir` pointing to a real plugin directory is followed and the linked plugin appears in results.
- [ ] A directory entry whose canonical path escapes `rootDir` (constructed via symlink to `..`) is skipped and emits a `IO_ERROR` result.
- [ ] Plugin directory name with non-ASCII characters (e.g. `héllo-plugin`) is discovered and the manifest's `id` round-trips through the result without mojibake.
- [ ] Files (not directories) at the top level of `rootDir` are silently skipped (no error).
- [ ] Hidden directories (name starts with `.`) are silently skipped.
- [ ] `parseManifest` on a file containing `not json` returns one `PARSE_ERROR` with the JSON parser's message text.
- [ ] `validateManifest` with the injected schemaValidator returns the validator's exact error list (no transformation).
- [ ] Discovery does NOT load, require, or execute any plugin entry-point files (verified by spying on `require`).
- [ ] Fixture `simple/hooks.json` validates against `schemas/hook-manifest-v1.json`.
- [ ] Fixture `multi-hook/hooks.json` validates against `schemas/hook-manifest-v1.json` and contains 3 hook entries.
- [ ] Fixture `malformed/hooks.json` fails schema validation with a single error at `/id` (`required` keyword).
- [ ] Each fixture entry-point JS file is a valid CommonJS module exporting a function.
- [ ] `src/hooks/index.ts` re-exports `PluginDiscovery`, `DiscoveryError`, `DiscoveryResult`.

## Dependencies

- SPEC-019-1-01 (types and schema) — imported.
- Node ≥ 18 (`fs/promises`, `path` core modules).
- No new npm packages.

## Notes

- The injected `schemaValidator` parameter keeps this spec independent of AJV. PLAN-019-2 will provide an AJV-backed validator and wire it through the daemon's DI graph. For tests in SPEC-019-1-05, a tiny hand-rolled validator (≤ 30 lines) suffices to assert the discovery flow.
- `concurrent reads via Promise.all` is critical for hitting the 100ms perf target on directories with many plugins. Avoid `for await` of `readdir` results for the manifest reads.
- The malformed fixture is intentionally minimal so the test assertion is exact: tests can compare against `/id` literally without brittleness.
- Discovery is read-only by design. Any future plan that needs write access (e.g., caching parse results) must add a separate writer; this class never writes to disk.
- Logging via `console.info` is a placeholder. The logger interface from PLAN-001-3 will replace it without changing the discovery API.
