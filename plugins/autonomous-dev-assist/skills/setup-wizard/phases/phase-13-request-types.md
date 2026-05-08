---
phase: 13
title: "Request types + extension hooks"
amendment_001_phase: 13
tdd_anchors: [TDD-018, TDD-019]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys:
    - governance.per_request_cost_cap_usd
optional_inputs:
  existing_request_types: true
  existing_hooks: true
skip_predicate: "skip-predicates.sh phase_13_skip_predicate"
skip_consequence: |
  Only the default request type is active; hotfix/exploration/refactor are unavailable until you run `wizard --phase 13`.
idempotency_probe: "idempotency-checks.sh phase-13-probe"
output_state:
  config_keys_written:
    - "request_types.<type>.enabled"
    - "request_types.<type>.cost_cap_usd"
    - "request_types.<type>.trust_threshold"
    - "request_types.<type>.default_reviewers"
    - "hooks.<hook_point>.<handler_id>"
  files_created: []
  external_resources_created: []
verification:
  - "request_types.<each-enabled>.enabled=true in config"
  - "autonomous-dev request types list returns the configured set"
  - "If any custom hook registered: autonomous-dev hooks list returns it"
  - "Dry-run submit observes request_type=<type> in first state transition"
  - "Daemon SIGHUP issued"
eval_set: "evals/test-cases/setup-wizard/phase-13-request-types/"
---

# Phase 13 — Request types + extension hooks

This phase configures the bundled request-type catalog
(default/hotfix/exploration/refactor) and lets the operator register
custom extension hooks via TDD-019's `autonomous-dev hooks add` CLI.
Verification is a **dry-run probe** — `autonomous-dev request submit
--type <t> --dry-run --observe-first-transition` — which MUST NOT
write to the daemon request store, MUST NOT emit notifications, and
MUST NOT trigger any reviewer chain.

## TDD-018 / TDD-019 cross-reference

This phase is operator onboarding for surfaces owned by:

  - TDD-018: request-type catalog + state machine.
  - TDD-019: extension hooks framework + `autonomous-dev hooks add`
    CLI + handler-path trust validator.

The wizard does NOT inline the request-type schemas or the hook
contract; it walks the operator through the supported CLIs and writes
the resulting config keys.

## Steps

### Step `intro`

Banner:

```
================================================================
   Phase 13: Request types + extension hooks
================================================================
This phase enables non-default request types (hotfix/exploration/
refactor) and lets you register custom extension hooks. All writes
are config-only; the verification step uses a strictly dry-run
submit that creates no real work and emits no notifications.
```

### Step `read-catalog`

```bash
catalog="$PLUGIN_DIR/config/request-types.json"
override="$REPO/.autonomous-dev/request-types-override.json"
if [[ -f "$override" ]]; then
  catalog="$override"   # TDD-018 layered-config behavior
fi
if [[ ! -f "$catalog" ]]; then
  echo "[phase-13] request-types catalog missing: $catalog" >&2
  echo "  See: /autonomous-dev-assist:troubleshoot" >&2
  exit 1
fi
jq -e 'type == "array"' "$catalog" >/dev/null \
  || { echo "[phase-13] catalog malformed (not a JSON array)" >&2; exit 1; }
```

The phase iterates whatever entries exist; the module body contains
no hard-coded type IDs (FR-7 data-drivenness).

### Step `per-type-prompt`

For each catalog entry (in catalog order):

```bash
gov_cap="$(jq -r '.governance.per_request_cost_cap_usd // 50' "$AUTONOMOUS_DEV_CONFIG")"

while IFS= read -r entry; do
  id="$(jq -r '.id' <<<"$entry")"
  desc="$(jq -r '.description // ""' <<<"$entry")"
  default_cap="$(jq -r ".default_cost_cap_usd // $gov_cap" <<<"$entry")"
  default_thresh="$(jq -r '.default_trust_threshold // 0.7' <<<"$entry")"
  default_revs="$(jq -r '.default_reviewers // [] | join(",")' <<<"$entry")"

  read -r -p "Enable request type '$id' ($desc)? [y/N] " ans
  case "$ans" in
    y|Y)
      read -r -p "  Cost cap USD [default $gov_cap]: " cap
      cap="${cap:-$gov_cap}"
      read -r -p "  Trust threshold [default $default_thresh]: " thresh
      thresh="${thresh:-$default_thresh}"
      read -r -p "  Default reviewers, comma-separated [default $default_revs]: " revs
      revs="${revs:-$default_revs}"
      # Trim per entry; emit JSON array
      revs_json="$(awk -v s="$revs" 'BEGIN{
        n=split(s,a,",");printf("[");
        for(i=1;i<=n;i++){gsub(/^ +| +$/,"",a[i]);
          if(a[i]!="")printf("%s\"%s\"",(i>1?",":""),a[i])} print "]"}')"
      ENABLED_TYPES+=("$id")
      TYPE_CAP[$id]="$cap"
      TYPE_THRESH[$id]="$thresh"
      TYPE_REVS[$id]="$revs_json"
      ;;
    *) ;;
  esac
done < <(jq -c '.[]' "$catalog")
```

### Step `prompt-custom-hook`

```bash
read -r -p "Register a custom extension hook? [y/N] " want_hook
[[ "$want_hook" =~ ^[Yy]$ ]] || HOOK_LOOP_DONE=1
```

### Step `hook-add-loop`

```bash
HOOK_TRIES=0
while [[ -z "${HOOK_LOOP_DONE:-}" ]]; do
  read -r -p "  hook_point (e.g. code-pre-write, pr-pre-create): " hp
  read -r -p "  handler_path (absolute or repo-relative): " hpath
  # Resolve to absolute path; reject if missing.
  abs="$(cd "$(dirname "$hpath")" 2>/dev/null && pwd)/$(basename "$hpath")"
  if [[ ! -f "$abs" ]]; then
    echo "  handler not found at: $abs" >&2
    HOOK_TRIES=$((HOOK_TRIES+1))
    [[ $HOOK_TRIES -ge 3 ]] && { echo "  too many attempts; aborting hook add"; break; }
    continue
  fi
  read -r -p "  handler_id (free-form name): " hid

  # Allowlist confirmation prompt — FR-11. Display absolute path AND
  # the first 200 bytes of the handler script's contents.
  cat <<EOF
================================================================
About to register a custom extension hook:

  hook_point:    $hp
  handler_id:    $hid
  handler_path:  $abs

First 200 bytes of $abs:
$(head -c 200 "$abs" | sed 's/^/  /')

This handler will run with daemon-process privileges on every
$hp event. To confirm, type the literal string "yes":
================================================================
EOF
  read -r confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "  rejected (input was not literal 'yes'); aborting hook add" >&2
    HOOK_TRIES=$((HOOK_TRIES+1))
    [[ $HOOK_TRIES -ge 3 ]] && break
    continue
  fi

  # Invoke autonomous-dev hooks add — TDD-019 CLI. Idempotent on
  # (hook_point, handler_path) collision.
  set +e
  out="$(autonomous-dev hooks add --hook-point "$hp" \
                                  --handler-path "$abs" \
                                  --handler-id "$hid" 2>&1)"
  rc=$?
  set -e
  case "$rc" in
    0)
      REGISTERED_HOOKS+=("$hp:$hid:$abs")
      ;;
    *)
      if grep -q "already registered with same handler_path" <<<"$out"; then
        echo "  already registered (idempotent); continuing"
        REGISTERED_HOOKS+=("$hp:$hid:$abs")
      elif grep -q "already registered with different handler_id" <<<"$out"; then
        read -r -p "  collision with different handler_id; update? [y/N] " upd
        if [[ "$upd" =~ ^[Yy]$ ]]; then
          autonomous-dev hooks add --hook-point "$hp" \
                                   --handler-path "$abs" \
                                   --handler-id "$hid" --update
          REGISTERED_HOOKS+=("$hp:$hid:$abs")
        fi
      else
        echo "  $out" >&2
        HOOK_TRIES=$((HOOK_TRIES+1))
        [[ $HOOK_TRIES -ge 3 ]] && break
      fi
      ;;
  esac
  read -r -p "Register another? [y/N] " more
  [[ "$more" =~ ^[Yy]$ ]] || HOOK_LOOP_DONE=1
done
```

### Step `dry-run-probe`

If at least one non-default type is enabled (`ENABLED_TYPES` non-empty):

```bash
first="${ENABLED_TYPES[0]:-}"
if [[ -z "$first" ]]; then
  # FR-17: no non-default enabled → skip submit; verify via list.
  autonomous-dev request types list >/dev/null \
    || { echo "[phase-13] request types list failed" >&2; exit 1; }
else
  # snapshot the daemon request store for fs-snapshot diff
  store="${AUTONOMOUS_DEV_DAEMON_STORE:-$HOME/.autonomous-dev/requests}"
  mkdir -p "$store"
  marker="$(mktemp)"
  touch "$marker"

  # Probe — FR-14, FR-15. --observe-first-transition is the
  # contracted flag; if absent, fall back to --json (Implementation
  # Notes §8 of SPEC).
  out="$(autonomous-dev request submit --type "$first" \
              --dry-run --observe-first-transition 2>&1)" \
    || { echo "[phase-13] dry-run probe failed: $out" >&2; exit 1; }

  # Defense-in-depth: parse the daemon's self-reported counts AND
  # do an independent fs-snapshot diff.
  observed="$(jq -r '.first_state_transition.request_type // empty' <<<"$out")"
  [[ "$observed" == "$first" ]] \
    || { echo "[phase-13] expected request_type=$first; got '$observed'" >&2; exit 1; }

  # Independent verification:
  new_entries="$(find "$store" -newer "$marker" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$new_entries" == "0" ]] \
    || { echo "[phase-13] DRY-RUN VIOLATION: $new_entries new store entries" >&2; exit 1; }
fi
```

### Step `write-config`

```bash
cfg="$AUTONOMOUS_DEV_CONFIG"
tmp="${cfg}.new"
jq_filter='.'
for t in "${ENABLED_TYPES[@]}"; do
  jq_filter+=" | .request_types[\"$t\"].enabled = true"
  jq_filter+=" | .request_types[\"$t\"].cost_cap_usd = ${TYPE_CAP[$t]}"
  jq_filter+=" | .request_types[\"$t\"].trust_threshold = ${TYPE_THRESH[$t]}"
  jq_filter+=" | .request_types[\"$t\"].default_reviewers = ${TYPE_REVS[$t]}"
done
for h in "${REGISTERED_HOOKS[@]:-}"; do
  IFS=":" read -r hp hid hpath <<<"$h"
  jq_filter+=" | .hooks[\"$hp\"][\"$hid\"] = \"$hpath\""
done
jq "$jq_filter" "$cfg" > "$tmp"
mv "$tmp" "$cfg"
```

### Step `sighup`

```bash
# FR-16: exactly one SIGHUP at phase end.
if [[ -z "${WIZARD_HEADLESS_EVAL:-}" ]] && [[ -f "$HOME/.autonomous-dev/daemon.pid" ]]; then
  kill -HUP "$(cat "$HOME/.autonomous-dev/daemon.pid")"
fi
```

### Step `summary`

Emit `{"phase":13,"step":"verify","status":"completed","duration_ms":N}`.

## Defense-in-depth

- The dry-run probe is the only step that interacts with the daemon;
  fs-snapshot diff + chat-mock + chain-mock provide independent
  verification (do not trust daemon's self-reported counts alone).
- The literal "yes" allowlist confirmation in `hook-add-loop` is a
  belt-and-suspenders gate even if TDD-019's CLI also enforces a
  handler-path allowlist.
- Hook re-registration with same `(hook_point, handler_path)` is a
  no-op (CLI returns `already registered with same handler_path`).
  Different handler_id collision triggers an explicit update prompt.
- Per-type `default_reviewers` is written as a JSON array (not CSV).

## Resume contract

`WIZARD_RESUME_STEP` jumps to a named step. Mid-prompt SIGTERM
preserves the wizard checkpoint at the most recently completed
step; resume continues at the next un-prompted catalog entry.
