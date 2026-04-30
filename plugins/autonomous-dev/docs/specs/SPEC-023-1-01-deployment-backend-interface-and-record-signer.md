# SPEC-023-1-01: DeploymentBackend Interface, Parameter Validation, and HMAC-Signed DeploymentRecord

## Metadata
- **Parent Plan**: PLAN-023-1
- **Tasks Covered**: Task 1 (DeploymentBackend interface + supporting types), Task 2 (parameter-validation framework), Task 3 (BuildContext + HMAC-signed DeploymentRecord)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-1-01-deployment-backend-interface-and-record-signer.md`

## Description
Establish the type-level contract and supporting primitives that every deployment backend in PLAN-023-1 must satisfy. This spec is the foundation other specs build on: it declares the `DeploymentBackend` TypeScript interface (per TDD-023 §5), the `BuildContext`/`DeployParameters`/`BuildArtifact`/`DeploymentRecord`/`HealthStatus`/`RollbackResult` supporting types (per TDD-023 §7), the server-side parameter-validation framework that prevents shell injection by rejecting metacharacters and path traversal, and the HMAC-SHA256 signing/verification helpers that protect `DeploymentRecord` integrity (per TDD-023 §8).

No backend implementations are produced here — sibling specs (SPEC-023-1-02, SPEC-023-1-03) implement the four bundled backends against this contract. The output of this spec is a strictly-typed module surface plus tested helpers, with no `any` and no shell invocation.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/types.ts` | Create | Interface + supporting types, JSDoc cross-refs to TDD-023 §5/§7 |
| `plugins/autonomous-dev/src/deploy/parameters.ts` | Create | `validateParameters(schema, values)` with format validators |
| `plugins/autonomous-dev/src/deploy/record-signer.ts` | Create | `signDeploymentRecord` / `verifyDeploymentRecord` + key bootstrap |
| `plugins/autonomous-dev/tests/deploy/parameters.test.ts` | Create | Negative + positive cases per validator |
| `plugins/autonomous-dev/tests/deploy/record-signer.test.ts` | Create | Sign/verify roundtrip + tamper detection |

## Implementation Details

### `src/deploy/types.ts`

Strict TypeScript, no `any`. All four interface methods are required (not optional). `metadata.capabilities` is a typed string-literal union so adding a capability is a compiler-enforced change.

```ts
// Cross-reference: TDD-023 §5 (DeploymentBackend interface), §7 (BuildContext)
export type BackendCapability =
  | 'github-pr' | 'local-fs' | 'remote-rsync'
  | 'localhost-docker' | 'github-pages';

export interface BackendMetadata {
  name: string;            // canonical id, lowercase-kebab
  version: string;         // semver
  supportedTargets: BackendCapability[];
  capabilities: BackendCapability[];
  requiredTools: string[]; // e.g. ['gh', 'git']
}

export interface BuildArtifact {
  artifactId: string;        // ULID
  type: 'commit' | 'directory' | 'docker-image' | 'archive';
  location: string;          // path / image ref / git ref
  checksum: string;          // sha256 hex
  sizeBytes: number;
  metadata: Record<string, string | number | boolean>;
}

export interface DeployParameters {
  [key: string]: string | number | boolean;
}

export interface BuildContext {
  repoPath: string;
  commitSha: string;
  branch: string;
  requestId: string;
  cleanWorktree: boolean;
  params: DeployParameters; // already validated upstream
}

export interface DeploymentRecord {
  deployId: string;          // ULID
  backend: string;
  environment: string;
  artifactId: string;
  deployedAt: string;        // ISO-8601
  status: 'deployed' | 'failed' | 'rolled-back';
  details: Record<string, string | number | boolean>;
  hmac: string;              // hex; empty string before signing
}

export interface HealthStatus {
  healthy: boolean;
  checks: { name: string; passed: boolean; message?: string }[];
  unhealthyReason?: string;
}

export interface RollbackResult {
  success: boolean;
  restoredArtifactId?: string;
  errors: string[];
}

export interface DeploymentBackend {
  readonly metadata: BackendMetadata;
  build(ctx: BuildContext): Promise<BuildArtifact>;
  deploy(artifact: BuildArtifact, environment: string, params: DeployParameters): Promise<DeploymentRecord>;
  healthCheck(record: DeploymentRecord): Promise<HealthStatus>;
  rollback(record: DeploymentRecord): Promise<RollbackResult>;
}
```

### `src/deploy/parameters.ts`

A schema-driven validator. Returns `{ valid, sanitized, errors }`. The validator is the only safe entry point; backends MUST receive `sanitized` rather than raw input.

```ts
export type ParamFormat = 'path' | 'shell-safe-arg' | 'url' | 'identifier';
export interface ParamSchema {
  type: 'string' | 'number' | 'boolean' | 'enum';
  required?: boolean;
  default?: string | number | boolean;
  enum?: readonly string[];
  regex?: RegExp;
  range?: [number, number];   // inclusive
  format?: ParamFormat;
}
export interface ParamValidationResult {
  valid: boolean;
  sanitized: Record<string, string | number | boolean>;
  errors: { key: string; message: string }[];
}
export function validateParameters(
  schema: Record<string, ParamSchema>,
  values: Record<string, unknown>,
): ParamValidationResult;
```

Validation rules (each enforced by a dedicated branch and tested):
- `type: 'number'` with `range: [min, max]` rejects out-of-range and non-finite values.
- `type: 'enum'` rejects values not in `enum`.
- `type: 'string'` with `format: 'path'` rejects `..`, NUL bytes, and any non-absolute value when configured to require absolute paths. Treat `/etc/`, `/proc/`, `/sys/` as denylisted roots.
- `type: 'string'` with no `format: 'shell-safe-arg'` rejects strings containing any of: `;`, `|`, `&`, `$`, backtick, `>`, `<`, `\n`, `\r`, NUL, `(`, `)`, `{`, `}`. Even `format: 'shell-safe-arg'` only allows `[A-Za-z0-9._\-/=:]`.
- `format: 'identifier'` allows `[A-Za-z][A-Za-z0-9_\-]*` only.
- `format: 'url'` requires the value to parse via `new URL(...)` and have a `https:` or `http:` protocol.
- Required-but-missing keys produce errors; defaults are applied before validation when the key is absent.

### `src/deploy/record-signer.ts`

HMAC-SHA256 over canonical-JSON of the record (all fields except `hmac`, keys sorted, no trailing whitespace). Key bootstrap order:

1. `process.env.DEPLOY_HMAC_KEY` (hex, ≥32 bytes).
2. `~/.autonomous-dev/deploy-key` (read; if exists, use; check permissions).
3. Auto-generate 32 random bytes, write to `~/.autonomous-dev/deploy-key` with mode `0600`, log a one-line warning to stderr.

```ts
export function loadDeployKey(): Buffer;       // throws on key file with insecure perms
export function signDeploymentRecord(record: DeploymentRecord, key?: Buffer): DeploymentRecord;
export function verifyDeploymentRecord(record: DeploymentRecord, key?: Buffer): { valid: boolean; error?: Error };
export function canonicalJson(record: Omit<DeploymentRecord, 'hmac'>): string;
```

`canonicalJson` MUST sort object keys recursively and serialize with no extra whitespace. Tests pin a known input to a known canonical string to guard against future formatter drift.

## Acceptance Criteria

- [ ] `tsc --noEmit` succeeds against `src/deploy/types.ts`, `parameters.ts`, and `record-signer.ts` under `strict: true` with no `any` (verified via `grep -n ' any' src/deploy` returning zero matches).
- [ ] All four `DeploymentBackend` methods are required (not optional) — verified by a test that imports the interface and a stub class missing `rollback` fails to compile (use `// @ts-expect-error`).
- [ ] `metadata.capabilities` is a typed enum (`BackendCapability` union); using a non-listed string fails to compile.
- [ ] `validateParameters({ port: { type: 'number', range: [1024, 65535] } }, { port: 8080 })` returns `valid: true`, `sanitized.port === 8080`.
- [ ] `validateParameters({ port: { type: 'number', range: [1024, 65535] } }, { port: 80 })` returns `valid: false` with an error mentioning the range.
- [ ] `validateParameters({ target: { type: 'string', format: 'path' } }, { target: '/var/www/site' })` returns `valid: true`.
- [ ] `validateParameters({ target: { type: 'string', format: 'path' } }, { target: '/etc/passwd' })` returns `valid: false`.
- [ ] `validateParameters({ target: { type: 'string', format: 'path' } }, { target: '/var/www/../etc' })` returns `valid: false`.
- [ ] String values containing `;`, `|`, `&`, `$`, backtick, `<`, `>`, newline, NUL, or `()` fail validation when `format` is not `shell-safe-arg`.
- [ ] `signDeploymentRecord(record)` returns the same record with `hmac` set to a non-empty 64-char lowercase hex string.
- [ ] `verifyDeploymentRecord(signed)` returns `{ valid: true }`.
- [ ] Mutating ANY field of a signed record (`environment`, `details.foo`, `deployedAt`, etc.) and re-verifying returns `{ valid: false, error }`.
- [ ] When `~/.autonomous-dev/deploy-key` is absent and `DEPLOY_HMAC_KEY` env is unset, calling `loadDeployKey()` creates the file with mode `0600` (verified via `fs.statSync(...).mode & 0o777 === 0o600`) and logs a stderr warning containing `auto-generated`.
- [ ] When the key file exists with mode `0644`, `loadDeployKey()` throws an error mentioning `insecure permissions`.
- [ ] `canonicalJson` produces byte-identical output for two records that differ only in JS object key insertion order (test asserts string equality).
- [ ] HMAC roundtrip test signs + verifies 100 generated records — all valid; mutates 100 signed records — all detected.

## Dependencies

- Node `crypto` (built-in) for HMAC-SHA256.
- Node `fs` and `os` for key file bootstrap.
- TDD-023 §5/§7/§8 are the source of truth for type shapes and signing rules.
- No external npm dependencies introduced by this spec.

## Notes

- This spec deliberately produces ZERO backend implementations. Adding a backend requires importing this module and conforming to its interface; SPEC-023-1-02 and SPEC-023-1-03 do that.
- Parameter validation is the security perimeter: validator-rejected input never reaches a backend. Defense in depth still applies — backends MUST use `execFile` (no shell), enforced in subsequent specs.
- The HMAC key bootstrap intentionally degrades to "auto-generate + warn" rather than failing closed; this matches PLAN-019-4's audit-key behavior. Operator documentation (separate plan) covers key rotation.
- `BackendCapability` is a union, not a string, to make adding a capability an explicit, reviewable change rather than a stringly-typed sprawl.
- Future cloud backends (TDD-024) will extend `BackendCapability` and add their own metadata; the interface stays stable.
