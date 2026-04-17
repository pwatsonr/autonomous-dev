# SPEC-004-3-2: Feedback Formatter & Cross-Iteration Finding Tracker

## Metadata
- **Parent Plan**: PLAN-004-3
- **Tasks Covered**: Task 4, Task 5
- **Estimated effort**: 8 hours

## Description

Build the FeedbackFormatter that merges, deduplicates, and structures findings from multiple reviewers into a unified review result, and the FindingTracker that links findings across iterations to track resolution and recurrence. Together, these components produce the actionable, structured feedback that the authoring agent receives and that the convergence tracker consumes.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/feedback-formatter.ts` | Create | Multi-reviewer finding merge and deduplication |
| `src/review-gate/finding-tracker.ts` | Create | Cross-iteration finding linking |

## Implementation Details

### 1. FeedbackFormatter (`feedback-formatter.ts`)

**Type definitions:**
```typescript
interface SimilarityFunction {
  (descriptionA: string, descriptionB: string): number;
}

interface FeedbackFormatterConfig {
  similarity_threshold: number;  // default: 0.85 (for Phase 2 embedding-based)
  similarity_function: SimilarityFunction | null;  // null = use Phase 1 keyword heuristic
}
```

**Class: `FeedbackFormatter`**

**Constructor:**
```typescript
constructor(private config: FeedbackFormatterConfig = {
  similarity_threshold: 0.85,
  similarity_function: null,
})
```

**Primary method:**
```typescript
formatFindings(
  reviewerOutputs: ReviewOutput[],
  previousIterationFindings?: MergedFinding[]
): FormattedFeedback
```

**`FormattedFeedback` interface:**
```typescript
interface FormattedFeedback {
  merged_findings: MergedFinding[];
  findings_by_section: Map<string, MergedFinding[]>;
  total_findings: number;
  severity_counts: { critical: number; major: number; minor: number; suggestion: number };
  deduplication_stats: { total_raw: number; after_dedup: number; duplicates_merged: number };
}
```

**Deduplication algorithm:**

**Phase 1 (keyword heuristic, default):**
Two findings are considered duplicates if ALL of the following match:
1. Same `section_id`
2. Same `category_id`
3. Keyword overlap score >= 0.5

Keyword overlap computation:
```typescript
function keywordOverlap(descA: string, descB: string): number {
  const wordsA = new Set(tokenize(descA));
  const wordsB = new Set(tokenize(descB));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;  // Jaccard similarity
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)        // drop short words
    .filter(w => !STOP_WORDS.has(w)); // drop common stop words
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all",
  "can", "has", "her", "was", "one", "our", "out", "his",
  "how", "its", "may", "who", "did", "get", "let", "say",
  "she", "too", "use", "this", "that", "with", "have", "from",
  "they", "been", "said", "each", "which", "their", "will",
  "other", "about", "many", "then", "them", "these", "some",
  "would", "make", "like", "into", "could", "than", "been",
  "what", "when", "where", "should", "does", "also",
]);
```

**Phase 2 interface (pluggable):**
When `config.similarity_function` is provided, use it instead of `keywordOverlap`:
```typescript
const similarity = config.similarity_function
  ? config.similarity_function(findingA.description, findingB.description)
  : keywordOverlap(findingA.description, findingB.description);

const isDuplicate = findingA.section_id === findingB.section_id
  && findingA.category_id === findingB.category_id
  && similarity >= config.similarity_threshold;
```

**Merge algorithm:**
```
1. Collect all findings from all reviewerOutputs into a flat list.
2. For each pair of findings, check if they are duplicates.
3. Group duplicates into clusters using union-find (transitive closure).
4. For each cluster, produce one MergedFinding:
   a. id: first finding's ID in the cluster.
   b. section_id, category_id: shared values (same by definition).
   c. severity: max severity in the cluster.
      Priority: critical > major > minor > suggestion.
   d. critical_sub: if severity is critical, use the sub from the highest-severity finding.
      If multiple critical findings, prefer "reject" over "blocking".
   e. upstream_defect: true if ANY finding in the cluster is upstream_defect.
   f. description: description from the highest-severity finding.
   g. evidence: evidence from the highest-severity finding.
   h. suggested_resolution: from the highest-severity finding.
      If multiple findings share the max severity, use the one with the longest
      suggested_resolution text.
   i. reported_by: list of all reviewer_ids from findings in the cluster.
   j. resolution_status: "open" (set by FindingTracker later).
   k. prior_finding_id: null (set by FindingTracker later).
5. Sort merged findings: critical first, then major, minor, suggestion.
   Within same severity, sort by section_id alphabetically.
```

**Severity ordering constant:**
```typescript
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  suggestion: 1,
};
```

**Organize by section:**
```typescript
function groupBySection(findings: MergedFinding[]): Map<string, MergedFinding[]> {
  const map = new Map<string, MergedFinding[]>();
  for (const f of findings) {
    if (!map.has(f.section_id)) map.set(f.section_id, []);
    map.get(f.section_id)!.push(f);
  }
  return map;
}
```

### 2. FindingTracker (`finding-tracker.ts`)

**Class: `FindingTracker`**

**Primary method:**
```typescript
trackFindings(
  currentFindings: MergedFinding[],
  previousIterationFindings: MergedFinding[] | null,
  allPreviousFindings?: MergedFinding[]  // all findings from all previous iterations
): TrackedFinding[]
```

**`TrackedFinding`** extends `MergedFinding` with populated `resolution_status` and `prior_finding_id`.

**Matching key:** `(section_id, category_id)` pair.

**Algorithm:**
```
1. If previousIterationFindings is null (iteration 1):
   Set all findings to resolution_status: "open", prior_finding_id: null.
   Return.

2. For each current finding:
   a. Search previousIterationFindings for a match on (section_id, category_id).
   b. If match found:
      - resolution_status: "open" (issue persists)
      - prior_finding_id: matched finding's ID
   c. If no match found:
      - Search allPreviousFindings for a match that was previously "resolved"
      - If match found:
        resolution_status: "recurred"
        prior_finding_id: the resolved finding's ID
      - Else:
        resolution_status: "open"  (new finding)
        prior_finding_id: null

3. For each previousIterationFinding not matched by any current finding:
   Create a "resolved" entry:
   - Copy the previous finding
   - Set resolution_status: "resolved"
   - This resolved entry is NOT added to the current findings list
     but is tracked for recurrence detection in future iterations
```

**Return value:** The `currentFindings` array with `resolution_status` and `prior_finding_id` populated, plus a separate list of resolved findings for bookkeeping.

```typescript
interface FindingTrackingResult {
  tracked_findings: MergedFinding[];        // current findings with status populated
  resolved_findings: MergedFinding[];        // findings from previous iteration now resolved
  recurred_findings: MergedFinding[];        // findings that recurred (subset of tracked)
  new_findings: MergedFinding[];             // findings with no prior match (subset of tracked)
  persistent_findings: MergedFinding[];      // findings that match previous (subset of tracked)
}
```

## Acceptance Criteria

1. FeedbackFormatter merges findings from all reviewers into `MergedFinding[]`.
2. Two findings are duplicates if same `section_id` AND same `category_id` AND keyword overlap >= 0.5 (Phase 1).
3. Phase 2 interface: pluggable similarity function with configurable threshold (default 0.85).
4. Merged finding uses highest severity among duplicates.
5. `critical_sub`: prefers "reject" over "blocking" when multiple critical findings conflict.
6. Merged `suggested_resolution` uses highest-severity resolution; if tied, longest text.
7. `reported_by` lists all contributing reviewer IDs.
8. Findings organized by section in the output.
9. Findings sorted by severity (critical first), then by section_id alphabetically.
10. Deduplication stats accurately count raw findings, post-dedup findings, and merged duplicates.
11. FindingTracker matches on (section_id, category_id) pair.
12. Finding `resolved` if no match in current iteration for a previous finding.
13. Finding `recurred` if it matches a previously resolved finding from any past iteration.
14. `prior_finding_id` links to the matched finding from the previous iteration.
15. Recurred findings contribute to stagnation detection via the ConvergenceTracker.

## Test Cases

### `tests/review-gate/feedback-formatter.test.ts`

1. **Single reviewer, no deduplication needed**: 1 reviewer with 3 findings. All 3 appear as merged findings with `reported_by: [reviewerId]`.
2. **Two reviewers, no duplicates**: Reviewer A flags section "goals"/category "measurability". Reviewer B flags section "risks"/category "risk_identification". Both appear separately.
3. **Two reviewers, exact duplicate**: Both flag same section_id, same category_id, similar descriptions. Merged into 1 finding with `reported_by: [A, B]`.
4. **Keyword overlap threshold**: Descriptions share some words but overlap is 0.4 (below 0.5). Not merged.
5. **Keyword overlap above threshold**: Descriptions overlap at 0.6. Same section and category. Merged.
6. **Same section, different category -- not duplicates**: Both flag "goals" section, but different categories. Not merged.
7. **Same category, different section -- not duplicates**: Both flag "requirements_completeness" but different sections. Not merged.
8. **Severity escalation on merge**: Reviewer A flags as "minor", Reviewer B flags same issue as "major". Merged severity: "major".
9. **Critical sub preference**: Reviewer A: `critical:blocking`. Reviewer B: `critical:reject`. Merged: `critical:reject`.
10. **Suggested resolution -- highest severity wins**: Major finding has resolution "Fix X". Minor finding has resolution "Consider fixing X". Merged uses "Fix X".
11. **Suggested resolution -- tied severity, longest wins**: Two major findings. Resolution A: "Fix X." Resolution B: "Fix X by changing Y and Z." Merged uses B.
12. **Upstream defect propagation**: One finding in cluster has `upstream_defect: true`. Merged finding has `upstream_defect: true`.
13. **Sorting**: Critical findings appear before major, which appear before minor. Within same severity, "architecture" section before "goals" section.
14. **Group by section**: 5 findings across 3 sections. `findings_by_section` map has 3 entries with correct findings.
15. **Deduplication stats**: 6 raw findings, 2 duplicate clusters of size 2, result: `total_raw: 6, after_dedup: 4, duplicates_merged: 2`.
16. **Pluggable similarity function**: Provide custom function that always returns 1.0. All same-section-category pairs are merged.
17. **Three-way merge**: Reviewers A, B, C all flag the same issue. Cluster of 3. `reported_by` has all 3 IDs.
18. **Empty findings**: No findings from any reviewer. Returns empty `merged_findings`.

### `tests/review-gate/finding-tracker.test.ts`

19. **Iteration 1 -- all open**: No previous findings. All current findings get `resolution_status: "open"`, `prior_finding_id: null`.
20. **Finding resolved**: Iteration 1 has finding (goals, measurability). Iteration 2 has no finding at that key. `resolved_findings` includes it.
21. **Finding persists**: Iteration 1 has finding (goals, measurability). Iteration 2 also has finding (goals, measurability). Current finding gets `prior_finding_id` set, `resolution_status: "open"`.
22. **Finding recurred**: Finding resolved in iteration 2 (not present). Reappears in iteration 3. `resolution_status: "recurred"`, `prior_finding_id` points to the original.
23. **New finding in iteration 2**: Finding in iteration 2 has no match in iteration 1. `resolution_status: "open"`, `prior_finding_id: null`.
24. **Multiple resolutions**: 3 findings resolved, 2 persist, 1 new. Counts match.
25. **Tracking result categories**: `recurred_findings`, `new_findings`, `persistent_findings` are correct subsets.
26. **No previous findings (first iteration)**: `previousIterationFindings` is null. All are "open".
27. **All findings resolved**: Every finding from iteration 1 is gone in iteration 2. All marked resolved.
