# SPEC-004-2-3: Reviewer Executor & Output Validator

## Metadata
- **Parent Plan**: PLAN-004-2
- **Tasks Covered**: Task 7, Task 8
- **Estimated effort**: 7 hours

## Description

Build the parallel reviewer execution layer that invokes reviewer agents concurrently and collects results, and the output validation/recovery system that handles malformed JSON, out-of-range scores, and missing categories. These components sit at the execution boundary between the review gate system and the LLM invocation layer.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/reviewer-executor.ts` | Create | Parallel reviewer invocation and result collection |
| `src/review-gate/reviewer-output-validator.ts` | Create | ReviewOutput schema validation and recovery |

## Implementation Details

### 1. ReviewerExecutor (`reviewer-executor.ts`)

**LLM Adapter Interface:**
```typescript
interface LLMAdapter {
  invoke(prompt: AssembledPrompt, agentSeed: number, timeoutMs: number): Promise<string>;
}
```
This interface decouples the executor from any specific LLM implementation. The adapter returns a raw string response that the output validator will parse.

**Class: `ReviewerExecutor`**

**Constructor:**
```typescript
constructor(
  private llmAdapter: LLMAdapter,
  private outputValidator: ReviewerOutputValidator,
  private agentPool: ReviewerAgentPool,
  private config: ReviewerExecutorConfig = DEFAULT_EXECUTOR_CONFIG
)
```

**Configuration:**
```typescript
interface ReviewerExecutorConfig {
  timeout_ms: number;              // default: 120_000 (120s per NFR-005)
  max_retries_per_reviewer: number; // default: 1
  proceed_with_partial_panel: boolean; // default: true (when panel > 1)
  max_total_failures_before_escalation: number; // default: 2
}

const DEFAULT_EXECUTOR_CONFIG: ReviewerExecutorConfig = {
  timeout_ms: 120_000,
  max_retries_per_reviewer: 1,
  proceed_with_partial_panel: true,
  max_total_failures_before_escalation: 2,
};
```

**Primary method:**
```typescript
async executePanel(
  assignments: ReviewerAssignment[],
  prompts: Map<string, AssembledPrompt>  // keyed by reviewer_id
): Promise<ExecutionResult>
```

**`ExecutionResult` interface:**
```typescript
interface ExecutionResult {
  review_outputs: ReviewOutput[];
  failures: ReviewerFailure[];
  partial_panel: boolean;     // true if some reviewers failed and were excluded
  escalation_required: boolean; // true if total failures >= max_total_failures
  execution_time_ms: number;
}

interface ReviewerFailure {
  reviewer_id: string;
  error_type: "timeout" | "malformed_output" | "crash" | "validation_error";
  error_message: string;
  retries_attempted: number;
}
```

**Execution algorithm:**

1. For each assignment, create an agent instance via `agentPool.createInstance()` and mark it active.
2. Execute all reviewers concurrently using `Promise.allSettled()` (not `Promise.all()` to handle individual failures gracefully).
3. For each reviewer invocation:
   ```
   a. Call llmAdapter.invoke(prompt, assignment.agent_seed, config.timeout_ms)
   b. On success: parse raw response via outputValidator.validateAndParse()
   c. On parse success: add to review_outputs, mark agent completed
   d. On parse failure (malformed output):
      - If retries_attempted < max_retries_per_reviewer:
        Retry with same prompt and seed
      - Else:
        Record failure, mark agent failed
   e. On timeout:
      - If retries_attempted < max_retries_per_reviewer:
        Retry once
      - If retry also fails AND panel_size > 1:
        Record failure, proceed with remaining reviewers
      - If sole reviewer and retry fails:
        Create fresh agent instance (new seed), retry once more
      - After max_total_failures: set escalation_required = true
   f. On crash (thrown error):
      Same recovery as timeout
   ```
4. After all promises settle:
   - `partial_panel = failures.length > 0 AND review_outputs.length > 0`
   - `escalation_required = total failure count >= max_total_failures_before_escalation AND review_outputs.length === 0`
5. Mark all remaining active agents as completed or failed.
6. Record `execution_time_ms` from start to finish.

**Fresh instance retry for sole reviewer:**
When the only reviewer on a panel fails twice (initial + retry), create a new agent instance with `agent_seed + 1` and attempt one final invocation. This gives 3 total attempts before escalation.

### 2. ReviewerOutputValidator (`reviewer-output-validator.ts`)

**Class: `ReviewerOutputValidator`**

**Primary method:**
```typescript
validateAndParse(
  rawOutput: string,
  rubric: Rubric,
  reviewerId: string
): ValidationParseResult
```

**`ValidationParseResult` interface:**
```typescript
interface ValidationParseResult {
  success: boolean;
  review_output: ReviewOutput | null;
  warnings: string[];
  errors: string[];
}
```

**Parsing steps:**

1. **JSON extraction:** The raw output may be wrapped in markdown code blocks. Extract JSON:
   ```typescript
   function extractJSON(raw: string): string {
     // Try direct parse first
     // If fails, look for ```json ... ``` block
     // If fails, look for ``` ... ``` block
     // If fails, look for { ... } (first to last brace)
     // If all fail, throw ParseError
   }
   ```

2. **JSON parsing:** Use `JSON.parse()` with try/catch. On failure, attempt lenient parsing:
   - Strip trailing commas before `}` or `]`.
   - Strip single-line comments (`// ...`).
   - If still fails, return `success: false` with parse error.

3. **Schema validation** (executed in order, accumulating warnings and errors):

   **Required top-level fields:**
   - `reviewer_id: string` -- must be non-empty
   - `reviewer_role: string` -- must be non-empty
   - `document_id: string` -- must be non-empty
   - `document_version: string` -- must be non-empty
   - `timestamp: string` -- must be valid ISO 8601
   - `scoring_mode: "per_section" | "document_level"`
   - `category_scores: CategoryScore[]` -- must be non-empty array
   - `findings: Finding[]` -- must be an array (can be empty)
   - `summary: string` -- must be non-empty

   Missing required fields: return `success: false`.

   **CategoryScore validation:**
   For each `CategoryScore`:
   - `category_id` must match a category in the rubric.
   - `score` must be a number.
   - Score range: if outside 0-100, **clamp** to the range and add warning: `"Score for category '{category_id}' was {original}, clamped to {clamped}."`
   - `justification` must be a non-empty string.
   - `section_scores`: if `scoring_mode === "per_section"`, must be a non-null array; each entry must have `section_id: string` and `score: number` (clamped to 0-100).

   **Missing category detection:**
   For each category in the rubric, check if a matching `category_id` exists in `category_scores`. If missing:
   - Add a `CategoryScore` with `score: 0`, `justification: "Category not evaluated by reviewer."`, `section_scores: null`.
   - Add a `Finding` with:
     - `id`: auto-generated `"sys-missing-{category_id}"`
     - `section_id`: first section mapped to that category (or `"document"` if no mapping)
     - `category_id`: the missing category
     - `severity: "critical"`
     - `critical_sub: "blocking"`
     - `upstream_defect: false`
     - `description`: `"Reviewer did not evaluate category '{category_name}'. Scoring as 0 with critical finding."`
     - `evidence`: `"Category '{category_id}' is absent from the reviewer's output."`
     - `suggested_resolution`: `"Re-run review or manually evaluate this category."`
   - Add warning: `"Missing category '{category_id}' assigned score 0 with critical:blocking finding."`

   **Finding validation:**
   For each `Finding`:
   - `id`: must be non-empty string.
   - `section_id`: must be non-empty string.
   - `category_id`: must be non-empty string.
   - `severity`: must be one of `"critical" | "major" | "minor" | "suggestion"`.
   - `critical_sub`: required when `severity === "critical"`, must be `"blocking" | "reject"`. If severity is critical and `critical_sub` is missing, default to `"blocking"` and add warning.
   - `upstream_defect`: must be boolean, default `false` if missing.
   - `description`: must be non-empty.
   - `evidence`: must be non-empty.
   - `suggested_resolution`: **required** when `severity` is `"critical"` or `"major"`. If missing for critical/major, add warning: `"Finding '{id}' is severity '{severity}' but has no suggested_resolution."` Do not reject the entire output for this.

4. **Override reviewer_id:** Replace `review_output.reviewer_id` with the `reviewerId` parameter (the system-assigned ID, not whatever the LLM put in the field).

## Acceptance Criteria

1. All panel reviewers execute concurrently via `Promise.allSettled()`.
2. Per-reviewer timeout is configurable, default 120 seconds.
3. Timeout handling: retry once; if retry fails and panel > 1, proceed with remaining reviewers.
4. If sole reviewer fails twice, retry with fresh instance (new seed); after 3 total failures, escalate.
5. `ExecutionResult.partial_panel` is `true` when some reviewers failed but at least one succeeded.
6. `ExecutionResult.escalation_required` is `true` when all reviewers failed.
7. `ReviewerOutputValidator` extracts JSON from markdown code blocks.
8. Lenient JSON parsing handles trailing commas and single-line comments.
9. Scores outside 0-100 are clamped to the range with a warning.
10. Missing categories assigned score 0 with `critical:blocking` finding.
11. All required fields in `Finding` are validated: `id`, `section_id`, `category_id`, `severity`, `description`, `evidence`.
12. `suggested_resolution` is required for critical and major findings (warning if missing, not rejection).
13. `critical_sub` defaults to `"blocking"` when severity is critical but sub is missing.
14. Reviewer ID in the output is overridden with the system-assigned reviewer_id.

## Test Cases

### `tests/review-gate/reviewer-executor.test.ts`

All tests use a mock `LLMAdapter`.

1. **Successful parallel execution**: 2 reviewers, both succeed. `review_outputs` has 2 entries. `failures` is empty. `partial_panel` is false.
2. **One reviewer times out, one succeeds**: Mock reviewer A times out. Reviewer B succeeds. After retry, reviewer A still times out. `review_outputs` has 1 entry. `failures` has 1. `partial_panel` is true.
3. **Retry succeeds on second attempt**: Reviewer fails first invocation, succeeds on retry. `review_outputs` has the output. `failures` is empty.
4. **Sole reviewer fails twice, fresh instance succeeds**: Panel size 1. Reviewer fails initial + retry. Fresh instance (new seed) succeeds. `review_outputs` has 1 entry.
5. **Sole reviewer fails 3 times -- escalation**: Panel size 1. All 3 attempts fail. `escalation_required` is true. `review_outputs` is empty.
6. **Malformed output triggers retry**: Reviewer returns invalid JSON. Retry returns valid JSON. Success.
7. **All reviewers fail -- escalation**: Panel size 2. Both reviewers fail all retries. `escalation_required` is true.
8. **Execution timing**: Verify `execution_time_ms` is approximately the time of the longest reviewer (parallel, not sequential).
9. **Agent pool status tracking**: After execution, verify completed reviewers are marked completed and failed reviewers are marked failed in the pool.
10. **Timeout configuration**: Set custom timeout of 5000ms. Verify the LLM adapter is called with the custom timeout.

### `tests/review-gate/reviewer-output-validator.test.ts`

1. **Valid output passes**: Complete, well-formed ReviewOutput JSON. Returns `success: true`, `warnings: []`, `errors: []`.
2. **JSON in markdown code block**: Output wrapped in ` ```json ... ``` `. Correctly extracted and parsed.
3. **JSON in plain code block**: Output wrapped in ` ``` ... ``` `. Correctly extracted.
4. **Trailing comma tolerance**: JSON has trailing comma in array. Parsed successfully.
5. **Single-line comment tolerance**: JSON has `// comment` on a line. Parsed successfully.
6. **Completely invalid output**: Output is "I cannot evaluate this document." Returns `success: false`.
7. **Score out of range (high)**: Category score is 115. Clamped to 100. Warning generated.
8. **Score out of range (low)**: Category score is -5. Clamped to 0. Warning generated.
9. **Missing category**: Rubric has 7 categories, output has 6. Missing category gets score 0 and `critical:blocking` finding.
10. **Multiple missing categories**: 3 categories missing. 3 auto-generated findings.
11. **Missing required Finding field**: Finding has no `evidence`. Returns `success: false`.
12. **Critical finding missing critical_sub**: Severity is "critical" but no `critical_sub`. Defaults to "blocking" with warning.
13. **Major finding missing suggested_resolution**: Warning generated but output not rejected.
14. **Invalid severity value**: Finding has `severity: "important"`. Returns `success: false`.
15. **Reviewer ID override**: Output contains `reviewer_id: "self-assigned"`. After validation, `reviewer_id` is replaced with the system-assigned value.
16. **Empty category_scores array**: Returns `success: false` with error.
17. **Invalid timestamp format**: `timestamp: "yesterday"`. Returns `success: false`.
18. **Missing summary**: No `summary` field. Returns `success: false`.
