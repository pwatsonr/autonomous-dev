#!/usr/bin/env bash
# wizard-rollback.sh — implements `autonomous-dev wizard rollback --phase NN`
# per SPEC-033-4-04.
#
# Reverts the config keys listed in the phase's
# output_state.config_keys_written to pre-phase snapshot values, revokes
# any external resources listed in output_state.external_resources_created,
# and resets phases.NN.status to "not-run".
#
# Snapshot stack: ~/.autonomous-dev/wizard-snapshots/phase-NN-pre-<ISO8601>.json
# Most-recent symlinked as phase-NN-pre.json. Multi-attempt support via --depth.
#
# Atomicity: build target state in memory, attempt all revocations, only
# persist if every revocation succeeds. On partial failure: exit 1; state
# unmodified; stderr enumerates revoked + remaining.
#
# Flags:
#   --phase NN     (required) phase number to roll back
#   --depth N      (optional, default 1) rollback the N most recent attempts
#   --yes          (optional) bypass confirmation when external resources present
#
# Exit codes:
#   0 = rollback succeeded (or no-op for not-run phase)
#   1 = revocation failure / I/O failure
#   2 = corrupt or missing snapshot / bad arguments
#
# Reference: SPEC-033-4-04 §FR-1..FR-9, §6 acceptance criteria.

set -uo pipefail

# Allow override for tests; default to $HOME.
: "${WIZARD_STATE_FILE:=${HOME}/.autonomous-dev/wizard-state.json}"
: "${AUTONOMOUS_DEV_CONFIG:=${HOME}/.autonomous-dev/config.json}"
: "${WIZARD_SNAPSHOT_DIR:=${HOME}/.autonomous-dev/wizard-snapshots}"

PHASE=""
DEPTH=1
ASSUME_YES=0

_die() {
  local code="${1:-1}"
  shift
  echo "$*" >&2
  exit "$code"
}

_usage() {
  cat <<'EOF'
Usage: wizard-rollback.sh --phase NN [--depth N] [--yes]

Rolls back a wizard phase by reverting config keys, revoking external
resources, and resetting phase status to not-run.
EOF
}

# Parse flags.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      PHASE="${2:-}"
      shift 2
      ;;
    --phase=*)
      PHASE="${1#--phase=}"
      shift
      ;;
    --depth)
      DEPTH="${2:-1}"
      shift 2
      ;;
    --depth=*)
      DEPTH="${1#--depth=}"
      shift
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --help|-h)
      _usage
      exit 0
      ;;
    *)
      _die 2 "[wizard-rollback] unknown argument: $1"
      ;;
  esac
done

[[ -z "$PHASE" ]] && _die 2 "[wizard-rollback] --phase NN is required"
[[ "$PHASE" =~ ^[0-9]+$ ]] || _die 2 "[wizard-rollback] --phase must be numeric (got: $PHASE)"
[[ "$DEPTH" =~ ^[0-9]+$ ]] || _die 2 "[wizard-rollback] --depth must be numeric (got: $DEPTH)"
[[ "$DEPTH" -ge 1 ]]       || _die 2 "[wizard-rollback] --depth must be >= 1"

# Zero-pad phase number to 2 digits. Use base-10 conversion to avoid
# bash treating leading-zero values as octal in the format spec.
PHASE_PADDED="$(printf '%02d' "$((10#$PHASE))")"

# --- helpers ---------------------------------------------------------------

_atomic_write() {
  local target="$1" content="$2"
  local tmp="${target}.tmp.$$"
  printf '%s' "$content" > "$tmp"
  mv "$tmp" "$target"
}

_phase_status() {
  jq -r --arg p "$PHASE_PADDED" '.phases[$p].status // "not-run"' "$WIZARD_STATE_FILE" 2>/dev/null
}

_list_snapshot_stack() {
  # Most-recent first (sort descending on filename = ISO8601 stamp).
  local pattern="${WIZARD_SNAPSHOT_DIR}/phase-${PHASE_PADDED}-pre-*.json"
  shopt -s nullglob
  local files=( $pattern )
  shopt -u nullglob
  if [[ ${#files[@]} -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${files[@]}" | sort -r
}

_validate_snapshot_json() {
  # Validate one snapshot is well-formed JSON with required fields.
  local file="$1"
  jq -e '. | type == "object" and has("phase") and has("config_keys")' "$file" >/dev/null 2>&1
}

_dispatch_revocation() {
  # $1 = resource string like "cred-proxy-handle:dev" or "firewall-allowlist:dev"
  local resource="$1"
  local kind="${resource%%:*}"
  local env="${resource#*:}"
  case "$kind" in
    cred-proxy-handle)
      local handle
      handle="$(jq -r --arg e "$env" '.deploy.envs[$e].cred_proxy_handle // empty' "$WIZARD_STATE_FILE")"
      if [[ -z "$handle" ]]; then
        # Already absent → idempotent success.
        return 0
      fi
      autonomous-dev cred-proxy revoke --handle "$handle" >/dev/null 2>&1
      return $?
      ;;
    firewall-allowlist)
      autonomous-dev firewall rollback --env "$env" >/dev/null 2>&1
      return $?
      ;;
    *)
      echo "[wizard-rollback] unknown external resource kind: $kind" >&2
      return 1
      ;;
  esac
}

# --- main ------------------------------------------------------------------

# State file must exist for rollback to be meaningful.
if [[ ! -f "$WIZARD_STATE_FILE" ]]; then
  _die 2 "[wizard-rollback] wizard-state.json not found at: $WIZARD_STATE_FILE"
fi

# Ensure jq is available.
command -v jq >/dev/null 2>&1 || _die 2 "[wizard-rollback] jq is required"

# FR-8: refuse to rollback a phase whose status is not-run; exit 0 with info.
status="$(_phase_status)"
if [[ "$status" == "not-run" ]]; then
  echo "[wizard-rollback] phase ${PHASE_PADDED} is not-run; nothing to rollback"
  exit 0
fi

# Load snapshot stack.
mapfile -t stack < <(_list_snapshot_stack)
if [[ ${#stack[@]} -eq 0 ]]; then
  _die 2 "[wizard-rollback] snapshot corrupt or missing for phase ${PHASE_PADDED}"
fi

if [[ "$DEPTH" -gt "${#stack[@]}" ]]; then
  _die 1 "[wizard-rollback] requested depth=${DEPTH} but only ${#stack[@]} snapshot(s) available"
fi

# Validate every snapshot we will use BEFORE any mutation (FR-6).
for ((i=0; i<DEPTH; i++)); do
  if ! _validate_snapshot_json "${stack[$i]}"; then
    _die 2 "[wizard-rollback] snapshot corrupt or missing for phase ${PHASE_PADDED}"
  fi
done

# Enumerate external resources from current state.
mapfile -t external_resources < <(jq -r --arg p "$PHASE_PADDED" '
  .phases[$p].external_resources // [] | .[]
' "$WIZARD_STATE_FILE")

# FR-9: confirm if external resources present and not --yes.
if [[ ${#external_resources[@]} -gt 0 && $ASSUME_YES -eq 0 ]]; then
  echo "About to revoke the following external resources:" >&2
  printf '  - %s\n' "${external_resources[@]}" >&2
  echo -n "Proceed? [y/N] " >&2
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) _die 1 "[wizard-rollback] aborted by operator" ;;
  esac
fi

# Compose target config from snapshots oldest-first (so the deepest
# snapshot's pre-phase values are the final result).
target_config="$(cat "$AUTONOMOUS_DEV_CONFIG" 2>/dev/null || echo '{}')"
for ((i=DEPTH-1; i>=0; i--)); do
  snap="${stack[$i]}"
  # For each key in config_keys: if value is null (was absent pre-phase), delete;
  # otherwise set.
  target_config="$(jq --slurpfile snap "$snap" '
    . as $cfg
    | $snap[0].config_keys
    | to_entries
    | reduce .[] as $kv ($cfg;
        if ($kv.value == null) then
          delpaths([$kv.key | split(".") | map(if test("^[0-9]+$") then tonumber else . end)])
        else
          setpath($kv.key | split("."); $kv.value)
        end
      )
  ' <<<"$target_config")"
done

# Track revocations attempted; abort with state-unchanged on first failure.
revoked=()
remaining=("${external_resources[@]:-}")
for resource in "${external_resources[@]:-}"; do
  if [[ -z "$resource" ]]; then continue; fi
  if _dispatch_revocation "$resource"; then
    revoked+=( "$resource" )
    # Trim from remaining.
    new_remaining=()
    for r in "${remaining[@]:-}"; do
      [[ "$r" != "$resource" && -n "$r" ]] && new_remaining+=( "$r" )
    done
    remaining=( "${new_remaining[@]:-}" )
  else
    {
      echo "[wizard-rollback] revocation failed for ${resource}."
      echo "[wizard-rollback] Already revoked: ${revoked[*]:-(none)}."
      echo "[wizard-rollback] Remaining: ${remaining[*]:-(none)}."
      echo "[wizard-rollback] State NOT modified."
    } >&2
    exit 1
  fi
done

# Build new state: reset phases.NN.status to not-run, drop external_resources,
# remove from phases_complete.
new_state="$(jq --arg p "$PHASE_PADDED" --argjson pn "$((10#$PHASE_PADDED))" '
  .phases[$p].status = "not-run"
  | .phases[$p].external_resources = []
  | .phases_complete = ((.phases_complete // []) | map(select(. != $pn)))
' "$WIZARD_STATE_FILE")"

# Persist atomically.
_atomic_write "$WIZARD_STATE_FILE" "$new_state"
_atomic_write "$AUTONOMOUS_DEV_CONFIG" "$target_config"

# Emit structured summary on stdout.
keys_reverted="$(jq -c '.config_keys // {} | keys' "${stack[0]}")"
jq -n \
  --argjson p "$((10#$PHASE_PADDED))" \
  --argjson keys "$keys_reverted" \
  --argjson revoked "$(printf '%s\n' "${revoked[@]:-}" | jq -R . | jq -s 'map(select(length>0))')" \
  --arg snap "${stack[0]}" \
  '{phase:$p, config_keys_reverted:$keys, external_resources_revoked:$revoked, snapshot_used:$snap}'
