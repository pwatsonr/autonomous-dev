# TDD-020: Quality Reviewer Suite

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Quality Reviewer Suite                             |
| **TDD ID**   | TDD-020                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-012: Quality Reviewer Suite                  |
| **Plugin**   | autonomous-dev                                     |

---

## 1. Summary

This TDD specifies the implementation of four specialist reviewer agents (QA edge-case, UX/UI, accessibility, rule-set-enforcement) that augment the generic reviewers from PRD-002. The reviewers register at PRD-002 review gates via TDD-019's reviewer-slot extension hooks (PRD-011 §19.3) and contribute scores to the gate aggregator under operator-configurable chain rules.

The design honors the §19 review-driven design updates from PRD-012: skill name collision (`standards-detection-guide`) is ceded to PRD-013, eval suite is split into 4 sub-suites totaling 90 cases, and concrete help/troubleshoot updates are specified.

## 2. Goals & Non-Goals

| ID    | Goal                                                                                  |
|-------|----------------------------------------------------------------------------------------|
| G-01  | Ship 4 specialist reviewer agents that catch quality issues generic reviewers miss.    |
| G-02  | Enable per-request-type reviewer chain configuration with thresholds + advisory/blocking. |
| G-03  | Auto-detect existing standards from repo signals (eslint/prettier/jest/tsconfig).      |
| G-04  | Concurrent execution of frontend-trigger reviewers (UX/UI + a11y) with shared cache.   |
| G-05  | Enforce minimum-built-in-reviewer rule (TDD-019 §19.3) at gate aggregation.            |
| G-06  | 4 eval sub-suites totaling 90 cases with security-critical at 100%.                    |

| ID     | Non-Goal                                                                            |
|--------|--------------------------------------------------------------------------------------|
| NG-01  | Standards DSL itself (PRD-013/TDD-021).                                              |
| NG-02  | Hook system mechanics (TDD-019).                                                     |
| NG-03  | Plugin chaining for fix-recipe → code-fixer (TDD-022).                               |

## 3. Background

PRD-002 ships generic reviewers (prd-reviewer, tdd-reviewer, code-reviewer, security-reviewer) that focus on architectural soundness, document compliance, and obvious vulnerabilities. They miss:

- **Edge cases** that QA engineers spot — null inputs, off-by-one, race conditions, missing error paths
- **UX friction** invisible to non-frontend reviewers — color-only signals, missing loading states, unclear error messages
- **Accessibility violations** — WCAG 2.2 AA contrast, keyboard traps, missing ARIA
- **Engineering standards** drift — using Flask when team standardized on FastAPI, missing /health endpoints

PRD-012 defines the four specialist reviewers; this TDD specifies their implementation.

## 4. Architecture

```
Review Gate Triggered
        │
        ▼
┌───────────────────────┐
│ Chain Config Resolver │ ──── reads .autonomous-dev/reviewer-chains.json + per-type defaults
└────────────┬──────────┘
             │
             ▼
┌────────────────────────────────────────────────┐
│ Reviewer Scheduler                             │
│ • Determines which specialists trigger        │
│ • Groups concurrent (UX+a11y share frontend   │
│   detection cache)                            │
│ • Sequential where ordering matters            │
└────────────┬───────────────────────────────────┘
             │
             ├──▶ qa-edge-case-reviewer    (sequential)
             ├──▶ ux-ui-reviewer           (concurrent w/ a11y on frontend changes)
             ├──▶ accessibility-reviewer   (concurrent w/ ux-ui)
             └──▶ rule-set-enforcement-reviewer (sequential, reads standards.yaml)
                       │
                       ▼
              ┌─────────────────────┐
              │ Score Aggregator    │ (built-in min rule from TDD-019 §19.3)
              └─────────┬───────────┘
                        ▼
                   Gate Verdict
```

## 5. Reviewer Agent Specifications

### 5.1 qa-edge-case-reviewer

**Agent file**: `plugins/autonomous-dev/agents/qa-edge-case-reviewer.md`

```markdown
---
name: qa-edge-case-reviewer
description: Specialist reviewer for input validation, boundary conditions, race conditions, error paths, null handling, and unhandled exceptions. Triggers on code-review gates.
model: claude-sonnet-4-6
tools: Read, Glob, Grep
---

You are a QA-edge-case reviewer. Your job is to find bugs the generic code-reviewer misses by systematically checking:

1. **Input validation**: every public function/endpoint — what happens with null, empty string, negative number, max int, unicode, very long string, malformed format?
2. **Boundary conditions**: array index 0 and length-1; off-by-one in loops; first/last items in iteration
3. **Race conditions**: shared state without synchronization; check-then-act patterns; promise ordering
4. **Error paths**: every throw/error return — is it caught? does the catch block leak resources or sensitive info?
5. **Null/undefined handling**: optional chaining gaps; defensive defaults that hide real issues
6. **Resource leaks**: file handles, sockets, timers, listeners — closed/cleared on error path?

For each issue: cite file:line, severity (low/med/high/critical), suggested fix in 1-2 sentences. Output findings as JSON per the schema in §5.5.
```

**Output schema** (`schemas/reviewer-finding-v1.json` — shared across all 4 reviewers):

```json
{
  "$id": "https://autonomous-dev/schemas/reviewer-finding-v1.json",
  "type": "object",
  "required": ["reviewer", "verdict", "score", "findings"],
  "properties": {
    "reviewer": {"type": "string"},
    "verdict": {"enum": ["APPROVE", "CONCERNS", "REQUEST_CHANGES"]},
    "score": {"type": "number", "minimum": 0, "maximum": 100},
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["file", "line", "severity", "category", "title", "description", "suggested_fix"],
        "properties": {
          "file": {"type": "string"},
          "line": {"type": "integer"},
          "severity": {"enum": ["low", "medium", "high", "critical"]},
          "category": {"type": "string"},
          "title": {"type": "string"},
          "description": {"type": "string"},
          "suggested_fix": {"type": "string"},
          "rule_id": {"type": "string"}
        }
      }
    }
  }
}
```

### 5.2 ux-ui-reviewer

Triggered on changes touching `**/components/`, `**/views/`, `**/pages/`, or `*.tsx|*.vue|*.svelte`. Reviews:

- Information density & visual hierarchy
- Color-only signaling (no text/icon backup)
- Loading / empty / error / success state coverage
- Mobile responsiveness (viewport breakpoints)
- Form field labels and helper text clarity
- Button labels (verbs over generic "OK/Submit")

### 5.3 accessibility-reviewer

Same trigger as ux-ui-reviewer. Reviews against WCAG 2.2 AA:

- 1.4.3 Contrast: ≥4.5:1 normal text, ≥3:1 large text
- 2.1 Keyboard accessible: tab order, no traps, visible focus
- 2.4.3 Focus order: logical sequence
- 4.1.2 Name/Role/Value: ARIA correctness, semantic HTML preference
- 1.1.1 Non-text content: alt text on images, captions on video

### 5.4 rule-set-enforcement-reviewer

Reads `.autonomous-dev/standards.yaml` (TDD-021 schema), evaluates each rule against the current change, produces findings with `rule_id` set. Findings are tagged with the fix-recipe pointer per TDD-021 §14, which TDD-022 plugin chains can consume.

### 5.5 Frontend Detection Cache

UX/UI and accessibility reviewers share a per-request detection result:

```typescript
interface FrontendDetection {
  isFrontendChange: boolean;
  detectedFiles: string[];           // paths matching frontend patterns
  framework?: "react" | "vue" | "svelte" | "angular" | "vanilla";
  hasViewportMeta: boolean;
}

const detectionCache = new Map<string, FrontendDetection>();  // keyed by request_id
```

## 6. Reviewer Chain Configuration

`<repo>/.autonomous-dev/reviewer-chains.json` (or per-type defaults):

```json
{
  "feature": {
    "code_review": {
      "reviewers": [
        {"name": "code-reviewer", "type": "built-in", "blocking": true, "threshold": 80},
        {"name": "security-reviewer", "type": "built-in", "blocking": true, "threshold": 90},
        {"name": "qa-edge-case-reviewer", "type": "specialist", "blocking": false, "threshold": 70},
        {"name": "ux-ui-reviewer", "type": "specialist", "blocking": false, "threshold": 70, "trigger": "frontend"},
        {"name": "accessibility-reviewer", "type": "specialist", "blocking": false, "threshold": 80, "trigger": "frontend"},
        {"name": "rule-set-enforcement-reviewer", "type": "specialist", "blocking": true, "threshold": 95}
      ]
    }
  },
  "bug": { /* simpler chain — qa-edge-case prioritized */ },
  "infra": { /* enhanced security */ },
  "refactor": { /* code quality emphasis */ },
  "hotfix": { /* minimal chain for speed */ }
}
```

Aggregation rule (per TDD-019 §19.3): a gate cannot pass with ONLY specialist verdicts. At least one built-in reviewer (code-reviewer, security-reviewer, etc.) must complete successfully. Scores from blocking reviewers below threshold fail the gate.

## 7. Auto-Detection of Existing Standards

The detection scanner runs at first install per repo:

```typescript
async function detectStandards(repoPath: string): Promise<DetectedStandards> {
  const detected: DetectedStandards = { rules: [], confidence: {} };

  // ESLint
  if (await fileExists(join(repoPath, ".eslintrc.json"))) {
    const eslintRules = await loadJson(".eslintrc.json").rules;
    for (const [rule, level] of Object.entries(eslintRules)) {
      detected.rules.push({
        id: `inferred:eslint-${rule}`,
        severity: level === "error" ? "blocking" : "warn",
        applies_to: { language: "javascript" },
        evaluator: "eslint-rule-check",
        confidence: 0.9
      });
    }
  }

  // Prettier, Jest, tsconfig, pyproject.toml, etc. — same pattern

  return detected;
}
```

Output written to `<repo>/.autonomous-dev/standards.inferred.yaml` (TDD-021 promotes to `standards.yaml` after operator review).

## 8. Cost & Latency Budget

Per-reviewer caps:

| Reviewer                   | Cost cap | Timeout |
|----------------------------|----------|---------|
| qa-edge-case-reviewer      | $1.50    | 8 min   |
| ux-ui-reviewer             | $1.00    | 5 min   |
| accessibility-reviewer     | $1.25    | 6 min   |
| rule-set-enforcement-reviewer | $0.75 | 4 min   |

Gate completion target: p95 < 2 min for typical PR (sequential where required, concurrent for UX+a11y).

## 9. Eval Suite Design

Four sub-suites mirroring fixture corpora:

| Suite                  | Cases | Security-critical (must pass at 100%)        |
|------------------------|-------|-----------------------------------------------|
| qa-reviewer-eval       | 25    | SQL injection, path traversal, null deref     |
| ux-reviewer-eval       | 20    | (none)                                        |
| a11y-reviewer-eval     | 30    | Keyboard trap, missing alt, contrast <3:1     |
| standards-reviewer-eval | 15   | Forbidden imports, exposed secrets via standards |

Total 90 cases. Cases live in `plugins/autonomous-dev-assist/evals/test-cases/<suite>.yaml`.

## 10. Test Strategy

- Fixture-based per reviewer: 20 PRs (10 clean, 10 with known issues) per reviewer. Precision ≥80%, recall ≥70% required for promotion to required-status check.
- A/B test specialists vs current generics on identical fixtures; demonstrate incremental value.
- False-positive rate measured weekly; auto-rollback to advisory if >25% false positive over 30 days.

## 11. Migration & Rollout

- Phase 1 (Week 1-2): All 4 reviewers ship as advisory only. Collect baseline metrics.
- Phase 2 (Week 3-6): Promote individually to blocking once precision ≥80% / recall ≥70% on the 20-PR fixture corpus.
- Phase 3 (Week 7+): Full integration as required status checks.

## 12. Open Questions

1. UX vs accessibility recommendation conflicts (shorter labels vs descriptive text) — resolution protocol?
2. Should specialist reviewers suggest specific code patches or only flag issues?
3. Legacy code: enforce on changed lines only or full file?
4. Should ux-ui-reviewer have WebFetch capability for design-system references? (security review required if yes)

## 13. References

- PRD-012 (whole + §19)
- PRD-002 (review gate model)
- TDD-004 (review gates impl)
- TDD-019 §19.3 (reviewer-slot mechanics, minimum built-in rule)
- TDD-021 (forward — standards DSL consumed by rule-set-enforcement-reviewer)
