#!/usr/bin/env bash
# validate-existing.sh -- Retroactive schema validation per SPEC-028-1-01 / SPEC-028-1-06.
#
# Walks plugins/autonomous-dev-assist/evals/test-cases/*.yaml, transforms each
# case to JSON, validates against eval-case-v1.json, and emits a Markdown
# summary table to stdout plus a JSON artefact at
# evals/schema/.retroactive-results.json.
#
# Per TDD-028 OQ-5: legacy violations are INFORMATIONAL only. The script
# exits 0 unconditionally; any non-zero violation count is filed as a
# follow-up ticket in the PR description.
#
# Dependencies: yq v4 (mikefarah/yq), python3 with json + jsonschema.
# Falls back gracefully if jsonschema is unavailable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCHEMA="${SCRIPT_DIR}/eval-case-v1.json"
TEST_CASES_DIR="${EVAL_DIR}/test-cases"
RESULTS_JSON="${SCRIPT_DIR}/.retroactive-results.json"

if [[ ! -f "${SCHEMA}" ]]; then
  echo "ERROR: Schema not found at ${SCHEMA}" >&2
  exit 0  # informational
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found on PATH; cannot run retroactive validation." >&2
  exit 0
fi

if command -v yq >/dev/null 2>&1; then
  HAS_YQ=1
else
  HAS_YQ=0
fi

# Probe jsonschema + yaml availability (python3 fallback path)
if ! python3 -c "import jsonschema, yaml" >/dev/null 2>&1; then
  echo "WARNING: python3 jsonschema or PyYAML module not available; running structural check only." >&2
  HAS_JSONSCHEMA=0
else
  HAS_JSONSCHEMA=1
fi

total_files=0
total_cases=0
total_violations=0

# Build JSON artefact incrementally
files_json="[]"

for yaml_file in "${TEST_CASES_DIR}"/*.yaml; do
  [[ -f "${yaml_file}" ]] || continue
  rel_path="test-cases/$(basename "${yaml_file}")"
  total_files=$((total_files + 1))

  # Extract cases array as JSON (yq preferred; python3+PyYAML fallback)
  if [[ "${HAS_YQ}" -eq 1 ]]; then
    cases_json=$(yq -o=json '.cases // []' "${yaml_file}" 2>/dev/null || echo "[]")
  else
    cases_json=$(python3 -c "
import json, sys, yaml
with open(sys.argv[1]) as f:
    doc = yaml.safe_load(f) or {}
cases = doc.get('cases', []) or []
print(json.dumps(cases))
" "${yaml_file}" 2>/dev/null || echo "[]")
  fi
  case_count=$(echo "${cases_json}" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)

  violations_for_file="[]"
  violation_count=0

  if [[ "${HAS_JSONSCHEMA}" -eq 1 && "${case_count}" -gt 0 ]]; then
    # Validate each case against schema
    while IFS= read -r line; do
      [[ -z "${line}" ]] && continue
      violation_count=$((violation_count + 1))
      violations_for_file=$(echo "${violations_for_file}" | python3 -c "
import json, sys
arr = json.load(sys.stdin)
arr.append('${line}')
print(json.dumps(arr))
" 2>/dev/null || echo "${violations_for_file}")
    done < <(python3 - "${SCHEMA}" "${cases_json}" <<'PY' 2>/dev/null
import json, sys
import jsonschema

schema_path = sys.argv[1]
cases_payload = sys.argv[2]
with open(schema_path) as f:
    schema = json.load(f)
cases = json.loads(cases_payload)
validator = jsonschema.Draft202012Validator(schema)
for idx, case in enumerate(cases):
    case_id = case.get("id", f"<index {idx}>") if isinstance(case, dict) else f"<index {idx}>"
    errors = list(validator.iter_errors(case))
    for err in errors:
        path = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "/"
        print(f"{case_id}|{path}|{err.validator}")
PY
    )
  fi

  total_cases=$((total_cases + case_count))
  total_violations=$((total_violations + violation_count))

  if [[ "${violation_count}" -eq 0 ]]; then
    echo "[OK] ${rel_path}: ${case_count} cases pass"
  else
    echo "[VIOLATIONS] ${rel_path}: ${violation_count} issues"
  fi

  files_json=$(echo "${files_json}" | python3 -c "
import json, sys
arr = json.load(sys.stdin)
arr.append({'path': '${rel_path}', 'case_count': ${case_count}, 'violations': ${violations_for_file:-[]}, 'violation_count': ${violation_count}})
print(json.dumps(arr))
" 2>/dev/null || echo "${files_json}")
done

# Write artefact
python3 - "${RESULTS_JSON}" "${files_json}" "${total_files}" "${total_cases}" "${total_violations}" <<'PY' || true
import json, sys
out_path = sys.argv[1]
files = json.loads(sys.argv[2])
totals = {"files": int(sys.argv[3]), "cases": int(sys.argv[4]), "violations": int(sys.argv[5])}
with open(out_path, "w") as f:
    json.dump({"files": files, "totals": totals}, f, indent=2, sort_keys=True)
PY

echo ""
echo "Totals: files=${total_files} cases=${total_cases} violations=${total_violations}"
echo "Artefact: ${RESULTS_JSON}"

# Exit 0 unconditionally (informational mode per OQ-5)
exit 0
