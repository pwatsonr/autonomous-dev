# TDD-003: Document Pipeline Architecture

| Field          | Value                                      |
|----------------|--------------------------------------------|
| **Title**      | Document Pipeline Architecture             |
| **TDD ID**     | TDD-003                                    |
| **Version**    | 0.1.0                                      |
| **Date**       | 2026-04-08                                 |
| **Status**     | Draft                                      |
| **Author**     | Patrick Watson                             |
| **Parent PRD** | PRD-002 (Document Pipeline & Review Gates) |
| **Plugin**     | autonomous-dev                             |

---

## 1. Overview

This Technical Design Document defines the architecture for the autonomous-dev document pipeline: the system that enforces structured progression from product requirements through technical design, planning, specification, and code. The pipeline is the backbone of autonomous development. Every artifact the system produces flows through it, and every quality check is enforced by it.

The pipeline manages five document types (PRD, TDD, Plan, Spec, Code), each with structured templates, YAML frontmatter for tracking, and quality rubrics. Documents advance through review gates, decompose into children, maintain bidirectional traceability, and support backward cascades when downstream review reveals upstream defects.

This TDD covers nine core subsystems:

1. **Document Type Registry** -- type definitions, templates, rubrics
2. **Document Frontmatter Schema** -- tracking metadata for every document
3. **Template Engine** -- rendering, validation, and customization of templates
4. **Document Storage Layer** -- directory layout, naming conventions, persistence
5. **Versioning Engine** -- revision tracking, diffs, rollback
6. **Decomposition Engine** -- parent-to-children splitting with coverage validation
7. **Traceability Matrix** -- cross-document requirement tracing and gap detection
8. **Backward Cascade Controller** -- upstream defect propagation and child invalidation
9. **Pipeline Flow Controller** -- phase progression, pause/resume, cancellation, priority

This TDD does NOT cover: agent orchestration and scheduling (PRD-003/PRD-004), review gate panel assembly and scoring algorithms (separate TDD), or the intake/parsing of raw product requests into initial PRDs (PRD-006).

### 1.1 Key Design Principles

- **File-first persistence**: All documents and metadata are stored as files on disk. No external database required for MVP. The file system IS the database.
- **Idempotent operations**: Every pipeline operation can be retried safely. Crash at any point, restart, arrive at the same state.
- **Append-only audit**: State transitions are logged, never mutated. The audit trail is reconstructable from the file system.
- **Convention over configuration**: Sensible defaults everywhere. Zero config gets you a working pipeline. Configuration overrides are layered.

---

## 2. Architecture

### 2.1 Pipeline Flow Diagram

```
                        +------------------+
                        |  Product Request  |
                        +--------+---------+
                                 |
                                 v
                    +------------+------------+
                    |    PRD Authoring Agent   |
                    +------------+------------+
                                 |
                                 v
                    +------------+------------+
                    |   PRD Review Gate        |
                    |   (rubric: PRD)          |
                    +---+-------+--------+----+
                        |       |        |
                   approved  changes   rejected
                        |   requested     |
                        |       |         v
                        |       +---> Author revises
                        |             (max 3 iterations)
                        |             then escalate
                        v
              +---------+-----------+
              | Decomposition Engine |
              | (PRD -> N x TDD)    |
              +---------+-----------+
                        |
              +---------+-----------+
              | Coverage Smoke Test  |
              +---------+-----------+
                        |
           +------------+------------+
           |            |            |
           v            v            v
     +-----+----+ +----+-----+ +----+-----+
     | TDD-A    | | TDD-B    | | TDD-C    |
     +-----+----+ +----+-----+ +----+-----+
           |            |            |
           v            v            v
     +-----+----+ +----+-----+ +----+-----+
     | TDD      | | TDD      | | TDD      |
     | Review   | | Review   | | Review   |
     | Gate     | | Gate     | | Gate     |
     +-----+----+ +----+-----+ +----+-----+
           |            |            |
           v            v            v
     Decompose    Decompose    Decompose
     (TDD->Plans) (TDD->Plans) (TDD->Plans)
           |            |            |
           v            v            v
       ... Plan review, decompose to Specs ...
           |            |            |
           v            v            v
       ... Spec review, produce Code ...
           |            |            |
           v            v            v
       ... Code review gates ...
```

### 2.2 Component Interaction Diagram

```
+------------------------------------------------------------------+
|                     Pipeline Flow Controller                      |
|  (state machine, pause/resume, cancellation, priority, events)   |
+-----+----------+----------+-----------+----------+--------+------+
      |          |          |           |          |        |
      v          v          v           v          v        v
+----------+ +--------+ +--------+ +---------+ +------+ +-------+
| Document | |Template| |Version | |Decomp.  | |Trace | |Backward|
| Storage  | |Engine  | |Engine  | |Engine   | |Matrix| |Cascade |
| Layer    | |        | |        | |         | |      | |Ctrl.   |
+----+-----+ +---+----+ +---+----+ +----+----+ +--+---+ +---+---+
     |            |          |           |         |         |
     +------------+----------+-----------+---------+---------+
                             |
                    +--------+--------+
                    | Document Type   |
                    | Registry        |
                    | (types, schemas,|
                    |  rubrics)       |
                    +-----------------+
```

### 2.3 Document Lifecycle State Machine

```
                 +-------+
                 | draft |
                 +---+---+
                     |
            submit to gate
                     |
                     v
              +------+-------+
              |  in-review   |<-----------+
              +--+-----+--+-+            |
                 |     |  |              |
            approved   |  rejected       |
                 |     |  |              |
                 |     |  v              |
                 |     | +----------+    |
                 |     | | rejected |    |
                 |     | +----------+    |
                 |     |                 |
                 |  changes_requested    |
                 |     |                 |
                 |     v                 |
                 | +---+------------+    |
                 | | revision-      |    |
                 | | requested      +----+
                 | +----------------+  (resubmit)
                 |
                 v
            +---------+
            | approved|
            +---------+
                 |
           (decompose or
            produce code)
                 |
                 v
            +---------+       +----------+
            |  stale  |<------| backward |
            |         |       | cascade  |
            +---------+       +----------+
                 |
           re-evaluate
                 |
         +-------+-------+
         |               |
    re-approved    needs revision
         |               |
         v               v
    +---------+   +------+-------+
    | approved|   | revision-    |
    |         |   | requested    |
    +---------+   +--------------+

    At ANY state:
         +------------+
         | cancelled  |  (terminal)
         +------------+
```

---

## 3. Detailed Design

### 3.1 Document Type Registry

The Document Type Registry is the single source of truth for what document types exist, their templates, required sections, rubric definitions, and validation rules. It is loaded at pipeline initialization and can be extended via configuration.

#### 3.1.1 Type Definitions

```typescript
enum DocumentType {
  PRD  = "prd",
  TDD  = "tdd",
  PLAN = "plan",
  SPEC = "spec",
  CODE = "code",
}

// The canonical pipeline order. Index = depth in the decomposition tree.
const PIPELINE_ORDER: DocumentType[] = [
  DocumentType.PRD,   // depth 0
  DocumentType.TDD,   // depth 1
  DocumentType.PLAN,  // depth 2
  DocumentType.SPEC,  // depth 3
  DocumentType.CODE,  // depth 4 (terminal -- no further decomposition)
];

interface DocumentTypeDefinition {
  type: DocumentType;
  label: string;                      // Human-readable name
  depth: number;                      // Position in pipeline (0-4)
  childType: DocumentType | null;     // What it decomposes into (null for CODE)
  parentType: DocumentType | null;    // What it decomposes from (null for PRD)
  template: DocumentTemplate;         // Template structure
  rubric: QualityRubric;             // Scoring rubric
  reviewConfig: ReviewGateConfig;     // Default review gate settings
  decompositionStrategy: string;      // "domain" | "phase" | "task" | null
}
```

#### 3.1.2 Rubric Definition Structure

```typescript
interface RubricCategory {
  id: string;                  // e.g., "problem_clarity"
  label: string;               // e.g., "Problem Clarity"
  weight: number;              // 0.0 - 1.0, all weights for a rubric sum to 1.0
  description: string;         // What this category evaluates
  scoringGuide: {              // Score interpretation
    excellent: string;         // 90-100 guidance
    good: string;              // 75-89 guidance
    adequate: string;          // 60-74 guidance
    poor: string;              // 40-59 guidance
    failing: string;           // 0-39 guidance
  };
  minimumScore: number;        // Per-category floor (default: 60)
}

interface QualityRubric {
  documentType: DocumentType;
  categories: RubricCategory[];
  approvalThreshold: number;   // Weighted aggregate minimum (default: 85)
  aggregationMethod: "mean" | "median" | "min";  // How multi-reviewer scores combine
}
```

#### 3.1.3 Review Gate Configuration

```typescript
interface ReviewGateConfig {
  panelSize: number;            // Number of reviewers (default varies by type)
  maxIterations: number;        // Max review cycles before escalation (default: 3)
  approvalThreshold: number;    // Override rubric default if set
  regressionMargin: number;     // Score drop that triggers regression flag (default: 5)
}

// Defaults per document type:
// PRD:  { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }
// TDD:  { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }
// Plan: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }
// Spec: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }
// Code: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }
```

### 3.2 Document Frontmatter Schema

Every document in the pipeline carries YAML frontmatter as its header. This is the primary metadata transport. The frontmatter is machine-parsed by every subsystem and must conform to a strict schema.

#### 3.2.1 Full Frontmatter Schema

```yaml
---
# === Identity ===
id: "TDD-003-001"                    # Unique tracking ID (format: {TYPE}-{PIPELINE_NUM}-{SEQ})
parent_id: "PRD-002"                 # Parent document ID (null for root PRDs)
pipeline_id: "PIPE-2026-0408-001"    # Pipeline run this document belongs to
type: "tdd"                          # Document type: prd | tdd | plan | spec | code

# === Lifecycle ===
status: "draft"                      # draft | in-review | approved | revision-requested |
                                     # rejected | cancelled | stale
version: "1.0"                       # major.minor -- minor for review revisions,
                                     #                major for backward cascade revisions
created_at: "2026-04-08T14:30:00Z"   # ISO 8601 creation timestamp
updated_at: "2026-04-08T15:45:00Z"   # ISO 8601 last modification timestamp

# === Authorship ===
author_agent: "staff-engineer-01"    # ID of the agent that authored this version
reviewer_agents: []                  # IDs of agents that reviewed this version (populated by gate)

# === Traceability ===
traces_from:                         # Parent sections this document addresses
  - "PRD-002#FR-001"
  - "PRD-002#FR-002"
  - "PRD-002#FR-003"
traces_to: []                        # Child document IDs (populated after decomposition)

# === Decomposition ===
depth: 1                             # Pipeline depth (0=PRD, 1=TDD, 2=Plan, 3=Spec, 4=Code)
sibling_index: 0                     # Order among siblings (0-based)
sibling_count: 3                     # Total number of siblings from same decomposition
depends_on: []                       # Sibling IDs this document depends on
dependency_type: []                  # Type of each dependency: "data" | "interface" | "ordering"
execution_mode: "parallel"           # "parallel" | "sequential" (derived from dependency graph)

# === Review ===
review_iteration: 0                  # Current review iteration count
last_review_score: null              # Aggregate score from most recent review (null if unreviewed)
last_review_version: null            # Version string of the most recent reviewed version

# === Pipeline Control ===
priority: "normal"                   # critical | high | normal | low
tags: []                             # Arbitrary tags for filtering and grouping
---
```

#### 3.2.2 Frontmatter Validation Rules

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `id` | string | Yes | Must match pattern `^(PRD\|TDD\|PLAN\|SPEC\|CODE)-\d{3}(-\d{3})?$` |
| `parent_id` | string\|null | Yes | Must be null for PRDs at depth 0; must reference a valid existing document ID otherwise |
| `pipeline_id` | string | Yes | Must match pattern `^PIPE-\d{4}-\d{4}-\d{3}$` |
| `type` | enum | Yes | One of: prd, tdd, plan, spec, code |
| `status` | enum | Yes | One of: draft, in-review, approved, revision-requested, rejected, cancelled, stale |
| `version` | string | Yes | Must match pattern `^\d+\.\d+$` |
| `created_at` | ISO 8601 | Yes | Must be valid UTC timestamp |
| `updated_at` | ISO 8601 | Yes | Must be >= `created_at` |
| `author_agent` | string | Yes | Non-empty agent identifier |
| `reviewer_agents` | string[] | No | Populated by review gate |
| `traces_from` | string[] | Conditional | Required for depth > 0; must reference valid parent sections |
| `traces_to` | string[] | No | Populated after decomposition |
| `depth` | integer | Yes | 0-4, must match `type` per PIPELINE_ORDER |
| `sibling_index` | integer | Yes | 0 to sibling_count-1 |
| `sibling_count` | integer | Yes | >= 1 |
| `depends_on` | string[] | No | Must reference valid sibling IDs |
| `dependency_type` | string[] | No | Length must match `depends_on`; values: data, interface, ordering |
| `execution_mode` | enum | Yes | parallel or sequential |
| `review_iteration` | integer | Yes | >= 0 |
| `last_review_score` | number\|null | No | 0-100 or null |
| `priority` | enum | Yes | critical, high, normal, low |

#### 3.2.3 Document ID Generation

Document IDs follow a deterministic scheme:

```
{TYPE}-{PIPELINE_SEQ}-{DOCUMENT_SEQ}

TYPE          = PRD | TDD | PLAN | SPEC | CODE
PIPELINE_SEQ  = 3-digit zero-padded pipeline sequence number (001, 002, ...)
DOCUMENT_SEQ  = 3-digit zero-padded document sequence within its type (001, 002, ...)
```

Root PRDs omit the DOCUMENT_SEQ since there is exactly one PRD per pipeline:

```
PRD-002         (root PRD for pipeline 002)
TDD-002-001     (first TDD from PRD-002)
TDD-002-002     (second TDD from PRD-002)
PLAN-002-001    (first Plan from TDD-002-001)
PLAN-002-002    (second Plan from TDD-002-001)
PLAN-002-003    (first Plan from TDD-002-002)
SPEC-002-001    (first Spec)
CODE-002-001    (first Code deliverable)
```

The DOCUMENT_SEQ is globally unique within a pipeline for a given type, assigned by an atomic counter. This ensures that two TDDs from different PRDs in different pipelines never collide.

### 3.3 Template Engine

The Template Engine is responsible for rendering document templates, validating that authored documents conform to template structure, and supporting operator customization.

#### 3.3.1 Template Structure

Each template is a Markdown document with YAML frontmatter (pre-filled with defaults) and a series of sections. Sections are marked as required or optional.

```typescript
interface TemplateSection {
  id: string;                   // Machine-readable section ID (e.g., "problem_statement")
  heading: string;              // Markdown heading text (e.g., "## 1. Problem Statement")
  level: number;                // Heading level (2 = ##, 3 = ###)
  required: boolean;            // Whether the section must be non-empty
  description: string;          // Guidance text (removed from final document)
  minWordCount: number;         // Minimum word count for the section (0 = no minimum)
  subsections: TemplateSection[];  // Nested sections
  rubricCategories: string[];   // Which rubric categories evaluate this section
}

interface DocumentTemplate {
  type: DocumentType;
  version: string;              // Template version (for template evolution tracking)
  frontmatterDefaults: Record<string, any>;  // Default frontmatter values
  sections: TemplateSection[];
  customSectionsAllowed: boolean;  // Whether authors can add sections not in the template
}
```

#### 3.3.2 Complete Template: PRD

```markdown
---
id: null
parent_id: null
pipeline_id: null
type: "prd"
status: "draft"
version: "1.0"
created_at: null
updated_at: null
author_agent: null
reviewer_agents: []
traces_from: []
traces_to: []
depth: 0
sibling_index: 0
sibling_count: 1
depends_on: []
dependency_type: []
execution_mode: "parallel"
review_iteration: 0
last_review_score: null
last_review_version: null
priority: "normal"
tags: []
---

# {TITLE}

## 1. Problem Statement

<!-- REQUIRED. Clear articulation of the problem being solved, who is affected,
     and the current state. Must answer: What is broken? Who feels the pain?
     What happens if we do nothing? -->

## 2. Goals

<!-- REQUIRED. Numbered list of measurable goals this PRD aims to achieve.
     Each goal must be specific, measurable, and directly tied to the problem
     statement. Minimum 3 goals. -->

## 3. Non-Goals

<!-- REQUIRED. Explicit boundaries on what this PRD does not cover.
     Prevents scope creep and sets clear expectations for downstream work.
     Minimum 3 non-goals. -->

## 4. User Stories

<!-- REQUIRED. Minimum 5 user stories in "As a [role], I want [action]
     so that [outcome]" format. Must cover normal flows, edge cases,
     and error scenarios. Each story must have a unique ID (US-NNN). -->

## 5. Functional Requirements

<!-- REQUIRED. Numbered requirements with priority (P0/P1/P2) and testable
     acceptance criteria. Requirements must be atomic (one testable statement
     per requirement). Use ID format FR-NNN. -->

## 6. Non-Functional Requirements

<!-- REQUIRED. Performance, security, reliability, and operability
     requirements. Use ID format NFR-NNN. Each must have a measurable
     threshold or acceptance criterion. -->

## 7. Success Metrics

<!-- REQUIRED. Quantitative metrics with targets and measurement methodology.
     Each metric must specify: what is measured, target value, how it is
     measured, and measurement frequency. -->

## 8. Risks & Mitigations

<!-- REQUIRED. Identified risks with likelihood (Low/Medium/High),
     impact (Low/Medium/High), and mitigation strategies. Minimum 3 risks. -->

## 9. Open Questions

<!-- OPTIONAL. Unresolved decisions that need input before downstream work.
     Each question must identify: the question, context, owner, and
     target resolution date. -->
```

**PRD Quality Rubric:**

| Category | Weight | Min Score | Evaluates |
|----------|--------|-----------|-----------|
| Problem Clarity | 15% | 60 | Is the problem well-defined, specific, and tied to real user pain? |
| Goals Measurability | 15% | 60 | Are goals specific, measurable, and achievable? |
| User Story Coverage | 15% | 60 | Do stories cover normal, edge, and error flows comprehensively? |
| Requirements Completeness | 20% | 70 | Are all functional requirements present with testable criteria? |
| Requirements Testability | 15% | 60 | Can each requirement be verified with a concrete test? |
| Risk Identification | 10% | 50 | Are significant risks identified with credible mitigations? |
| Internal Consistency | 10% | 60 | Do goals, stories, and requirements align without contradictions? |

#### 3.3.3 Complete Template: TDD

```markdown
---
id: null
parent_id: null
pipeline_id: null
type: "tdd"
status: "draft"
version: "1.0"
created_at: null
updated_at: null
author_agent: null
reviewer_agents: []
traces_from: []
traces_to: []
depth: 1
sibling_index: 0
sibling_count: 1
depends_on: []
dependency_type: []
execution_mode: "parallel"
review_iteration: 0
last_review_score: null
last_review_version: null
priority: "normal"
tags: []
---

# {TITLE}

## 1. Overview

<!-- REQUIRED. Summary of the technical domain this TDD covers.
     Must reference specific parent PRD sections and requirements.
     Must state the bounded context and what is in/out of scope
     for this specific TDD. -->

## 2. Architecture

<!-- REQUIRED. Component diagram (ASCII art), interaction patterns,
     and architectural style decisions. Must include:
     - High-level component diagram
     - Component interaction / sequence diagram
     - State machines for any stateful components
     - Architectural style rationale (e.g., event-driven, layered, etc.) -->

## 3. Detailed Design

<!-- REQUIRED. Per-component deep-dive covering:
     - Component responsibilities
     - Internal data flow
     - Algorithms or business logic
     - Configuration surface area -->

## 4. Trade-off Analysis

<!-- REQUIRED. Alternatives considered, evaluation criteria, and
     rationale for chosen approach. Minimum 2 alternatives per
     major architectural decision. Must include a decision matrix
     with scored criteria. -->

## 5. Data Models

<!-- REQUIRED. Entity definitions, relationships, constraints,
     and migration strategy. Must include:
     - TypeScript/language interfaces or schemas
     - Relationship diagrams
     - Constraints and validation rules
     - Storage format decisions -->

## 6. API / Interface Contracts

<!-- REQUIRED. Endpoint definitions, request/response schemas,
     error codes, and versioning strategy. For internal APIs:
     function signatures and behavioral contracts. -->

## 7. Integration Points

<!-- REQUIRED. External systems, protocols, authentication,
     failure modes, and circuit breaker strategies.
     For each integration: what, how, auth, failure mode, retry. -->

## 8. Security Considerations

<!-- REQUIRED. Threat model, authentication/authorization design,
     data protection measures. Must address:
     - Data at rest and in transit
     - Access control model
     - Audit trail requirements
     - Secrets management -->

## 9. Error Handling & Recovery

<!-- REQUIRED. Failure taxonomy, recovery strategies,
     and degradation modes. -->

## 10. Testing Strategy

<!-- REQUIRED. Unit, integration, and end-to-end test approach.
     Must specify coverage targets and critical test scenarios. -->

## 11. Observability

<!-- OPTIONAL. Logging strategy, metrics, tracing, and alerting
     design. Structured logging schema, metric names and types,
     trace span definitions. -->

## 12. Implementation Plan

<!-- REQUIRED. Phased delivery plan with dependencies and
     estimated effort. -->

## 13. Open Questions

<!-- OPTIONAL. Technical uncertainties requiring spike or prototype.
     Each must identify: the question, impact if unresolved,
     proposed investigation approach. -->
```

**TDD Quality Rubric:**

| Category | Weight | Min Score | Evaluates |
|----------|--------|-----------|-----------|
| Architecture Soundness | 20% | 70 | Is the architecture well-reasoned, scalable, and maintainable? |
| Trade-off Rigor | 15% | 60 | Are alternatives genuinely considered with honest evaluation? |
| Data Model Integrity | 15% | 60 | Are data models complete, consistent, and well-constrained? |
| API Contract Completeness | 15% | 60 | Are all interfaces fully specified with error handling? |
| Integration Robustness | 10% | 50 | Are failure modes identified with recovery strategies? |
| Security Depth | 10% | 50 | Are threats identified and mitigated credibly? |
| PRD Alignment | 15% | 70 | Does the design address all traced PRD requirements? |

#### 3.3.4 Complete Template: Plan

```markdown
---
id: null
parent_id: null
pipeline_id: null
type: "plan"
status: "draft"
version: "1.0"
created_at: null
updated_at: null
author_agent: null
reviewer_agents: []
traces_from: []
traces_to: []
depth: 2
sibling_index: 0
sibling_count: 1
depends_on: []
dependency_type: []
execution_mode: "parallel"
review_iteration: 0
last_review_score: null
last_review_version: null
priority: "normal"
tags: []
---

# {TITLE}

## 1. Overview

<!-- REQUIRED. Scope of this implementation plan.
     Must reference specific parent TDD sections.
     Must state what is delivered when this plan completes. -->

## 2. Work Units

<!-- REQUIRED. Time-boxed units of work, each with:
     - Unique ID (WU-NNN)
     - Description
     - Estimated effort (T-shirt size: XS/S/M/L/XL)
     - Required skills / agent type
     - Deliverables (concrete outputs)
     - Acceptance criteria
     Minimum 2 work units per plan. -->

## 3. Dependency Graph

<!-- REQUIRED. DAG of work units showing blocking relationships
     and critical path. ASCII diagram or list of edges.
     Must identify the critical path explicitly. -->

## 4. Agent Assignments

<!-- REQUIRED. Which agent type (or specific agent) is assigned
     to each work unit. Must justify assignment based on
     required skills. -->

## 5. Test Strategy

<!-- REQUIRED. Unit, integration, and end-to-end test approach
     for this plan's deliverables. Must specify:
     - Test types per work unit
     - Coverage targets
     - Integration test boundaries -->

## 6. Risk & Contingency

<!-- REQUIRED. Implementation risks specific to this plan
     and fallback strategies. Minimum 2 risks. -->

## 7. Parallel Execution Strategy

<!-- OPTIONAL. Which work units can run concurrently and
     resource requirements for parallelism. Include
     synchronization points. -->
```

**Plan Quality Rubric:**

| Category | Weight | Min Score | Evaluates |
|----------|--------|-----------|-----------|
| Work Unit Granularity | 20% | 60 | Are work units sized appropriately (not too large, not too fine)? |
| Dependency Accuracy | 20% | 70 | Is the dependency graph correct and complete? |
| Test Strategy Coverage | 15% | 60 | Does the test strategy cover critical paths and edge cases? |
| Effort Estimation Reasonableness | 15% | 50 | Are estimates internally consistent and realistic? |
| TDD Alignment | 15% | 70 | Does the plan implement the TDD design faithfully? |
| Risk Awareness | 15% | 50 | Are implementation risks identified with credible fallbacks? |

#### 3.3.5 Complete Template: Spec

```markdown
---
id: null
parent_id: null
pipeline_id: null
type: "spec"
status: "draft"
version: "1.0"
created_at: null
updated_at: null
author_agent: null
reviewer_agents: []
traces_from: []
traces_to: []
depth: 3
sibling_index: 0
sibling_count: 1
depends_on: []
dependency_type: []
execution_mode: "parallel"
review_iteration: 0
last_review_score: null
last_review_version: null
priority: "normal"
tags: []
---

# {TITLE}

## 1. Overview

<!-- REQUIRED. Concrete task description with reference to parent
     Plan work unit. Must be specific enough that a code-generation
     agent can implement without ambiguity. -->

## 2. File Manifest

<!-- REQUIRED. Exact file paths to create or modify, with rationale
     for each. Format:
     | File Path | Action | Rationale |
     |-----------|--------|-----------|
     | src/pipeline/gate.ts | Create | Review gate implementation |
     -->

## 3. Acceptance Criteria

<!-- REQUIRED. Numbered, testable criteria that define "done"
     for this spec. Format: AC-NNN: {criterion}.
     Each criterion must be verifiable by automated test or
     deterministic inspection. Minimum 3 criteria. -->

## 4. Code Patterns

<!-- REQUIRED. Required patterns, conventions, and anti-patterns
     to follow/avoid. Include code examples where helpful. -->

## 5. Test Cases

<!-- REQUIRED. Specific test cases with:
     - Test ID (TC-NNN)
     - Description
     - Inputs / preconditions
     - Expected outputs / postconditions
     - Edge cases
     Minimum 3 test cases. -->

## 6. Dependencies

<!-- REQUIRED. Other specs this depends on and the interfaces
     it expects from them. If no dependencies, state "None." -->
```

**Spec Quality Rubric:**

| Category | Weight | Min Score | Evaluates |
|----------|--------|-----------|-----------|
| Acceptance Criteria Precision | 25% | 70 | Are criteria unambiguous, testable, and complete? |
| File Path Accuracy | 15% | 60 | Are file paths valid and consistent with project structure? |
| Test Case Coverage | 20% | 60 | Do test cases cover happy path, edge cases, and error cases? |
| Code Pattern Clarity | 15% | 60 | Are patterns actionable and well-illustrated? |
| Plan Alignment | 15% | 70 | Does the spec implement its parent work unit fully? |
| Dependency Completeness | 10% | 50 | Are all interface dependencies identified? |

#### 3.3.6 Complete Template: Code

```markdown
---
id: null
parent_id: null
pipeline_id: null
type: "code"
status: "draft"
version: "1.0"
created_at: null
updated_at: null
author_agent: null
reviewer_agents: []
traces_from: []
traces_to: []
depth: 4
sibling_index: 0
sibling_count: 1
depends_on: []
dependency_type: []
execution_mode: "parallel"
review_iteration: 0
last_review_score: null
last_review_version: null
priority: "normal"
tags: []
---

# {TITLE}

## 1. Implementation Summary

<!-- REQUIRED. Brief description of what was implemented and
     which spec acceptance criteria are satisfied. -->

## 2. Files Delivered

<!-- REQUIRED. Table of all files created or modified.
     | File Path | Type | Description |
     |-----------|------|-------------|
     | src/pipeline/gate.ts | Implementation | Review gate logic |
     | tests/pipeline/gate.test.ts | Test | Unit tests for gate |
     -->

## 3. Test Results

<!-- REQUIRED. Test execution summary:
     - Total tests: N
     - Passing: N
     - Failing: N
     - Coverage: N%
     Include test output or link to test report. -->

## 4. Acceptance Criteria Verification

<!-- REQUIRED. Map each spec acceptance criterion to its
     verification evidence:
     | AC ID | Criterion | Verified By | Status |
     |-------|-----------|-------------|--------|
     | AC-001 | ... | TC-001 | PASS |
     -->

## 5. Changelog Entry

<!-- OPTIONAL. Summary of changes for release notes. -->
```

**Code Quality Rubric:**

| Category | Weight | Min Score | Evaluates |
|----------|--------|-----------|-----------|
| Spec Compliance | 25% | 70 | Does the code satisfy all acceptance criteria? |
| Test Coverage | 20% | 70 | Does test coverage meet the configured threshold (default 80%)? |
| Code Quality | 15% | 60 | Is the code clean, well-structured, and idiomatic? |
| Documentation Completeness | 10% | 50 | Are public APIs documented? Is complex logic commented? |
| Performance | 10% | 50 | Does the code meet performance requirements from the spec? |
| Security | 10% | 50 | Does the code follow security patterns from the TDD? |
| Maintainability | 10% | 50 | Is the code easy to understand, modify, and extend? |

#### 3.3.7 Template Validation

Before a document can be submitted to a review gate, the Template Engine validates:

1. **Frontmatter completeness**: All required fields present with valid types.
2. **Section presence**: All required sections exist with headings matching the template.
3. **Section non-emptiness**: Required sections have content beyond the guidance comments.
4. **Minimum word counts**: Sections meeting their minimum word count thresholds.
5. **Comment removal**: Guidance comments (`<!-- ... -->`) have been replaced with actual content.

Validation produces a `TemplateValidationResult`:

```typescript
interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateValidationError[];   // Blocking issues
  warnings: TemplateValidationWarning[]; // Non-blocking concerns
}

interface TemplateValidationError {
  field: string;          // "frontmatter.parent_id" or "section.problem_statement"
  rule: string;           // "required" | "type" | "pattern" | "non_empty" | "min_words"
  message: string;        // Human-readable explanation
}
```

### 3.4 Document Storage Layer

#### 3.4.1 Directory Structure

All pipeline artifacts are stored under a single root directory, configurable but defaulting to `{project_root}/.autonomous-dev/`. The layout is organized by pipeline run, then by document type.

```
{project_root}/
  .autonomous-dev/
    config.yaml                          # Global pipeline configuration
    pipelines/
      PIPE-2026-0408-001/
        pipeline.yaml                    # Pipeline metadata and state
        audit.log                        # Append-only audit log
        traceability.yaml                # Traceability matrix for this pipeline
        documents/
          prd/
            PRD-001/
              current.md                 # Symlink to latest version
              v1.0.md                    # Version 1.0
              v1.1.md                    # Version 1.1 (after review revision)
              reviews/
                v1.0-review-001.yaml     # Review feedback for v1.0
                v1.1-review-001.yaml     # Review feedback for v1.1
              diffs/
                v1.0-to-v1.1.diff        # Structured diff
          tdd/
            TDD-001-001/
              current.md
              v1.0.md
              reviews/
                v1.0-review-001.yaml
              diffs/
            TDD-001-002/
              current.md
              v1.0.md
              ...
          plan/
            PLAN-001-001/
              current.md
              v1.0.md
              ...
          spec/
            SPEC-001-001/
              current.md
              v1.0.md
              ...
          code/
            CODE-001-001/
              current.md                 # Code deliverable manifest
              v1.0.md
              files/                     # Actual implementation files (copies or refs)
                src/
                  pipeline/
                    gate.ts
                tests/
                  pipeline/
                    gate.test.ts
              ...
        decomposition/
          PRD-001-decomposition.yaml     # Decomposition record: PRD -> TDDs
          TDD-001-001-decomposition.yaml # Decomposition record: TDD -> Plans
          ...
```

#### 3.4.2 Naming Conventions

| Entity | Pattern | Example |
|--------|---------|---------|
| Pipeline directory | `PIPE-{YYYY}-{MMDD}-{SEQ}` | `PIPE-2026-0408-001` |
| Document directory | `{ID}` | `TDD-001-002` |
| Version file | `v{MAJOR}.{MINOR}.md` | `v1.3.md` |
| Current version | `current.md` (symlink) | Points to `v1.3.md` |
| Review file | `v{VERSION}-review-{SEQ}.yaml` | `v1.0-review-001.yaml` |
| Diff file | `v{FROM}-to-v{TO}.diff` | `v1.0-to-v1.1.diff` |
| Decomposition file | `{PARENT_ID}-decomposition.yaml` | `PRD-001-decomposition.yaml` |
| Pipeline state file | `pipeline.yaml` | -- |
| Traceability file | `traceability.yaml` | -- |
| Audit log | `audit.log` | -- |

#### 3.4.3 File Operations and Atomicity

All file writes use atomic write-then-rename to prevent corruption from crashes:

```typescript
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.tmp.${Date.now()}`;
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, targetPath);   // Atomic on POSIX
}
```

Symlink updates for `current.md` also use atomic replacement:

```typescript
async function atomicSymlink(target: string, linkPath: string): Promise<void> {
  const tempLink = `${linkPath}.tmp.${Date.now()}`;
  await fs.symlink(target, tempLink);
  await fs.rename(tempLink, linkPath);     // Atomic symlink swap
}
```

#### 3.4.4 Storage Quotas

To prevent runaway disk usage (R2 in the PRD -- decomposition explosion):

| Limit | Default | Configurable |
|-------|---------|--------------|
| Max documents per pipeline | 100 | Yes |
| Max versions per document | 20 | Yes |
| Max total pipeline storage | 500 MB | Yes |
| Max single document size | 1 MB | Yes |

The storage layer enforces these limits and returns structured errors when limits are exceeded.

### 3.5 Versioning Engine

The Versioning Engine manages document revision history: creating new versions, computing diffs, detecting quality regression, and executing rollbacks.

#### 3.5.1 Version Numbering

```
MAJOR.MINOR

MINOR increment:
  - Review-driven revision (author fixes reviewer feedback)
  - Template format update
  - Minor content correction

  Example: 1.0 -> 1.1 -> 1.2

MAJOR increment:
  - Backward cascade revision (parent change forces scope change)
  - Fundamental restructure of the document

  Example: 1.3 -> 2.0
```

Version numbers are stored in the document frontmatter and embedded in the file name. They are never reused. A rollback creates a NEW version with the content of the target version, preserving the audit trail:

```
v1.0  (original)
v1.1  (revision after review feedback)
v1.2  (revision that introduced quality regression)
v1.3  (rollback -- content identical to v1.1, new version number)
```

#### 3.5.2 Version Creation

```typescript
interface VersionCreateRequest {
  documentId: string;
  content: string;           // Full markdown content including frontmatter
  reason: VersionReason;     // "review_revision" | "backward_cascade" | "rollback" | "initial"
  sourceVersion?: string;    // For rollback: the version being restored
}

enum VersionReason {
  INITIAL = "initial",
  REVIEW_REVISION = "review_revision",
  BACKWARD_CASCADE = "backward_cascade",
  ROLLBACK = "rollback",
}

interface VersionRecord {
  version: string;
  reason: VersionReason;
  sourceVersion: string | null;  // Non-null for rollbacks
  createdAt: string;             // ISO 8601
  authorAgent: string;
  contentHash: string;           // SHA-256 of the full content
  filePath: string;              // Relative path to the version file
}
```

#### 3.5.3 Structured Diff

Diffs are computed at the section level, not the raw text level. This makes diffs meaningful in the context of document structure:

```typescript
interface SectionDiff {
  sectionId: string;         // e.g., "problem_statement"
  sectionHeading: string;    // e.g., "## 1. Problem Statement"
  changeType: "added" | "removed" | "modified" | "unchanged";
  oldContent?: string;       // Content in the previous version (if modified/removed)
  newContent?: string;       // Content in the new version (if modified/added)
  wordCountDelta: number;    // Change in word count
}

interface VersionDiff {
  fromVersion: string;
  toVersion: string;
  documentId: string;
  sections: SectionDiff[];
  frontmatterChanges: Record<string, { old: any; new: any }>;
  summary: {
    sectionsAdded: number;
    sectionsRemoved: number;
    sectionsModified: number;
    sectionsUnchanged: number;
    totalWordCountDelta: number;
  };
}
```

The diff is stored as a YAML file in the `diffs/` subdirectory of the document.

#### 3.5.4 Quality Regression Detection

After each review, the Versioning Engine compares the new aggregate score to the previous version's score:

```typescript
interface RegressionCheckResult {
  isRegression: boolean;
  currentVersion: string;
  currentScore: number;
  previousVersion: string;
  previousScore: number;
  scoreDelta: number;        // Negative means regression
  regressionMargin: number;  // Configured threshold (default: 5)
  recommendation: "proceed" | "rollback_suggested";
}
```

If `scoreDelta < -regressionMargin`, the system flags a regression and offers rollback. Rollback is NOT automatic -- it requires confirmation from the pipeline flow controller (which may be configured for auto-rollback or human confirmation).

### 3.6 Decomposition Engine

The Decomposition Engine transforms a single approved parent document into N child documents of the next pipeline type. It is invoked by the Pipeline Flow Controller after a document passes its review gate.

#### 3.6.1 Decomposition Strategies

Each pipeline transition uses a different decomposition strategy:

| Transition | Strategy | Description |
|------------|----------|-------------|
| PRD -> TDD | Domain decomposition | Identify bounded domains, subsystems, or feature areas. One TDD per domain. |
| TDD -> Plan | Implementation phasing | Identify sequential or parallel implementation phases. One Plan per phase. |
| Plan -> Spec | Task decomposition | Break work units into concrete, independently executable tasks. One Spec per task. |
| Spec -> Code | Direct generation | One-to-one. Each Spec produces exactly one Code deliverable. No decomposition logic. |

#### 3.6.2 Decomposition Tree Data Structure

The decomposition tree is the complete graph of parent-child relationships across the entire pipeline. It is stored per-pipeline and reconstructable from individual decomposition records.

```typescript
interface DecompositionNode {
  documentId: string;
  type: DocumentType;
  depth: number;
  status: DocumentStatus;
  version: string;
  parentId: string | null;
  children: string[];              // Child document IDs
  siblingDependencies: {           // Dependencies among siblings
    dependsOn: string;             // Sibling document ID
    type: "data" | "interface" | "ordering";
    description: string;
  }[];
  executionMode: "parallel" | "sequential";
}

interface DecompositionTree {
  pipelineId: string;
  rootId: string;                  // The PRD document ID
  nodes: Map<string, DecompositionNode>;
  totalNodeCount: number;
  maxDepth: number;                // Observed max depth
  createdAt: string;
  updatedAt: string;
}

// Example tree for a pipeline:
//
//   PRD-001 (depth 0)
//   +-- TDD-001-001 (depth 1)
//   |   +-- PLAN-001-001 (depth 2)
//   |   |   +-- SPEC-001-001 (depth 3)
//   |   |   |   +-- CODE-001-001 (depth 4)
//   |   |   +-- SPEC-001-002 (depth 3, depends_on: SPEC-001-001)
//   |   |       +-- CODE-001-002 (depth 4)
//   |   +-- PLAN-001-002 (depth 2, depends_on: PLAN-001-001)
//   |       +-- SPEC-001-003 (depth 3)
//   |           +-- CODE-001-003 (depth 4)
//   +-- TDD-001-002 (depth 1)
//       +-- PLAN-001-003 (depth 2)
//       |   +-- SPEC-001-004 (depth 3)
//       |       +-- CODE-001-004 (depth 4)
//       +-- PLAN-001-004 (depth 2)
//           +-- SPEC-001-005 (depth 3)
//               +-- CODE-001-005 (depth 4)
```

#### 3.6.3 Decomposition Record

Each decomposition event produces a record stored in the `decomposition/` directory:

```yaml
# PRD-001-decomposition.yaml
parent_id: "PRD-001"
parent_type: "prd"
parent_version: "1.0"           # Version of parent when decomposition occurred
child_type: "tdd"
strategy: "domain"
children:
  - id: "TDD-001-001"
    title: "Document Pipeline Architecture"
    traces_from:
      - "PRD-001#FR-001"
      - "PRD-001#FR-002"
      - "PRD-001#FR-003"
      - "PRD-001#FR-050"
      - "PRD-001#FR-051"
      - "PRD-001#FR-052"
    execution_mode: "parallel"
    depends_on: []
  - id: "TDD-001-002"
    title: "Review Gate Engine"
    traces_from:
      - "PRD-001#FR-010"
      - "PRD-001#FR-011"
      - "PRD-001#FR-012"
    execution_mode: "parallel"
    depends_on: []
  - id: "TDD-001-003"
    title: "Pipeline Orchestration"
    traces_from:
      - "PRD-001#FR-080"
      - "PRD-001#FR-081"
    execution_mode: "sequential"
    depends_on:
      - id: "TDD-001-001"
        type: "interface"
        description: "Requires document storage API from TDD-001-001"
coverage_matrix:
  parent_sections_covered:
    - "PRD-001#FR-001"
    - "PRD-001#FR-002"
    # ... all covered sections
  parent_sections_uncovered: []       # Must be empty for smoke test to pass
  child_scope_beyond_parent: []       # Must be empty for smoke test to pass
smoke_test_result: "pass"             # pass | fail
smoke_test_details:
  coverage_complete: true
  no_scope_creep: true
  no_contradictions: true
  contradiction_details: []
created_at: "2026-04-08T14:30:00Z"
decomposition_agent: "architect-agent-01"
```

#### 3.6.4 Decomposition Limits and Safeguards

| Limit | Default | Configurable | Enforcement |
|-------|---------|--------------|-------------|
| Max children per decomposition | 10 | Yes | If the agent proposes more, it must sub-group and decompose iteratively |
| Max pipeline depth | 4 (PRD->TDD->Plan->Spec->Code) | No | Hardcoded to the five pipeline types; no recursive sub-decomposition within a type |
| Max total nodes per pipeline | 100 | Yes | Checked before each decomposition; alert if >75% of limit |
| Decomposition explosion threshold | 75% of max total nodes | Yes | Human confirmation required above this threshold |

#### 3.6.5 Coverage Smoke Test

The smoke test runs after every decomposition and validates three properties:

1. **Coverage completeness**: Every requirement/section of the parent that is within scope appears in at least one child's `traces_from`. The test iterates parent requirements and checks the union of all children's `traces_from`.

2. **No scope creep**: No child's content introduces requirements or scope that cannot be traced back to the parent. This is validated by checking that every child's `traces_from` entries are valid parent section IDs.

3. **No contradictions**: No two children make contradictory design decisions. This is detected by having the decomposition agent explicitly declare key decisions per child and checking for conflicts. (Note: full semantic contradiction detection is aspirational; the MVP checks for explicit declaration conflicts only.)

```typescript
interface SmokeTestResult {
  passed: boolean;
  coverageComplete: boolean;
  uncoveredParentSections: string[];     // Parent sections with no child coverage
  scopeCreep: boolean;
  outOfScopeChildren: {
    childId: string;
    outOfScopeContent: string;
  }[];
  contradictions: boolean;
  contradictionDetails: {
    childA: string;
    childB: string;
    description: string;
  }[];
}
```

If the smoke test fails, the decomposition is rejected. The decomposition agent must revise its proposal before children enter their review gates.

### 3.7 Cross-Document Traceability Matrix

The Traceability Matrix is the central data structure that maps every requirement in every PRD to its chain of downstream documents, and every downstream document back to its originating requirement.

#### 3.7.1 Data Model

```typescript
interface TraceLink {
  sourceId: string;          // e.g., "PRD-001#FR-003"
  sourceType: "requirement" | "section" | "work_unit" | "acceptance_criterion";
  targetId: string;          // e.g., "TDD-001-001#section.data_models"
  targetType: "document" | "section" | "file" | "line_range";
  linkType: "implements" | "addresses" | "tests" | "derived_from";
  status: "active" | "stale" | "orphaned";
  createdAt: string;
  updatedAt: string;
}

interface TraceChain {
  // Full chain from a single PRD requirement to code
  requirement: string;       // e.g., "PRD-001#FR-003"
  tdd: string[];             // e.g., ["TDD-001-001#section.data_models"]
  plan: string[];            // e.g., ["PLAN-001-001#WU-002"]
  spec: string[];            // e.g., ["SPEC-001-003#AC-001"]
  code: string[];            // e.g., ["CODE-001-003#src/models/document.ts:15-45"]
  complete: boolean;         // True if chain reaches code
  gaps: TraceGap[];          // Missing links in the chain
}

interface TraceGap {
  level: DocumentType;       // Where the gap occurs
  sourceId: string;          // What should have a downstream trace but does not
  severity: "critical" | "warning";  // Critical if requirement has NO downstream trace
  description: string;
}

interface TraceabilityMatrix {
  pipelineId: string;
  chains: TraceChain[];
  totalRequirements: number;
  completeChains: number;
  incompleteChains: number;
  gaps: TraceGap[];
  orphans: string[];          // Documents whose traced parent sections no longer exist
  lastValidated: string;      // ISO 8601
}
```

#### 3.7.2 Traceability Matrix Storage

The matrix is stored as `traceability.yaml` at the pipeline root. It is regenerated (not manually maintained) from the frontmatter of all documents in the pipeline. The regeneration process:

1. Walk all document directories in the pipeline.
2. Parse the `traces_from` and `traces_to` fields from each document's current version frontmatter.
3. Build the forward chain: PRD requirement -> TDD section -> Plan work unit -> Spec AC -> Code file.
4. Detect gaps: requirements with incomplete chains.
5. Detect orphans: documents whose `traces_from` references sections that no longer exist in the parent's current version.

Regeneration happens:
- After every decomposition (new children added).
- After every review gate pass (document may have changed traced sections).
- After every backward cascade (parent sections may have changed).
- On demand (human or orchestrator request).

#### 3.7.3 Gap Detection Algorithm

```
function detectGaps(matrix: TraceabilityMatrix): TraceGap[] {
  gaps = []

  for each chain in matrix.chains:
    // Check each level in order
    for each level in [TDD, PLAN, SPEC, CODE]:
      if chain[level] is empty:
        // If this level exists in the pipeline (documents have been decomposed to this depth)
        if pipeline has reached this level:
          gaps.push({
            level: level,
            sourceId: chain's last non-empty level entry,
            severity: "critical",
            description: "Requirement {chain.requirement} has no {level} coverage"
          })
          break  // No need to check further downstream

  return gaps
}
```

Gap detection findings at review gates are classified as `critical`, which blocks approval per FR-063.

#### 3.7.4 Update Mechanism

The traceability matrix is updated lazily and on-demand rather than eagerly maintained. The reasons:

1. **Consistency**: Regenerating from source-of-truth (document frontmatter) avoids drift between the matrix and actual document state.
2. **Performance**: Incremental updates are complex to get right; full regeneration is fast for pipelines within the 100-node limit.
3. **Simplicity**: One code path for building the matrix, not N code paths for N types of updates.

For pipelines approaching the 100-node limit, regeneration is optimized by caching parsed frontmatter and only re-parsing documents modified since the last regeneration (using `updated_at` timestamps).

### 3.8 Backward Cascade Controller

The Backward Cascade Controller handles the case where a downstream review reveals a defect in an upstream (parent or ancestor) document. This is the most complex flow in the pipeline because it reverses the normal direction of progression.

#### 3.8.1 Backward Cascade Flow

```
                                         Review of TDD-001-002 finds
                                         defect in PRD-001#FR-005
                                                    |
                                                    v
                                     +-----------------------------+
                                     | 1. Reviewer classifies      |
                                     |    finding as upstream_defect|
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 2. Pipeline Flow Controller |
                                     |    validates the claim      |
                                     |    (is FR-005 in PRD-001?)  |
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 3. Identify all documents   |
                                     |    tracing from PRD-001#FR-005|
                                     |    (impact analysis)        |
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 4. Pause all in-flight work |
                                     |    on affected documents    |
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 5. Mark affected approved   |
                                     |    children as "stale"      |
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 6. Re-open PRD-001 for      |
                                     |    revision (major version) |
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 7. PRD revision goes through|
                                     |    review gate              |
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 8. Re-evaluate stale children|
                                     |    - Unaffected: re-approve |
                                     |    - Affected: revision-    |
                                     |      requested              |
                                     +-------------+---------------+
                                                   |
                                                   v
                                     +-----------------------------+
                                     | 9. Resume pipeline for      |
                                     |    re-approved and revised  |
                                     |    children                 |
                                     +-----------------------------+
```

#### 3.8.2 Backward Cascade Data Model

```typescript
interface BackwardCascadeEvent {
  id: string;                        // CASCADE-{PIPE_SEQ}-{SEQ}
  pipelineId: string;
  triggeredBy: {
    reviewId: string;                // The review that found the defect
    reviewingDocumentId: string;     // The document being reviewed when defect was found
    findingId: string;               // The specific finding
  };
  targetDocumentId: string;          // The upstream document with the defect
  targetSectionIds: string[];        // Specific sections identified as defective
  affectedDocuments: {               // All documents impacted by this cascade
    documentId: string;
    previousStatus: DocumentStatus;
    newStatus: "stale" | "paused";
    tracesToAffectedSections: boolean;  // True if this doc traces to affected sections
  }[];
  status: "initiated" | "parent_revised" | "children_re_evaluated" | "resolved" | "escalated";
  cascadeDepth: number;              // How many levels up the cascade went (1 = parent, 2 = grandparent)
  maxCascadeDepth: number;           // Configured limit (default: 2)
  createdAt: string;
  resolvedAt: string | null;
}
```

#### 3.8.3 Scoped Cascade Logic

Backward cascades are scoped to minimize disruption (FR-073):

```
function scopeCascade(
  targetDoc: Document,
  affectedSections: string[],
  allChildren: Document[]
): { affected: Document[], unaffected: Document[] } {

  affected = []
  unaffected = []

  for each child in allChildren:
    // Check if any of the child's traces_from entries
    // reference an affected section
    childTracesAffected = child.frontmatter.traces_from
      .some(trace => affectedSections.includes(trace))

    if childTracesAffected:
      affected.push(child)
    else:
      unaffected.push(child)

  return { affected, unaffected }
}
```

Children tracing only to unaffected sections of the parent remain in their current state. Children tracing to affected sections are marked `stale` and queued for re-evaluation.

#### 3.8.4 Cascade Depth Limiting

Maximum cascade depth is configurable (default: 2 levels up). If a cascade would propagate further (e.g., a Plan review finds a defect in the PRD, which is 2 levels up), the system checks:

- Depth 1 (parent): Automatic cascade.
- Depth 2 (grandparent): Automatic cascade with warning logged.
- Depth 3+: Escalate to human operator. The cascade is paused, the human reviews the finding, and decides whether to propagate further or resolve it at the current level.

### 3.9 Pipeline Flow Controller

The Pipeline Flow Controller is the state machine that governs the entire pipeline lifecycle. It coordinates all other subsystems (storage, versioning, decomposition, traceability, backward cascade) and manages phase progression, pause/resume, and cancellation.

#### 3.9.1 Pipeline State

```typescript
interface PipelineState {
  pipelineId: string;
  status: PipelineStatus;
  priority: "critical" | "high" | "normal" | "low";
  rootDocumentId: string;             // The PRD
  currentPhase: DocumentType;         // Furthest phase reached
  documentStates: Map<string, DocumentState>;  // All documents in this pipeline
  activeCascades: string[];           // IDs of active backward cascades
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  pausedAt: string | null;
  totalIterations: number;            // Across all gates
  totalDocuments: number;
}

enum PipelineStatus {
  ACTIVE = "active",
  PAUSED = "paused",
  COMPLETED = "completed",
  CANCELLED = "cancelled",
  FAILED = "failed",                  // Unrecoverable error
}

interface DocumentState {
  documentId: string;
  type: DocumentType;
  status: DocumentStatus;
  version: string;
  reviewIteration: number;
  lastReviewScore: number | null;
  assignedAgent: string | null;
  parentId: string | null;
  children: string[];
  blockedBy: string[];               // Document IDs this is waiting on
  blocking: string[];                // Document IDs waiting on this
}
```

#### 3.9.2 Pipeline State File

The pipeline state is persisted as `pipeline.yaml` in the pipeline directory. It is updated atomically after every state transition.

```yaml
# pipeline.yaml
pipeline_id: "PIPE-2026-0408-001"
status: "active"
priority: "normal"
root_document_id: "PRD-001"
current_phase: "tdd"
created_at: "2026-04-08T10:00:00Z"
updated_at: "2026-04-08T15:45:00Z"
completed_at: null
cancelled_at: null
paused_at: null
total_iterations: 5
total_documents: 8

document_states:
  PRD-001:
    type: "prd"
    status: "approved"
    version: "1.1"
    review_iteration: 2
    last_review_score: 91
    assigned_agent: "product-manager-01"
    parent_id: null
    children: ["TDD-001-001", "TDD-001-002", "TDD-001-003"]
    blocked_by: []
    blocking: []

  TDD-001-001:
    type: "tdd"
    status: "in-review"
    version: "1.0"
    review_iteration: 1
    last_review_score: null
    assigned_agent: "staff-engineer-01"
    parent_id: "PRD-001"
    children: []
    blocked_by: []
    blocking: ["TDD-001-003"]

  TDD-001-002:
    type: "tdd"
    status: "draft"
    version: "1.0"
    review_iteration: 0
    last_review_score: null
    assigned_agent: "staff-engineer-02"
    parent_id: "PRD-001"
    children: []
    blocked_by: []
    blocking: []

  TDD-001-003:
    type: "tdd"
    status: "draft"
    version: "1.0"
    review_iteration: 0
    last_review_score: null
    assigned_agent: null
    parent_id: "PRD-001"
    children: []
    blocked_by: ["TDD-001-001"]
    blocking: []
```

#### 3.9.3 Phase Progression Rules

The flow controller enforces these progression rules:

1. **No skipping**: A document at depth N can only be created by decomposition of an approved document at depth N-1. There is no shortcut from PRD to Spec.

2. **Gate required**: A document must pass its review gate before it can decompose into children. No unapproved document produces children.

3. **Parallel siblings**: Siblings marked `execution_mode: parallel` with no interdependencies are submitted to their respective review gates concurrently. The flow controller does not wait for sibling A to be approved before submitting sibling B, unless B `depends_on` A.

4. **Sequential siblings**: Siblings marked `execution_mode: sequential` or with dependencies are processed in dependency order. A document is not assigned to an authoring agent until all its `depends_on` siblings are approved.

5. **Phase completion**: A phase is considered "complete" for a subtree when all documents at that depth in the subtree are approved. This triggers decomposition of all approved documents into the next phase.

#### 3.9.4 Pause / Resume

**Pause**: Sets `pipeline.status` to `paused` and `paused_at` to the current timestamp. All in-flight work (authoring, reviewing) is signaled to stop at the next safe checkpoint. Documents in `in-review` or `draft` states retain their state; no data is lost. The signal mechanism is a `paused` flag in the pipeline state file that agents check before starting new work.

**Resume**: Sets `pipeline.status` back to `active`, clears `paused_at`. The flow controller re-evaluates all documents and resumes processing from where it left off. Documents that were `in-review` when paused are resubmitted to their review gates. Documents that were `draft` are re-assigned to authoring agents.

State serialization: The entire pipeline state is captured in `pipeline.yaml`. Resuming after a crash is identical to resuming after an explicit pause -- the flow controller reads `pipeline.yaml` and reconstructs the execution plan.

#### 3.9.5 Cancellation

**Full cancellation**: Sets `pipeline.status` to `cancelled` and `cancelled_at` to the current timestamp. All documents in non-terminal states (`draft`, `in-review`, `revision-requested`, `stale`) are marked `cancelled`. Documents already `approved` or `rejected` retain their terminal status. All partial work is preserved on disk for forensic review.

**Partial cancellation** (Phase 3): Cancels a subtree by specifying a root document ID. Only that document and its descendants are cancelled. Sibling subtrees are unaffected. The traceability matrix is updated to reflect the cancelled subtree.

```typescript
interface CancellationRequest {
  pipelineId: string;
  scope: "full" | "subtree";
  subtreeRootId?: string;        // Required if scope is "subtree"
  reason: string;
}
```

#### 3.9.6 Priority Changes

Priority is a scheduling hint that affects agent assignment order but does not change pipeline structure. When priority changes:

1. Update `priority` in `pipeline.yaml` and in all document frontmatter for the pipeline.
2. Emit a `priority_changed` event.
3. The agent scheduler (separate subsystem, out of scope for this TDD) uses priority to order its work queue.

#### 3.9.7 Event Emission

The flow controller emits structured events at every state transition. Events are appended to the `audit.log` file and optionally published to an event bus (for observability integration).

```typescript
interface PipelineEvent {
  eventId: string;                    // UUID
  pipelineId: string;
  timestamp: string;                  // ISO 8601
  eventType: PipelineEventType;
  documentId?: string;                // When event relates to a specific document
  details: Record<string, any>;       // Event-specific payload
  actorId: string;                    // Agent or human that caused the event
}

enum PipelineEventType {
  // Document lifecycle
  DOCUMENT_CREATED = "document_created",
  DOCUMENT_SUBMITTED = "document_submitted",
  REVIEW_STARTED = "review_started",
  REVIEW_COMPLETED = "review_completed",
  DOCUMENT_APPROVED = "document_approved",
  DOCUMENT_REJECTED = "document_rejected",
  CHANGES_REQUESTED = "changes_requested",
  DOCUMENT_CANCELLED = "document_cancelled",
  DOCUMENT_STALE = "document_stale",
  DOCUMENT_RE_EVALUATED = "document_re_evaluated",

  // Decomposition
  DECOMPOSITION_STARTED = "decomposition_started",
  DECOMPOSITION_COMPLETED = "decomposition_completed",
  SMOKE_TEST_PASSED = "smoke_test_passed",
  SMOKE_TEST_FAILED = "smoke_test_failed",

  // Backward cascade
  BACKWARD_CASCADE_TRIGGERED = "backward_cascade_triggered",
  BACKWARD_CASCADE_RESOLVED = "backward_cascade_resolved",

  // Pipeline control
  PIPELINE_CREATED = "pipeline_created",
  PIPELINE_PAUSED = "pipeline_paused",
  PIPELINE_RESUMED = "pipeline_resumed",
  PIPELINE_CANCELLED = "pipeline_cancelled",
  PIPELINE_COMPLETED = "pipeline_completed",
  PRIORITY_CHANGED = "priority_changed",

  // Versioning
  VERSION_CREATED = "version_created",
  QUALITY_REGRESSION = "quality_regression",
  ROLLBACK_EXECUTED = "rollback_executed",

  // Escalation
  HUMAN_ESCALATION = "human_escalation",
}
```

---

## 4. Data Models

### 4.1 Configuration Schema

All configurable thresholds are centralized in `config.yaml`:

```yaml
# .autonomous-dev/config.yaml

pipeline:
  max_depth: 4                          # Maximum pipeline depth (PRD=0 through Code=4)
  max_nodes_per_pipeline: 100           # Maximum total documents per pipeline
  explosion_threshold_pct: 75           # Alert at this % of max_nodes
  default_priority: "normal"

decomposition:
  max_children_per_parent: 10           # Maximum children from one decomposition
  smoke_test_enabled: true              # Run coverage smoke test after decomposition
  auto_reject_on_smoke_failure: true    # Reject decomposition if smoke test fails

versioning:
  regression_margin: 5                  # Score drop that triggers regression flag
  auto_rollback: false                  # Automatically rollback on regression (vs. suggest)
  max_versions_per_document: 20

review_gates:
  default_approval_threshold: 85        # Weighted aggregate minimum
  default_max_iterations: 3             # Max review cycles before escalation
  default_aggregation_method: "mean"    # mean | median | min
  per_type_overrides:
    prd:
      panel_size: 2
    tdd:
      panel_size: 2
    plan:
      panel_size: 1
    spec:
      panel_size: 1
    code:
      panel_size: 2

backward_cascade:
  max_depth: 2                          # Maximum levels to cascade upward
  auto_cascade: true                    # Automatically cascade (vs. require human confirmation)
  scoped_cascade: true                  # Only affect children tracing to defective sections

storage:
  root_dir: ".autonomous-dev"           # Relative to project root
  max_pipeline_storage_mb: 500
  max_document_size_mb: 1

traceability:
  gap_detection_at_gates: true          # Run gap detection at every review gate
  gap_severity: "critical"             # Severity of gap findings (critical blocks approval)
  lazy_regeneration: true              # Regenerate matrix on-demand vs. eagerly
```

### 4.2 Review Feedback Schema

```yaml
# v1.0-review-001.yaml
review_id: "REV-001-001"
document_id: "TDD-001-001"
document_version: "1.0"
reviewer_agent: "reviewer-architect-01"
review_iteration: 1
timestamp: "2026-04-08T15:30:00Z"

outcome: "changes_requested"        # approved | changes_requested | rejected

scores:
  architecture_soundness:
    score: 82
    weight: 0.20
    feedback: "Component boundaries are well-defined but the interaction between
               the Versioning Engine and Decomposition Engine is underspecified."
  trade_off_rigor:
    score: 75
    weight: 0.15
    feedback: "Two alternatives are considered but the evaluation criteria are
               not quantified. Needs a decision matrix."
  data_model_integrity:
    score: 88
    weight: 0.15
    feedback: "Models are complete. Minor: the TraceLink status enum should
               include 'orphaned'."
  api_contract_completeness:
    score: 70
    weight: 0.15
    feedback: "Error handling is missing from the decomposition API contract."
  integration_robustness:
    score: 80
    weight: 0.10
    feedback: "Adequate."
  security_depth:
    score: 65
    weight: 0.10
    feedback: "Threat model is superficial. Needs to address document tampering."
  prd_alignment:
    score: 90
    weight: 0.15
    feedback: "Strong alignment. All traced requirements are addressed."

aggregate_score: 79.35                 # Weighted aggregate
approval_threshold: 85

findings:
  - id: "F-001"
    severity: "major"
    section: "api_contracts"
    rubric_category: "api_contract_completeness"
    description: "The decomposition engine API does not specify error responses
                  for invalid parent documents or exceeded child limits."
    suggested_resolution: "Add error response schemas for DecompositionError
                           with codes: INVALID_PARENT, CHILD_LIMIT_EXCEEDED,
                           SMOKE_TEST_FAILED."

  - id: "F-002"
    severity: "minor"
    section: "data_models"
    rubric_category: "data_model_integrity"
    description: "TraceLink status enum is missing 'orphaned' state."
    suggested_resolution: "Add 'orphaned' to the status enum and document
                           when a trace link enters this state."

  - id: "F-003"
    severity: "suggestion"
    section: "trade_off_analysis"
    rubric_category: "trade_off_rigor"
    description: "Consider adding a decision matrix for the storage backend
                  decision (git vs. document DB vs. artifact store)."
    suggested_resolution: "Add a table with criteria columns and option rows."

  # Example of an upstream_defect finding:
  # - id: "F-004"
  #   severity: "critical"
  #   section: "overview"
  #   rubric_category: "prd_alignment"
  #   description: "PRD-001#FR-005 contradicts PRD-001#FR-010. The TDD cannot
  #                 implement both consistently."
  #   suggested_resolution: "Resolve the contradiction in PRD-001 before
  #                          proceeding with this TDD."
  #   upstream_defect:
  #     target_document: "PRD-001"
  #     target_sections: ["FR-005", "FR-010"]
  #     description: "Requirements FR-005 and FR-010 are contradictory."
```

### 4.3 Audit Log Format

The audit log is an append-only, newline-delimited JSON file:

```jsonl
{"event_id":"evt-001","pipeline_id":"PIPE-2026-0408-001","timestamp":"2026-04-08T10:00:00Z","event_type":"pipeline_created","actor_id":"orchestrator","details":{"priority":"normal","root_document":"PRD-001"}}
{"event_id":"evt-002","pipeline_id":"PIPE-2026-0408-001","timestamp":"2026-04-08T10:01:00Z","event_type":"document_created","document_id":"PRD-001","actor_id":"product-manager-01","details":{"type":"prd","version":"1.0"}}
{"event_id":"evt-003","pipeline_id":"PIPE-2026-0408-001","timestamp":"2026-04-08T10:30:00Z","event_type":"document_submitted","document_id":"PRD-001","actor_id":"product-manager-01","details":{"version":"1.0","gate":"prd_review"}}
{"event_id":"evt-004","pipeline_id":"PIPE-2026-0408-001","timestamp":"2026-04-08T10:32:00Z","event_type":"review_started","document_id":"PRD-001","actor_id":"reviewer-pm-01","details":{"version":"1.0","iteration":1}}
```

---

## 5. API / Interface Contracts Between Components

### 5.1 Document Storage API

```typescript
interface DocumentStorageAPI {
  // Create a new document from template
  createDocument(request: CreateDocumentRequest): Promise<DocumentHandle>;

  // Read the current version of a document
  readDocument(documentId: string): Promise<DocumentContent>;

  // Read a specific version
  readVersion(documentId: string, version: string): Promise<DocumentContent>;

  // List all versions of a document
  listVersions(documentId: string): Promise<VersionRecord[]>;

  // Write a new version (called by Versioning Engine)
  writeVersion(request: VersionCreateRequest): Promise<VersionRecord>;

  // List all documents in a pipeline, optionally filtered
  listDocuments(pipelineId: string, filter?: DocumentFilter): Promise<DocumentHandle[]>;

  // Delete a document (admin only, not used in normal flow)
  deleteDocument(documentId: string): Promise<void>;
}

interface CreateDocumentRequest {
  pipelineId: string;
  type: DocumentType;
  parentId: string | null;
  authorAgent: string;
  tracesFrom: string[];
  siblingIndex: number;
  siblingCount: number;
  dependsOn: string[];
  dependencyType: string[];
  executionMode: "parallel" | "sequential";
  priority: string;
}

interface DocumentHandle {
  id: string;
  type: DocumentType;
  currentVersion: string;
  filePath: string;        // Path to current.md
}

interface DocumentContent {
  id: string;
  version: string;
  frontmatter: Record<string, any>;
  body: string;            // Markdown body (without frontmatter)
  raw: string;             // Full file content (frontmatter + body)
}

interface DocumentFilter {
  type?: DocumentType;
  status?: DocumentStatus;
  parentId?: string;
  minDepth?: number;
  maxDepth?: number;
}
```

### 5.2 Template Engine API

```typescript
interface TemplateEngineAPI {
  // Get the template for a document type
  getTemplate(type: DocumentType): Promise<DocumentTemplate>;

  // Render a template with initial values (for document creation)
  renderTemplate(type: DocumentType, values: TemplateValues): Promise<string>;

  // Validate a document against its template
  validateDocument(content: string, type: DocumentType): Promise<TemplateValidationResult>;

  // Get the rubric for a document type
  getRubric(type: DocumentType): Promise<QualityRubric>;
}

interface TemplateValues {
  title: string;
  frontmatter: Partial<Record<string, any>>;  // Override default frontmatter values
}
```

### 5.3 Versioning Engine API

```typescript
interface VersioningEngineAPI {
  // Create a new version of a document
  createVersion(request: VersionCreateRequest): Promise<VersionRecord>;

  // Compute diff between two versions
  computeDiff(documentId: string, fromVersion: string, toVersion: string): Promise<VersionDiff>;

  // Check for quality regression
  checkRegression(documentId: string, newScore: number): Promise<RegressionCheckResult>;

  // Execute a rollback (creates a new version with old content)
  rollback(documentId: string, targetVersion: string): Promise<VersionRecord>;

  // Get the version history for a document
  getHistory(documentId: string): Promise<VersionRecord[]>;
}
```

### 5.4 Decomposition Engine API

```typescript
interface DecompositionEngineAPI {
  // Decompose a parent document into children
  decompose(request: DecompositionRequest): Promise<DecompositionResult>;

  // Run the coverage smoke test on a proposed decomposition
  smokeTest(parentId: string, proposedChildren: ProposedChild[]): Promise<SmokeTestResult>;

  // Get the decomposition record for a parent document
  getDecomposition(parentId: string): Promise<DecompositionRecord | null>;

  // Get the full decomposition tree for a pipeline
  getTree(pipelineId: string): Promise<DecompositionTree>;
}

interface DecompositionRequest {
  parentDocumentId: string;
  decompositionAgent: string;      // Agent performing the decomposition
}

interface DecompositionResult {
  success: boolean;
  parentId: string;
  children: DocumentHandle[];      // Created child documents
  smokeTestResult: SmokeTestResult;
  decompositionRecord: DecompositionRecord;
  error?: DecompositionError;
}

interface DecompositionError {
  code: "INVALID_PARENT" | "PARENT_NOT_APPROVED" | "CHILD_LIMIT_EXCEEDED"
        | "DEPTH_LIMIT_EXCEEDED" | "EXPLOSION_THRESHOLD" | "SMOKE_TEST_FAILED";
  message: string;
  details: Record<string, any>;
}

interface ProposedChild {
  title: string;
  tracesFrom: string[];
  dependsOn: string[];
  dependencyType: string[];
  executionMode: "parallel" | "sequential";
}
```

### 5.5 Traceability Matrix API

```typescript
interface TraceabilityMatrixAPI {
  // Regenerate the full traceability matrix for a pipeline
  regenerate(pipelineId: string): Promise<TraceabilityMatrix>;

  // Run gap detection
  detectGaps(pipelineId: string): Promise<TraceGap[]>;

  // Run orphan detection
  detectOrphans(pipelineId: string): Promise<string[]>;

  // Get the full trace chain for a specific requirement
  getTraceChain(requirementId: string): Promise<TraceChain>;

  // Impact analysis: what documents are affected by a change to a section
  analyzeImpact(documentId: string, sectionIds: string[]): Promise<string[]>;
}
```

### 5.6 Backward Cascade Controller API

```typescript
interface BackwardCascadeAPI {
  // Initiate a backward cascade
  initiate(request: CascadeRequest): Promise<BackwardCascadeEvent>;

  // Get the status of an active cascade
  getStatus(cascadeId: string): Promise<BackwardCascadeEvent>;

  // Mark a cascade as resolved after parent revision and child re-evaluation
  resolve(cascadeId: string): Promise<void>;

  // Escalate a cascade to human operator
  escalate(cascadeId: string, reason: string): Promise<void>;
}

interface CascadeRequest {
  reviewId: string;
  findingId: string;
  targetDocumentId: string;
  targetSectionIds: string[];
}
```

### 5.7 Pipeline Flow Controller API

```typescript
interface PipelineFlowControllerAPI {
  // Create a new pipeline from a product request
  createPipeline(request: CreatePipelineRequest): Promise<PipelineState>;

  // Get the current state of a pipeline
  getState(pipelineId: string): Promise<PipelineState>;

  // Advance a document through the pipeline (called after review gate or decomposition)
  advance(documentId: string, action: AdvanceAction): Promise<PipelineState>;

  // Pause a pipeline
  pause(pipelineId: string): Promise<PipelineState>;

  // Resume a paused pipeline
  resume(pipelineId: string): Promise<PipelineState>;

  // Cancel a pipeline (full or subtree)
  cancel(request: CancellationRequest): Promise<PipelineState>;

  // Change priority
  changePriority(pipelineId: string, priority: string): Promise<PipelineState>;

  // List all pipelines, optionally filtered by status
  listPipelines(filter?: PipelineFilter): Promise<PipelineState[]>;
}

interface CreatePipelineRequest {
  title: string;
  priority?: string;
  tags?: string[];
  authorAgent: string;
}

enum AdvanceAction {
  SUBMIT_FOR_REVIEW = "submit_for_review",
  REVIEW_COMPLETED = "review_completed",
  DECOMPOSE = "decompose",
  REVISION_SUBMITTED = "revision_submitted",
}

interface PipelineFilter {
  status?: PipelineStatus;
  priority?: string;
  createdAfter?: string;
  createdBefore?: string;
}
```

---

## 6. Error Handling & Recovery

### 6.1 Failure Taxonomy

| Failure Category | Examples | Severity | Recovery |
|-----------------|----------|----------|----------|
| **Agent crash** | Authoring agent OOM, reviewer agent timeout | Transient | Retry with same or different agent. Preserve last checkpoint. |
| **Validation failure** | Invalid frontmatter, missing required section | Permanent | Return to author with validation errors. No retry. |
| **Storage failure** | Disk full, permission denied, corrupted file | Transient/Permanent | Retry for transient. Alert human for permanent. |
| **Decomposition failure** | Smoke test fail, child limit exceeded | Recoverable | Decomposition agent revises proposal. Max 3 attempts. |
| **Review gate failure** | Reviewer produces invalid output, scoring error | Transient | Retry with same reviewer. If persistent, substitute reviewer. |
| **Cascade loop** | Backward cascade triggers re-cascade | Permanent | Escalate to human. Circuit breaker after 2 cascades on same section. |
| **Pipeline state corruption** | pipeline.yaml inconsistent with documents on disk | Permanent | Reconstruct pipeline state from document frontmatter and audit log. |

### 6.2 Recovery Strategies

**Crash recovery**: The Pipeline Flow Controller persists state after every transition. On restart, it reads `pipeline.yaml` and the audit log, reconciles any inconsistencies (e.g., an event was logged but state was not updated), and resumes from the last consistent state. This is why all writes are atomic and all state transitions are logged before execution.

**Idempotent operations**: Every operation checks preconditions before executing. Creating a version that already exists is a no-op. Submitting a document that is already in-review is a no-op. This allows safe retry of any operation.

**State reconciliation**: If `pipeline.yaml` is corrupted or missing, the system can reconstruct it by:
1. Scanning all document directories for frontmatter.
2. Reading the audit log for the latest event per document.
3. Rebuilding the pipeline state from these sources.

This reconstruction is a manual recovery operation, not automatic, to avoid masking underlying issues.

### 6.3 Circuit Breakers

| Circuit Breaker | Trigger | Action |
|----------------|---------|--------|
| Review loop | Same finding recurs after being marked resolved | Escalate to human immediately |
| Backward cascade | Same section cascaded twice within one pipeline run | Escalate to human |
| Decomposition retry | 3 consecutive smoke test failures | Escalate to human |
| Agent failure | Same agent fails 3 consecutive tasks | Remove agent from rotation, assign substitute |

---

## 7. Security Considerations

### 7.1 Document Integrity

- **Immutable versions**: Once written, version files are never modified. New versions create new files. This prevents tampering with historical records.
- **Content hashing**: Every version record includes a SHA-256 hash of the full content. On read, the hash is verified. Any mismatch indicates corruption or tampering.
- **Audit trail integrity**: The audit log is append-only. Entries include a hash chain (each entry includes the hash of the previous entry) to detect log tampering or truncation.

### 7.2 Access Control

- **Agent identity**: Every operation is attributed to an agent ID. Agents cannot impersonate other agents.
- **Operation permissions**: Agents are scoped to their role:
  - Author agents: create documents, write versions.
  - Reviewer agents: read documents, write reviews. Cannot modify documents.
  - Decomposition agents: read parents, propose children. Cannot approve.
  - Orchestrator: full pipeline control (pause, cancel, priority).
  - Human operators: full access including override, rollback, and escalation resolution.

### 7.3 Secrets and Sensitive Data

- Documents should not contain secrets (API keys, passwords, tokens). The template validation layer flags common secret patterns (regex matching `[A-Za-z0-9]{32,}`, `sk-...`, `ghp_...`, etc.) and warns before submission.
- Pipeline configuration (`config.yaml`) does not contain secrets. Agent credentials are managed by the agent orchestration layer (out of scope for this TDD).

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Component | Key Test Scenarios | Coverage Target |
|-----------|--------------------|-----------------|
| Frontmatter parser | Valid/invalid YAML, missing fields, wrong types, edge cases | 95% |
| Template validator | All document types, missing sections, empty sections, min word counts | 90% |
| Version numbering | Minor increment, major increment, rollback version creation | 100% |
| Diff engine | Added/removed/modified sections, frontmatter changes, identical versions | 90% |
| Regression detector | Score above threshold, below threshold, at exact margin | 100% |
| ID generator | Uniqueness, format validation, counter atomicity | 100% |
| Smoke test | Full coverage, gaps, scope creep, contradictions | 90% |
| Cascade scoping | Affected/unaffected children, multi-level cascade, depth limit | 90% |

### 8.2 Integration Tests

| Scenario | Components Involved | Validation |
|----------|-------------------|------------|
| Full pipeline: PRD to Code | All components | Document at each phase is created, reviewed, decomposed correctly |
| Review loop: 3 iterations then escalate | Template, Versioning, Flow Controller | Escalation event emitted, document state correct |
| Backward cascade: TDD defect in PRD | Cascade Controller, Traceability, Flow Controller | Correct children marked stale, parent revised, children re-evaluated |
| Decomposition with dependencies | Decomposition Engine, Storage, Flow Controller | Dependency graph respected in execution order |
| Crash recovery: kill mid-review | Storage, Flow Controller | Pipeline resumes correctly from last consistent state |
| Quality regression rollback | Versioning, Flow Controller | New version created with old content, scores compared correctly |

### 8.3 End-to-End Tests

- **Happy path**: Submit a product request, pipeline produces PRD, 2 TDDs, 4 Plans, 8 Specs, 8 Code deliverables. All approved. Full traceability matrix is complete.
- **Unhappy path**: PRD fails review twice, passes on third. One TDD triggers backward cascade. Pipeline still completes.
- **Cancellation**: Pipeline cancelled mid-Plan phase. All documents in correct terminal states. Forensic review possible.
- **Pause/resume**: Pipeline paused at TDD review, resumed after 1 hour. State is identical to pre-pause.

### 8.4 Performance Tests

- **Throughput**: 5 concurrent pipelines, each with 50 documents. Pipeline completion within resource limits.
- **Traceability regeneration**: 100-node pipeline matrix regeneration under 5 seconds.
- **State file I/O**: Atomic write + read cycle under 50ms for pipeline.yaml of maximum size.

---

## 9. Trade-offs & Alternatives

### 9.1 Storage Backend

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **File system (chosen)** | Simple, no dependencies, natural for Markdown, works with existing tools, easy to inspect | No built-in indexing, no concurrent write coordination, scales poorly beyond thousands of files | Chosen for MVP. The 100-node pipeline limit keeps file counts manageable. |
| Git repository | Built-in versioning, diff support, branch model | Heavy for per-document versioning, merge conflicts for concurrent writes, git overhead per operation | Rejected for document storage. Git is used for the code deliverables themselves, not the pipeline metadata. |
| SQLite | ACID, indexed queries, single-file database | Opaque (not human-inspectable), adds dependency, schema migration overhead | Considered for Phase 2+ if file system becomes a bottleneck. |
| Document database (MongoDB, etc.) | Scalable, indexed, query-rich | External dependency, operational overhead, overkill for single-host system | Rejected. The system runs on a single host. |

### 9.2 Traceability: Eager vs. Lazy

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Lazy regeneration (chosen)** | Simpler, always consistent with source, no stale cache | Slower reads (must regenerate), no incremental updates | Chosen. Regeneration is fast within the 100-node limit. Consistency is more important than read speed. |
| Eager maintenance | Fast reads, no regeneration delay | Complex update logic, risk of drift between matrix and documents, multiple code paths | Rejected for MVP. Reconsidered if regeneration latency becomes a problem. |

### 9.3 Backward Cascade: Automatic vs. Human-Gated

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Automatic with depth limit (chosen)** | Fast response, no human bottleneck, depth limit prevents runaway | May cause unnecessary disruption for minor upstream defects | Chosen. Configurable: operators can set `auto_cascade: false` to require human confirmation. |
| Always human-gated | No unnecessary disruption, human judgment on severity | Slow, human becomes bottleneck, defeats purpose of autonomous pipeline | Available as configuration option, not the default. |

### 9.4 Document Versioning: Full Content vs. Diff-Only

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Full content per version (chosen)** | Independent retrieval of any version, no reconstruction needed, simple | More disk space, some duplication | Chosen per FR-051. Disk is cheap. Simplicity of retrieval outweighs storage cost. |
| Diff-only (reconstruct from base + diffs) | Minimal storage | Slow retrieval (must replay diffs), corruption in one diff corrupts all subsequent versions | Rejected. Fragile and slow for read-heavy workloads. |

### 9.5 Symlink-Based current.md vs. Tracked Pointer

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Symlink (chosen)** | Atomic swap, file system native, tools follow symlinks transparently | Not portable to all file systems (Windows without developer mode), `ls -la` required to see target | Chosen. Target platforms are macOS and Linux (per PRD-001). Windows is not a target. |
| Pointer file (current.txt containing version string) | Portable, explicit | Two reads to get content (read pointer, then read target), not atomic (pointer can point to non-existent version during write) | Rejected. Symlink is more robust on target platforms. |

---

## 10. Implementation Plan

### Phase 1: Foundation (MVP)

**Goal**: Core storage, templates, basic versioning, linear pipeline.

| Step | Deliverable | Dependencies | Effort |
|------|-------------|--------------|--------|
| 1.1 | Document Type Registry (type definitions, template structures, rubric definitions) | None | M |
| 1.2 | Frontmatter schema and parser/validator | 1.1 | M |
| 1.3 | Document Storage Layer (directory layout, atomic writes, CRUD operations) | 1.2 | L |
| 1.4 | Template Engine (rendering, validation) | 1.1, 1.2 | M |
| 1.5 | Versioning Engine (version creation, basic diff, version history) | 1.3 | M |
| 1.6 | Pipeline Flow Controller (state machine, linear progression, pause/cancel) | 1.3, 1.5 | L |
| 1.7 | Basic Decomposition Engine (1:N splitting, dependency graph, no smoke test) | 1.3, 1.4 | L |
| 1.8 | Basic Traceability (forward-only, `traces_from`/`traces_to` population) | 1.3 | M |
| 1.9 | Audit logging | 1.6 | S |

### Phase 2: Quality & Intelligence

**Goal**: Richer review mechanics, backward cascades, gap detection.

| Step | Deliverable | Dependencies | Effort |
|------|-------------|--------------|--------|
| 2.1 | Decomposition smoke test (coverage, scope creep, contradiction check) | 1.7 | M |
| 2.2 | Traceability matrix regeneration and gap detection | 1.8 | M |
| 2.3 | Backward Cascade Controller (initiation, scoping, child re-evaluation) | 1.6, 2.2 | L |
| 2.4 | Quality regression detection and rollback | 1.5 | M |
| 2.5 | Structured diff (section-level, not just text-level) | 1.5 | M |
| 2.6 | Pipeline event emission | 1.6 | S |
| 2.7 | Parallel sibling execution support in Flow Controller | 1.6 | M |

### Phase 3: Optimization & Observability

**Goal**: Advanced features, tuning, analytics.

| Step | Deliverable | Dependencies | Effort |
|------|-------------|--------------|--------|
| 3.1 | Configurable templates (operator customization) | 1.4 | M |
| 3.2 | Orphan detection | 2.2 | S |
| 3.3 | Impact analysis | 2.2 | M |
| 3.4 | Partial cancellation (subtree) | 1.6 | M |
| 3.5 | Priority scheduling integration | 1.6 | S |
| 3.6 | Decomposition explosion detection and alerting | 1.7 | S |
| 3.7 | Version comparison (side-by-side diff with scores) | 2.5 | M |
| 3.8 | Observability metrics export | 2.6 | M |
| 3.9 | State reconciliation tool (rebuild pipeline.yaml from documents + audit log) | 1.6 | M |

Effort key: S = Small (< 1 day), M = Medium (1-3 days), L = Large (3-5 days)

---

## 11. Open Questions

| # | Question | Impact if Unresolved | Proposed Investigation |
|---|----------|---------------------|----------------------|
| OQ-1 | Should the traceability matrix be stored as a single YAML file or split per-phase? A single file simplifies gap detection but becomes large for big pipelines. | Performance degradation for large pipelines during matrix regeneration. | Benchmark regeneration time at 50, 100, and 200 nodes. If single-file regeneration stays under 5 seconds at 100 nodes, keep single file. |
| OQ-2 | How should the decomposition agent communicate its proposed children to the Decomposition Engine? Options: (a) agent returns structured YAML, (b) agent creates draft files directly, (c) agent returns natural language that the engine parses. | Determines the contract between the agent layer and the pipeline layer. | Option (a) is preferred for reliability. Prototype the agent interface and validate that LLM output reliably conforms to the YAML schema. |
| OQ-3 | Should the `current.md` symlink track be replaced with a `manifest.yaml` file inside each document directory that tracks the current version, all versions, and their metadata? This would consolidate per-document metadata and avoid symlink limitations. | Affects storage layer implementation and all consumers of `current.md`. | Prototype both approaches. Symlink is simpler but manifest is more portable and extensible. Decision needed before Phase 1.3. |
| OQ-4 | What is the right behavior when a backward cascade affects a document that is currently in-review? Should the review be aborted (wasting reviewer work), or should the review complete and then the document be marked stale? | Affects backward cascade latency and reviewer resource waste. | Let the review complete. The review findings may still be relevant after the cascade. Mark the document stale after the review completes. This avoids wasting reviewer work while still respecting the cascade. |
| OQ-5 | Should code deliverables (depth 4) store actual implementation files inside the pipeline directory, or should they reference files in the project source tree? Storing copies creates duplication; referencing creates fragile links. | Affects storage size and the integrity of Code document artifacts. | Store copies in the pipeline directory for audit purposes. The actual project source tree is managed by git. The Code document serves as a record of what was delivered, not the canonical source. |
| OQ-6 | How should inter-pipeline traceability work? If Pipeline B's PRD references requirements from Pipeline A's PRD, should the traceability matrix span pipelines? | Affects whether cross-pipeline requirements can be tracked and validated. | Out of scope for this TDD. Defer to a future cross-pipeline traceability design. For now, each pipeline's traceability is self-contained. |
| OQ-7 | Should the Pipeline Flow Controller be a long-running process or an event-driven function that is invoked by the core daemon (PRD-001)? | Determines integration pattern with the system core. | Event-driven function invoked by the daemon. The daemon manages lifecycle; the flow controller manages pipeline logic. This aligns with PRD-001's process supervisor model. |
