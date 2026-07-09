# Reviewer Authoring Guide

This document is the normative reference for authors creating or modifying
reviewer agent system prompts under `plugins/autonomous-dev/agents/`.

---

## Dispatcher Output Contract

The dispatcher (`intake/reviewers/invoke-reviewer.ts`) expects every reviewer
agent to emit a compact JSON object as the **absolute last line of stdout**.
This is the primary (intended) path — all other parser strategies are safety
nets, not the target contract.

### Required tail JSON shape

```json
{
  "score": 85,
  "verdict": "APPROVE",
  "findings": [
    {
      "severity": "blocking|warn|info",
      "file": "<repo-relative path>",
      "line": 42,
      "message": "<one sentence describing the issue>"
    }
  ]
}
```

| Field      | Type                                | Required | Notes |
|------------|-------------------------------------|----------|-------|
| `score`    | integer 0–100                       | yes      | A gate passes when `score >= threshold`. |
| `verdict`  | `"APPROVE"` or `"REQUEST_CHANGES"`  | yes      | Case-sensitive. See "CONCERNS mapping" below. |
| `findings` | array (may be `[]`)                 | yes      | Do not omit the key even when empty. |

**Rules:**

1. `verdict` MUST be exactly `"APPROVE"` or `"REQUEST_CHANGES"`. Do **NOT**
   emit `"CONCERNS"` or `"BLOCK"` in the tail JSON — map those to
   `"REQUEST_CHANGES"` yourself.
2. Do **NOT** wrap the JSON in markdown code fences.
3. Do **NOT** print anything after this JSON line — no trailing prose, no blank
   lines with visible characters.

### CONCERNS mapping (defense-in-depth)

The parser will also accept `verdict: "CONCERNS"` as a defense-in-depth
fallback. When it sees `CONCERNS` in the tail JSON it coerces the verdict to
`REQUEST_CHANGES` with `score = min(threshold − 1, 60)`. However, agents
**SHOULD** emit one of the two hard verdicts (`APPROVE` / `REQUEST_CHANGES`)
and map their semantic verdict in their own logic, rather than relying on this
fallback.

---

## Dispatcher Parser Strategies

The dispatcher tries four strategies in order; the first match wins.
Strategies 2–4 are safety nets that **lose information** and should not be
relied upon as the primary path.

| # | Strategy | Trigger | Information loss |
|---|----------|---------|-----------------|
| 1 | **Verdict-JSON** (primary) | Last balanced `{…}` with `score: number` and `verdict ∈ {"APPROVE","REQUEST_CHANGES","CONCERNS"}` | None — all fields preserved. |
| 2 | Phase-result envelope | Last balanced `{…}` with `status: "pass"\|"fail"` and `phase: string` | `score` is derived from threshold, not the reviewer's actual score. |
| 3 | Markdown-fenced JSON | Stdout is a single triple-backtick code block; re-runs strategies 1+2 on inner content | Adds fragility — any trailing prose breaks this. |
| 4 | Verdict marker | Line matching `/^\s*VERDICT:\s*(APPROVE\|REQUEST_CHANGES\|BLOCK)\s*$/` | `score` derived from threshold; `findings` lost entirely. |

If all four strategies fail, the result is `verdict: "ERROR"` and `raw_output`
is populated on the `ReviewerResult` for operator diagnosis.

---

## Canonical Output Instruction block

Copy-paste this block verbatim into every new reviewer's system prompt. Adapt
only the threshold value and the analysis schema reference:

```markdown
## Output Instruction (dispatcher contract)

1. Write your full analysis to `phase-result-<your-phase>.json` in the
   request directory. This is the audit trail and is consumed by humans and
   downstream tooling.

2. As the **absolute last line** of stdout, print exactly ONE compact JSON
   object matching this schema and nothing after it:

   {"score": <integer 0-100>, "verdict": "APPROVE" | "REQUEST_CHANGES", "findings": [ {"severity": "blocking|warn|info", "file": "<path>", "line": <n>, "message": "<one sentence>"} ]}

   - `score` is your overall 0-100 quality score. A passing gate is
     `score >= threshold` (this reviewer's threshold: **<threshold>**).
   - `verdict` MUST be exactly `APPROVE` or `REQUEST_CHANGES`. Map any
     semantic `CONCERNS` or `BLOCK` value to `REQUEST_CHANGES`.
   - `findings` MAY be `[]`. Do not omit the key.
   - Do **NOT** wrap this JSON in markdown code fences.
   - Do **NOT** print anything after this line (no trailing prose, no blank
     lines with visible characters).
```

See `plugins/autonomous-dev/agents/standards-meta-reviewer.md` for the
reference reviewer implementation, including a projection table that maps
semantic verdicts to the tail JSON format.

---

## Drift detection

A snapshot test at
`plugins/autonomous-dev/agents/__tests__/reviewer-output-contract.test.ts`
enumerates every `*-reviewer.md` file and asserts the canonical anchor phrase
is present. Any reviewer missing the Output Instruction block will fail this
test. Run `pnpm --filter autonomous-dev test reviewer-output-contract` to
verify.
