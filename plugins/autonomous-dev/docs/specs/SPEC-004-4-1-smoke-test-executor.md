# SPEC-004-4-1: Smoke Test Executor -- Coverage, Scope Containment & Contradiction Detection

## Metadata
- **Parent Plan**: PLAN-004-4
- **Tasks Covered**: Task 1, Task 2, Task 3, Task 4
- **Estimated effort**: 15 hours

## Description

Implement the full SmokeTestExecutor with its three checks (coverage, scope containment, contradiction detection) and the smoke test orchestration layer with its own iteration loop. The smoke test validates that a decomposition's children collectively and accurately cover the parent document, catching gaps, scope creep, and contradictions before children enter their own review gates.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/smoke-test/smoke-test-executor.ts` | Create | Orchestrator that runs all 3 checks and manages iteration |
| `src/review-gate/smoke-test/coverage-checker.ts` | Create | Validates every parent section is covered by children |
| `src/review-gate/smoke-test/scope-containment-checker.ts` | Create | Detects child content not traceable to parent |
| `src/review-gate/smoke-test/contradiction-detector.ts` | Create | Heuristic-based contradiction detection across siblings |
| `src/review-gate/smoke-test/types.ts` | Create | Shared type definitions for smoke test components |

## Implementation Details

### 1. Shared Types (`smoke-test/types.ts`)

```typescript
interface ParentDocument {
  id: string;
  sections: { id: string; title: string; content: string }[];
}

interface ChildDocument {
  id: string;
  sections: { id: string; title: string; content: string }[];
  traces_from: { document_id: string; section_ids: string[] }[];
}

// Re-exported from core types
interface ParentSectionCoverage {
  section_id: string;
  covered_by: string[];              // child document IDs
  coverage_type: "full" | "partial" | "none";
}

interface CoverageMatrix {
  parent_id: string;
  parent_sections: ParentSectionCoverage[];
  coverage_percentage: number;
  gaps: string[];                     // parent section IDs with no child coverage
  pass: boolean;
}

interface ScopeContainmentResult {
  children_with_scope_creep: {
    child_id: string;
    unmapped_sections: string[];
    creep_percentage: number;
  }[];
  pass: boolean;
}

interface Contradiction {
  child_a_id: string;
  child_b_id: string;
  entity: string;
  statement_a: string;
  statement_b: string;
  confidence: number;                 // 0-1
}

interface ContradictionResult {
  contradictions: Contradiction[];
  pass: boolean;
}

interface SmokeTestResult {
  smoke_test_id: string;
  parent_document_id: string;
  parent_document_version: string;
  child_document_ids: string[];
  timestamp: string;
  coverage: CoverageMatrix & { pass: boolean };
  scope_containment: ScopeContainmentResult;
  contradiction_detection: ContradictionResult;
  overall_pass: boolean;
  iteration: number;
  max_iterations: number;
}
```

### 2. CoverageChecker (`coverage-checker.ts`)

**Class: `CoverageChecker`**

**Primary method:**
```typescript
check(parent: ParentDocument, children: ChildDocument[]): CoverageMatrix
```

**Algorithm:**
```
1. For each parent section:
   a. Find all children whose traces_from includes this parent section ID.
   b. covered_by = list of matching child IDs.
   c. coverage_type:
      - "full" if covered_by.length >= 1
        (substantive coverage -- at least one child references it)
      - "none" if covered_by.length === 0
      - "partial" is reserved for future use (e.g., when content analysis
        determines a child references but doesn't fully address the section)
        For Phase 2, everything with coverage is "full".

2. gaps = parent sections where coverage_type === "none"

3. coverage_percentage = (sections with coverage_type !== "none") / total_sections * 100
   Round to 2 decimal places.

4. pass = coverage_percentage === 100 (no gaps)
```

**Edge cases:**
- Parent with no decomposable sections (e.g., 0 sections): `coverage_percentage: 100`, `pass: true`, `gaps: []`.
- Child traces to nonexistent parent section: log warning, do not count as coverage for any parent section. The child's `traces_from` entry is ignored for coverage purposes.
- Multiple children covering the same section: all listed in `covered_by`. Still "full" coverage.

### 3. ScopeContainmentChecker (`scope-containment-checker.ts`)

**Class: `ScopeContainmentChecker`**

**Configuration:**
```typescript
interface ScopeContainmentConfig {
  creep_threshold_percentage: number;  // default: 20
}
```

**Primary method:**
```typescript
check(
  parent: ParentDocument,
  children: ChildDocument[],
  config?: Partial<ScopeContainmentConfig>
): ScopeContainmentResult
```

**Algorithm:**
```
For each child document:
  1. parentSectionIds = Set of all section IDs in the parent document
  2. tracedSectionIds = Set of all section_ids from the child's traces_from
     that reference this parent document
  3. For each section in the child:
     - If the section does NOT trace to any parent section:
       Mark as unmapped
  4. unmapped_sections = child sections with no traces_from reference to a parent section
  5. creep_percentage = unmapped_sections.length / child.sections.length * 100
  6. Round to 2 decimal places.

children_with_scope_creep = children where creep_percentage > 0
  (list all, even those below threshold, for information)

pass = ALL children have creep_percentage <= config.creep_threshold_percentage
```

**Key behavior:**
- Scope creep is a **warning**, not a blocking failure in the overall smoke test.
- The checker reports ALL children with any unmapped sections, but the pass/fail is based on the threshold.
- Sections like "Introduction" or "Overview" in children that don't map to a specific parent section are expected. The 20% threshold accommodates this.

### 4. ContradictionDetector (`contradiction-detector.ts`)

**Class: `ContradictionDetector`**

**Primary method:**
```typescript
detect(children: ChildDocument[]): ContradictionResult
```

**Phase 2 Heuristic Algorithm:**

**Step 1: Entity extraction**
Extract technology/entity names from each child document using pattern matching:
```typescript
function extractEntities(content: string): Map<string, string[]> {
  // Returns Map<entity_name, statements_mentioning_entity>
  const entities = new Map<string, string[]>();

  // Pattern 1: Technology names (capitalized words that look like tech)
  // E.g., "PostgreSQL", "MongoDB", "Redis", "Kafka", "REST", "GraphQL"
  const techPattern = /\b((?:[A-Z][a-zA-Z]*(?:SQL|DB|MQ|API))|(?:PostgreSQL|MongoDB|MySQL|Redis|Kafka|RabbitMQ|GraphQL|REST|gRPC|Docker|Kubernetes|Terraform|AWS|GCP|Azure))\b/g;

  // Pattern 2: "use X" / "uses X" / "using X" patterns
  const usePattern = /\b(?:use|uses|using|adopt|adopts|adopting|implement|implements|implementing)\s+([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\b/g;

  // Pattern 3: "X for Y" patterns (technology for purpose)
  const forPattern = /\b([A-Z][a-zA-Z0-9]+)\s+(?:for|as)\s+(?:the\s+)?(\w+(?:\s+\w+){0,3})\b/g;

  // Extract and associate each entity with the sentence(s) it appears in
  // ...
  return entities;
}
```

**Step 2: Pairwise comparison**
For every pair of sibling children (i, j) where i < j:
```
1. entitiesA = extractEntities(childA.content)
2. entitiesB = extractEntities(childB.content)
3. sharedEntities = intersection of entity names from A and B
4. For each shared entity:
   a. Get statementsA and statementsB for this entity
   b. Check for contradicting technology choices:
      - If entity is a category (e.g., "database", "message queue")
        and A mentions technology X for it while B mentions technology Y:
        Flag as contradiction.
   c. Check for contradicting properties:
      - If both mention numeric values for the same property
        (e.g., "timeout: 30s" vs "timeout: 60s"):
        Flag as contradiction.
5. Assign confidence:
   - Direct technology conflict (same category, different tech): 0.9
   - Numeric value conflict: 0.7
   - Keyword-based potential conflict: 0.4
```

**Contradiction confidence thresholds:**
- Confidence >= 0.7: Reported as contradiction.
- Confidence 0.4-0.69: Reported but flagged as "low confidence".
- Confidence < 0.4: Not reported.

**Step 3: Result assembly**
```
contradictions = all detected contradictions with confidence >= 0.4
pass = contradictions.filter(c => c.confidence >= 0.7).length === 0
```

**Pluggable interface for Phase 3 AI-agent detection:**
```typescript
interface ContradictionDetectionStrategy {
  detect(childA: ChildDocument, childB: ChildDocument): Promise<Contradiction[]>;
}
```
The heuristic implementation is the default. Phase 3 can provide an AI-agent implementation.

### 5. SmokeTestExecutor (`smoke-test-executor.ts`)

**Class: `SmokeTestExecutor`**

**Configuration:**
```typescript
interface SmokeTestConfig {
  max_iterations: number;  // default: 2
  scope_creep_threshold: number;  // default: 20
}
```

**Primary method:**
```typescript
async execute(
  parent: ParentDocument,
  children: ChildDocument[],
  parentVersion: string,
  config?: Partial<SmokeTestConfig>
): Promise<SmokeTestResult>
```

**Orchestration:**
```
1. Run all three checks:
   coverage = coverageChecker.check(parent, children)
   scopeContainment = scopeContainmentChecker.check(parent, children)
   contradictions = contradictionDetector.detect(children)

2. overall_pass = coverage.pass AND contradictions.pass
   (scope containment does NOT block -- it's a warning)

3. Build SmokeTestResult with all check results.

4. Return result.
```

**Iteration logic:**
The SmokeTestExecutor does NOT manage its own iteration loop internally. Instead, it returns the result and the caller (typically the pipeline orchestrator or ReviewGateService) decides whether to request a re-decomposition. The `iteration` and `max_iterations` fields on `SmokeTestResult` are set by the caller.

The executor provides a convenience method:
```typescript
shouldRetry(result: SmokeTestResult): boolean {
  return !result.overall_pass && result.iteration < result.max_iterations;
}
```

**Outcome table (from TDD section 3.9.3):**

| Coverage | Scope | Contradictions | Overall | Behavior |
|----------|-------|----------------|---------|----------|
| Pass | Pass | Pass | Pass | Children proceed to review gates |
| Fail | Any | Any | Fail | Decomposition rejected; agent must fill gaps |
| Pass | Fail | Pass | Pass | Warning attached to children's review context |
| Pass | Pass | Fail | Fail | Decomposition rejected; agent must resolve contradictions |
| Fail | Fail | Fail | Fail | Decomposition rejected; all issues listed |

## Acceptance Criteria

1. CoverageChecker validates every parent section has at least one child referencing it via `traces_from`.
2. `CoverageMatrix` reports per-section coverage as `full`, `partial`, or `none`.
3. `coverage_percentage` = covered / total * 100.
4. Coverage pass condition: `coverage_percentage === 100`.
5. Gaps listed as parent section IDs with no child coverage.
6. Parent with 0 sections: coverage passes.
7. Child tracing to nonexistent parent section: warning logged, not counted as coverage.
8. ScopeContainmentChecker flags child sections not traceable to parent.
9. `creep_percentage` per child = unmapped / total * 100.
10. Scope creep threshold configurable, default 20%.
11. Scope creep is a warning, not a blocking failure.
12. ContradictionDetector compares every pair of sibling children.
13. Entity extraction identifies technology names and "use X" patterns.
14. Conflicting technology choices for the same category flagged with confidence 0.9.
15. Contradictions with confidence >= 0.7 block (fail), 0.4-0.69 reported as low confidence.
16. Pluggable interface for future AI-agent-based detection.
17. `overall_pass = coverage.pass AND contradictions.pass`.
18. Smoke test iteration is separate from review iteration (default max: 2).
19. Smoke test failures do NOT count against parent document's review iteration count.
20. `shouldRetry()` returns true when failed and under max iterations.

## Test Cases

### `tests/review-gate/smoke-test/coverage-checker.test.ts`

1. **100% coverage**: Parent has 3 sections. Each referenced by at least one child. `coverage_percentage: 100`, `pass: true`.
2. **Partial coverage gap**: Parent has 4 sections. 3 covered, 1 not. `coverage_percentage: 75`, `pass: false`, `gaps` contains the missing section.
3. **Zero coverage**: No children reference any parent section. `coverage_percentage: 0`, `pass: false`.
4. **Multiple children covering same section**: Section A covered by child 1 and child 2. `covered_by: [child1, child2]`. `coverage_type: "full"`.
5. **Parent with 0 sections**: `coverage_percentage: 100`, `pass: true`, `gaps: []`.
6. **Child traces to nonexistent parent section**: Warning logged. Not counted as coverage for any parent section.
7. **Single child covers all sections**: One child references all 5 parent sections. Full coverage.

### `tests/review-gate/smoke-test/scope-containment-checker.test.ts`

8. **No scope creep**: All child sections trace to parent sections. `creep_percentage: 0` for all children. `pass: true`.
9. **Below threshold**: Child has 10 sections, 1 unmapped. `creep_percentage: 10`. Below 20% threshold. `pass: true`.
10. **At threshold**: Child has 10 sections, 2 unmapped. `creep_percentage: 20`. At threshold. `pass: true` (threshold is inclusive <=).
11. **Above threshold**: Child has 10 sections, 3 unmapped. `creep_percentage: 30`. `pass: false`.
12. **Multiple children, one exceeds**: Child A: 0% creep. Child B: 25% creep. `pass: false` (not all below threshold).
13. **Custom threshold**: Threshold set to 10%. Child with 15% creep fails.
14. **Child with 0 sections**: Edge case. `creep_percentage: 0`. Not flagged.

### `tests/review-gate/smoke-test/contradiction-detector.test.ts`

15. **No contradictions**: Two children with no shared entities. `pass: true`, `contradictions: []`.
16. **Clear technology conflict**: Child A: "use PostgreSQL for the database". Child B: "use MongoDB for the database". Flagged with confidence >= 0.7.
17. **Same technology, no conflict**: Both children mention "PostgreSQL". No contradiction.
18. **Numeric value conflict**: Child A: "timeout: 30s". Child B: "timeout: 60s" for same entity. Flagged with confidence ~0.7.
19. **Low confidence match**: Keyword overlap suggests potential conflict but entity matching is ambiguous. Confidence < 0.7. Reported but does not block.
20. **Three children, one pair conflicts**: Children A, B, C. Only A and B conflict. Contradiction references `child_a_id: A, child_b_id: B`.
21. **No shared entities at all**: Children discuss completely different topics. No contradictions.
22. **Entity extraction -- technology names**: Content "We will use Redis for caching" extracts entity "Redis".
23. **Entity extraction -- use pattern**: Content "The system adopts GraphQL for API layer" extracts "GraphQL".
24. **Pluggable strategy interface**: Provide a mock strategy that returns a hardcoded contradiction. Verify it is used instead of the heuristic.

### `tests/review-gate/smoke-test/smoke-test-executor.test.ts`

25. **All pass**: Coverage pass, scope pass, contradictions pass. `overall_pass: true`.
26. **Coverage failure blocks**: Coverage fails, others pass. `overall_pass: false`.
27. **Contradiction failure blocks**: Contradictions fail, coverage passes. `overall_pass: false`.
28. **Scope creep does not block**: Scope creep exceeds threshold but coverage and contradictions pass. `overall_pass: true`. Scope containment `pass: false` is informational.
29. **All fail**: Coverage, scope, and contradictions all fail. `overall_pass: false`.
30. **shouldRetry -- failed, under max**: Iteration 1, max 2, overall_pass false. `shouldRetry: true`.
31. **shouldRetry -- failed, at max**: Iteration 2, max 2, overall_pass false. `shouldRetry: false`.
32. **shouldRetry -- passed**: overall_pass true. `shouldRetry: false`.
