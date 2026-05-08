---
phase: 14
title: "Engineering standards bootstrap"
amendment_001_phase: 14
tdd_anchors: [TDD-021]
prd_links: []
required_inputs:
  phases_complete: [1,2,3,4,5,6,7]
  config_keys: []
optional_inputs:
  existing_standards_yaml: true
skip_predicate: "skip-predicates.sh phase_14_skip_predicate"
skip_consequence: |
  Author agents will not be standards-aware; code may violate team conventions silently.
idempotency_probe: "idempotency-checks.sh phase-14-probe"
output_state:
  config_keys_written:
    - standards.pack_id
    - standards.path
    - standards.two_person_approval_enabled
    - standards.last_dry_run_at
  files_created:
    - "<repo>/.autonomous-dev/standards.yaml"
    - "<repo>/.autonomous-dev/standards-dry-run-<YYYY-MM-DD>.json"
  external_resources_created: []
verification:
  - "standards.yaml validates via autonomous-dev standards validate"
  - "Prompt renderer returns non-empty STANDARDS_SECTION"
  - "Meta-reviewer --dry-run produces JSON without crash"
  - "two_person_approval_enabled flag persisted"
  - "Daemon SIGHUP issued"
eval_set: "evals/test-cases/setup-wizard/phase-14-eng-standards/"
---

# Phase 14 — Engineering standards bootstrap

This phase configures engineering standards on the operator's repo
(TDD-021). It auto-detects the primary language, surfaces a bundled
standards pack for confirmation, writes
`<repo>/.autonomous-dev/standards.yaml`, validates the file via the
TDD-021 schema validator, exercises the **prompt renderer**
(SPEC-021-3-01), runs the **standards-meta-reviewer** in dry-run mode
against recent commits (SPEC-021-3-02), and optionally enables
**two-person-approval** for fix-recipe applications.

The phase is dry-run-only: no PR is opened and no CI workflow is
invoked. The dated `standards-dry-run-YYYY-MM-DD.json` is the audit
trail.

## Steps

### Step `intro`

Banner:

```
================================================================
   Phase 14: Engineering standards bootstrap
================================================================
This phase configures the engineering-standards pack on your repo.
Validation runs locally; the meta-reviewer runs against the last 5
commits in dry-run mode (no PR comments, no LLM calls).
```

### Step `detect-language`

```bash
detected="$(autonomous-dev detect-language --repo "$REPO" 2>/dev/null || echo unknown)"
```

The detected language is **surfaced** for operator confirmation, not
auto-accepted. Allowed override codes: `ts`, `py`, `go`, `js`,
`rust`, `java`, `cs`, `unknown`.

### Step `confirm-language`

```bash
read -r -p "Detected: $detected. Confirm or override (ts/py/go/js/...) [Enter=accept]: " ans
ans="${ans:-$detected}"
LANGUAGE="$ans"
```

### Step `existing-yaml-decision`

```bash
target="$REPO/.autonomous-dev/standards.yaml"
if [[ -f "$target" ]]; then
  read -r -p "standards.yaml exists. (k)eep / (m)erge / (r)eplace? [k] " choice
  choice="${choice:-k}"
  case "$choice" in
    k|K) EXISTING_DECISION=keep ;;
    m|M) EXISTING_DECISION=merge ;;
    r|R) EXISTING_DECISION=replace ;;
    *)   EXISTING_DECISION=keep ;;
  esac
  jq --arg c "$EXISTING_DECISION" '.phase14_existing_decision=$c' \
    "$WIZARD_CHECKPOINT" > "${WIZARD_CHECKPOINT}.new" && mv "${WIZARD_CHECKPOINT}.new" "$WIZARD_CHECKPOINT"
fi
```

### Step `offer-pack`

```bash
catalog="$PLUGIN_DIR/config/standards-packs.json"
if [[ ! -f "$catalog" ]]; then
  echo "[phase-14] standards-packs catalog missing: $catalog" >&2
  echo "  See: /autonomous-dev-assist:troubleshoot" >&2
  exit 1
fi
# Filter packs by language; offer matching + "author your own".
packs="$(jq -c --arg lang "$LANGUAGE" '.[] | select(.language==$lang or $lang=="unknown")' "$catalog")"
echo "Available packs for $LANGUAGE:"
i=0
declare -a PACK_IDS
while IFS= read -r p; do
  id="$(jq -r '.id' <<<"$p")"
  desc="$(jq -r '.description // ""' <<<"$p")"
  echo "  [$i] $id — $desc"
  PACK_IDS[$i]="$id"
  i=$((i+1))
done <<<"$packs"
echo "  [a] author your own"
read -r -p "Pick pack: " sel
if [[ "$sel" == "a" ]]; then
  PACK_ID=author-your-own
else
  PACK_ID="${PACK_IDS[$sel]:-}"
fi
```

### Step `write-yaml`

Skipped on `keep`. On `replace` or `merge`, write the pack template
to `<repo>/.autonomous-dev/standards.yaml`. On `merge`, the merge UX
opens `$EDITOR` on a candidate file at
`<repo>/.autonomous-dev/standards.yaml.candidate` and atomic-renames
to the live path only after editor exit 0.

```bash
mkdir -p "$REPO/.autonomous-dev"
template="$PLUGIN_DIR/templates/standards-packs/$PACK_ID.yaml"
case "$EXISTING_DECISION" in
  keep) ;;
  replace|"")
    if [[ "$PACK_ID" == "author-your-own" ]]; then
      cat > "$target" <<'EOF'
# author-your-own standards.yaml stub. Add rules below.
rules: []
EOF
    else
      cp "$template" "$target"
    fi
    ;;
  merge)
    cand="${target}.candidate"
    cp "$template" "$cand"
    "${EDITOR:-vi}" "$cand" || { echo "[phase-14] editor exited non-zero; aborting merge" >&2; exit 1; }
    mv "$cand" "$target"
    ;;
esac
```

### Step `validate-yaml`

```bash
TRIES=0
while ! autonomous-dev standards validate --repo "$REPO" 2> "$TMP/validate.err"; do
  TRIES=$((TRIES+1))
  cat "$TMP/validate.err" >&2
  if (( TRIES >= 3 )); then
    echo "[phase-14] validation failed after 3 attempts" >&2
    exit 1
  fi
  read -r -p "Validation failed. Re-pick? [y/N] " r
  [[ "$r" =~ ^[Yy]$ ]] || exit 1
  # caller jumps back to offer-pack
  WIZARD_RESUME_STEP=offer-pack
done
```

### Step `exercise-prompt-renderer`

The prompt-renderer regression gate (FR-24): pick the first listed
rule in the pack, invoke `render-prompt`, assert non-empty
`STANDARDS_SECTION`.

```bash
first_rule="$(jq -r '.rules[0].id // ""' "$target")"
[[ -n "$first_rule" ]] || { echo "[phase-14] no rules in $target" >&2; exit 1; }
render_out="$(autonomous-dev standards render-prompt --rule-id "$PACK_ID:$first_rule")" \
  || { echo "[phase-14] render-prompt failed" >&2; exit 1; }
grep -q '^STANDARDS_SECTION:' <<<"$render_out" \
  || { echo "[phase-14] STANDARDS_SECTION missing from renderer output" >&2; exit 1; }
```

### Step `meta-reviewer-dry-run`

```bash
total_commits="$(git -C "$REPO" rev-list --count HEAD)"
if (( total_commits >= 5 )); then
  range="HEAD~5..HEAD"
  truncated=false
else
  range="HEAD~${total_commits}..HEAD"
  truncated=true
fi
today_utc="$(date -u +%Y-%m-%d)"
out="$REPO/.autonomous-dev/standards-dry-run-${today_utc}.json"
autonomous-dev standards-meta-reviewer --dry-run --against "$range" \
  | jq --argjson trunc "$truncated" '.metadata.range_truncated=$trunc' \
  > "$out" \
  || { echo "[phase-14] meta-reviewer dry-run failed" >&2; exit 1; }
```

### Step `two-person-approval`

```bash
read -r -p "Enable two-person-approval for fix-recipe applications? [y/N] " tpa
case "$tpa" in
  y|Y) TPA=true ;;
  *)   TPA=false ;;
esac
```

### Step `write-config`

```bash
cfg="$AUTONOMOUS_DEV_CONFIG"
tmp="${cfg}.new"
jq --arg pid "$PACK_ID" \
   --arg path "$target" \
   --argjson tpa "$TPA" \
   --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.standards.pack_id=$pid
    | .standards.path=$path
    | .standards.two_person_approval_enabled=$tpa
    | .standards.last_dry_run_at=$ts' \
   "$cfg" > "$tmp"
mv "$tmp" "$cfg"
```

### Step `sighup`

```bash
if [[ -z "${WIZARD_HEADLESS_EVAL:-}" ]] && [[ -f "$HOME/.autonomous-dev/daemon.pid" ]]; then
  kill -HUP "$(cat "$HOME/.autonomous-dev/daemon.pid")"
fi
```

### Step `summary`

Emit the structured log line per TDD-033 §10.5:

```
{"phase":14,"step":"verify","status":"completed","duration_ms":N}
```

## Defense-in-depth

- Validation up to 3 attempts; on failure, the phase exits with a
  pointer to `/autonomous-dev-assist:troubleshoot` and does NOT
  pretend success.
- The dated `standards-dry-run-YYYY-MM-DD.json` is the only file the
  meta-reviewer dry-run writes. Re-running on the same UTC date
  overwrites the day's file (eval `idempotency-resume.md` Sub-D
  asserts this behavior).
- Two-person-approval is off by default; opting in is an explicit
  `y` answer at the prompt. The flag wires to SPEC-021-3-02's
  contract; phase 14 does not validate that contract here.

## Resume contract

`WIZARD_RESUME_STEP` jumps to a named step. The
`existing-yaml-decision` choice is recorded in
`wizard-checkpoint.json` so resume after that step does not re-prompt.
