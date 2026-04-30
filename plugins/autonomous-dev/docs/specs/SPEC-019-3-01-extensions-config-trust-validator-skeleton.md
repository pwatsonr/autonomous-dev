# SPEC-019-3-01: Extensions Config Schema & TrustValidator Class Skeleton

## Metadata
- **Parent Plan**: PLAN-019-3
- **Tasks Covered**: Task 1 (extensions config schema), Task 2 (TrustValidator class skeleton)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-019-3-01-extensions-config-trust-validator-skeleton.md`

## Description
Lay the foundation for plugin trust enforcement: extend the global `~/.claude/autonomous-dev.json` config schema with the `extensions` section per TDD-019 §10.1, and author the `TrustValidator` class scaffold that implements the seven-step validation order from TDD-019 §10.2. This spec is structural — it adds the configuration surface and the class skeleton with all seven step methods declared, but leaves the per-mode logic, signature verification, and meta-review trigger to subsequent specs (SPEC-019-3-02 through SPEC-019-3-04). The result is a compiling, importable `TrustValidator` that returns a stub verdict and a config schema that round-trips through `config init` / `config validate` cleanly.

The config additions ship with safe defaults (allowlist mode, empty allowlists, signature verification off, conservative resource limits) so existing operators are not broken by the upgrade. Existing configs without the `extensions` section are auto-upgraded with defaults on next save.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/autonomous-dev-config.schema.json` | Modify | Add `extensions` object with all sub-properties |
| `plugins/autonomous-dev/config_defaults.json` | Modify | Add default `extensions` block matching schema defaults |
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Create | `TrustValidator` class with seven step methods (stubbed) |
| `plugins/autonomous-dev/src/hooks/types.ts` | Modify | Add `TrustVerdict`, `ExtensionsConfig`, `TrustMode` types |
| `plugins/autonomous-dev/src/config/upgrader.ts` | Modify | Auto-upgrade configs missing `extensions` section |

## Implementation Details

### Config Schema — `extensions` section

Add to `autonomous-dev-config.schema.json` under `properties`:

```json
"extensions": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "allowlist": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[a-z0-9.-]+$" },
      "default": []
    },
    "privileged_reviewers": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[a-z0-9.-]+$" },
      "default": []
    },
    "trust_mode": {
      "type": "string",
      "enum": ["allowlist", "permissive", "strict"],
      "default": "allowlist"
    },
    "signature_verification": { "type": "boolean", "default": false },
    "auto_update_allowed": { "type": "boolean", "default": false },
    "max_plugins_per_hook_point": {
      "type": "integer", "minimum": 1, "maximum": 100, "default": 5
    },
    "global_resource_limits": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_total_memory_mb": { "type": "integer", "minimum": 16, "default": 256 },
        "max_concurrent_executions": { "type": "integer", "minimum": 1, "default": 8 },
        "max_execution_time_seconds": { "type": "integer", "minimum": 1, "default": 30 }
      },
      "default": { "max_total_memory_mb": 256, "max_concurrent_executions": 8, "max_execution_time_seconds": 30 }
    }
  },
  "default": {}
}
```

### `config_defaults.json` Block

```json
"extensions": {
  "allowlist": [],
  "privileged_reviewers": [],
  "trust_mode": "allowlist",
  "signature_verification": false,
  "auto_update_allowed": false,
  "max_plugins_per_hook_point": 5,
  "global_resource_limits": {
    "max_total_memory_mb": 256,
    "max_concurrent_executions": 8,
    "max_execution_time_seconds": 30
  }
}
```

### `TrustValidator` Class Skeleton

```ts
// src/hooks/trust-validator.ts
import type { HookManifest } from './types';
import type { ExtensionsConfig, TrustVerdict } from './types';
import type { ValidationPipeline } from './validation-pipeline';

export class TrustValidator {
  constructor(
    private readonly config: ExtensionsConfig,
    private readonly validationPipeline: ValidationPipeline,
    private readonly trustedKeysDir: string,
  ) {}

  /** Runs seven-step order from TDD-019 §10.2. Returns verdict + meta-review flag. */
  async validatePlugin(manifest: HookManifest, manifestPath: string): Promise<TrustVerdict> {
    const steps = [
      () => this.stepManifestSyntax(manifest, manifestPath),
      () => this.stepTrustStatus(manifest),
      () => this.stepSignatureVerification(manifest, manifestPath),
      () => this.stepCapabilityValidation(manifest),
      () => this.stepMetaReviewerAudit(manifest),
      () => this.stepDependencyResolution(manifest),
      () => this.stepRegistration(manifest),
    ];
    for (const step of steps) {
      const result = await step();
      if (!result.trusted) return result;
    }
    return { trusted: true, requiresMetaReview: false };
  }

  /** O(1) runtime check used by the executor before each invocation. */
  isTrusted(pluginId: string): boolean {
    // Implemented in SPEC-019-3-04
    return this.config.allowlist.includes(pluginId);
  }

  // --- Seven steps (stubs return trusted; filled in by 019-3-02..04) ---
  private async stepManifestSyntax(_m: HookManifest, _p: string): Promise<TrustVerdict> { return { trusted: true, requiresMetaReview: false }; }
  private async stepTrustStatus(_m: HookManifest): Promise<TrustVerdict> { return { trusted: true, requiresMetaReview: false }; }
  private async stepSignatureVerification(_m: HookManifest, _p: string): Promise<TrustVerdict> { return { trusted: true, requiresMetaReview: false }; }
  private async stepCapabilityValidation(_m: HookManifest): Promise<TrustVerdict> { return { trusted: true, requiresMetaReview: false }; }
  private async stepMetaReviewerAudit(_m: HookManifest): Promise<TrustVerdict> { return { trusted: true, requiresMetaReview: false }; }
  private async stepDependencyResolution(_m: HookManifest): Promise<TrustVerdict> { return { trusted: true, requiresMetaReview: false }; }
  private async stepRegistration(_m: HookManifest): Promise<TrustVerdict> { return { trusted: true, requiresMetaReview: false }; }
}
```

### Type Additions — `src/hooks/types.ts`

```ts
export type TrustMode = 'allowlist' | 'permissive' | 'strict';

export interface ExtensionsConfig {
  allowlist: string[];
  privileged_reviewers: string[];
  trust_mode: TrustMode;
  signature_verification: boolean;
  auto_update_allowed: boolean;
  max_plugins_per_hook_point: number;
  global_resource_limits: {
    max_total_memory_mb: number;
    max_concurrent_executions: number;
    max_execution_time_seconds: number;
  };
}

export interface TrustVerdict {
  trusted: boolean;
  reason?: string;
  requiresMetaReview: boolean;
  metaReviewVerdict?: { pass: boolean; findings: string[] };
}
```

### Auto-upgrade Behavior

`src/config/upgrader.ts` reads the config; if `extensions` is missing, it merges in the `config_defaults.json` block, writes a backup at `~/.claude/autonomous-dev.json.bak.<ISO-timestamp>`, and writes the upgraded config atomically (temp file + rename).

## Acceptance Criteria

- [ ] `autonomous-dev config init --global` produces a config containing the full `extensions` block with all seven sub-keys.
- [ ] `autonomous-dev config validate` against a fresh init returns exit 0.
- [ ] `autonomous-dev config validate` against a config with `trust_mode: "invalid"` exits non-zero with a schema error mentioning the enum.
- [ ] An existing config without `extensions` is auto-upgraded on next save; original is preserved at `~/.claude/autonomous-dev.json.bak.<timestamp>`.
- [ ] `TrustValidator` exports a public class with `validatePlugin(manifest, path)` and `isTrusted(id)` methods.
- [ ] Each of the seven private step methods exists, is async, and returns `TrustVerdict`. Method names match TDD-019 §10.2 verbatim.
- [ ] TypeScript compiles with `tsc --noEmit` zero errors.
- [ ] `TrustVerdict`, `ExtensionsConfig`, `TrustMode` types are exported from `types.ts`.
- [ ] Schema defaults match `config_defaults.json` byte-for-byte (a unit test asserts this).
- [ ] `max_plugins_per_hook_point` defaults to 5; `global_resource_limits.max_total_memory_mb` defaults to 256.

## Dependencies

- **PLAN-019-1** (blocking): provides `HookManifest` type and `ValidationPipeline` (consumed by step 1).
- **PLAN-019-2** (blocking): provides the `ValidationPipeline` class; this spec injects an instance.
- TDD-007 / existing config infrastructure: provides `config init`, `config validate`, atomic-write helper.
- No new npm dependencies in this spec; all crypto/agent-spawn work happens in 019-3-03 and later.

## Notes

- The seven step methods are intentionally stubbed to return trusted verdicts. Subsequent specs (019-3-02, 019-3-03, 019-3-04) replace each stub with real logic. Splitting this way lets the class be merged, imported, and unit-tested for shape before the security-critical content lands.
- The `isTrusted(pluginId)` runtime check is also stubbed here as a simple allowlist lookup; 019-3-04 wraps it with the audit-log emission and revocation handling.
- Configs are mutated only via atomic write (temp file + rename) and always backed up first; the upgrader follows the same pattern that `plugin trust` / `plugin revoke` will use in 019-3-04.
- The schema's `additionalProperties: false` is deliberate: unknown keys under `extensions` are a configuration error, not a forward-compat hint. New keys land via schema bumps in subsequent specs.
- Defaults are conservative-by-design: allowlist mode + empty allowlist means a fresh install registers no plugins until the operator explicitly trusts them.
