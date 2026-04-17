# PRD-002: Document Pipeline & Review Gates

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | Document Pipeline & Review Gates           |
| **PRD ID**  | PRD-002                                    |
| **Version** | 0.1.0                                      |
| **Date**    | 2026-04-08                                 |
| **Author**  | Product Management                         |
| **Status**  | Draft                                      |
| **Plugin**  | autonomous-dev                             |

---

## 1. Problem Statement

Autonomous AI development requires more than just code generation. The gap between a product idea and production-quality code is filled with architectural decisions, implementation trade-offs, and specification details that compound in complexity at every step. Without a structured pipeline, AI agents produce code that drifts from intent, misses requirements, introduces contradictions between components, and lacks the auditability that production systems demand.

Today, when AI generates code directly from high-level requirements, the failure modes are predictable: incomplete coverage of requirements, architectural decisions made implicitly rather than explicitly, no record of why alternatives were rejected, and no mechanism to catch degradation early before it propagates downstream. A single flawed assumption in a design document becomes dozens of flawed implementations.

The autonomous-dev plugin needs a document pipeline that enforces structured progression from product requirements through technical design, planning, specification, and finally code. Each transition must pass through a review gate where AI reviewer agents evaluate the work against explicit rubrics, catching problems before they cascade. The pipeline must also maintain full traceability so that every line of code can be traced back to the requirement that motivated it, and every requirement can be verified against the code that implements it.

---

## 2. Goals

1. **Structured progression**: Enforce a mandatory cascade (PRD --> TDD --> Plan --> Spec --> Code) where each phase produces well-defined documents from explicit templates.
2. **Quality enforcement**: Implement review gates at every phase transition where AI reviewer panels score documents against rubrics, blocking advancement until quality thresholds are met.
3. **Decomposition with integrity**: Support 1:N decomposition at each phase (one PRD produces multiple TDDs, one TDD produces multiple Plans, etc.) while maintaining collective coverage of the parent document.
4. **Full traceability**: Maintain bidirectional traceability from requirements to code and back, with automatic gap detection when requirements lack downstream implementation.
5. **Backward cascade**: Allow downstream review findings to propagate corrections back upstream when a child review reveals a defect in the parent document.
6. **Version integrity**: Track document revisions with diffs, enable rollback, and attach review feedback to specific versions.
7. **Human escalation**: Provide clear escalation paths when AI review loops exhaust their iteration budget without convergence.

## 3. Non-Goals

1. **Human authoring tools**: This PRD does not cover UIs or editors for humans to write documents manually. Documents are authored by AI agents.
2. **Real-time collaboration**: Multiple agents may write sibling documents in parallel, but co-editing a single document simultaneously is out of scope.
3. **External review systems**: Integration with external review platforms (GitHub PR reviews, Confluence, etc.) is out of scope for this PRD.
4. **Agent orchestration**: How agents are assigned, scheduled, and parallelized is covered by a separate orchestration PRD. This PRD defines the pipeline structure and gate mechanics that the orchestrator consumes.
5. **Natural language understanding of requirements**: This PRD assumes incoming product requests have already been parsed into a structured PRD. Intake and parsing are separate concerns.
6. **Code deployment**: The pipeline ends at production-ready code with tests. Deployment is a separate concern.

---

## 4. User Stories

### Normal Flow

**US-001**: As an autonomous-dev orchestrator, I want to generate a PRD from a product request using a structured template so that all required sections (problem, goals, user stories, requirements, success metrics, risks) are present before any downstream work begins.

**US-002**: As an autonomous-dev orchestrator, I want to submit a completed PRD to a review gate so that a panel of AI reviewers scores it against a defined rubric and either approves it or returns actionable feedback.

**US-003**: As an autonomous-dev orchestrator, I want an approved PRD to automatically decompose into one or more TDDs so that each bounded domain or subsystem gets its own technical design document with a traceable link to the parent PRD.

**US-004**: As an autonomous-dev orchestrator, I want each TDD to pass through its own review gate with architecture-specific rubric criteria (trade-off analysis, API contract completeness, data model integrity) before it can decompose into Plans.

**US-005**: As an autonomous-dev orchestrator, I want approved Plans to decompose into concrete Specs, each specifying exact file paths, acceptance criteria, and code patterns, so that the code-generation phase has unambiguous instructions.

**US-006**: As an autonomous-dev orchestrator, I want the code phase to produce implementation files, test files, and inline documentation that satisfy every acceptance criterion in the parent Spec.

**US-007**: As a human operator, I want to inspect the full traceability matrix at any time so that I can verify every PRD requirement has a chain through TDD, Plan, Spec, and Code.

### Revision Loops

**US-008**: As an AI reviewer agent, I want to return structured feedback with per-section scores and specific change requests so that the authoring agent knows exactly what to fix without re-reading the entire rubric.

**US-009**: As an autonomous-dev orchestrator, I want the pipeline to automatically resubmit a revised document to the same review gate so that the revision is evaluated against the same rubric and the original feedback.

**US-010**: As an autonomous-dev orchestrator, I want the pipeline to escalate to a human operator when a document fails review after the maximum number of iterations (default 3) so that the pipeline does not loop indefinitely.

**US-011**: As a human operator, I want to see the full revision history (all versions, all review feedback, all diffs) when a document is escalated to me so that I can make an informed decision without re-reviewing from scratch.

### Decomposition Edge Cases

**US-012**: As an autonomous-dev orchestrator, I want decomposition to enforce maximum child limits (configurable, default 10 per parent) so that a single document does not explode into an unmanageable number of children.

**US-013**: As an autonomous-dev orchestrator, I want a "smoke test" to run after decomposition that validates the set of child documents collectively covers all requirements of the parent, with no gaps and no contradictions.

**US-014**: As an autonomous-dev orchestrator, I want the decomposition engine to detect dependencies between sibling documents and produce a dependency graph that determines which can execute in parallel and which must be sequential.

**US-015**: As an autonomous-dev orchestrator, I want the pipeline to enforce a maximum tree depth (configurable, default 4 levels: PRD --> TDD --> Plan --> Spec) so that decomposition does not recurse beyond the defined phases.

### Backward Cascades

**US-016**: As an AI reviewer agent reviewing a TDD, I want to flag findings that indicate a defect in the parent PRD (e.g., contradictory requirements, missing domain) so that the pipeline can pause downstream work and trigger a PRD revision.

**US-017**: As an autonomous-dev orchestrator, I want backward cascade events to pause all in-flight children of the affected parent so that no further work is done against a document that is being revised.

**US-018**: As an autonomous-dev orchestrator, I want a backward cascade revision to the parent to trigger re-evaluation of all previously approved children so that stale approvals do not persist after the parent changes.

### Versioning & Rollback

**US-019**: As an autonomous-dev orchestrator, I want every document revision to produce a new version (v1.0, v1.1, v1.2) with a stored diff from the previous version so that the evolution of the document is fully auditable.

**US-020**: As an autonomous-dev orchestrator, I want the review gate to compare the current version's scores against the previous version's scores and automatically roll back if the revision degraded overall quality.

### Pipeline Control

**US-021**: As a human operator, I want to pause the pipeline at any gate so that I can intervene, inspect state, or redirect priorities without losing progress.

**US-022**: As a human operator, I want to cancel a pipeline run and have all in-progress documents marked as cancelled with their partial state preserved for forensics.

**US-023**: As a human operator, I want to change the priority of an in-flight pipeline so that urgent work can be elevated and lower-priority work can be deprioritized or suspended.

---

## 5. Functional Requirements

### 5.1 Document Types & Templates

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-001 | P0 | The system SHALL define five document types in the pipeline: PRD, TDD, Plan, Spec, and Code. |
| FR-002 | P0 | Each document type SHALL have a structured template with required sections as defined in Section 5.1.1 through 5.1.5. |
| FR-003 | P0 | Every document SHALL include YAML frontmatter containing: `id` (unique tracking ID), `parent_id` (parent document ID or null for root PRDs), `type` (PRD/TDD/Plan/Spec/Code), `status` (draft/in-review/approved/revision-requested/rejected/cancelled), `version` (semver), `author_agent` (ID of the authoring agent), `created_at`, `updated_at`. |
| FR-004 | P0 | Each document type SHALL have a quality rubric defining scored categories, category weights, and minimum per-category thresholds. |
| FR-005 | P1 | Templates SHALL be configurable: operators can add optional sections, modify section descriptions, and adjust rubric weights without changing plugin code. |
| FR-006 | P1 | The system SHALL validate that all required sections are present and non-empty before a document can be submitted to a review gate. |

#### 5.1.1 PRD Template

| Section | Required | Description |
|---------|----------|-------------|
| Problem Statement | Yes | Clear articulation of the problem being solved, who is affected, and the current state. |
| Goals | Yes | Numbered list of measurable goals this PRD aims to achieve. |
| Non-Goals | Yes | Explicit boundaries on what this PRD does not cover. |
| User Stories | Yes | Minimum 5 user stories in "As a [role], I want [action] so that [outcome]" format. |
| Functional Requirements | Yes | Numbered requirements with priority (P0/P1/P2) and testable acceptance criteria. |
| Non-Functional Requirements | Yes | Performance, security, reliability, and operability requirements. |
| Success Metrics | Yes | Quantitative metrics with targets and measurement methodology. |
| Risks & Mitigations | Yes | Identified risks with likelihood, impact, and mitigation strategies. |
| Open Questions | No | Unresolved decisions that need input before downstream work. |

**Quality Rubric Categories**: Problem Clarity (15%), Goals Measurability (15%), User Story Coverage (15%), Requirements Completeness (20%), Requirements Testability (15%), Risk Identification (10%), Internal Consistency (10%).

#### 5.1.2 TDD Template

| Section | Required | Description |
|---------|----------|-------------|
| Overview | Yes | Summary of the technical domain this TDD covers, with reference to parent PRD sections. |
| Architecture | Yes | Component diagram, interaction patterns, and architectural style decisions. |
| Trade-off Analysis | Yes | Alternatives considered, evaluation criteria, and rationale for chosen approach. |
| Data Models | Yes | Entity definitions, relationships, constraints, and migration strategy. |
| API Contracts | Yes | Endpoint definitions, request/response schemas, error codes, and versioning strategy. |
| Integration Points | Yes | External systems, protocols, authentication, failure modes, and circuit breaker strategies. |
| Security Considerations | Yes | Threat model, authentication/authorization design, data protection measures. |
| Observability | No | Logging strategy, metrics, tracing, and alerting design. |
| Open Questions | No | Technical uncertainties requiring spike or prototype. |

**Quality Rubric Categories**: Architecture Soundness (20%), Trade-off Rigor (15%), Data Model Integrity (15%), API Contract Completeness (15%), Integration Robustness (10%), Security Depth (10%), PRD Alignment (15%).

#### 5.1.3 Plan Template

| Section | Required | Description |
|---------|----------|-------------|
| Overview | Yes | Scope of this implementation plan, with reference to parent TDD sections. |
| Work Units | Yes | Time-boxed units of work, each with estimated effort, required skills, and deliverables. |
| Dependency Graph | Yes | DAG of work units showing blocking relationships and critical path. |
| Agent Assignments | Yes | Which agent type (or specific agent) is assigned to each work unit. |
| Test Strategy | Yes | Unit, integration, and end-to-end test approach for this plan's deliverables. |
| Risk & Contingency | Yes | Implementation risks specific to this plan and fallback strategies. |
| Parallel Execution Strategy | No | Which work units can run concurrently and resource requirements for parallelism. |

**Quality Rubric Categories**: Work Unit Granularity (20%), Dependency Accuracy (20%), Test Strategy Coverage (15%), Effort Estimation Reasonableness (15%), TDD Alignment (15%), Risk Awareness (15%).

#### 5.1.4 Spec Template

| Section | Required | Description |
|---------|----------|-------------|
| Overview | Yes | Concrete task description with reference to parent Plan work unit. |
| File Manifest | Yes | Exact file paths to create or modify, with rationale for each. |
| Acceptance Criteria | Yes | Numbered, testable criteria that define "done" for this spec. |
| Code Patterns | Yes | Required patterns, conventions, and anti-patterns to follow/avoid. |
| Test Cases | Yes | Specific test cases with inputs, expected outputs, and edge cases. |
| Dependencies | Yes | Other specs this depends on and the interfaces it expects from them. |

**Quality Rubric Categories**: Acceptance Criteria Precision (25%), File Path Accuracy (15%), Test Case Coverage (20%), Code Pattern Clarity (15%), Plan Alignment (15%), Dependency Completeness (10%).

#### 5.1.5 Code Deliverable Structure

| Component | Required | Description |
|-----------|----------|-------------|
| Implementation Files | Yes | Production code implementing the spec. |
| Test Files | Yes | Unit tests achieving minimum coverage threshold (configurable, default 80%). |
| Inline Documentation | Yes | Docstrings/comments for all public APIs and complex logic. |
| Changelog Entry | No | Summary of changes for release notes. |

**Quality Rubric Categories**: Spec Compliance (25%), Test Coverage (20%), Code Quality (15%), Documentation Completeness (10%), Performance (10%), Security (10%), Maintainability (10%).

---

### 5.2 Review Gate Mechanics

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-010 | P0 | Each phase transition SHALL require passage through a review gate before the document can advance to the next phase or trigger decomposition. |
| FR-011 | P0 | Each review gate SHALL assemble a review panel of 1 to 3 AI reviewer agents. The panel size SHALL be configurable per document type (default: 2 for PRD and TDD, 1 for Plan and Spec, 2 for Code). |
| FR-012 | P0 | Each reviewer SHALL independently score the document against the rubric defined for that document type. Scores SHALL be integers from 0 to 100 per rubric category. |
| FR-013 | P0 | The gate SHALL compute a weighted aggregate score from all reviewers. The aggregation method SHALL be configurable: `mean` (default), `median`, or `min`. |
| FR-014 | P0 | The approval threshold SHALL be configurable per document type (default: 85%). A document passes the gate if and only if its aggregate score meets or exceeds the threshold AND no critical findings exist. |
| FR-015 | P0 | Reviewers SHALL classify findings by severity: `critical` (auto-fail regardless of score), `major` (score penalty >= 10 points), `minor` (score penalty >= 3 points), `suggestion` (no score impact). |
| FR-016 | P0 | A review gate SHALL produce one of three outcomes: `approved` (passes gate), `changes_requested` (returns to author with specific feedback), `rejected` (escalates to human with rationale). |
| FR-017 | P0 | The maximum number of review iterations per gate SHALL be configurable (default: 3). When the maximum is reached without approval, the gate SHALL escalate to a human operator. |
| FR-018 | P1 | Review feedback SHALL be structured: each finding SHALL reference the specific document section, rubric category, severity, a description of the issue, and a suggested resolution. |
| FR-019 | P1 | The system SHALL support both per-section scoring and document-level scoring. Per-section scoring SHALL be the default, as it provides more actionable feedback. Document-level scoring SHALL be available as a fallback when per-section granularity is not meaningful. |
| FR-020 | P1 | When a review panel has multiple reviewers, the system SHALL detect and flag inter-reviewer disagreements (score variance > 15 points on any category) and include the disagreement in the review summary. |
| FR-021 | P2 | The system SHALL track reviewer calibration over time: how often each reviewer's scores align with final outcomes (approved documents that succeed downstream vs. those that cause problems). |

---

### 5.3 Decomposition Rules

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-030 | P0 | Upon approval at a review gate, the system SHALL invoke the decomposition engine for that document type to produce child documents of the next type in the pipeline. |
| FR-031 | P0 | PRD decomposition SHALL use domain decomposition: identify bounded domains, subsystems, or feature areas and produce one TDD per domain. The decomposition agent SHALL explain its domain boundaries. |
| FR-032 | P0 | TDD decomposition SHALL use implementation phasing: identify sequential or parallel implementation phases and produce one Plan per phase. |
| FR-033 | P0 | Plan decomposition SHALL use task decomposition: break work units into concrete, independently executable tasks and produce one Spec per task. |
| FR-034 | P0 | Each decomposition SHALL produce a dependency graph among sibling children, annotating each edge with the nature of the dependency (data dependency, interface dependency, ordering constraint). |
| FR-035 | P0 | Each decomposition SHALL mark children as `parallel` (can execute concurrently) or `sequential` (must wait for dependencies) based on the dependency graph. |
| FR-036 | P0 | Maximum children per decomposition SHALL be configurable (default: 10). If the decomposition engine determines more children are needed, it SHALL split the parent into sub-groups and decompose iteratively. |
| FR-037 | P0 | Maximum pipeline depth SHALL be enforced (default: 4 levels). The system SHALL reject any attempt to decompose beyond the defined phases. |
| FR-038 | P1 | After decomposition, the system SHALL run a coverage smoke test that validates: (a) every requirement/section of the parent is addressed by at least one child, (b) no child introduces scope not present in the parent, (c) no two children contradict each other. |
| FR-039 | P1 | The smoke test SHALL produce a coverage matrix mapping parent sections to child documents, flagging gaps (parent sections with no child coverage) and overlaps (parent sections covered by multiple children, which may indicate redundancy or conflict). |
| FR-040 | P1 | If the smoke test fails, the decomposition SHALL be rejected and the decomposition agent SHALL revise before the children enter their review gates. |
| FR-041 | P2 | The system SHALL detect "decomposition explosion" (when recursive decomposition across phases would produce more than a configurable total node count, default 100) and alert the human operator before proceeding. |

---

### 5.4 Document Versioning

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-050 | P0 | Every document revision SHALL increment the version number following a `major.minor` scheme: minor increments for review-driven revisions (v1.0 --> v1.1), major increments for backward-cascade revisions that change the document's scope (v1.3 --> v2.0). |
| FR-051 | P0 | The system SHALL store the full content of every version, not just diffs, to enable independent retrieval of any version. |
| FR-052 | P0 | The system SHALL compute and store a structured diff between consecutive versions, identifying added, removed, and modified sections. |
| FR-053 | P1 | Review feedback SHALL be attached to the specific version it was generated against. When viewing a version, its associated review feedback SHALL be retrievable. |
| FR-054 | P1 | If a revision's aggregate review score is lower than the previous version's score by more than a configurable margin (default: 5 points), the system SHALL flag this as a "quality regression" and offer rollback to the previous version. |
| FR-055 | P1 | Rollback SHALL create a new version (not revert the version counter) that restores the content of the target version, preserving full audit history. |
| FR-056 | P2 | The system SHALL support version comparison: given any two versions of a document, produce a side-by-side diff with review score comparison. |

---

### 5.5 Cross-Document Traceability

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-060 | P0 | Every document SHALL contain a `traces_from` field in its frontmatter listing the specific parent sections it addresses (e.g., `traces_from: ["PRD-001#FR-003", "PRD-001#FR-007"]`). |
| FR-061 | P0 | The system SHALL maintain a traceability matrix that maps every requirement in every PRD to its chain of downstream documents: PRD requirement --> TDD section(s) --> Plan work unit(s) --> Spec item(s) --> Code location(s). |
| FR-062 | P0 | The system SHALL run gap detection on the traceability matrix at each phase transition, identifying requirements that have no downstream implementation at the current phase. |
| FR-063 | P0 | Gap detection findings SHALL be treated as `critical` findings in the review gate, blocking approval until gaps are resolved. |
| FR-064 | P1 | Code traceability SHALL reference specific file paths and line ranges (e.g., `src/pipeline/gate.ts:45-92`). These references SHALL be validated to confirm the referenced code exists. |
| FR-065 | P1 | The system SHALL detect "orphan" documents: children whose traced parent sections have been removed or substantially modified by a backward cascade, rendering the child potentially invalid. |
| FR-066 | P2 | The system SHALL support impact analysis: given a proposed change to any document, compute the set of downstream documents that would be affected. |

---

### 5.6 Backward Cascade

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-070 | P0 | Reviewers at any gate SHALL be able to classify a finding as `upstream_defect`, indicating the issue originates in a parent or ancestor document rather than the document under review. |
| FR-071 | P0 | When an `upstream_defect` is confirmed, the system SHALL initiate a backward cascade: pause all in-flight children of the affected ancestor, re-open the ancestor for revision, and mark all previously approved children as `stale`. |
| FR-072 | P0 | After a backward cascade revision is approved, all `stale` children SHALL be re-evaluated. Re-evaluation SHALL determine whether the child needs revision (if the parent changes affect it) or can be re-approved (if the parent changes are in unrelated sections). |
| FR-073 | P1 | The backward cascade SHALL be scoped: only the specific sections of the parent identified as defective trigger re-evaluation of children that trace to those sections. Children tracing to unaffected sections remain valid. |
| FR-074 | P1 | Backward cascades SHALL have a maximum depth (configurable, default: 2 levels up). A cascade that would propagate further SHALL escalate to a human operator. |
| FR-075 | P2 | The system SHALL track backward cascade frequency per document and per author agent as a quality signal. High backward cascade rates indicate systematic issues in upstream authoring. |

---

### 5.7 Pipeline Flow Control

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-080 | P0 | The pipeline SHALL enforce linear phase progression: no phase may be skipped. A document cannot enter the Code phase without an approved Spec, which requires an approved Plan, which requires an approved TDD, which requires an approved PRD. |
| FR-081 | P0 | Sibling documents at the same phase SHALL execute in parallel where the dependency graph permits. |
| FR-082 | P0 | The pipeline SHALL support pause at any gate. Pausing freezes all in-flight work for that pipeline run. The state SHALL be fully serializable and resumable. |
| FR-083 | P0 | The pipeline SHALL support cancellation. Cancelled pipelines SHALL mark all in-progress documents as `cancelled` and preserve their current state for forensic review. |
| FR-084 | P1 | The pipeline SHALL support priority changes. Priority levels SHALL be: `critical`, `high`, `normal` (default), `low`. Changing priority SHALL affect agent scheduling order but not pipeline structure. |
| FR-085 | P1 | The pipeline SHALL emit structured events at every state transition (document created, review started, review completed, approved, rejected, decomposition started, decomposition completed, backward cascade triggered, paused, resumed, cancelled) for observability. |
| FR-086 | P2 | The pipeline SHALL support partial cancellation: cancel a subtree of the pipeline (e.g., cancel one TDD and its descendants) without affecting sibling subtrees. |

---

## 6. Non-Functional Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| NFR-001 | P0 | **Deterministic reproducibility**: Given the same document and the same reviewer agent configuration, a review gate SHALL produce consistent scores (within a tolerance of +/- 5 points) across repeated evaluations. |
| NFR-002 | P0 | **Auditability**: Every state transition, review decision, score, finding, decomposition, and version change SHALL be recorded in an append-only audit log with timestamps and actor IDs. |
| NFR-003 | P0 | **Fault tolerance**: If an agent crashes mid-review or mid-authoring, the pipeline SHALL detect the failure, preserve the last consistent state, and allow retry or reassignment without data loss. |
| NFR-004 | P1 | **Pipeline throughput**: The system SHALL support at least 5 concurrent pipeline runs without degradation. Each pipeline run may have up to 50 active documents across all phases. |
| NFR-005 | P1 | **Review latency**: A single review gate (excluding author revision time) SHALL complete within 120 seconds for documents under 5,000 words. |
| NFR-006 | P1 | **Storage efficiency**: Document versions SHALL be stored with content-addressable deduplication. Unchanged sections across versions SHALL not be duplicated. |
| NFR-007 | P1 | **Configurability**: All numeric thresholds (approval score, max iterations, max children, max depth, regression margin, explosion limit) SHALL be configurable via a single configuration file with sensible defaults. |
| NFR-008 | P2 | **Observability**: The system SHALL expose metrics for: documents per phase, review pass rate per gate, average review iterations to approval, backward cascade frequency, and pipeline completion rate. |

---

## 7. Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Review gate pass rate (first attempt) | >= 60% | Documents approved on first review / total documents submitted |
| Review gate pass rate (within 3 attempts) | >= 95% | Documents approved within max iterations / total documents submitted |
| Human escalation rate | <= 5% | Documents escalated to human / total documents submitted |
| Traceability coverage | 100% | PRD requirements with complete trace chains to code / total PRD requirements |
| Traceability gap detection accuracy | >= 95% | Gaps correctly identified / (correctly identified + missed gaps) |
| Backward cascade rate | <= 10% | Documents triggering backward cascades / total approved documents |
| Decomposition smoke test pass rate | >= 85% | Decompositions passing smoke test on first attempt / total decompositions |
| Pipeline completion rate | >= 90% | Pipelines reaching Code phase / total pipelines started (excluding intentional cancellations) |
| Mean pipeline duration (PRD to Code) | Baseline + trend | Wall-clock time from PRD creation to final code approval, tracked over time |
| Quality regression rollback rate | <= 5% | Revisions triggering quality regression rollback / total revisions |

---

## 8. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Compound quality degradation**: Small quality issues at each phase compound into significant defects in final code, but no single review gate catches the accumulated drift. | Medium | High | Implement cross-phase quality checks at Plan and Code gates that re-validate alignment with the original PRD, not just the immediate parent. Add a "PRD alignment" rubric category at every gate. |
| R2 | **Decomposition explosion**: A complex PRD decomposes into many TDDs, each producing many Plans, resulting in hundreds of Specs and an unmanageable pipeline. | Medium | High | Enforce configurable limits at each level (default 10 children per parent, 100 total nodes per pipeline). Require human approval for decompositions exceeding 75% of the limit. Implement iterative sub-grouping for large decompositions. |
| R3 | **Review loop stagnation**: Author and reviewer agents enter a cycle where revisions fix one issue but introduce another, never converging. | Medium | Medium | Track per-finding resolution across iterations. If the same finding recurs after being marked resolved, escalate immediately. Require that each iteration reduces total finding count. |
| R4 | **Backward cascade storm**: A foundational PRD defect discovered late causes cascading re-evaluation of dozens of downstream documents, effectively restarting the pipeline. | Low | High | Scope backward cascades to affected sections only (FR-073). Limit cascade depth (FR-074). Invest in PRD review quality to catch foundational issues early. Track cascade cost metrics to justify upstream quality investment. |
| R5 | **Reviewer bias or blind spots**: AI reviewer agents consistently miss certain categories of defects, creating a false sense of quality. | Medium | High | Rotate reviewer agents across gates. Track per-reviewer miss rates by comparing review findings with downstream failures. Periodically inject known-defective documents to calibrate reviewers. |
| R6 | **Template rigidity**: Overly rigid templates constrain agents from expressing domain-specific concerns that do not fit neatly into predefined sections. | Medium | Medium | Allow optional custom sections in every template. Provide a "Notes & Considerations" catch-all section. Allow operators to customize templates per project (FR-005). |
| R7 | **Traceability overhead**: Maintaining bidirectional traceability across hundreds of documents creates significant bookkeeping overhead that slows the pipeline. | Medium | Medium | Automate traceability matrix maintenance. Compute traceability lazily (on-demand rather than eagerly). Optimize storage with indexed lookups rather than full-matrix scans. |
| R8 | **Inconsistent scoring across reviewer agents**: Different reviewers interpret rubric categories differently, leading to unpredictable gate outcomes. | Medium | Medium | Publish rubric interpretation guides with examples for each score range. Detect and flag inter-reviewer disagreements (FR-020). Track calibration metrics (FR-021). |

---

## 9. Phasing

### Phase 1: MVP

**Goal**: End-to-end pipeline with basic gates and decomposition.

| Capability | Requirements |
|------------|--------------|
| Document templates for all 5 types | FR-001, FR-002, FR-003 |
| Basic rubrics (document-level scoring) | FR-004 |
| Review gates with single reviewer | FR-010, FR-012 through FR-017 |
| Linear decomposition (1:N at each phase) | FR-030 through FR-035, FR-037 |
| Basic versioning (version numbers, full content storage) | FR-050, FR-051 |
| Basic traceability (forward only) | FR-060, FR-061 |
| Pipeline enforcement (no skipping, pause, cancel) | FR-080, FR-082, FR-083 |
| Audit logging | NFR-002 |
| Fault tolerance (crash recovery) | NFR-003 |

### Phase 2: Quality & Intelligence

**Goal**: Richer review mechanics, backward cascades, and advanced traceability.

| Capability | Requirements |
|------------|--------------|
| Multi-reviewer panels | FR-011, FR-013, FR-020 |
| Per-section scoring | FR-019 |
| Structured review feedback | FR-018 |
| Decomposition smoke tests | FR-038, FR-039, FR-040 |
| Backward cascade | FR-070 through FR-074 |
| Gap detection | FR-062, FR-063 |
| Diff tracking and quality regression detection | FR-052, FR-054, FR-055 |
| Pipeline events | FR-085 |
| Parallel sibling execution | FR-081 |

### Phase 3: Optimization & Observability

**Goal**: Tuning, analytics, and advanced pipeline control.

| Capability | Requirements |
|------------|--------------|
| Configurable templates | FR-005 |
| Template validation | FR-006 |
| Reviewer calibration tracking | FR-021 |
| Decomposition explosion detection | FR-041 |
| Orphan detection | FR-065 |
| Impact analysis | FR-066 |
| Backward cascade analytics | FR-075 |
| Priority changes | FR-084 |
| Partial cancellation | FR-086 |
| Version comparison | FR-056 |
| Code traceability validation | FR-064 |
| Full observability metrics | NFR-008 |

---

## 10. Open Questions

| # | Question | Context | Owner | Target Date |
|---|----------|---------|-------|-------------|
| OQ-1 | Should the review panel composition be static per gate type or dynamically selected based on document content (e.g., a TDD heavy on data modeling gets a data-specialist reviewer)? | Dynamic selection increases review quality but adds complexity to reviewer assignment. | Engineering | TBD |
| OQ-2 | What is the right default approval threshold? 85% is the current proposal, but should PRD gates have a higher threshold than Spec gates (since PRD errors are more expensive)? | Asymmetric thresholds could reduce backward cascades but may create bottlenecks at early gates. | Product | TBD |
| OQ-3 | Should decomposition children inherit their parent's review panel, or should each child get a fresh panel? | Inherited panels have context but may develop blind spots. Fresh panels catch different issues but lack parent context. | Engineering | TBD |
| OQ-4 | How should the system handle conflicting findings from multiple reviewers on the same panel? Currently FR-020 flags disagreements, but who resolves them? | Options: majority vote, highest-severity wins, escalate all disagreements, or meta-reviewer agent. | Product | TBD |
| OQ-5 | What is the right granularity for traceability? Tracing to individual requirements is expensive; tracing to sections is cheaper but less precise. | The current design traces to individual requirements (FR-060). Need to validate this is feasible at scale. | Engineering | TBD |
| OQ-6 | Should the backward cascade be automatic or require human confirmation before pausing downstream work? | Automatic is faster but risks unnecessary disruption if the upstream defect is minor. | Product | TBD |
| OQ-7 | How do we handle documents that straddle domain boundaries during PRD-to-TDD decomposition? | A feature that touches both the API layer and the data layer might need to be in both TDDs, creating duplication and potential inconsistency. | Engineering | TBD |
| OQ-8 | What storage backend should back the document versioning system? Options include git (natural versioning, diff support), a document database, or a dedicated artifact store. | Git aligns with code workflows but may not scale well for hundreds of documents per pipeline. | Engineering | TBD |
| OQ-9 | Should the smoke test after decomposition be a lightweight heuristic check or a full AI-agent review? | Full review is thorough but doubles the review cost at every decomposition boundary. | Product | TBD |
| OQ-10 | How should the pipeline handle external dependencies (e.g., a Spec that depends on an API provided by a different team or system outside this pipeline)? | Currently the pipeline assumes all work is self-contained. External dependencies need a different tracking mechanism. | Product | TBD |

---

## Appendix A: Document Lifecycle State Machine

```
                          ┌─────────────┐
                          │   created   │
                          └──────┬──────┘
                                 │
                                 v
                          ┌─────────────┐
                     ┌────│   drafting   │
                     │    └──────┬──────┘
                     │           │ (author submits)
                     │           v
                     │    ┌─────────────┐
                     │    │  in_review   │◄──────────────┐
                     │    └──────┬──────┘               │
                     │           │                      │
                     │     ┌─────┴──────┐               │
                     │     │            │               │
                     │     v            v               │
                     │  ┌────────┐  ┌──────────────┐    │
                     │  │approved│  │changes_needed │────┘
                     │  └───┬────┘  └──────────────┘  (author revises
                     │      │        (iteration < max)  & resubmits)
                     │      │
                     │      │       ┌──────────────┐
                     │      │       │  rejected    │
                     │      │       │ (escalated)  │
                     │      │       └──────────────┘
                     │      │        (iteration >= max
                     │      │         or critical+reject)
                     │      v
                     │  ┌─────────────┐
                     │  │decomposing  │
                     │  └──────┬──────┘
                     │         │
                     │         v
                     │  ┌─────────────┐
                     │  │  completed  │
                     │  └─────────────┘
                     │
                     │  ┌─────────────┐
                     └──│  cancelled  │  (can occur from any state)
                        └─────────────┘

                     ┌─────────────┐
                     │    stale     │  (backward cascade marks
                     └─────────────┘   approved children stale)
```

## Appendix B: Decomposition Tree Example

```
PRD-042 (Product: Notification System)
├── TDD-042-001 (Domain: Delivery Engine)
│   ├── PLAN-042-001-001 (Phase: Core SMTP + Push)
│   │   ├── SPEC-042-001-001-001 (Task: SMTP adapter)
│   │   ├── SPEC-042-001-001-002 (Task: Push notification adapter)
│   │   └── SPEC-042-001-001-003 (Task: Delivery retry logic)
│   └── PLAN-042-001-002 (Phase: Rate limiting + batching)
│       ├── SPEC-042-001-002-001 (Task: Rate limiter)
│       └── SPEC-042-001-002-002 (Task: Batch aggregator)
├── TDD-042-002 (Domain: Template Engine)
│   └── PLAN-042-002-001 (Phase: Template CRUD + rendering)
│       ├── SPEC-042-002-001-001 (Task: Template storage)
│       ├── SPEC-042-002-001-002 (Task: Variable substitution engine)
│       └── SPEC-042-002-001-003 (Task: Template preview API)
└── TDD-042-003 (Domain: Preference Management)
    └── PLAN-042-003-001 (Phase: User preference CRUD)
        ├── SPEC-042-003-001-001 (Task: Preference data model)
        └── SPEC-042-003-001-002 (Task: Preference API endpoints)

Total nodes: 15 (within default limit of 100)
Max depth: 4 (PRD → TDD → Plan → Spec)
Max breadth: 3 (TDDs under PRD-042)
```

## Appendix C: Traceability Matrix Example (Partial)

| PRD Requirement | TDD Section | Plan Work Unit | Spec Item | Code Location |
|-----------------|-------------|----------------|-----------|---------------|
| FR-003 (Email delivery) | TDD-042-001 Section 4.2 | PLAN-042-001-001 WU-1 | SPEC-042-001-001-001 AC-1 | `src/delivery/smtp.ts:12-89` |
| FR-003 (Email delivery) | TDD-042-001 Section 4.2 | PLAN-042-001-001 WU-3 | SPEC-042-001-001-003 AC-2 | `src/delivery/retry.ts:5-45` |
| FR-007 (User opt-out) | TDD-042-003 Section 3.1 | PLAN-042-003-001 WU-1 | SPEC-042-003-001-002 AC-3 | `src/preferences/api.ts:102-130` |
| FR-012 (Template variables) | TDD-042-002 Section 5.1 | PLAN-042-002-001 WU-2 | SPEC-042-002-001-002 AC-1 | `src/templates/engine.ts:34-78` |
| FR-015 (Rate limiting) | TDD-042-001 Section 6.3 | PLAN-042-001-002 WU-1 | SPEC-042-001-002-001 AC-1 | `src/delivery/ratelimit.ts:8-56` |

## Appendix D: Configuration Defaults

```yaml
pipeline:
  phases:
    - PRD
    - TDD
    - Plan
    - Spec
    - Code

review_gates:
  default_threshold: 85
  thresholds_by_type:
    PRD: 85
    TDD: 85
    Plan: 80
    Spec: 80
    Code: 85
  max_iterations: 3
  panel_size:
    PRD: 2
    TDD: 2
    Plan: 1
    Spec: 1
    Code: 2
  score_aggregation: mean  # mean | median | min
  disagreement_threshold: 15  # score variance triggering flag

decomposition:
  max_children_per_parent: 10
  max_pipeline_depth: 4
  max_total_nodes: 100
  explosion_alert_threshold: 75  # percentage of max_total_nodes

versioning:
  quality_regression_margin: 5  # points below previous version triggers warning

backward_cascade:
  max_depth: 2
  require_human_confirmation: false

traceability:
  gap_detection_severity: critical
  validate_code_references: true

pipeline_control:
  default_priority: normal  # critical | high | normal | low
  max_concurrent_pipelines: 5
```

---

*End of PRD-002*
