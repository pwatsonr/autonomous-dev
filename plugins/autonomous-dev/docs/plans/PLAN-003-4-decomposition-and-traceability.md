# PLAN-003-4: Decomposition Engine and Traceability Matrix

## Metadata
- **Parent TDD**: TDD-003-document-pipeline
- **Estimated effort**: 8 days
- **Dependencies**: [PLAN-003-1 (types, frontmatter, templates), PLAN-003-2 (storage layer), PLAN-003-3 (versioning engine)]
- **Blocked by**: [PLAN-003-2]
- **Priority**: P1

## Objective
Deliver the two subsystems that manage document relationships: the Decomposition Engine (splitting a parent document into N typed children with dependency tracking, coverage smoke tests, and explosion safeguards) and the Traceability Matrix (cross-document requirement tracing from PRD requirements through to code, gap detection, orphan detection, and impact analysis). After this plan, the system can decompose approved documents, validate that decompositions cover all parent requirements without scope creep, maintain a full traceability graph for a pipeline, and detect requirements that lack downstream coverage.

## Scope
### In Scope
- TDD Section 3.6: Decomposition Engine (strategies, tree data structure, decomposition records, limits/safeguards, coverage smoke test)
- TDD Section 3.7: Cross-Document Traceability Matrix (data model, storage, gap detection algorithm, update mechanism)
- TDD Section 5.4: Decomposition Engine API contract (`decompose`, `smokeTest`, `getDecomposition`, `getTree`)
- TDD Section 5.5: Traceability Matrix API contract (`regenerate`, `detectGaps`, `detectOrphans`, `getTraceChain`, `analyzeImpact`)

### Out of Scope
- Agent orchestration for decomposition (the agent interface is a contract; the actual agent that proposes children is out of scope)
- Backward cascade controller (PLAN-003-5 -- it consumes traceability but is a separate subsystem)
- Pipeline flow controller integration (PLAN-003-5 -- it calls decompose after review gate pass)
- Review gate scoring (separate TDD)
- Cross-pipeline traceability (OQ-6, deferred)

## Tasks

1. **Implement decomposition strategy registry** -- Define the four decomposition strategies (domain, implementation phasing, task, direct generation) and their mapping to pipeline transitions.
   - Files to create: `src/pipeline/decomposition/strategy-registry.ts`
   - Acceptance criteria: Strategies match TDD Section 3.6.1 table: PRD->TDD uses "domain", TDD->Plan uses "phase", Plan->Spec uses "task", Spec->Code is "direct" (1:1, no decomposition logic). Each strategy has an ID, description, and the transition it applies to. Registry provides `getStrategy(parentType, childType)`.
   - Estimated effort: 2 hours

2. **Implement DecompositionNode and DecompositionTree data structures** -- In-memory tree that tracks the full parent-child graph across the entire pipeline, including sibling dependencies and execution mode.
   - Files to create: `src/pipeline/decomposition/decomposition-tree.ts`
   - Acceptance criteria: Interfaces match TDD Section 3.6.2 (`DecompositionNode`, `DecompositionTree`). Tree supports: add node, get node, get children, get subtree, compute total node count, compute max depth. Sibling dependencies tracked per node. Execution mode (parallel/sequential) derived from dependency graph.
   - Estimated effort: 4 hours

3. **Implement decomposition record I/O** -- Read and write decomposition YAML files in the `decomposition/` directory.
   - Files to create: `src/pipeline/decomposition/decomposition-record-io.ts`
   - Acceptance criteria: Schema matches TDD Section 3.6.3 (parent_id, parent_type, parent_version, child_type, strategy, children array with id/title/traces_from/execution_mode/depends_on, coverage_matrix, smoke_test_result, created_at, decomposition_agent). Files named `{PARENT_ID}-decomposition.yaml` per TDD Section 3.4.2. Atomic writes via storage layer.
   - Estimated effort: 3 hours

4. **Implement decomposition limits checker** -- Validate that a proposed decomposition does not exceed configured limits before creating children.
   - Files to create: `src/pipeline/decomposition/limits-checker.ts`
   - Acceptance criteria: Enforces all limits from TDD Section 3.6.4: max children per decomposition (default 10), max pipeline depth (hardcoded 4), max total nodes per pipeline (default 100), explosion threshold (default 75% of max). Returns specific `DecompositionError` codes: `CHILD_LIMIT_EXCEEDED`, `DEPTH_LIMIT_EXCEEDED`, `EXPLOSION_THRESHOLD`. Explosion threshold triggers human confirmation requirement. All limits except depth are configurable.
   - Estimated effort: 3 hours

5. **Implement coverage smoke test** -- Validate three properties of a proposed decomposition: coverage completeness (every parent requirement appears in at least one child's traces_from), no scope creep (all child traces_from are valid parent sections), and no contradictions (explicit declaration conflicts).
   - Files to create: `src/pipeline/decomposition/smoke-test.ts`
   - Acceptance criteria: Implements `smokeTest(parentId, proposedChildren): Promise<SmokeTestResult>` per TDD Section 3.6.5. Returns `SmokeTestResult` with: passed boolean, coverageComplete, uncoveredParentSections, scopeCreep flag with out-of-scope details, contradictions flag with contradiction details. Requires parent document to be read and parsed for its sections/requirements.
   - Estimated effort: 6 hours

6. **Implement decomposition orchestrator** -- Coordinates the full decomposition flow: validate parent is approved, check limits, run smoke test, create child documents via storage layer, write decomposition record, update parent's `traces_to` frontmatter.
   - Files to create: `src/pipeline/decomposition/decomposition-engine.ts`
   - Acceptance criteria: Implements `decompose(request: DecompositionRequest): Promise<DecompositionResult>` per TDD Section 5.4. Validates parent status is "approved" (rejects `PARENT_NOT_APPROVED`). Validates parent ID exists (rejects `INVALID_PARENT`). Checks all limits. Runs smoke test (rejects `SMOKE_TEST_FAILED` if configured). Creates all child documents with correct frontmatter (type, depth, sibling_index, sibling_count, depends_on, traces_from). Updates parent's `traces_to` field. Writes decomposition record. Returns `DecompositionResult` with success status, created children, smoke test result, and decomposition record.
   - Estimated effort: 8 hours

7. **Implement tree reconstruction from storage** -- Rebuild the full `DecompositionTree` for a pipeline by reading all decomposition records and document frontmatter.
   - Files to create: `src/pipeline/decomposition/tree-reconstructor.ts`
   - Acceptance criteria: Implements `getTree(pipelineId): Promise<DecompositionTree>` per TDD Section 5.4. Scans all decomposition records in the pipeline's `decomposition/` directory. Reads frontmatter from all documents to populate node status and version. Produces complete tree with correct parent-child relationships, depths, and dependency edges.
   - Estimated effort: 4 hours

8. **Implement TraceLink and TraceChain data models** -- Define the core traceability data structures: individual trace links and full requirement-to-code chains.
   - Files to create: `src/pipeline/traceability/trace-types.ts`
   - Acceptance criteria: Interfaces match TDD Section 3.7.1 (`TraceLink`, `TraceChain`, `TraceGap`, `TraceabilityMatrix`). Link types: implements, addresses, tests, derived_from. Link statuses: active, stale, orphaned. Gap severities: critical, warning.
   - Estimated effort: 2 hours

9. **Implement traceability matrix regenerator** -- Build the full traceability matrix from document frontmatter by walking all documents in a pipeline and constructing forward chains from PRD requirements through TDD, Plan, Spec, to Code.
   - Files to create: `src/pipeline/traceability/matrix-regenerator.ts`
   - Acceptance criteria: Implements `regenerate(pipelineId): Promise<TraceabilityMatrix>` per TDD Section 5.5. Follows the 5-step process from TDD Section 3.7.2: walk documents, parse traces_from/traces_to, build forward chains, detect gaps, detect orphans. Produces `TraceabilityMatrix` with complete chain data. Writes result to `traceability.yaml` at pipeline root. Uses `updated_at` timestamps for incremental optimization when approaching 100-node limit.
   - Estimated effort: 8 hours

10. **Implement gap detection algorithm** -- Identify requirements with incomplete trace chains (missing coverage at a pipeline level that has been reached).
    - Files to create: `src/pipeline/traceability/gap-detector.ts`
    - Acceptance criteria: Implements `detectGaps(pipelineId): Promise<TraceGap[]>` per TDD Section 5.5. Algorithm matches TDD Section 3.7.3 pseudocode. Gaps classified as "critical" (requirement has NO downstream trace at a reached level). Gaps include the level where coverage is missing, source ID, severity, and description.
    - Estimated effort: 4 hours

11. **Implement orphan detection** -- Identify documents whose `traces_from` entries reference sections that no longer exist in the parent's current version (e.g., after a backward cascade revision).
    - Files to create: `src/pipeline/traceability/orphan-detector.ts`
    - Acceptance criteria: Implements `detectOrphans(pipelineId): Promise<string[]>` per TDD Section 5.5. Returns document IDs whose `traces_from` reference invalid parent sections. Validates by reading the parent document's current version and checking section IDs.
    - Estimated effort: 3 hours

12. **Implement trace chain retrieval** -- Return the full forward chain for a specific requirement from PRD through to Code.
    - Files to create: `src/pipeline/traceability/chain-retriever.ts`
    - Acceptance criteria: Implements `getTraceChain(requirementId): Promise<TraceChain>` per TDD Section 5.5. Returns the chain with entries at each level (tdd, plan, spec, code), completeness flag, and any gaps. Works from the regenerated matrix (does not scan documents directly).
    - Estimated effort: 3 hours

13. **Implement impact analysis** -- Given a document and specific section IDs, identify all downstream documents that trace to those sections (directly or transitively).
    - Files to create: `src/pipeline/traceability/impact-analyzer.ts`
    - Acceptance criteria: Implements `analyzeImpact(documentId, sectionIds): Promise<string[]>` per TDD Section 5.5. Returns all document IDs at any depth that trace to the specified sections. Traverses the decomposition tree following `traces_from` links transitively. Used by the backward cascade controller (PLAN-003-5) to determine affected documents.
    - Estimated effort: 4 hours

14. **Assemble DecompositionEngineAPI and TraceabilityMatrixAPI facades** -- Wire components into the unified API interfaces.
    - Files to create: `src/pipeline/decomposition/index.ts`, `src/pipeline/traceability/index.ts`
    - Acceptance criteria: Decomposition facade implements all methods of `DecompositionEngineAPI` from TDD Section 5.4. Traceability facade implements all methods of `TraceabilityMatrixAPI` from TDD Section 5.5. Traceability regeneration triggered after every decomposition (per TDD Section 3.7.2).
    - Estimated effort: 3 hours

## Dependencies & Integration Points
- **PLAN-003-1**: Uses `DocumentType`, frontmatter types, template section definitions for identifying parent requirements/sections.
- **PLAN-003-2**: All file I/O (document creation, decomposition record writes, traceability.yaml writes) goes through the storage layer.
- **PLAN-003-3**: Decomposition reads parent version from versioning history. The parent's `traces_to` field is updated via a version write when modified.
- **PLAN-003-5** (Pipeline Flow Controller): The flow controller calls `decompose()` after a document passes its review gate. The backward cascade controller calls `analyzeImpact()` to scope cascades. Gap detection runs at review gates per configuration.

## Testing Strategy
- **Unit tests**:
  - Decomposition limits checker: each limit individually, combinations, configurable values.
  - Smoke test: full coverage (pass), missing coverage (fail), scope creep (fail), contradictions (fail), mixed results.
  - Gap detector: complete chains (no gaps), missing TDD coverage, missing Plan coverage, missing at multiple levels.
  - Orphan detector: valid traces (no orphans), invalid parent section reference (orphan detected), parent revised removing a section.
  - Impact analyzer: single-level impact, transitive multi-level impact, no impact (sections not traced).
  - Target: 90% coverage for smoke test and cascade scoping per TDD Section 8.1.
- **Integration tests**:
  - Create PRD -> decompose to 3 TDDs -> verify decomposition record, tree structure, coverage matrix. (TDD Section 8.2 scenario)
  - Create PRD -> decompose to TDDs -> decompose TDDs to Plans -> regenerate traceability -> verify chains are complete.
  - Decompose with 11 children -> verify `CHILD_LIMIT_EXCEEDED` rejection.
  - Decompose with missing coverage -> verify `SMOKE_TEST_FAILED` rejection with specific uncovered sections.
- **Property-based tests**: Random decomposition proposals never produce a tree with more than 100 nodes (within limit).

## Risks
1. **Coverage smoke test accuracy** -- The test validates traces_from entries but does not semantically verify that the child content actually addresses the parent requirement. Mitigation: Per TDD Section 3.6.5, full semantic contradiction detection is aspirational; MVP checks explicit declaration conflicts only. The review gate provides the semantic check.
2. **Traceability regeneration performance** -- For pipelines near 100 nodes, full regeneration could be slow. Mitigation: TDD Section 3.7.4 provides the incremental optimization (cache parsed frontmatter, only re-parse modified documents). Benchmark at 50, 100 nodes per OQ-1.
3. **Decomposition agent interface** -- The contract between the agent and the decomposition engine (OQ-2) is not finalized. Mitigation: This plan implements the engine side assuming structured YAML input (Option A from OQ-2). The `ProposedChild` interface in TDD Section 5.4 is the contract. If the agent interface changes, only the adapter layer needs updating.
4. **Circular dependencies in sibling graph** -- A bug in the decomposition agent could propose children with circular dependencies. Mitigation: The decomposition engine validates the dependency graph is a DAG before accepting the proposal.

## Definition of Done
- [ ] Decomposition engine creates child documents with correct type, depth, and frontmatter
- [ ] Decomposition strategies map correctly to pipeline transitions
- [ ] Coverage smoke test validates coverage completeness, scope creep, and contradictions
- [ ] Decomposition limits enforced with correct error codes
- [ ] Decomposition records written in correct YAML schema
- [ ] DecompositionTree correctly reconstructed from storage
- [ ] Traceability matrix regenerated from document frontmatter
- [ ] Gap detection identifies requirements with missing downstream coverage
- [ ] Orphan detection identifies documents tracing to removed parent sections
- [ ] Impact analysis returns all downstream documents affected by section changes
- [ ] Trace chain retrieval returns complete forward chain for any requirement
- [ ] Both API facades expose all methods from TDD Sections 5.4 and 5.5
- [ ] Integration test: full PRD -> TDD -> Plan decomposition with traceability verification passes
- [ ] Unit test coverage >= 90% for smoke test, gap detection, and orphan detection
