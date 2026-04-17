# SPEC-005-4-1: Historical Input Selector, Blind Runner, and Label Randomizer

## Metadata
- **Parent Plan**: PLAN-005-4
- **Tasks Covered**: Task 1 (Historical input selector), Task 2 (Blind runner), Task 3 (Label randomizer)
- **Estimated effort**: 16 hours

## Description

Implement the first three steps of the 7-step A/B evaluation protocol: selecting appropriate historical inputs for validation, executing both current and proposed agent versions on those inputs, and randomizing output labels to ensure blind scoring. These components set up the unbiased comparison that drives validation decisions.

## Files to Create/Modify

### New Files

**`src/agent-factory/validation/input-selector.ts`**
- Exports: `InputSelector` class with `selectInputs(agentName: string, report: WeaknessReport): SelectedInput[]`

**`src/agent-factory/validation/blind-runner.ts`**
- Exports: `BlindRunner` class with `runBothVersions(input: SelectedInput, currentAgent: AgentRecord, proposedDef: string): RunPair`

**`src/agent-factory/validation/randomizer.ts`**
- Exports: `LabelRandomizer` class with `randomize(pair: RunPair): RandomizedPair`
- Exports: `derandomize(pair: RandomizedPair): DerandomizedPair`

## Implementation Details

### Input Selector (`validation/input-selector.ts`)

```typescript
interface SelectedInput {
  input_id: string;               // UUID v4
  original_invocation_id: string; // reference to the historical invocation
  input_content: string;          // the actual input text
  input_hash: string;
  input_domain: string;
  original_quality_score: number; // score from the original invocation
  selection_reason: string;       // e.g., "below-median", "above-median", "weakness-domain"
}

interface InputSelectionResult {
  success: boolean;
  inputs: SelectedInput[];
  error?: string;
}
```

**Selection algorithm (TDD 3.5.1 Step 1):**

1. Query all production invocations for the agent: `metricsEngine.getInvocations(agentName, { environment: 'production' })`.

2. **Minimum enforcement**: If fewer than 3 historical invocations exist, return error: "Insufficient historical inputs for A/B validation (found {N}, minimum 3 required)".

3. **Compute median quality score** across all invocations.

4. **Select inputs (3-5 total):**
   - At least 1 **below-median** input: select the invocation with quality score furthest below median. Reason: "below-median".
   - At least 1 **above-median** input: select the invocation with quality score furthest above median. Reason: "above-median".
   - At least 1 **weakness-domain** input: if the weakness report identifies affected domains, select an invocation from that domain. Reason: "weakness-domain". If no domain-specific invocation exists, select another below-median input.
   - Remaining slots (up to 5 total): select inputs that maximize domain diversity.

5. **Deduplication**: Do not select the same invocation twice.

6. **Record selection**: Store selected input hashes in the evaluation record for audit.

**Input content reconstruction:**
- The selector needs the original input text. This should be stored or reconstructable from the invocation metric's `input_hash`. If full input text is not stored in metrics, the selector queries the pipeline's artifact store using the `pipeline_run_id`.

### Blind Runner (`validation/blind-runner.ts`)

```typescript
interface RunPair {
  input: SelectedInput;
  version_a: RunResult;           // current agent
  version_b: RunResult;           // proposed agent
}

interface RunResult {
  output: string;
  output_hash: string;
  input_tokens: number;
  output_tokens: number;
  wall_clock_ms: number;
  turn_count: number;
  tool_calls: ToolCallRecord[];
  error?: string;
}

interface TokenTracker {
  cumulative_tokens: number;
  budget: number;
  remaining: number;
  exceeded: boolean;
}
```

**Execution steps:**

1. **Run current agent (version_a):**
   - Invoke the current agent version via Agent Runtime with the selected input.
   - Record output, token consumption, wall clock time, turn count, tool calls.
   - Tag the invocation with `environment: 'validation'` in metrics.
   - Do NOT reuse the historical output. Re-run the agent fresh.

2. **Run proposed agent (version_b):**
   - Load the proposed agent definition (from the proposal's `proposed_definition`).
   - Create a temporary AgentRecord with the proposed definition.
   - Invoke via Agent Runtime with the same input.
   - Tag with `environment: 'validation'`.
   - Same metrics recording.

3. **Token tracking:**
   - After each run, update the cumulative token counter.
   - If cumulative exceeds budget: return the partial result, set `exceeded: true`.
   - The orchestrator (SPEC-005-4-3) checks this after each run pair.

4. **Error handling:**
   - If either version fails to produce output (timeout, error): record the error in the RunResult.
   - A failed run counts as a loss for that version in scoring.

### Label Randomizer (`validation/randomizer.ts`)

```typescript
interface RandomizedPair {
  input: SelectedInput;
  output_1: string;               // could be version_a or version_b
  output_2: string;               // the other one
  mapping_id: string;             // UUID for the mapping record
  // mapping is NOT accessible from this interface
}

interface RandomizationMapping {
  mapping_id: string;
  output_1_is: 'version_a' | 'version_b';
  output_2_is: 'version_a' | 'version_b';
}

// Stored separately from RandomizedPair
interface MappingStore {
  store(mapping: RandomizationMapping): void;
  retrieve(mappingId: string): RandomizationMapping;
}
```

**Randomization:**
- Use `crypto.randomBytes(1)` to generate a random bit.
- If bit is 0: Output 1 = version_a, Output 2 = version_b.
- If bit is 1: Output 1 = version_b, Output 2 = version_a.
- Store the mapping in a separate data structure NOT passed to the scorer.

**De-randomization:**
- After scoring, retrieve the mapping and assign scores back to version_a/version_b.

**Separation of concerns:**
- The `RandomizedPair` does NOT contain any indication of which output is which.
- The `MappingStore` is accessed only during de-randomization, not during scoring.
- Output text is stripped of any version metadata before randomization.

## Acceptance Criteria

1. Input selector queries production invocations only (not validation/canary).
2. Minimum 3 historical inputs enforced; error returned if fewer.
3. At least 1 below-median, 1 above-median, 1 weakness-domain input selected.
4. Selected inputs deduplicated.
5. Selection reasons recorded for audit trail.
6. Blind runner re-runs both versions (does NOT reuse historical outputs).
7. Both invocations tagged with `environment: 'validation'` in metrics.
8. Token consumption tracked cumulatively across all runs.
9. Failed runs recorded with error (not silently dropped).
10. Randomizer uses cryptographically secure random source.
11. Randomized pair contains no indication of which output is current vs. proposed.
12. Mapping stored separately and only accessed during de-randomization.

## Test Cases

### Input Selector Tests

```
test_select_3_inputs_minimum
  Setup: agent with 10 historical invocations
  Expected: exactly 3-5 inputs returned

test_minimum_enforcement_fails
  Setup: agent with 2 historical invocations
  Expected: error "Insufficient historical inputs"

test_below_median_selected
  Setup: invocations with scores [2.0, 3.0, 4.0, 5.0]
  Expected: at least 1 input with score <= 3.0, reason="below-median"

test_above_median_selected
  Setup: invocations with scores [2.0, 3.0, 4.0, 5.0]
  Expected: at least 1 input with score >= 4.0, reason="above-median"

test_weakness_domain_selected
  Setup: weakness report identifies "python" domain
  Expected: at least 1 input from "python" domain, reason="weakness-domain"

test_fallback_when_no_domain_match
  Setup: weakness identifies "rust" but no rust invocations exist
  Expected: selects another below-median input instead

test_no_duplicate_inputs
  Expected: all input_ids are unique

test_only_production_invocations
  Setup: mix of production and validation invocations
  Expected: only production invocations selected

test_max_5_inputs
  Setup: agent with 50 historical invocations
  Expected: at most 5 inputs selected
```

### Blind Runner Tests

```
test_both_versions_run
  Action: runBothVersions with input
  Expected: version_a and version_b both have output

test_version_a_is_current
  Expected: version_a output produced by current agent

test_version_b_is_proposed
  Expected: version_b output produced by proposed agent definition

test_environment_tagged_validation
  Expected: invocations in metrics have environment="validation"

test_does_not_reuse_historical_output
  Expected: version_a output differs from original historical output (fresh run)

test_token_tracking_cumulative
  Action: run 3 pairs
  Expected: cumulative_tokens = sum of all 6 runs

test_token_budget_exceeded
  Setup: budget=10000, first pair consumes 12000
  Expected: exceeded=true after first pair

test_run_failure_recorded
  Setup: proposed agent definition causes timeout
  Expected: version_b.error set, output may be empty

test_run_failure_counts_as_loss
  Expected: scoring treats empty/error output as a loss
```

### Randomizer Tests

```
test_randomize_hides_version_info
  Action: randomize(pair)
  Expected: RandomizedPair has output_1 and output_2 with no version labels

test_randomize_is_random
  Action: randomize 100 pairs
  Expected: approximately 50% have output_1=version_a (within statistical bounds)

test_derandomize_restores_labels
  Action: randomize then derandomize
  Expected: version_a and version_b scores correctly assigned

test_cryptographic_random_source
  Expected: randomizer uses crypto.randomBytes, not Math.random

test_mapping_not_in_randomized_pair
  Expected: RandomizedPair type does not contain mapping information

test_mapping_stored_separately
  Action: randomize
  Expected: MappingStore.store called with correct mapping

test_mapping_retrieved_for_derandomization
  Action: derandomize
  Expected: MappingStore.retrieve called with correct mapping_id

test_output_stripped_of_metadata
  Setup: output contains version number in header
  Expected: version references stripped before randomization
```
