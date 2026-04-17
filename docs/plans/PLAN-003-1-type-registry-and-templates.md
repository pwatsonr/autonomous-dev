# PLAN-003-1: Document Type Registry, Frontmatter Schema, and Template Engine

## Metadata
- **Parent TDD**: TDD-003-document-pipeline
- **Estimated effort**: 7 days
- **Dependencies**: None (foundation plan)
- **Blocked by**: None
- **Priority**: P0

## Objective
Deliver the foundational type system that every other pipeline subsystem depends on: the Document Type Registry (type definitions, rubric structures, review gate defaults), the YAML frontmatter schema (parsing, validation, ID generation), and the Template Engine (rendering, structural validation, rubric retrieval). After this plan, the system can define document types, render blank documents from templates, parse and validate frontmatter, and enforce template conformance -- but cannot yet persist or version them.

## Scope
### In Scope
- TDD Section 3.1: Document Type Registry (type definitions, rubric definition structure, review gate configuration, pipeline order)
- TDD Section 3.2: Frontmatter Schema (full schema, validation rules, document ID generation)
- TDD Section 3.3: Template Engine (template structure, all five complete templates -- PRD/TDD/Plan/Spec/Code, template validation, rubric retrieval)
- TDD Section 4.1: Configuration schema (`config.yaml`) -- the parts relevant to review gate defaults, decomposition limits, and versioning thresholds (schema definition only; file I/O belongs to PLAN-003-2)
- TDD Section 5.2: Template Engine API contract

### Out of Scope
- File persistence and directory layout (PLAN-003-2)
- Version creation and diff computation (PLAN-003-3)
- Decomposition, traceability, cascade logic (PLAN-003-4, PLAN-003-5)
- Pipeline state machine (PLAN-003-5)
- Review gate scoring algorithms (separate TDD)
- Agent orchestration (PRD-003/PRD-004)

## Tasks

1. **Define DocumentType enum and PIPELINE_ORDER** -- Implement the `DocumentType` enum (PRD, TDD, PLAN, SPEC, CODE) and the `PIPELINE_ORDER` constant array. These are referenced throughout every other subsystem.
   - Files to create: `src/pipeline/types/document-type.ts`
   - Acceptance criteria: Enum values match TDD Section 3.1.1; PIPELINE_ORDER maps index to depth correctly; exporting both for downstream consumption.
   - Estimated effort: 2 hours

2. **Define DocumentTypeDefinition interface and registry** -- Implement the `DocumentTypeDefinition` interface (type, label, depth, childType, parentType, template, rubric, reviewConfig, decompositionStrategy) and the registry that stores all five definitions.
   - Files to create: `src/pipeline/types/document-type-definition.ts`, `src/pipeline/registry/document-type-registry.ts`
   - Acceptance criteria: All five document types registered with correct depth, parent/child relationships, and decomposition strategies per TDD Section 3.1.1. Registry provides `getDefinition(type)` and `getAllDefinitions()` methods. CODE has `childType: null`; PRD has `parentType: null`.
   - Estimated effort: 4 hours

3. **Define RubricCategory and QualityRubric interfaces** -- Implement rubric data models with scoring guide, weights, minimum scores, and aggregation method.
   - Files to create: `src/pipeline/types/quality-rubric.ts`
   - Acceptance criteria: Interfaces match TDD Section 3.1.2. All weights for each rubric sum to 1.0. Aggregation methods: mean, median, min.
   - Estimated effort: 2 hours

4. **Implement per-type rubric definitions** -- Define the complete rubric for each document type (PRD: 7 categories, TDD: 7 categories, Plan: 6 categories, Spec: 6 categories, Code: 7 categories) with weights and minimum scores per TDD Sections 3.3.2-3.3.6.
   - Files to create: `src/pipeline/registry/rubrics/prd-rubric.ts`, `src/pipeline/registry/rubrics/tdd-rubric.ts`, `src/pipeline/registry/rubrics/plan-rubric.ts`, `src/pipeline/registry/rubrics/spec-rubric.ts`, `src/pipeline/registry/rubrics/code-rubric.ts`
   - Acceptance criteria: Each rubric matches the table in the TDD exactly (category IDs, weights, min scores, descriptions). Weights sum to 1.0 for each rubric. All rubrics pass a self-consistency validation test.
   - Estimated effort: 4 hours

5. **Define ReviewGateConfig interface and per-type defaults** -- Implement the review gate configuration with panel size, max iterations, approval threshold, and regression margin defaults.
   - Files to create: `src/pipeline/types/review-gate-config.ts`
   - Acceptance criteria: Defaults match TDD Section 3.1.3 exactly (PRD/TDD: panelSize 2; Plan/Spec: panelSize 1; Code: panelSize 2; all: maxIterations 3, approvalThreshold 85, regressionMargin 5).
   - Estimated effort: 2 hours

6. **Implement frontmatter schema and parser** -- Build a YAML frontmatter parser that extracts the `---` delimited header from Markdown content and parses it into a typed object. Handle edge cases: missing delimiters, empty frontmatter, malformed YAML.
   - Files to create: `src/pipeline/frontmatter/parser.ts`, `src/pipeline/types/frontmatter.ts`
   - Acceptance criteria: Parses all fields defined in TDD Section 3.2.1. Returns typed `DocumentFrontmatter` object. Throws structured error on malformed YAML. Handles documents with no frontmatter gracefully.
   - Estimated effort: 4 hours

7. **Implement frontmatter validator** -- Validate parsed frontmatter against the rules in TDD Section 3.2.2: required fields, type checking, regex patterns for IDs and versions, cross-field consistency (depth matches type, `updated_at >= created_at`, `depends_on` length matches `dependency_type`).
   - Files to create: `src/pipeline/frontmatter/validator.ts`
   - Acceptance criteria: Every rule in the TDD 3.2.2 table is enforced. Returns `FrontmatterValidationResult` with errors (blocking) and warnings. Conditional rules enforced (e.g., `traces_from` required when `depth > 0`). Regex patterns match TDD exactly.
   - Estimated effort: 6 hours

8. **Implement document ID generator** -- Deterministic ID generation following the scheme `{TYPE}-{PIPELINE_SEQ}-{DOCUMENT_SEQ}` with atomic counter per type within a pipeline. Root PRDs omit the document sequence.
   - Files to create: `src/pipeline/frontmatter/id-generator.ts`
   - Acceptance criteria: Generated IDs match the format in TDD Section 3.2.3. Atomic counter prevents collisions under concurrent calls. Root PRDs use format `PRD-{SEQ}` without document sequence. Counter state is injectable for testability.
   - Estimated effort: 3 hours

9. **Define TemplateSection and DocumentTemplate interfaces** -- Model the template structure: section IDs, headings, levels, required flags, descriptions, min word counts, subsections, and rubric category mappings.
   - Files to create: `src/pipeline/types/template.ts`
   - Acceptance criteria: Interfaces match TDD Section 3.3.1. `customSectionsAllowed` flag supported. Template version tracking field present.
   - Estimated effort: 2 hours

10. **Implement complete templates for all five document types** -- Define the full template structure for PRD (9 sections), TDD (13 sections), Plan (7 sections), Spec (6 sections), and Code (5 sections) with all Markdown content, guidance comments, required/optional flags, and min word counts.
    - Files to create: `src/pipeline/templates/prd-template.ts`, `src/pipeline/templates/tdd-template.ts`, `src/pipeline/templates/plan-template.ts`, `src/pipeline/templates/spec-template.ts`, `src/pipeline/templates/code-template.ts`
    - Acceptance criteria: Each template renders to Markdown identical to the TDD Sections 3.3.2-3.3.6 examples. Frontmatter defaults are correct per type. All required sections marked as such.
    - Estimated effort: 6 hours

11. **Implement Template Engine (rendering and validation)** -- Build the engine that renders templates with initial values (title, frontmatter overrides) and validates authored documents against their template structure.
    - Files to create: `src/pipeline/template-engine/template-engine.ts`
    - Acceptance criteria: Implements `TemplateEngineAPI` from TDD Section 5.2 (`getTemplate`, `renderTemplate`, `validateDocument`, `getRubric`). Validation checks per TDD Section 3.3.7: frontmatter completeness, section presence, section non-emptiness, minimum word counts, guidance comment removal. Returns `TemplateValidationResult` with errors and warnings.
    - Estimated effort: 8 hours

12. **Define configuration schema types** -- Type definitions for `config.yaml` covering pipeline, decomposition, versioning, review_gates, backward_cascade, storage, and traceability sections.
    - Files to create: `src/pipeline/types/config.ts`
    - Acceptance criteria: Types cover all fields in TDD Section 4.1. Default values defined as constants. Per-type overrides supported for review gates.
    - Estimated effort: 3 hours

## Dependencies & Integration Points
- This plan has no upstream dependencies. It is the first plan to implement.
- All subsequent plans (PLAN-003-2 through PLAN-003-5) depend on types and interfaces defined here.
- The Template Engine API (Task 11) is consumed by the Document Storage Layer (PLAN-003-2) when creating new documents.
- The frontmatter parser/validator (Tasks 6-7) is consumed by every subsystem that reads documents.
- The ID generator (Task 8) is consumed by the Storage Layer and Decomposition Engine.

## Testing Strategy
- **Unit tests** for every task:
  - Frontmatter parser: valid/invalid YAML, missing fields, wrong types, edge cases (target: 95% coverage per TDD Section 8.1).
  - Frontmatter validator: every rule in the validation table, cross-field consistency.
  - Template validator: all document types, missing sections, empty sections, min word counts (target: 90% coverage).
  - ID generator: uniqueness, format validation, counter atomicity (target: 100% coverage).
  - Rubric definitions: weight sums, minimum scores, category completeness.
- **Property-based tests** for ID generation (no collisions across 10,000 generated IDs).
- **Snapshot tests** for rendered templates (each of the 5 types renders to expected Markdown).

## Risks
1. **Frontmatter schema evolution** -- The schema may need fields added in later plans. Mitigation: Design the parser and validator to be extensible; unknown fields are preserved (not rejected) with a warning.
2. **Template rigidity** -- Hardcoded templates may be too rigid for operator customization. Mitigation: The `customSectionsAllowed` flag and TDD Section 3.3 design already account for this; full customization is deferred to Phase 3 (PLAN-003-5 or later).
3. **YAML parsing edge cases** -- Multi-line strings, special characters, and anchors in YAML can cause parser issues. Mitigation: Use a well-tested YAML library (js-yaml); add explicit test cases for edge cases.

## Definition of Done
- [ ] All five `DocumentType` definitions registered and accessible via registry
- [ ] Frontmatter parser handles valid and invalid YAML correctly
- [ ] Frontmatter validator enforces all rules from TDD Section 3.2.2
- [ ] Document ID generator produces valid, collision-free IDs
- [ ] All five document templates render to correct Markdown
- [ ] Template Engine validates documents against template structure (section presence, non-emptiness, word counts, comment removal)
- [ ] All five rubrics defined with correct weights, minimum scores, and categories
- [ ] Configuration schema types defined with defaults
- [ ] Unit test coverage meets targets (95% frontmatter parser, 90% template validator, 100% ID generator)
- [ ] All public interfaces are documented with JSDoc comments
