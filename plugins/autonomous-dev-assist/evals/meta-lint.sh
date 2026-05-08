#!/usr/bin/env bash
# meta-lint.sh -- CI-time linter for autonomous-dev-assist eval suites.
#
# Walks every suite registered in evals/eval-config.yaml whose enabled flag
# is true, validates frontmatter and per-case schema conformance against
# evals/schema/eval-case-v1.json, enforces case_minimum and negative_minimum
# floors, and emits human-readable or JSON output.
#
# Exit codes:
#   0  all suites pass (or violations downgraded under --allow-baseline-deficit)
#   1  one or more suites failed
#   2  internal error (missing config, missing schema, dependency error)
#
# Usage:
#   bash evals/meta-lint.sh                                     # human output
#   bash evals/meta-lint.sh --json                              # JSON output
#   bash evals/meta-lint.sh --allow-baseline-deficit            # tolerate case_minimum
#   bash evals/meta-lint.sh --config <path> --schema <path>     # override paths
#
# Dependencies: bash 4+, python3 (with PyYAML + jsonschema). yq is preferred
# for YAML parsing but python3 is the documented fallback.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CONFIG="${SCRIPT_DIR}/eval-config.yaml"
DEFAULT_SCHEMA="${SCRIPT_DIR}/schema/eval-case-v1.json"

CONFIG="${DEFAULT_CONFIG}"
SCHEMA="${DEFAULT_SCHEMA}"
JSON_OUTPUT=0
ALLOW_BASELINE_DEFICIT=0

usage() {
  cat <<'USAGE'
Usage: meta-lint.sh [--json] [--allow-baseline-deficit] [--config PATH] [--schema PATH] [--help]

  --json                       emit a JSON document on stdout
  --allow-baseline-deficit     downgrade case_minimum violations to warnings (exit 0)
  --config PATH                override eval-config.yaml path
  --schema PATH                override eval-case-v1.json path
  --help                       show this help and exit
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUTPUT=1; shift ;;
    --allow-baseline-deficit) ALLOW_BASELINE_DEFICIT=1; shift ;;
    --config) CONFIG="$2"; shift 2 ;;
    --schema) SCHEMA="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -f "${CONFIG}" ]]; then
  echo "ERROR: eval-config.yaml not found at ${CONFIG}" >&2
  exit 2
fi

if [[ ! -f "${SCHEMA}" ]]; then
  echo "ERROR: schema not found at ${SCHEMA}" >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required (for YAML and jsonschema validation)." >&2
  exit 2
fi

if ! python3 -c "import yaml, jsonschema" >/dev/null 2>&1; then
  echo "ERROR: python3 modules 'yaml' and 'jsonschema' are required." >&2
  echo "       Install with: pip3 install --user PyYAML jsonschema" >&2
  exit 2
fi

# Delegate the heavy lifting to a single embedded Python script. Keeping this
# in one process avoids per-suite forking and meets the <5 s NFR for 8 suites.
# Suite file paths in eval-config.yaml are resolved relative to the config's
# own directory, so a custom --config path can be used in smoke tests.
EVAL_DIR="$(cd "$(dirname "${CONFIG}")" && pwd)"
export META_LINT_CONFIG="${CONFIG}"
export META_LINT_SCHEMA="${SCHEMA}"
export META_LINT_EVAL_DIR="${EVAL_DIR}"
export META_LINT_JSON="${JSON_OUTPUT}"
export META_LINT_ALLOW_DEFICIT="${ALLOW_BASELINE_DEFICIT}"

python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

import yaml
import jsonschema

config_path = Path(os.environ["META_LINT_CONFIG"])
schema_path = Path(os.environ["META_LINT_SCHEMA"])
eval_dir = Path(os.environ["META_LINT_EVAL_DIR"])
json_mode = os.environ.get("META_LINT_JSON") == "1"
allow_deficit = os.environ.get("META_LINT_ALLOW_DEFICIT") == "1"

with config_path.open() as f:
    config = yaml.safe_load(f)
with schema_path.open() as f:
    schema = json.load(f)

try:
    jsonschema.Draft202012Validator.check_schema(schema)
except jsonschema.SchemaError as exc:
    print(f"ERROR: schema is malformed: {exc.message}", file=sys.stderr)
    sys.exit(2)

validator = jsonschema.Draft202012Validator(schema)

suites_cfg = (config or {}).get("suites", {}) or {}
findings = []
suites_out = {}
overall_pass = True

for suite_name, suite_cfg in suites_cfg.items():
    if not isinstance(suite_cfg, dict) or not suite_cfg.get("enabled", False):
        continue
    rel_file = suite_cfg.get("file")
    case_minimum = int(suite_cfg.get("case_minimum", 0) or 0)
    negative_minimum = int(suite_cfg.get("negative_minimum", 0) or 0)

    suite_findings = []
    case_count = 0
    negative_count = 0
    suite_pass = True

    if not rel_file:
        suite_findings.append({
            "suite": suite_name,
            "rule": "frontmatter",
            "severity": "error",
            "message": "suite registration is missing 'file' key",
        })
        suite_pass = False
    else:
        suite_yaml_path = eval_dir / rel_file
        if not suite_yaml_path.exists():
            suite_findings.append({
                "suite": suite_name,
                "rule": "frontmatter",
                "severity": "error",
                "message": f"suite file not found at {suite_yaml_path}",
            })
            suite_pass = False
        else:
            try:
                with suite_yaml_path.open() as f:
                    doc = yaml.safe_load(f)
            except yaml.YAMLError as exc:
                suite_findings.append({
                    "suite": suite_name,
                    "rule": "frontmatter",
                    "severity": "error",
                    "message": f"YAML parse error: {exc}",
                })
                suite_pass = False
                doc = None

            if doc is not None:
                # Frontmatter checks
                if doc.get("suite") != suite_name:
                    suite_findings.append({
                        "suite": suite_name,
                        "rule": "frontmatter",
                        "severity": "error",
                        "message": (
                            f"suite frontmatter 'suite' is '{doc.get('suite')}'"
                            f" but config registers '{suite_name}'"
                        ),
                    })
                    suite_pass = False
                if doc.get("schema") != "eval-case-v1":
                    suite_findings.append({
                        "suite": suite_name,
                        "rule": "frontmatter",
                        "severity": "error",
                        "message": "missing or wrong 'schema' field; expected 'eval-case-v1'",
                    })
                    suite_pass = False
                if not isinstance(doc.get("case_minimum"), int) or doc.get("case_minimum") < 1:
                    suite_findings.append({
                        "suite": suite_name,
                        "rule": "frontmatter",
                        "severity": "error",
                        "message": "frontmatter 'case_minimum' must be an integer >= 1",
                    })
                    suite_pass = False
                if not isinstance(doc.get("negative_minimum"), int) or doc.get("negative_minimum") < 0:
                    suite_findings.append({
                        "suite": suite_name,
                        "rule": "frontmatter",
                        "severity": "error",
                        "message": "frontmatter 'negative_minimum' must be an integer >= 0",
                    })
                    suite_pass = False

                cases = doc.get("cases") or []
                if not isinstance(cases, list):
                    suite_findings.append({
                        "suite": suite_name,
                        "rule": "frontmatter",
                        "severity": "error",
                        "message": "'cases' must be a list",
                    })
                    suite_pass = False
                    cases = []

                case_count = len(cases)
                # Schema validation per case
                for idx, case in enumerate(cases):
                    case_id = case.get("id", f"<index {idx}>") if isinstance(case, dict) else f"<index {idx}>"
                    errors = list(validator.iter_errors(case))
                    for err in errors:
                        path = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "/"
                        suite_findings.append({
                            "suite": suite_name,
                            "rule": "schema",
                            "severity": "error",
                            "case_id": case_id,
                            "path": path,
                            "keyword": err.validator,
                            "message": err.message,
                        })
                        suite_pass = False
                    if isinstance(case, dict):
                        nm = case.get("must_not_mention") or []
                        if isinstance(nm, list):
                            negative_count += len(nm)

                # case_minimum check
                if case_count < case_minimum:
                    severity = "warning" if allow_deficit else "error"
                    suite_findings.append({
                        "suite": suite_name,
                        "rule": "case_minimum",
                        "severity": severity,
                        "actual": case_count,
                        "expected": case_minimum,
                        "message": f"{case_count} cases (minimum {case_minimum})",
                    })
                    if severity == "error":
                        suite_pass = False

                # negative_minimum check
                if negative_count < negative_minimum:
                    suite_findings.append({
                        "suite": suite_name,
                        "rule": "negative_minimum",
                        "severity": "error",
                        "actual": negative_count,
                        "expected": negative_minimum,
                        "message": f"{negative_count} negative entries (minimum {negative_minimum})",
                    })
                    suite_pass = False

    suites_out[suite_name] = {
        "pass": suite_pass,
        "case_count": case_count,
        "negative_count": negative_count,
        "errors": suite_findings,
    }
    findings.extend(suite_findings)
    if not suite_pass:
        overall_pass = False

if json_mode:
    payload = {
        "pass": overall_pass,
        "findings": findings,
        "suites": suites_out,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
else:
    pass_count = 0
    fail_count = 0
    for name, info in suites_out.items():
        if info["pass"]:
            print(f"[OK] {name} ({info['case_count']} cases, {info['negative_count']} negative)")
            pass_count += 1
        else:
            reasons = sorted({f.get("rule", "unknown") for f in info["errors"]})
            print(f"[FAIL] {name}: {', '.join(reasons)}")
            fail_count += 1
    total = pass_count + fail_count
    print(f"Total: {total} suites, {pass_count} pass, {fail_count} fail")

sys.exit(0 if overall_pass else 1)
PY
