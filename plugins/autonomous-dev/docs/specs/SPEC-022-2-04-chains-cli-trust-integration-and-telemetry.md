# SPEC-022-2-04: `chains approve`/`reject` CLI + Trust Integration via TrustValidator + Telemetry

## Metadata
- **Parent Plan**: PLAN-022-2
- **Tasks Covered**: Task 8 (`chains approve`/`reject` CLI subcommands), Task 9 (trust integration + privileged-chains allowlist), Task 10 (telemetry emission per chain)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-022-2-04-chains-cli-trust-integration-and-telemetry.md`

## Description
Close the operator-facing loop on the standards-to-fix flow by shipping (a) the CLI subcommands operators use to approve or reject paused chains, (b) trust integration that gates every plugin invocation against PLAN-019-3's `TrustValidator` and additionally requires privileged chains to appear in the `extensions.privileged_chains[]` allowlist, and (c) per-chain telemetry emission so operations have visibility into chain duration, plugin count, artifact count, and outcome.

`chains approve <artifact-id>` writes the `.approved.json` marker file (contract from SPEC-022-2-03), invokes `executor.resume(chain_id)`, and reports the resume outcome. `chains reject <artifact-id> --reason <text>` deletes the chain state file and writes a `.rejected.json` marker recording the reason; the chain is permanently cancelled. Both commands require admin authorization per PRD-009 (delegate to existing admin-auth check; do not reimplement).

Trust integration runs the validator before each plugin invocation. Untrusted plugins are skipped (their consumers also skipped, per `warn` failure-mode default; this is the strictest sensible default for trust failures regardless of the manifest's declared mode). Privileged chains — defined as any chain that includes a `consumes` declaration on a `requires_approval: true` artifact path — additionally require an entry in `extensions.privileged_chains[]` matching `<producer>:<consumer>` with optional glob version suffix.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cli/commands/chains-approve.ts` | Create | `chains approve <artifact-id>` |
| `plugins/autonomous-dev/src/cli/commands/chains-reject.ts` | Create | `chains reject <artifact-id> --reason <text>` |
| `plugins/autonomous-dev/src/cli/commands/index.ts` | Modify | Register both new subcommands |
| `plugins/autonomous-dev/src/chains/executor.ts` | Modify | Trust check before each invocation; privileged-chain pre-flight check |
| `plugins/autonomous-dev/src/chains/privileged-chain-resolver.ts` | Create | Glob matcher for `producer:consumer@version` patterns |
| `plugins/autonomous-dev/src/chains/errors.ts` | Modify | Add `TrustValidationError`, `PrivilegedChainNotAllowedError` |
| `plugins/autonomous-dev/schemas/autonomous-dev-config.schema.json` | Modify | Add `extensions.privileged_chains` array of strings |
| `plugins/autonomous-dev/src/chains/telemetry-emitter.ts` | Create | One emission per chain on completion |
| `plugins/autonomous-dev/tests/chains/test-trust-integration.test.ts` | Create | Unit tests for trust + privileged-chain scenarios |
| `plugins/autonomous-dev/tests/cli/test-chains-approve-reject.test.ts` | Create | CLI subcommand tests |

## Implementation Details

### `chains approve` Subcommand

```ts
export async function chainsApprove(argv: { artifactId: string }): Promise<void> {
  await requireAdminAuth(); // existing PRD-009 helper
  const chainState = await locateChainStateByArtifact(argv.artifactId);
  if (!chainState) throw new Error(`No paused chain found for artifact ${argv.artifactId}`);
  const approvedMarker = `${artifactPath(argv.artifactId)}.approved.json`;
  await fs.writeFile(approvedMarker, JSON.stringify({
    artifact_id: argv.artifactId,
    chain_id: chainState.chain_id,
    approved_by: process.env.USER ?? 'unknown',
    approved_at_iso: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  const result = await executor.resume(chainState.chain_id);
  console.log(`Chain ${chainState.chain_id} resumed: outcome=${result.outcome}`);
}
```

### `chains reject` Subcommand

```ts
export async function chainsReject(argv: { artifactId: string; reason: string }): Promise<void> {
  await requireAdminAuth();
  if (!argv.reason || argv.reason.trim().length === 0) {
    throw new Error('--reason is required for chains reject');
  }
  const chainState = await locateChainStateByArtifact(argv.artifactId);
  if (!chainState) throw new Error(`No paused chain found for artifact ${argv.artifactId}`);
  const rejectedMarker = `${artifactPath(argv.artifactId)}.rejected.json`;
  await fs.writeFile(rejectedMarker, JSON.stringify({
    artifact_id: argv.artifactId,
    chain_id: chainState.chain_id,
    rejected_by: process.env.USER ?? 'unknown',
    rejected_at_iso: new Date().toISOString(),
    reason: argv.reason,
  }, null, 2), { mode: 0o600 });
  await fs.unlink(statePath(chainState.chain_id));
  console.log(`Chain ${chainState.chain_id} rejected: reason="${argv.reason}"`);
}
```

### Trust Integration in `ChainExecutor`

Before each `invokeWithTimeout(plugin, ctx)` call:

```ts
const trustResult = await this.trustValidator.isTrusted(plugin.id);
if (!trustResult.trusted) {
  this.recordFailure(plugin.id, new TrustValidationError(plugin.id, trustResult.reason), 'warn');
  return this.skipDownstreamOf(plugin); // standard skip path
}
```

`TrustValidationError` includes the reason from the validator (e.g., 'unknown-publisher', 'revoked', 'not-allowlisted').

### Privileged-Chain Pre-Flight

Before chain execution, after the topological order is computed:

```ts
const isPrivileged = order.some(p =>
  p.manifest.consumes?.requires_approval === true
  || hasUpstreamRequiringApproval(p, order),
);
if (isPrivileged) {
  const allowed = this.privilegedChainResolver.matches(
    order,
    this.config.extensions?.privileged_chains ?? [],
  );
  if (!allowed) {
    throw new PrivilegedChainNotAllowedError(order.map(p => p.id), order.map(p => p.version));
  }
}
```

### Privileged-Chain Resolver

Allowlist entry format: `<producer-id>:<consumer-id>@<version-glob>`. Examples:
- `rule-set-enforcement-reviewer:code-fixer@*` — any version
- `rule-set-enforcement-reviewer:code-fixer@1.x` — major-pinned
- `rule-set-enforcement-reviewer:code-fixer@1.2.3` — exact

```ts
export class PrivilegedChainResolver {
  matches(order: PluginRecord[], allowlist: string[]): boolean {
    // For each consecutive (producer, consumer) pair where consumer requires approval,
    // check that an allowlist entry matches.
    for (let i = 0; i < order.length - 1; i++) {
      const consumer = order[i + 1];
      if (consumer.manifest.consumes?.requires_approval !== true) continue;
      const producer = order[i];
      const matched = allowlist.some(entry =>
        this.matchEntry(entry, producer, consumer)
      );
      if (!matched) return false;
    }
    return true;
  }
  private matchEntry(entry: string, producer: PluginRecord, consumer: PluginRecord): boolean {
    const m = entry.match(/^([^:]+):([^@]+)@(.+)$/);
    if (!m) return false;
    const [_, prodPattern, consPattern, versionGlob] = m;
    return prodPattern === producer.id
      && consPattern === consumer.id
      && this.versionMatches(versionGlob, consumer.version);
  }
  private versionMatches(glob: string, version: string): boolean {
    if (glob === '*') return true;
    if (glob.endsWith('.x')) {
      const major = glob.slice(0, -2);
      return version.startsWith(`${major}.`);
    }
    return glob === version;
  }
}
```

### Config Schema Addition

```json
"extensions": {
  "type": "object",
  "properties": {
    "privileged_chains": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[^:]+:[^@]+@.+$" },
      "default": []
    }
  }
}
```

### Telemetry Emission

```ts
export interface ChainTelemetryEvent {
  event: 'chain.completed';
  chain_id: string;
  request_id: string;
  plugins: string[];           // plugin IDs in invocation order
  duration_ms: number;
  artifacts: Array<{ id: string; type: string; size_bytes: number; requires_approval: boolean }>;
  outcome: 'success' | 'failed' | 'paused' | 'blocked' | 'rejected';
  error_type?: string;         // present when outcome != 'success' / 'paused'
}
```

Emit exactly once per chain in `runChain`'s `finally` block, using the existing TDD-007 metrics pipeline.

## Acceptance Criteria

- [ ] `autonomous-dev chains approve VIO-123` writes `<artifact-path>.approved.json` with mode `0o600`, calls `executor.resume(chain_id)`, and prints the resume outcome to stdout.
- [ ] `autonomous-dev chains approve VIO-123` invoked by a non-admin user fails with the existing admin-auth error (delegated; not re-tested here beyond verifying the auth helper is called).
- [ ] `autonomous-dev chains approve VIO-NONEXISTENT` exits non-zero with `No paused chain found for artifact VIO-NONEXISTENT`.
- [ ] `autonomous-dev chains reject VIO-123 --reason "patches too risky"` writes `<artifact-path>.rejected.json` with the reason, deletes the chain state file, and prints the rejection summary.
- [ ] `autonomous-dev chains reject VIO-123` (no `--reason`) exits non-zero with `--reason is required for chains reject`.
- [ ] In a 3-plugin chain where the middle plugin is untrusted (`trustValidator.isTrusted` returns `{trusted: false, reason: 'revoked'}`), the executor skips the middle plugin AND its downstream consumer; the first plugin runs normally; the chain result records a `TrustValidationError` against the middle plugin with `reason: 'revoked'`.
- [ ] An untrusted producer in a 2-plugin chain causes the consumer to be skipped (consumer has no upstream artifact); chain outcome is `failed` with the trust error attached.
- [ ] A privileged chain (`code-fixer` with `consumes.requires_approval: true`) NOT listed in `extensions.privileged_chains` is rejected before execution with `PrivilegedChainNotAllowedError`; no plugins are invoked.
- [ ] The same chain WITH `extensions.privileged_chains: ["rule-set-enforcement-reviewer:code-fixer@*"]` proceeds to execution.
- [ ] Allowlist `rule-set-enforcement-reviewer:code-fixer@1.x` matches consumer version `1.0.0`, `1.5.2`, but NOT `2.0.0`.
- [ ] Allowlist `rule-set-enforcement-reviewer:code-fixer@1.2.3` matches exactly that version, no others.
- [ ] Allowlist entries that do not match the format `producer:consumer@version` are rejected by the JSON schema (`pattern`) and `config validate` fails.
- [ ] Each `runChain` invocation emits exactly one `ChainTelemetryEvent` to the TDD-007 metrics pipeline; the event's `plugins[]` lists invocation order, `duration_ms` is positive, `artifacts[]` reflects all persisted artifacts, and `outcome` is one of the enum values.
- [ ] Telemetry is emitted for both successful and failed chains (verified by inducing a failure in test).
- [ ] Telemetry emission failure does NOT crash the chain execution (wrapped in try/catch; failure is logged but swallowed).
- [ ] Unit-test coverage on trust-integration, privileged-chain-resolver, CLI commands, and telemetry emission paths is ≥95% (line + branch).

## Dependencies

- **Blocked by**: SPEC-022-2-03 (executor.resume entry point, state file format, `.approved.json` contract).
- **Blocked by**: PLAN-019-3 `TrustValidator` (existing on main).
- **Blocked by**: PLAN-009 admin-auth helper (existing on main).
- **Blocked by**: PLAN-007-X telemetry pipeline (existing on main).
- No new npm packages introduced.

## Notes

- Trust failure always uses the `warn` skip behavior regardless of the manifest's declared `on_failure` mode. This is by design: a trusted plugin's failure-mode preferences should not be honored if the plugin itself is untrusted (e.g., an untrusted plugin declaring `on_failure: 'ignore'` to silently mask its skip is exactly the attack surface this prevents).
- The privileged-chain check is structural (any chain consuming a `requires_approval: true` artifact). It does not depend on the chain actually pausing — even if approval logic were bypassed, the allowlist gate ensures the operator has explicitly sanctioned the chain shape.
- Allowlist entries use `producer:consumer@version` pairs because chains in TDD-022 are linear pairwise links. For diamond chains (one producer, two consumers, both privileged), the operator lists each pair separately. Multi-hop chains are listed pairwise as well; the resolver iterates consecutive pairs.
- `chains approve` does NOT verify the artifact contents — that is the operator's responsibility before invoking the command. Future enhancement: a `chains diff <artifact-id>` subcommand to render the artifact for review.
- Telemetry event names follow the existing metrics pipeline conventions (`<noun>.<verb>`); `chain.completed` aligns with `request.completed` already in use.
- `chains reject` is non-recoverable: there is no `chains reapprove` flow. Operators who reject by mistake must re-trigger the chain from scratch (e.g., by re-running the originating code review). Documented in operator-facing CLI help text.
