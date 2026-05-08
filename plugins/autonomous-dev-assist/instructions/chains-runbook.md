# Chains Runbook

This runbook is the operator deep-dive companion to the
[`## Plugin Chains` section in help/SKILL.md](../skills/help/SKILL.md#plugin-chains).
It covers chain bootstrapping, dependency-graph troubleshooting, the HMAC-chained
audit log, manifest-v2 migration, the approval flow, common errors, escalation,
and cross-references.

For chain CLI command reference and conceptual definition, see
[help/SKILL.md Plugin Chains](../skills/help/SKILL.md#plugin-chains).
For chain configuration parameters, see
[config-guide/SKILL.md Section 19 chains](../skills/config-guide/SKILL.md#section-19-chains).
Upstream design: TDD-022 §5 Plugin Manifest Extensions and TDD-022 §13 Audit Log.

## Table of Contents

1. [Bootstrap](#1-bootstrap)
2. [Dependency-graph troubleshooting](#2-dependency-graph-troubleshooting)
3. [Audit verification](#3-audit-verification)
4. [Manifest-v2 migration](#4-manifest-v2-migration)
5. [Approval flow](#5-approval-flow)
6. [Common errors](#6-common-errors)
7. [Escalation](#7-escalation)
8. [See also](#8-see-also)

## 1. Bootstrap

To enable chain-aware plugin execution, set the HMAC audit key in the env var
named by `chains.audit.key_env` (default `CHAINS_AUDIT_KEY`). The key signs
each audit-log entry; without it, the chain executor refuses to start.

Generate and export the key (illustrative — for production, store the key in
your secret manager and load it via your shell's secret-injection mechanism;
do NOT paste this command into a shared shell):

```bash
# Illustrative — for production, store the key in your secret manager.
export CHAINS_AUDIT_KEY=$(openssl rand -hex 32)
```

The audit log path defaults to `~/.autonomous-dev/chains/audit.log` and is
created lazily on the first chain invocation. The directory is created with
mode 0700 by the executor.

For plugins to participate in chains, their `.claude-plugin/plugin.json` MUST
declare manifest-v2 fields (`produces`, `consumes`, `egress_allowlist`). See
§4 Manifest-v2 migration below for the migration cookbook, and TDD-022 §5
Plugin Manifest Extensions for the schema definition.

After exporting the key and migrating manifests, validate with
`chains list` — every registered plugin must report `manifest: v2`. Plugins
still on the legacy schema are rejected at load time.

## 2. Dependency-graph troubleshooting

The chain dependency graph is computed from each plugin's `produces` and
`consumes` declarations in its `plugin.json`. Use `chains graph` to render
the DAG and diagnose declaration errors.

### Cycle detection

A cycle occurs when two or more plugins consume each other's outputs (directly
or transitively). The executor refuses to load a cyclic graph:

```text
$ chains graph
cycle detected: example-plugin-a -> example-plugin-b -> example-plugin-a
exit 3
```

Resolve by editing one plugin's `consumes` declaration to remove the back-edge,
or by splitting a plugin into producer/consumer halves so the dependency
becomes acyclic.

### Missing `produces` declaration

A plugin that emits an artifact (file, JSON document, registered resource)
without declaring it in `produces` is invisible to downstream consumers:

```text
$ chains graph
warning: example-plugin-a emits artifact 'lint-report' but does not declare it
```

Edit `.claude-plugin/plugin.json` and add the artifact name to `produces`.

### Missing `consumes` declaration

The mirror of the above: a plugin that reads an upstream artifact without
declaring it in `consumes` is dispatched in the wrong topological order:

```text
$ chains graph
warning: example-plugin-b reads 'lint-report' but does not declare it in consumes
```

Edit the manifest and add the artifact name to `consumes`.

### Reading the DAG ASCII output

`chains graph` renders the DAG as an indented tree, with arrows pointing from
producer to consumer. Roots (no consumes) appear at the top; leaves (no
produces) appear at the bottom. A linear chain renders as a single column;
diamond patterns indicate parallelism opportunities.

## 3. Audit verification

The chain audit log at `~/.autonomous-dev/chains/audit.log` is HMAC-chained:
each entry's HMAC depends on the previous entry's HMAC. A single tampered or
corrupted entry breaks verification of every subsequent entry. The log is the
only authoritative record of chain approvals and executions.

> **WARNING: do NOT delete the audit log.** The file is the irrecoverable
> record of every chain approval and execution. Deletion destroys the
> security audit trail; there is no rebuild path.

> **WARNING: do NOT rotate the HMAC key.** No rotation command exists in
> TDD-022 §13 Audit Log. Rotating the env-var value naively invalidates
> verification of every prior entry. Rotation is tracked as TDD-022 OQ-3
> future work.

### `chains audit verify`

```text
$ chains audit verify
verifying ~/.autonomous-dev/chains/audit.log
entries verified: 0..N
status: PASS
# exit 0
```

```text
$ chains audit verify
verifying ~/.autonomous-dev/chains/audit.log
HMAC mismatch at entry 42
status: FAIL
# exit 2 (non-zero)
```

The first divergence index is reported in the output so the operator can
locate the offending entry without scanning the whole log.

### Recovery procedure

1. **do NOT delete the audit log.** Stop and read this section in full
   before taking any action on the file.
2. Check whether a shadow log exists at
   `~/.autonomous-dev/chains/audit.log.shadow`.
3. If yes: run `chains audit verify --shadow` to cross-check the live log
   against the shadow log.
4. If no shadow log exists: file a TDD-022 §13 Audit Log issue with the
   verify output and do NOT modify the log file. The integrity record is
   more valuable than the inconvenience of a paused chain.

### Error patterns

| Error                          | Cause                                          | Action                                                                  |
|--------------------------------|------------------------------------------------|-------------------------------------------------------------------------|
| `HMAC mismatch at entry N`     | An entry was edited or the key changed         | do NOT delete; check shadow log; file TDD-022 §13 Audit Log issue       |
| `audit log truncated`          | A crash interrupted an append                  | Investigate via shadow log; do NOT regenerate the log                   |
| `audit key not set`            | `CHAINS_AUDIT_KEY` env var missing             | Set the env var; do NOT generate a new key if entries already exist     |

The three patterns above are the only divergences `chains audit verify`
emits today. Any other output is a bug — file a TDD-022 §13 Audit Log
issue with the full verifier transcript.

### Cryptographic construction

See TDD-022 §13 Audit Log for the cryptographic construction (HMAC-SHA256 over
the previous entry's MAC concatenated with the new entry's serialized body).
The seed MAC is computed over a fixed-string preamble bound to
`CHAINS_AUDIT_KEY`. This is why rotating the key naively breaks verification
of every prior entry — the chain re-anchors at the rotation point.

### What NOT to do (recap)

- do NOT delete the audit log under any failure scenario; the integrity
  record is irrecoverable.
- do NOT rotate the HMAC key while entries exist; no rotation command
  exists in TDD-022 §13.
- do NOT manually edit a single byte of the log; HMAC verification will
  flag the next read.

## 4. Manifest-v2 migration

Every chain participant MUST declare manifest-v2 fields. The chain executor
REJECTS legacy manifests with a clear error per TDD-022 §5 Plugin Manifest
Extensions; do NOT skip the migration or attempt to regress to manifest-v1
(the executor refuses to load it).

### Walkthrough: migrating `example-scanner-plugin`

1. **Identify artifact types.** What does the plugin produce (e.g.,
   `scan-report`)? What does it read from upstream (e.g., `source-tree`)?
2. **Add `produces` and `consumes` to the manifest.** Edit
   `.claude-plugin/plugin.json` to add the new fields:

```json
{
  "name": "example-scanner-plugin",
  "version": "2.0.0",
  "manifest": "v2",
  "produces": ["scan-report"],
  "consumes": ["source-tree"],
  "egress_allowlist": ["api.example.invalid"]
}
```

3. **Validate with `chains list`.** The plugin must now appear with
   `manifest: v2` in the listing. If it does not, re-check the JSON syntax
   and the field names.
4. **Commit and ship.** The migration is complete when `chains list` shows
   the plugin and `chains graph` includes its node in the DAG.

### Notes

- The `egress_allowlist` field is required for chain participants that make
  network calls; an empty list (`[]`) is valid for offline plugins.
- A plugin that emits but does not declare an artifact, or vice versa, will
  warn at `chains graph` time (see §2). The chain still loads, but ordering
  is undefined.
- Versions: bump the `version` to a new major when migrating, so dependents
  can pin against the new schema.

## 5. Approval flow

The chain approval gate fires when `chains.approval.required_for_prod_egress`
is `true` (default) AND a chain step's `egress_allowlist` resolves to a host
classified as production. The chain enters `awaiting-approval` and emits a
`REQ-NNNNNN` request ID — a six-digit zero-padded token (e.g., `REQ-000042`)
operators reference in approve/reject commands.

```bash
# approve a pending request
chains approve REQ-NNNNNN --comment "rollout per RFC-XYZ"

# reject (with required reason)
chains reject REQ-NNNNNN --reason "needs security review first"
```

Both commands write an audit-log entry covered by the HMAC chain in §3.
Approval transitions `awaiting-approval` → `approved` → `executing`;
rejection transitions to a terminal `rejected` state.

The approval state-machine and policy semantics are defined in
TDD-022 §11 Approval State Machine (the same trust-integration model used
by the deploy framework — see deploy-runbook §2 for the parallel surface).

## 6. Common errors

The HMAC-mismatch and audit-key errors are covered in §3 Audit verification
(see the error-pattern table there). The remaining six common errors that
arise during day-to-day chain operation:

| Error                                          | Cause                                                       | Action                                                                                                            |
|------------------------------------------------|-------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| `cycle detected: A -> B -> A`                  | Two plugins consume each other's outputs                    | Run `chains graph` to locate the cycle; remove or split the offending plugin pair (see §2)                        |
| `manifest schema error: missing 'produces'`    | A plugin upgraded without declaring produces                | Edit the plugin's `.claude-plugin/plugin.json` and add the artifact name; see §4                                   |
| `manifest schema error: missing 'consumes'`    | A plugin upgraded without declaring consumes                | Edit the plugin's `.claude-plugin/plugin.json` and add the upstream artifact name; see §4                          |
| `manifest schema error: invalid version`       | A plugin still on the legacy schema                         | Migrate the plugin to manifest-v2 per §4 (do NOT regress to manifest-v1 — the executor rejects the legacy schema) |
| `approval-gate timeout: REQ-NNNNNN`            | Pending approval expired before operator acted              | Re-trigger the request; ensure on-call coverage; the audit log shows the timeout entry                            |
| `unknown plugin in chains list`                | A registered plugin's manifest is missing or unreadable     | Re-install the plugin; check filesystem perms on `.claude-plugin/plugin.json` and the plugin install directory    |

If the failure mode does not match any of the six rows above and is not
covered by §3, it is likely a bug in shipped behavior — see §7 Escalation
for the file-an-issue-vs-recover-locally decision.

For chain-egress denials specifically (a request blocked because a host
falls outside the plugin's `egress_allowlist`), the recovery is to update
the manifest's allowlist via a deliberate, reviewable code change — not a
runtime override. There is no per-invocation bypass.

### Diagnostic order

When a chain fails to start or fails mid-flight, work through the
diagnostic order: (1) `chains list` to confirm every participant loaded
and reports `manifest: v2`; (2) `chains graph` to confirm the DAG is
acyclic and every artifact has a producer; (3) `chains audit verify` if
the failure narrative mentions an integrity warning (covered in §3).

Each step takes seconds and rules out an entire class of failure. Skipping
to the audit verifier without first ruling out a manifest error wastes
operator time and risks misattributing a load-time error to the audit log.

## 7. Escalation

**File a TDD-022 issue** when the failure is in shipped behavior:

- HMAC-verification false positive (the log was not tampered, yet
  `chains audit verify` reports a mismatch).
- Manifest schema validator rejects a valid manifest-v2 document.
- The chain executor enters an inconsistent state (e.g., a plugin reports
  as both running and completed simultaneously).

**Recover locally** without filing an issue when the failure is
operator-fixable:

- Missing `produces` or `consumes` declaration: edit the manifest (§4).
- Cycle detected: remove or split a plugin (§2).
- Approval-gate timeout: re-trigger the request (§5).

## 8. See also

- [deploy-runbook.md](./deploy-runbook.md) — the parallel deploy framework runbook (PLAN-026-3 ships this file)
- [TDD-022 §5 Plugin Manifest Extensions](../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#5-plugin-manifest-extensions)
- [TDD-022 §11 Approval State Machine](../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#11-approval-state-machine)
- [TDD-022 §13 Audit Log](../../autonomous-dev/docs/tdd/TDD-022-plugin-chaining-engine.md#13-audit-log)
- [help/SKILL.md Plugin Chains](../skills/help/SKILL.md#plugin-chains)
- [config-guide/SKILL.md Section 19 chains](../skills/config-guide/SKILL.md#section-19-chains)
