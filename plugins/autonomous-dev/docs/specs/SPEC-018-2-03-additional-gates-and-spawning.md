# SPEC-018-2-03: Additional-Gate Enforcement and Type-Aware Session Spawning

## Metadata
- **Parent Plan**: PLAN-018-2
- **Tasks Covered**: Task 4 (additional-gate enforcement at `<state-dir>/gates/<name>.json`), Task 5 (type-aware session spawning with `--bug-context-path`, `ENHANCED_GATES`, `--expedited`)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-2-03-additional-gates-and-spawning.md`

## Description
Two related but separable changes both gated on per-request `type_config`. First, before advancing past any phase whose name appears as a key in `type_config.additionalGates`, the supervisor verifies the corresponding gate artifact exists at `<state-dir>/gates/<gate-name>.json`; if absent, the request stays put and `status_reason` is updated to name the awaited gate. Second, the session-spawning helper is taught to inject per-type flags into agent invocations: `--bug-context-path <state-file>` for `bug`-typed requests entering a TDD-author phase, `ENHANCED_GATES=...` exported for `infra`-typed requests entering any author phase, and `--expedited` to reviewer agents whenever `expedited_reviews` is true on the state.

The spec also ships three stub gate-evaluator scripts (`security_review.sh`, `cost_analysis.sh`, `rollback_plan.sh`) that emit a passing artifact when run. These exist so infra-typed requests don't hang in production before real evaluators are written; the stubs are explicitly documented as such.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/bin/supervisor-loop.sh` | Modify | Add gate-presence check before phase advancement; integrate type-aware spawn flags |
| `plugins/autonomous-dev/bin/spawn-session.sh` | Modify | Accept new args from caller; assemble `--bug-context-path`, `--expedited`, env-var injection |
| `plugins/autonomous-dev/bin/lib/gate-check.sh` | Create | Helper `check_required_gates` that returns missing-gate name or empty |
| `plugins/autonomous-dev/bin/gates/security_review.sh` | Create | Stub: writes `{"status":"passed","stub":true}` to gate artifact |
| `plugins/autonomous-dev/bin/gates/cost_analysis.sh` | Create | Stub: identical structure |
| `plugins/autonomous-dev/bin/gates/rollback_plan.sh` | Create | Stub: identical structure |
| `plugins/autonomous-dev/bin/gates/README.md` | Create | One-page operator note explaining the stub status and the artifact contract |

## Implementation Details

### Gate Presence Check

`type_config.additionalGates` is an object mapping phase name → gate name (per the v1.1 schema). Example:

```json
"additionalGates": {
  "tdd_review": "security_review",
  "plan_review": "cost_analysis",
  "validate":    "rollback_plan"
}
```

`lib/gate-check.sh`:

```bash
#!/usr/bin/env bash
# Returns the name of the first missing required gate for the current phase, or empty string.
check_required_gates() {
  local state_file="$1" phase="$2" state_dir
  state_dir=$(dirname "$state_file")
  local gate
  gate=$(jq -r --arg p "$phase" \
    '.type_config.additionalGates[$p] // empty' \
    "$state_file")
  if [[ -z "$gate" ]]; then
    return 0  # no gates required, empty stdout
  fi
  if [[ ! -f "$state_dir/gates/$gate.json" ]]; then
    printf '%s\n' "$gate"
  fi
}
```

In `select_request()` (after the next-phase calculation from SPEC-018-2-01), the supervisor consults this helper for the **outgoing** phase:

```bash
local missing_gate
missing_gate=$(check_required_gates "$state_file" "$current_phase")
if [[ -n "$missing_gate" ]]; then
  jq --arg g "$missing_gate" '.status_reason = ("awaiting gate: " + $g)' \
    "$state_file" > "$state_file.tmp" && mv "$state_file.tmp" "$state_file"
  return 0  # do not advance
fi
```

### Type-Aware Spawning

Update `spawn-session.sh` so its caller (the supervisor) provides type, expedited flag, and target phase. The script assembles the command line. Pseudocode:

```bash
spawn_session() {
  local state_file="$1" target_phase="$2" agent="$3"
  local req_type expedited args=()
  req_type=$(jq -r '.type // "feature"' "$state_file")
  expedited=$(jq -r '.expedited_reviews // false' "$state_file")

  # Bug context for TDD-author when type=bug
  if [[ "$req_type" == "bug" && "$target_phase" == "tdd" ]]; then
    args+=(--bug-context-path "$state_file")
  fi

  # Expedited flag for reviewer phases
  if [[ "$expedited" == "true" && "$target_phase" == *"_review" ]]; then
    args+=(--expedited)
  fi

  # ENHANCED_GATES env var for infra-typed author phases (non-review)
  local env_prefix=()
  if [[ "$req_type" == "infra" && "$target_phase" != *"_review" ]]; then
    env_prefix=(env ENHANCED_GATES=security_review,cost_analysis,rollback_plan)
  fi

  "${env_prefix[@]}" claude --agent "$agent" "${args[@]}" --state "$state_file"
}
```

The `claude` CLI invocation in the existing helper is preserved verbatim except for the new args/env-prefix.

### Stub Gate Evaluator Format

Each stub follows the same shape:

```bash
#!/usr/bin/env bash
# STUB: replace with a real gate evaluator before relying on this in production.
set -euo pipefail
state_dir="$1"
mkdir -p "$state_dir/gates"
cat > "$state_dir/gates/security_review.json" <<'JSON'
{
  "gate": "security_review",
  "status": "passed",
  "stub": true,
  "evaluated_at": "STUB_TIMESTAMP"
}
JSON
sed -i.bak "s/STUB_TIMESTAMP/$(date -u +%Y-%m-%dT%H:%M:%SZ)/" \
  "$state_dir/gates/security_review.json"
rm -f "$state_dir/gates/security_review.json.bak"
```

`cost_analysis.sh` and `rollback_plan.sh` are identical except for the gate name in the artifact and filename. The stubs are NOT auto-invoked by this spec; they are operator-callable scripts. A future plan wires them into a hook or the spawning helper.

### `gates/README.md`

Single-page operator doc that:
1. States the stubs are stubs and emit `passed` unconditionally.
2. Documents the artifact JSON shape (`gate`, `status`, optional `stub`, `evaluated_at`, plus arbitrary additional keys).
3. Documents the artifact path: `<state-dir>/gates/<gate-name>.json`.
4. Notes that the supervisor checks **presence**, not content, so any artifact at that path unblocks advancement (operators relying on real semantics must replace stubs).

## Acceptance Criteria

- [ ] For an `infra`-typed state in `tdd_review`, when `gates/security_review.json` is absent, `select_request()` does not advance the phase and writes `status_reason: "awaiting gate: security_review"` into the state.
- [ ] After manually placing a valid `gates/security_review.json` artifact, the next supervisor iteration advances the same state to `plan` (assuming no other blockers).
- [ ] For a `feature`-typed state in `tdd_review` (no `additionalGates` configured), gate-check is a no-op and advancement proceeds unchanged.
- [ ] For a `bug`-typed state advancing into the `tdd` phase, the spawned command line contains `--bug-context-path <abs-path-to-state.json>`.
- [ ] For an `infra`-typed state advancing into the `tdd` phase, the spawned process inherits `ENHANCED_GATES=security_review,cost_analysis,rollback_plan` in its environment (verified by a snapshot of the env-prefixed command).
- [ ] For a state with `expedited_reviews: true` advancing into any `_review` phase, the spawned command line contains `--expedited`.
- [ ] `--bug-context-path` is NOT added when `req_type != bug`, regardless of phase.
- [ ] `--expedited` is NOT added for non-review phases.
- [ ] `ENHANCED_GATES` is NOT exported for non-infra requests or for review phases.
- [ ] All three stub scripts (`security_review.sh`, `cost_analysis.sh`, `rollback_plan.sh`) exit 0, are marked executable, and produce valid JSON artifacts containing `"stub": true`.
- [ ] `gates/README.md` exists, is at most 80 lines, and contains the four documented points.
- [ ] `shellcheck` passes on `supervisor-loop.sh`, `spawn-session.sh`, `lib/gate-check.sh`, and all three gate stubs.
- [ ] Modifying `status_reason` is idempotent: running the supervisor twice on a still-blocked state writes the same value without corrupting `state.json`.

## Dependencies

- **Blocked by PLAN-018-1**: requires `type_config.additionalGates`, `type`, and `expedited_reviews` fields in v1.1 state.
- **Blocked by SPEC-018-2-01**: shares `select_request()` and the `is_enhanced_phase` helper; gate-check runs after next-phase computation.
- **Coordinates with PLAN-018-3**: the TDD-author agent prompt that consumes `--bug-context-path` ships there. If PLAN-018-3 is not yet deployed when this spec lands, the agent will likely error on the unknown flag — both plans should release together (documented in PLAN-018-2 risks).
- TDD-009 supplies the escalation router (unused here; this spec only updates `status_reason`).
- No new external library or runtime introduced.

## Notes

- The supervisor consults gates for the **current** phase before allowing advancement, not for the **target** phase. Rationale: a gate listed for `tdd_review` is the work product of `tdd_review`; without that artifact, leaving the phase is wrong.
- `status_reason` is a free-text field already present in v1.0 state. Operators see it via the daemon's status CLI.
- Stub gate evaluators are intentionally minimalist. A future plan (likely under TDD-019 hooks or a dedicated security/cost PRD) replaces them with real implementations. The presence-only check in this spec means real evaluators can drop in without daemon changes.
- Snapshot tests for the spawned command lines live in SPEC-018-2-04. This spec only requires the contract.
- The `_review` suffix check is a deliberate convention: every reviewer phase ends in `_review`. If a future variant breaks this convention, the type-aware spawner will need explicit phase-classification metadata; for now, the suffix is sufficient and matches the existing 14-phase taxonomy.
- `ENHANCED_GATES` is comma-separated for forward compatibility with shell-friendly parsing in downstream gate evaluators; keep the value sorted alphabetically so snapshots are deterministic.
