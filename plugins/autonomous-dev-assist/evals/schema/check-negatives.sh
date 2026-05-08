#!/usr/bin/env bash
# check-negatives.sh -- proves each negative regex in chains-eval.yaml and
# deploy-eval.yaml catches a representative synthetic hallucination.
# Exits 0 iff all 10 entries produce FAIL (regex match against the synthetic
# response). Per SPEC-028-2-03.
#
# Reads regexes from the eval YAMLs (single source of truth) so the doc and
# the YAMLs cannot drift. The synthetic responses are sourced from
# evals/schema/fixtures/synthetic-hallucinations.md.
#
# Dependencies: bash 4+, python3 with PyYAML.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOC="${SCRIPT_DIR}/fixtures/synthetic-hallucinations.md"
CHAINS_YAML="${EVAL_DIR}/test-cases/chains-eval.yaml"
DEPLOY_YAML="${EVAL_DIR}/test-cases/deploy-eval.yaml"

if [[ ! -f "${DOC}" ]]; then
  echo "ERROR: synthetic-hallucinations.md not found at ${DOC}" >&2
  exit 2
fi
if [[ ! -f "${CHAINS_YAML}" || ! -f "${DEPLOY_YAML}" ]]; then
  echo "ERROR: eval YAMLs missing under ${EVAL_DIR}/test-cases/" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 required" >&2
  exit 2
fi

export META_LINT_DOC="${DOC}"
export META_LINT_CHAINS="${CHAINS_YAML}"
export META_LINT_DEPLOY="${DEPLOY_YAML}"

python3 - <<'PY'
import os
import re
import sys
import yaml

DOC = os.environ["META_LINT_DOC"]
CHAINS = os.environ["META_LINT_CHAINS"]
DEPLOY = os.environ["META_LINT_DEPLOY"]


def load_cases(path):
    with open(path) as f:
        doc = yaml.safe_load(f)
    return {c["id"]: c for c in doc.get("cases", [])}


def parse_entries(doc_path):
    """Parse synthetic-hallucinations.md into a list of entries."""
    entries = []
    current = None
    in_response = False
    response_buf = []
    in_paraphrase = False
    paraphrase_buf = []
    with open(doc_path) as f:
        for raw in f:
            line = raw.rstrip("\n")
            if line.startswith("### case_id:"):
                if current is not None:
                    if response_buf:
                        current["response"] = " ".join(response_buf).strip()
                    if paraphrase_buf:
                        current["paraphrase"] = " ".join(paraphrase_buf).strip()
                    entries.append(current)
                current = {"case_id": line.split(":", 1)[1].strip()}
                response_buf = []
                paraphrase_buf = []
                in_response = False
                in_paraphrase = False
            elif current is None:
                continue
            elif line.startswith("- synthetic response"):
                in_response = True
                in_paraphrase = False
            elif line.startswith("- paraphrase variant"):
                in_response = False
                in_paraphrase = True
            elif line.startswith("- expected"):
                in_response = False
                in_paraphrase = False
            elif line.startswith("- regex"):
                in_response = False
                in_paraphrase = False
            elif (in_response or in_paraphrase) and line.strip().startswith(">"):
                content = line.strip().lstrip(">").strip()
                if in_response:
                    response_buf.append(content)
                else:
                    paraphrase_buf.append(content)
    if current is not None:
        if response_buf:
            current["response"] = " ".join(response_buf).strip()
        if paraphrase_buf:
            current["paraphrase"] = " ".join(paraphrase_buf).strip()
        entries.append(current)
    return entries


chains_cases = load_cases(CHAINS)
deploy_cases = load_cases(DEPLOY)
all_cases = {**chains_cases, **deploy_cases}

entries = parse_entries(DOC)

print("| case_id | regex | response (truncated) | result |")
print("|---------|-------|----------------------|--------|")

failures = 0
total = 0

for entry in entries:
    case_id = entry["case_id"]
    if case_id not in all_cases:
        print(f"| {case_id} | -- | (case not found) | ERROR |")
        failures += 1
        total += 1
        continue
    patterns = all_cases[case_id].get("must_not_mention", [])
    response = entry.get("response", "")
    paraphrase = entry.get("paraphrase", "")
    matched = False
    for p in patterns:
        try:
            if re.search(p, response):
                matched = True
                break
        except re.error:
            continue
    truncated = response[:48].replace("|", "\\|")
    result = "FAIL (good)" if matched else "PASS (bad-no-match)"
    print(f"| {case_id} | {patterns[0] if patterns else ''} | {truncated} | {result} |")
    if not matched:
        failures += 1
    total += 1
    if paraphrase:
        matched_p = False
        for p in patterns:
            try:
                if re.search(p, paraphrase):
                    matched_p = True
                    break
            except re.error:
                continue
        truncated = paraphrase[:48].replace("|", "\\|")
        result = "FAIL (good)" if matched_p else "PASS (bad-no-match)"
        print(f"| {case_id} (paraphrase) | {patterns[0] if patterns else ''} | {truncated} | {result} |")
        if not matched_p:
            failures += 1
        total += 1

print()
print(f"Result: {total - failures}/{total} entries marked FAIL by must_not_mention regex.")
sys.exit(0 if failures == 0 else 1)
PY
