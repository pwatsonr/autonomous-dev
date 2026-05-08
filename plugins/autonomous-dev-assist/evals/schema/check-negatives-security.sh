#!/usr/bin/env bash
# check-negatives-security.sh -- proves each cred-proxy/firewall negative regex
# catches verbatim AND paraphrase synthetic hallucinations. Per SPEC-028-3-03.
# Exits 0 iff all 32 checks (16 verbatim + 16 paraphrase) produce FAIL.
#
# Reads regexes from the eval YAMLs (single source of truth).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOC="${SCRIPT_DIR}/fixtures/synthetic-hallucinations-security.md"
CRED_PROXY_YAML="${EVAL_DIR}/test-cases/cred-proxy-eval.yaml"
FIREWALL_YAML="${EVAL_DIR}/test-cases/firewall-eval.yaml"

if [[ ! -f "${DOC}" ]]; then
  echo "ERROR: synthetic-hallucinations-security.md not found at ${DOC}" >&2
  exit 2
fi
if [[ ! -f "${CRED_PROXY_YAML}" || ! -f "${FIREWALL_YAML}" ]]; then
  echo "ERROR: cred-proxy or firewall yaml missing" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 required" >&2
  exit 2
fi

export META_LINT_DOC="${DOC}"
export META_LINT_CP="${CRED_PROXY_YAML}"
export META_LINT_FW="${FIREWALL_YAML}"

python3 - <<'PY'
import os
import re
import sys
import yaml

DOC = os.environ["META_LINT_DOC"]
CP = os.environ["META_LINT_CP"]
FW = os.environ["META_LINT_FW"]


def load_cases(path):
    with open(path) as f:
        doc = yaml.safe_load(f)
    return {c["id"]: c for c in doc.get("cases", [])}


def parse_entries(doc_path):
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
            elif line.startswith("- expected") or line.startswith("- regex"):
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


cred_cases = load_cases(CP)
fw_cases = load_cases(FW)
all_cases = {**cred_cases, **fw_cases}

entries = parse_entries(DOC)

print("| case_id | regex | response (truncated) | result |")
print("|---------|-------|----------------------|--------|")

failures = 0
total = 0


def check(case_id, label, response, patterns):
    global failures, total
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
    rx = patterns[0] if patterns else ""
    label_str = f"{case_id} ({label})" if label else case_id
    print(f"| {label_str} | {rx} | {truncated} | {result} |")
    if not matched:
        failures += 1
    total += 1


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
    check(case_id, "verbatim", response, patterns)
    if paraphrase:
        check(case_id, "paraphrase", paraphrase, patterns)

print()
print(f"Result: {total - failures}/{total} entries marked FAIL by must_not_mention regex.")
sys.exit(0 if failures == 0 else 1)
PY
