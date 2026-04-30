# SPEC-023-2-03: Approval State Machine and Deploy Phase Wiring

## Metadata
- **Parent Plan**: PLAN-023-2
- **Tasks Covered**: Task 5 (implement approval state machine), Task 6 (wire approval into deploy phase)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-2-03-approval-state-machine-deploy-wiring.md`

## Description
Implement the per-environment approval state machine specified by TDD-023 §11 and wire it into the deploy phase entry point. The state machine handles the four approval levels (`none`, `single`, `two-person`, `admin`) declared by `ResolvedEnvironment.approval` (from SPEC-023-2-01). State is persisted at `<request>/.autonomous-dev/deployments/<deployId>.approval.json` with HMAC chaining (mirroring PLAN-022-2's chain-approval pattern) so that approvals survive daemon restarts and tampering is detected on read.

The deploy orchestrator (created in this spec, extended in SPEC-023-2-04) owns the lifecycle: resolve env → check approval requirement → either proceed (`none`) or raise an escalation via PLAN-009-X's router and pause until threshold is met. CLI commands (`deploy approve`, `deploy reject`) are deferred to SPEC-023-2-04; this spec defines the underlying `requestApproval()` / `recordApproval()` / `checkApprovalStatus()` API they will call.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/approval.ts` | Create | State machine: `requestApproval`, `recordApproval`, `recordRejection`, `checkApprovalStatus`, `loadApprovalState` |
| `plugins/autonomous-dev/src/deploy/approval-types.ts` | Create | `ApprovalState`, `ApprovalEntry`, `ApprovalDecision`, `ApprovalChainError` types |
| `plugins/autonomous-dev/src/deploy/approval-store.ts` | Create | Filesystem persistence with two-phase commit (temp + atomic rename) |
| `plugins/autonomous-dev/src/deploy/orchestrator.ts` | Create | `runDeploy(deployId, ctx)` entry point invoked by supervisor; integrates resolver + selector + approval |
| `plugins/autonomous-dev/bin/supervisor-loop.sh` | Modify | Replace stub deploy invocation with call into `orchestrator.runDeploy()` |

## Implementation Details

### State Shape (`approval-types.ts`)

```ts
export type ApprovalLevel = "none" | "single" | "two-person" | "admin";
export type ApprovalDecision = "pending" | "approved" | "rejected";

export interface ApprovalEntry {
  approver: string;        // operator's verified email (per PLAN-019-3)
  role: string;            // "operator" | "admin" (from PLAN-019-3 trust framework)
  decision: "approve" | "reject";
  reason?: string;         // required when decision === "reject"
  recordedAt: string;      // ISO-8601 UTC
  hmac: string;            // HMAC-SHA256 over canonical-JSON of (prev_hmac + this_entry_minus_hmac)
}

export interface ApprovalState {
  deployId: string;
  envName: string;         // for audit; matches the resolved env at request time
  requirement: ApprovalLevel;
  decision: ApprovalDecision;     // derived from entries; recomputed on every load
  entries: ApprovalEntry[];       // append-only; chained via HMAC
  requestedAt: string;            // ISO-8601 UTC
  resolvedAt: string | null;      // set when decision moves out of "pending"
  chainHeadHmac: string;          // last entry's HMAC, or initial HMAC if no entries
}
```

### Persistence Path
- Approval state file: `<requestDir>/.autonomous-dev/deployments/<deployId>.approval.json`
- File mode `0600`. Directory created `0700` if missing.
- HMAC key reused from PLAN-023-1's `DEPLOY_HMAC_KEY` (env var or `~/.autonomous-dev/deploy-key`).

### HMAC Chain
- Each `ApprovalEntry.hmac` = HMAC-SHA256(key, canonical_json(prev_chain_head + entry_without_hmac))
- The first entry's `prev_chain_head` is the literal string `"INIT:" + deployId`.
- `loadApprovalState()` recomputes the chain on read and throws `ApprovalChainError` if any entry's HMAC fails verification (tamper detection).

### Public API

```ts
export async function requestApproval(args: {
  deployId: string;
  envName: string;
  requirement: ApprovalLevel;
  requestDir: string;
}): Promise<ApprovalState>;

// Records an "approve" decision. Returns updated state.
// Throws DuplicateApproverError if same operator approves twice.
// Throws AdminRequiredError if requirement === "admin" and approver.role !== "admin".
export async function recordApproval(args: {
  deployId: string;
  approver: string;       // verified email
  role: "operator" | "admin";
  requestDir: string;
}): Promise<ApprovalState>;

// Records a "reject" decision. Returns updated state with decision="rejected".
// Any allowlisted operator may reject (no two-person rule on reject).
export async function recordRejection(args: {
  deployId: string;
  approver: string;
  role: "operator" | "admin";
  reason: string;          // required, min length 1
  requestDir: string;
}): Promise<ApprovalState>;

// Pure read; does not mutate.
export async function checkApprovalStatus(
  deployId: string,
  requestDir: string,
): Promise<ApprovalState>;
```

### Decision Logic (recomputed in `loadApprovalState`)
```
if any entry.decision === "reject" -> decision = "rejected"
elif requirement === "none"        -> decision = "approved"
elif requirement === "single"      -> decision = "approved" iff >=1 approve entry
elif requirement === "two-person"  -> decision = "approved" iff >=2 approve entries
                                       AND distinct approver emails
elif requirement === "admin"       -> decision = "approved" iff >=1 approve entry
                                       with role === "admin"
else                                -> decision = "pending"
```

### Two-Phase Commit (approval-store.ts)
```
write_state(state):
  tmp = approval_path + ".tmp." + random
  fd = open(tmp, O_WRONLY|O_CREAT|O_EXCL, 0600)
  write(fd, canonical_json(state))
  fsync(fd); close(fd)
  rename(tmp, approval_path)        // atomic on POSIX
  fsync(parent_dir_fd)               // durability
```

### Orchestrator Wiring (`orchestrator.ts`)

```ts
// Pseudo-flow only — real impl wires resolver + selector + approval + cost cap (SPEC-023-2-04)
export async function runDeploy(args: {
  deployId: string;
  envName: string;
  requestDir: string;
  cliBackendOverride?: string;
}): Promise<{ status: "completed" | "paused" | "rejected" | "failed"; }> {
  const config = await loadConfig(args.requestDir);
  const resolved = resolveEnvironment(config, args.envName);
  // Selector + parameter validation (SPEC-023-2-02)
  const selection = selectBackend({ resolved, registry, override: args.cliBackendOverride ? { backend: args.cliBackendOverride } : undefined, repoDefaultBackend: config?.default_backend });

  // Approval gate
  if (resolved.approval !== "none") {
    const state = await requestApproval({ deployId: args.deployId, envName: resolved.envName, requirement: resolved.approval, requestDir: args.requestDir });
    if (state.decision === "pending") {
      await raiseEscalation({ deployId: args.deployId, env: resolved.envName, requirement: resolved.approval, selection });
      return { status: "paused" };
    }
    if (state.decision === "rejected") {
      return { status: "rejected" };
    }
  }

  // (Cost cap pre-check + backend invoke + telemetry: layered in by SPEC-023-2-04)
  return invokeBackend(selection);
}
```

### Supervisor Loop Change
Replace the existing stub deploy block in `bin/supervisor-loop.sh` with a single call:
```bash
node "${PLUGIN_ROOT}/dist/cli/internal/run-deploy.js" \
  --deploy-id "${deploy_id}" \
  --env "${env_name}" \
  --request-dir "${request_dir}"
```
The TS entry point invokes `orchestrator.runDeploy()` and exits with codes: 0 = completed, 10 = paused (resumeable), 20 = rejected, 30 = failed.

## Acceptance Criteria
1. [ ] `requestApproval` with `requirement: "none"` immediately returns state with `decision: "approved"`, no entries written.
2. [ ] `requestApproval` with `requirement: "single"` returns state with `decision: "pending"` and an empty entries array.
3. [ ] `recordApproval` with a single approver advances `single` requirement to `decision: "approved"` and sets `resolvedAt`.
4. [ ] `recordApproval` with two distinct approvers advances `two-person` requirement to `approved`.
5. [ ] `recordApproval` with the SAME approver twice on `two-person` throws `DuplicateApproverError`; state unchanged.
6. [ ] `recordApproval` with role `"operator"` on `requirement: "admin"` throws `AdminRequiredError`; state unchanged.
7. [ ] `recordApproval` with role `"admin"` on `requirement: "admin"` advances to `approved`.
8. [ ] `recordRejection` with any valid operator sets `decision: "rejected"` regardless of requirement level.
9. [ ] `recordRejection` requires non-empty `reason` (validation error otherwise).
10. [ ] HMAC chain verifies on read; tampering with any entry's `recordedAt` causes `loadApprovalState` to throw `ApprovalChainError` referencing the bad entry index.
11. [ ] State file written with mode `0600`; parent directory `0700`.
12. [ ] Two-phase commit: simulated crash between temp-write and rename leaves the original file intact.
13. [ ] Approval state survives a process restart: write state in process A, read in process B → identical decoded state.
14. [ ] `orchestrator.runDeploy()` with `approval: "none"` invokes the backend directly (no escalation raised).
15. [ ] `orchestrator.runDeploy()` with `approval: "single"` raises an escalation via PLAN-009-X router and returns `status: "paused"` without invoking the backend.
16. [ ] After `recordApproval` completes the threshold, a re-invocation of `runDeploy(deployId)` proceeds to backend invocation (resumeable behavior).
17. [ ] `bin/supervisor-loop.sh` no longer contains the stub deploy block; integration test confirms it now dispatches via `run-deploy.js`.

## Dependencies
- **Blocks**: SPEC-023-2-04 (CLI commands wrap `recordApproval` / `recordRejection`; cost-cap pre-check is layered into `runDeploy`), SPEC-023-2-05 (integration test exercises full flow).
- **Consumes**:
  - SPEC-023-2-01: `ResolvedEnvironment`, `loadConfig`, `resolveEnvironment`.
  - SPEC-023-2-02: `selectBackend`, `BackendSelection`.
  - PLAN-023-1: `DEPLOY_HMAC_KEY` resolution, `BackendRegistry`, deployment record signing helpers.
  - PLAN-009-X (existing on main): `raiseEscalation()` router for approval notifications.
  - PLAN-019-3 (existing on main): operator email verification + admin role lookup.

## Notes
- The HMAC chain mirrors PLAN-022-2's pattern intentionally so operator-facing tooling (audit log viewers, chain explorers) can be reused. Any divergence here will create operational surprise.
- `decision` is derived (never written directly) so that the entries log is the source of truth. This means a tampered file with `decision: "approved"` but no valid entries will still resolve to `pending` after recomputation.
- Same-email collapse for two-person: PLAN-019-3 verifies the operator's email at SSH-key load time. Two SSH keys with the same verified email are treated as the same operator (closes the governance hole called out in PLAN-023-2 risk table).
- The orchestrator stub in this spec has placeholders for cost cap and telemetry; SPEC-023-2-04 fills them in. This split keeps the approval state machine reviewable in isolation.
- Recovery procedure (documented in operator guide): if `<deployId>.approval.json` is corrupted beyond chain-verification, the operator deletes the file and re-issues the deploy request. The original deploy record (PLAN-023-1) remains for audit.
- `raiseEscalation()` is invoked via the existing PLAN-009-X interface; this spec does NOT define its payload shape beyond the obvious fields (deployId, env, requirement, selection summary).
