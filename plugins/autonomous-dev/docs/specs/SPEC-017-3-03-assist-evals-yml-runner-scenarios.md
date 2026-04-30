# SPEC-017-3-03: assist-evals.yml Scaffold, Eval Runner Script, Baseline Scenarios, and Spend Artifact (Evals)

## Metadata
- **Parent Plan**: PLAN-017-3
- **Tasks Covered**: Task 5 (scaffold assist-evals.yml), Task 6 (eval runner script + scorer), Task 11 (10 baseline scenarios), Task 10 (spend artifact emission — evals portion)
- **Estimated effort**: 11 hours
- **Spec path (after promotion)**: `plugins/autonomous-dev/docs/specs/SPEC-017-3-03-assist-evals-yml-runner-scenarios.md`

## Description
Stand up the `assist-evals.yml` workflow that runs the assist-plugin help/troubleshoot eval suite on PRs touching assist code and on a nightly cron, plus the deterministic `scripts/ci/run-assist-evals.sh` runner, the JS scorer it depends on, and the 10 seed scenarios that constitute the initial baseline. This spec produces a workflow that finishes by uploading `eval-results.json` and a HMAC-signed spend artifact; the threshold-comparison logic and baseline-update step land in SPEC-017-3-04.

This is the largest of the four 017-3 specs because the eval-runner script and scorer are content-rich (per the plan's Task 6 estimate of 4h) and the 10 scenarios each carry their own validation contract.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/assist-evals.yml` | Create | Scaffold + run-evals job + spend artifact step |
| `scripts/ci/run-assist-evals.sh` | Create | Iterates scenarios, invokes the assist plugin, writes eval-results.json |
| `scripts/ci/score-eval-response.js` | Create | Deterministic scorer: keyword/forbidden-phrase matching + length bounds |
| `tests/evals/assist/setup-help-01.json` | Create | Seed scenario: setup-wizard help happy path |
| `tests/evals/assist/setup-help-02.json` | Create | Seed scenario: setup-wizard help with ambiguous input |
| `tests/evals/assist/help-skill-01.json` | Create | Seed scenario: general help-skill query |
| `tests/evals/assist/help-skill-02.json` | Create | Seed scenario: help-skill out-of-scope refusal |
| `tests/evals/assist/help-skill-03.json` | Create | Seed scenario: help-skill error-recovery prompt |
| `tests/evals/assist/troubleshoot-01.json` | Create | Seed scenario: troubleshoot diagnostic flow |
| `tests/evals/assist/troubleshoot-02.json` | Create | Seed scenario: troubleshoot with missing context |
| `tests/evals/assist/troubleshoot-03.json` | Create | Seed scenario: troubleshoot known-issue lookup |
| `tests/evals/assist/troubleshoot-04.json` | Create | Seed scenario: troubleshoot escalation path |
| `tests/evals/assist/troubleshoot-05.json` | Create | Seed scenario: troubleshoot ambiguous symptom triage |
| `tests/ci/test_score_eval_response.test.ts` | Create | Unit tests for the scorer (covered in detail by SPEC-017-3-04 §Testing? No — owned here) |

## Implementation Details

### `assist-evals.yml` Top-Level Structure

```yaml
name: assist-evals

on:
  pull_request:
    paths:
      - 'plugins/autonomous-dev-assist/skills/**'
      - 'plugins/autonomous-dev-assist/agents/**'
      - 'tests/evals/assist/**'
      - 'scripts/ci/run-assist-evals.sh'
      - 'scripts/ci/score-eval-response.js'
  schedule:
    - cron: '0 6 * * *'

permissions:
  contents: read
  pull-requests: write   # for results comment in SPEC-017-3-04

concurrency:
  group: assist-evals-${{ github.ref }}
  cancel-in-progress: true

jobs:
  run-evals:
    name: Run assist eval scenarios
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      pass-rate: ${{ steps.summary.outputs.pass-rate }}
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run eval suite
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: bash scripts/ci/run-assist-evals.sh

      - name: Summarize results
        id: summary
        run: |
          set -euo pipefail
          PASS_RATE="$(jq -r '.pass_rate' eval-results.json)"
          TOTAL="$(jq -r '.total' eval-results.json)"
          PASSED="$(jq -r '.passed' eval-results.json)"
          echo "Pass rate: $PASS_RATE  ($PASSED / $TOTAL)"
          echo "pass-rate=${PASS_RATE}" >> "$GITHUB_OUTPUT"
          {
            echo "## Assist Evals"
            echo ""
            echo "- Total scenarios: ${TOTAL}"
            echo "- Passed: ${PASSED}"
            echo "- Pass rate: ${PASS_RATE}"
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Upload eval results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-results-${{ github.run_id }}
          path: eval-results.json
          retention-days: 90

      - name: Emit spend estimate
        if: always()
        env:
          BUDGET_HMAC_KEY: ${{ secrets.BUDGET_HMAC_KEY }}
          ESTIMATED_COST_USD: ${{ steps.summary.outputs.pass-rate && '0.30' || '0.30' }}
        run: bash scripts/ci/emit-spend-estimate.sh

      - name: Upload spend artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: spend-estimate-${{ github.run_id }}
          path: .github/budget/spend-${{ github.run_id }}.json
          retention-days: 90
```

### `scripts/ci/run-assist-evals.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SCENARIO_DIR="tests/evals/assist"
RESULTS_FILE="eval-results.json"
TOTAL=0
PASSED=0
FAILED_SCENARIOS=()

if [ ! -d "$SCENARIO_DIR" ]; then
  echo "::error::Scenario directory $SCENARIO_DIR does not exist"
  exit 1
fi

shopt -s nullglob
for scenario_file in "$SCENARIO_DIR"/*.json; do
  TOTAL=$((TOTAL + 1))
  scenario_id="$(basename "$scenario_file" .json)"

  # Validate scenario shape
  if ! jq -e '.input and .expected_keywords and (.skill // "help")' "$scenario_file" > /dev/null; then
    echo "::error::Scenario $scenario_id is malformed (missing required fields)"
    FAILED_SCENARIOS+=("$scenario_id")
    continue
  fi

  skill="$(jq -r '.skill // "help"' "$scenario_file")"
  input="$(jq -r '.input' "$scenario_file")"

  # Invoke the assist plugin's skill via the autonomous-dev CLI.
  # The CLI dispatcher contract: `autodev assist <skill> --prompt <text>`
  # writes the response to stdout and exits 0 on success.
  response="$(autodev assist "$skill" --prompt "$input" 2>/dev/null || true)"

  # Score deterministically
  if node scripts/ci/score-eval-response.js \
       --scenario "$scenario_file" \
       --response <(printf '%s' "$response"); then
    PASSED=$((PASSED + 1))
  else
    FAILED_SCENARIOS+=("$scenario_id")
  fi
done

PASS_RATE="0"
if [ "$TOTAL" -gt 0 ]; then
  PASS_RATE="$(awk "BEGIN { printf \"%.4f\", $PASSED / $TOTAL }")"
fi

# Build the JSON output
jq -n \
  --argjson total "$TOTAL" \
  --argjson passed "$PASSED" \
  --argjson rate "$PASS_RATE" \
  --argjson failed "$(printf '%s\n' "${FAILED_SCENARIOS[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')" \
  '{ total: $total, passed: $passed, pass_rate: $rate, failed_scenarios: $failed }' \
  > "$RESULTS_FILE"

echo "Wrote $RESULTS_FILE"
cat "$RESULTS_FILE"
```

### `scripts/ci/score-eval-response.js`

Deterministic scorer; no Claude calls, no network, no randomness. Returns exit 0 = pass, 1 = fail.

```js
#!/usr/bin/env node
const fs = require('fs');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--scenario') out.scenario = argv[++i];
    else if (argv[i] === '--response') out.response = argv[++i];
  }
  return out;
}

function fail(reason) {
  process.stderr.write(`SCORE FAIL: ${reason}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv);
if (!args.scenario || !args.response) {
  fail('Usage: score-eval-response.js --scenario <file> --response <file>');
}

let scenario;
try {
  scenario = JSON.parse(fs.readFileSync(args.scenario, 'utf8'));
} catch (e) {
  fail(`Cannot parse scenario JSON: ${e.message}`);
}

const response = fs.readFileSync(args.response, 'utf8');
const lower = response.toLowerCase();

// 1. Required keywords (case-insensitive substring match)
for (const kw of scenario.expected_keywords || []) {
  if (!lower.includes(String(kw).toLowerCase())) {
    fail(`Missing expected keyword: "${kw}"`);
  }
}

// 2. Forbidden phrases
for (const phrase of scenario.forbidden_phrases || []) {
  if (lower.includes(String(phrase).toLowerCase())) {
    fail(`Contains forbidden phrase: "${phrase}"`);
  }
}

// 3. Length bounds
const len = response.length;
const minLen = scenario.min_response_length ?? 0;
const maxLen = scenario.max_response_length ?? Infinity;
if (len < minLen) fail(`Response too short: ${len} < ${minLen}`);
if (len > maxLen) fail(`Response too long: ${len} > ${maxLen}`);

process.exit(0);
```

### Scenario JSON Schema

Every scenario file in `tests/evals/assist/*.json` MUST conform to:

```json
{
  "description": "Human-readable summary of what this scenario verifies.",
  "skill": "help",                       
  "input": "User prompt text.",
  "expected_keywords": ["keyword1", "keyword2"],
  "forbidden_phrases": ["i don't know", "i cannot help"],
  "min_response_length": 50,
  "max_response_length": 2000
}
```

- `skill` MUST be one of `help`, `troubleshoot` (matches available skills in `plugins/autonomous-dev-assist/skills/`).
- `expected_keywords` is required and non-empty.
- `forbidden_phrases` is required (may be empty array).
- `min_response_length` and `max_response_length` default to 0 and Infinity respectively if omitted, but MUST be specified explicitly for every seed scenario for clarity.

### Seed Scenarios (10 files)

| File | Skill | Description |
|------|-------|-------------|
| `setup-help-01.json` | help | "How do I install autonomous-dev?" — expects keywords `install`, `plugin`; min 100, max 2000 |
| `setup-help-02.json` | help | "Set it up for me" (ambiguous) — expects clarifying-question phrasing; forbids `i don't know`; min 50, max 1500 |
| `help-skill-01.json` | help | "What does the help skill do?" — expects keywords `help`, `skill`, `assist`; min 80, max 2000 |
| `help-skill-02.json` | help | "Write me a poem about Python" (out of scope) — expects refusal phrasing; forbids `here is a poem`; min 30, max 800 |
| `help-skill-03.json` | help | "I got an error: ENOENT plugin.json" — expects keywords `manifest`, `path`; min 80, max 2000 |
| `troubleshoot-01.json` | troubleshoot | "Plugin won't load" — expects keywords `manifest`, `validate`; min 100, max 2000 |
| `troubleshoot-02.json` | troubleshoot | "It's broken" (no context) — expects clarifying questions; forbids `i don't know`; min 50, max 1500 |
| `troubleshoot-03.json` | troubleshoot | "ANTHROPIC_API_KEY not set" — expects keywords `secret`, `key`, `environment`; min 80, max 2000 |
| `troubleshoot-04.json` | troubleshoot | "Workflow keeps timing out" — expects keywords `timeout`, `step`, `log`; min 80, max 2000 |
| `troubleshoot-05.json` | troubleshoot | "Output looks wrong but no error" — expects keywords `verify`, `expected`; min 80, max 2000 |

Concrete content for each scenario must satisfy: when run against the current `autonomous-dev-assist` plugin via `autodev assist <skill> --prompt <input>`, the scorer exits 0. (This is the meaning of "all 10 scenarios pass on the current plugin", per Plan §Task 11 acceptance.)

### `tests/ci/test_score_eval_response.test.ts`

Cover the four scorer paths:

1. All keywords present, no forbidden phrases, length in range → exit 0.
2. Missing required keyword → exit 1, stderr `SCORE FAIL: Missing expected keyword: ...`.
3. Forbidden phrase present → exit 1, stderr `SCORE FAIL: Contains forbidden phrase: ...`.
4. Response shorter than min OR longer than max → exit 1, stderr `SCORE FAIL: Response too short` / `... too long`.
5. Malformed scenario JSON → exit 1, stderr `SCORE FAIL: Cannot parse scenario JSON`.

Use `vitest` or the project's existing TS test runner (check `package.json` at implementation time; do not introduce a new runner).

## Acceptance Criteria

- [ ] `.github/workflows/assist-evals.yml` exists and `actionlint` exits 0.
- [ ] Workflow trigger includes both `pull_request` (with the documented paths) AND `schedule: cron: '0 6 * * *'`.
- [ ] Top-level `permissions` contain `contents: read` and `pull-requests: write`.
- [ ] `concurrency` group is `assist-evals-${{ github.ref }}` with `cancel-in-progress: true`.
- [ ] `timeout-minutes: 15` on the `run-evals` job.
- [ ] `scripts/ci/run-assist-evals.sh` is executable (`chmod +x`) and runnable from repo root.
- [ ] Running `bash scripts/ci/run-assist-evals.sh` against the 10 seed scenarios on the current assist plugin produces `eval-results.json` with `pass_rate >= 0.95` (allowing for one borderline scenario; the plan target of all-passing is preferred but a single threshold-tolerated failure is acceptable for the seed set if documented).
- [ ] Two consecutive runs of the script produce byte-identical `eval-results.json` (deterministic; the only non-deterministic input is the assist plugin's response, which the script must call only once per scenario per run).
- [ ] `scripts/ci/score-eval-response.js` exits 0 for happy-path inputs and 1 with a `SCORE FAIL: ...` stderr message for each documented failure mode.
- [ ] All 10 seed scenarios validate against the documented JSON schema (keys present, types correct, `skill` in `[help, troubleshoot]`).
- [ ] Each seed scenario file contains a non-empty `description` field documenting what the scenario verifies.
- [ ] At least 5 scenarios use `skill: help` and at least 5 use `skill: troubleshoot`.
- [ ] `tests/ci/test_score_eval_response.test.ts` covers all 5 documented test paths and passes.
- [ ] `eval-results.json` is uploaded as artifact `eval-results-${{ github.run_id }}` after every run (success or failure) with `retention-days: 90`.
- [ ] Spend artifact `spend-estimate-${{ github.run_id }}` is uploaded after every run, JSON shape matches SPEC-017-3-01's contract, HMAC verifies.
- [ ] `BUDGET_HMAC_KEY` value never appears in workflow logs.
- [ ] Workflow summary (`$GITHUB_STEP_SUMMARY`) shows total/passed/pass_rate after every run.
- [ ] All third-party actions (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`) pinned to a major version.

## Dependencies

- **Blocking**: `scripts/ci/emit-spend-estimate.sh` from SPEC-017-3-01 (this spec reuses it).
- **Blocking**: `autodev` CLI dispatcher with subcommand `assist <skill> --prompt <text>` exists. If it does not, this spec is blocked on whatever spec creates that dispatcher (check assist plugin specs; if absent, escalate to the orchestrator before implementing).
- **Plugin precondition**: `plugins/autonomous-dev-assist/skills/help/` and `.../skills/troubleshoot/` exist (verified at write time).
- **Secret precondition**: `ANTHROPIC_API_KEY` and `BUDGET_HMAC_KEY` are configured in repo secrets.
- **Soft**: SPEC-017-3-04 consumes `eval-results.json` and the `pass-rate` job output. Their existence as stable contracts is what this spec provides.

## Notes

- The `cancel-in-progress: true` for evals (vs. `false` for releases) is intentional: a PR that pushes 5 commits in 30 seconds should only run the eval suite for the latest commit. Releases don't have this property.
- The scorer is deliberately simple — keyword/phrase/length matching, no semantic similarity, no embedding comparison. Per PLAN-017-3 §Risks, this is the chosen mitigation against drift-induced false-failures: permissive heuristics tolerate phrasing changes.
- The `--response <(printf '%s' "$response")` process-substitution pattern in the runner is used because the scorer expects a file path; passing as a path avoids shell-quoting issues with multi-line responses.
- Seed scenarios are content-defined: an implementer must craft `expected_keywords` and `forbidden_phrases` that the *current* assist plugin's responses actually satisfy. This requires running each scenario against the plugin during implementation and tuning the keyword list. The acceptance criterion "all 10 pass on the current plugin" is the gate.
- The ~$0.30 cost estimate per eval run assumes 10 scenarios × ~$0.03 per Claude invocation. Tune in PLAN-017-4 once real cost data is available.
- The `_eval-baseline` branch is created by SPEC-017-3-04, not here. This spec produces `eval-results.json` as a uniform output that SPEC-017-3-04's threshold step consumes.
- If a future scenario requires multi-turn interactions, extend the scorer with a `turns: [{prompt, expected_keywords}, ...]` field. Out of scope for this spec.
