# SPEC-003-1-04: Template Interfaces, Template Definitions, Template Engine, and Config Schema

## Metadata
- **Parent Plan**: PLAN-003-1
- **Tasks Covered**: Task 9, Task 10, Task 11, Task 12
- **Estimated effort**: 19 hours

## Description
Define the template data structures, implement all five document templates (PRD, TDD, Plan, Spec, Code), build the Template Engine that renders blank documents and validates authored documents against template structure, and define the typed configuration schema for `config.yaml`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/types/template.ts` | Create |
| `src/pipeline/templates/prd-template.ts` | Create |
| `src/pipeline/templates/tdd-template.ts` | Create |
| `src/pipeline/templates/plan-template.ts` | Create |
| `src/pipeline/templates/spec-template.ts` | Create |
| `src/pipeline/templates/code-template.ts` | Create |
| `src/pipeline/templates/index.ts` | Create (barrel) |
| `src/pipeline/template-engine/template-engine.ts` | Create |
| `src/pipeline/types/config.ts` | Create |

## Implementation Details

### Task 9: `src/pipeline/types/template.ts`

```typescript
export interface TemplateSection {
  /** Unique section identifier, e.g. 'executive-summary' */
  id: string;
  /** The Markdown heading text */
  heading: string;
  /** Heading level (1=H1, 2=H2, 3=H3, etc.) */
  level: number;
  /** Whether this section must be present */
  required: boolean;
  /** Description/guidance for what should be in this section */
  description: string;
  /** Minimum word count for this section (0 = no minimum) */
  minWordCount: number;
  /** Nested subsections */
  subsections: TemplateSection[];
  /** ID of the rubric category this section maps to for scoring */
  rubricCategoryId: string | null;
}

export interface DocumentTemplate {
  /** Template identifier, e.g. 'prd-v1' */
  id: string;
  /** Document type this template is for */
  documentType: string;
  /** Template version for evolution tracking */
  version: string;
  /** Top-level sections */
  sections: TemplateSection[];
  /** Whether custom (non-template) sections are allowed */
  customSectionsAllowed: boolean;
  /** Default frontmatter values for documents created from this template */
  frontmatterDefaults: Record<string, unknown>;
}
```

### Task 10: Template Definitions

Each template file exports a `DocumentTemplate` constant. Example structure for PRD (9 sections):

```typescript
// src/pipeline/templates/prd-template.ts
import { DocumentTemplate } from '../types/template';

export const PRD_TEMPLATE: DocumentTemplate = {
  id: 'prd-v1',
  documentType: 'PRD',
  version: '1.0',
  customSectionsAllowed: false,
  frontmatterDefaults: {
    status: 'draft',
    version: '1.0',
    depth: 0,
    sibling_index: 0,
    sibling_count: 1,
    execution_mode: 'sequential',
    priority: 'normal',
    traces_from: [],
    traces_to: [],
    depends_on: [],
    dependency_type: [],
  },
  sections: [
    {
      id: 'executive-summary',
      heading: 'Executive Summary',
      level: 2,
      required: true,
      description: 'High-level overview of the product direction',
      minWordCount: 100,
      subsections: [],
      rubricCategoryId: 'completeness',
    },
    {
      id: 'problem-statement',
      heading: 'Problem Statement',
      level: 2,
      required: true,
      description: 'The problem being solved and why it matters',
      minWordCount: 150,
      subsections: [],
      rubricCategoryId: 'user_value',
    },
    {
      id: 'goals-and-objectives',
      heading: 'Goals and Objectives',
      level: 2,
      required: true,
      description: 'Measurable goals and success criteria',
      minWordCount: 100,
      subsections: [],
      rubricCategoryId: 'scope_definition',
    },
    {
      id: 'user-stories',
      heading: 'User Stories',
      level: 2,
      required: true,
      description: 'Key user stories in standard format',
      minWordCount: 200,
      subsections: [],
      rubricCategoryId: 'user_value',
    },
    {
      id: 'functional-requirements',
      heading: 'Functional Requirements',
      level: 2,
      required: true,
      description: 'Detailed functional requirements',
      minWordCount: 300,
      subsections: [],
      rubricCategoryId: 'completeness',
    },
    {
      id: 'non-functional-requirements',
      heading: 'Non-Functional Requirements',
      level: 2,
      required: true,
      description: 'Performance, security, scalability requirements',
      minWordCount: 150,
      subsections: [],
      rubricCategoryId: 'feasibility',
    },
    {
      id: 'scope-and-constraints',
      heading: 'Scope and Constraints',
      level: 2,
      required: true,
      description: 'What is in/out of scope; known constraints',
      minWordCount: 100,
      subsections: [],
      rubricCategoryId: 'scope_definition',
    },
    {
      id: 'acceptance-criteria',
      heading: 'Acceptance Criteria',
      level: 2,
      required: true,
      description: 'Criteria for considering the PRD satisfied',
      minWordCount: 100,
      subsections: [],
      rubricCategoryId: 'acceptance_criteria',
    },
    {
      id: 'risks-and-mitigations',
      heading: 'Risks and Mitigations',
      level: 2,
      required: true,
      description: 'Identified risks and mitigation strategies',
      minWordCount: 100,
      subsections: [],
      rubricCategoryId: 'risk_assessment',
    },
  ],
};
```

Section counts per template:
- **PRD**: 9 sections (executive-summary, problem-statement, goals-and-objectives, user-stories, functional-requirements, non-functional-requirements, scope-and-constraints, acceptance-criteria, risks-and-mitigations)
- **TDD**: 13 sections (overview, architecture, data-models, api-design, error-handling, security, testing-strategy, deployment, performance, monitoring, dependencies, migration, appendices)
- **Plan**: 7 sections (objective, scope, tasks, dependencies, testing-strategy, risks, definition-of-done)
- **Spec**: 6 sections (description, files-to-create-modify, implementation-details, acceptance-criteria, test-cases, notes)
- **Code**: 5 sections (overview, implementation, tests, documentation, changelog)

### Task 11: `src/pipeline/template-engine/template-engine.ts`

```typescript
import { DocumentTemplate, TemplateSection } from '../types/template';
import { DocumentType } from '../types/document-type';
import { QualityRubric } from '../types/quality-rubric';
import { DocumentFrontmatter } from '../types/frontmatter';

export interface RenderOptions {
  /** Document title */
  title: string;
  /** Frontmatter field overrides */
  frontmatterOverrides?: Partial<DocumentFrontmatter>;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateValidationError[];
  warnings: TemplateValidationError[];
}

export interface TemplateValidationError {
  /** Which section or aspect failed */
  sectionId: string | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Validation codes:
 *   MISSING_SECTION          - required section not found in document
 *   EMPTY_SECTION            - required section is present but has no content
 *   BELOW_WORD_COUNT         - section word count below minimum
 *   GUIDANCE_COMMENT_PRESENT - template guidance comment not removed
 *   FRONTMATTER_INCOMPLETE   - frontmatter missing required fields
 *   UNKNOWN_SECTION          - section not in template (when customSectionsAllowed=false)
 */

export class TemplateEngine {
  private templates: Map<string, DocumentTemplate>;

  constructor() {
    this.templates = new Map();
    // Register all 5 templates in constructor
  }

  /**
   * Returns the template for the given document type.
   * @throws Error if type has no registered template.
   */
  getTemplate(type: DocumentType): DocumentTemplate { ... }

  /**
   * Renders a blank document from the template with initial values.
   *
   * Output format:
   * ---
   * {frontmatter YAML}
   * ---
   * # {title}
   *
   * ## {section.heading}
   * <!-- Guidance: {section.description} -->
   *
   * (repeat for all sections and subsections)
   *
   * @returns Rendered Markdown string with frontmatter
   */
  renderTemplate(type: DocumentType, options: RenderOptions): string { ... }

  /**
   * Validates an authored document against its template structure.
   *
   * Checks (per TDD Section 3.3.7):
   * 1. Frontmatter completeness (delegates to frontmatter validator)
   * 2. All required sections present (by heading match)
   * 3. Required sections are non-empty (have content beyond guidance comments)
   * 4. Sections meet minimum word counts
   * 5. Guidance comments removed (no <!-- Guidance: ... --> markers)
   * 6. No unknown sections when customSectionsAllowed=false
   *
   * @param content Full Markdown document content
   * @param type Document type (determines which template to validate against)
   * @returns TemplateValidationResult with errors and warnings
   */
  validateDocument(content: string, type: DocumentType): TemplateValidationResult { ... }

  /**
   * Returns the quality rubric for the given document type.
   */
  getRubric(type: DocumentType): QualityRubric { ... }
}
```

**Rendering pseudocode**:
```
function renderTemplate(type, options):
  template = getTemplate(type)
  frontmatter = { ...template.frontmatterDefaults, ...options.frontmatterOverrides }
  frontmatter.title = options.title
  frontmatter.type = type
  frontmatter.created_at = now()
  frontmatter.updated_at = now()

  output = "---\n"
  output += yaml.dump(frontmatter)
  output += "---\n\n"
  output += "# " + options.title + "\n\n"

  for section in template.sections:
    output += "#".repeat(section.level) + " " + section.heading + "\n"
    output += "<!-- Guidance: " + section.description + " -->\n\n"
    for subsection in section.subsections:
      output += "#".repeat(subsection.level) + " " + subsection.heading + "\n"
      output += "<!-- Guidance: " + subsection.description + " -->\n\n"

  return output
```

**Validation pseudocode**:
```
function validateDocument(content, type):
  template = getTemplate(type)
  errors = []
  warnings = []

  // 1. Parse frontmatter
  parseResult = parseFrontmatter(content)
  if parseResult.error:
    errors.push({ sectionId: null, code: 'FRONTMATTER_INCOMPLETE', ... })

  // 2. Parse sections from body (split on heading regex)
  documentSections = parseSections(parseResult.body)
  documentSectionIds = Set(documentSections.map(s => deriveSectionId(s.heading)))

  // 3. Check required sections
  for section in template.sections:
    if section.required and section.id not in documentSectionIds:
      errors.push({ sectionId: section.id, code: 'MISSING_SECTION', ... })

  // 4. Check non-empty and word counts
  for section in template.sections:
    docSection = findMatchingSection(documentSections, section)
    if docSection and isContentEmpty(docSection):
      errors.push({ sectionId: section.id, code: 'EMPTY_SECTION', ... })
    if docSection and wordCount(docSection) < section.minWordCount:
      errors.push({ sectionId: section.id, code: 'BELOW_WORD_COUNT', ... })

  // 5. Check guidance comments removed
  if content.includes('<!-- Guidance:'):
    errors.push({ sectionId: null, code: 'GUIDANCE_COMMENT_PRESENT', ... })

  // 6. Unknown sections
  if not template.customSectionsAllowed:
    for docSection in documentSections:
      if docSection.id not in templateSectionIds:
        warnings.push({ sectionId: docSection.id, code: 'UNKNOWN_SECTION', ... })

  return { valid: errors.length === 0, errors, warnings }
```

### Task 12: `src/pipeline/types/config.ts`

```typescript
import { DocumentType } from './document-type';
import { ReviewGateConfig } from './review-gate-config';

export interface PipelineConfig {
  pipeline: {
    /** Maximum depth of the pipeline tree (hardcoded to 4, not configurable) */
    maxDepth: 4;
    /** Root directory for pipeline storage */
    rootDir: string;
  };
  decomposition: {
    /** Maximum children per decomposition */
    maxChildrenPerDecomposition: number;
    /** Maximum total nodes in a pipeline */
    maxTotalNodes: number;
    /** Explosion threshold percentage of maxTotalNodes */
    explosionThresholdPercent: number;
    /** Whether smoke test is required for decomposition */
    smokeTestRequired: boolean;
  };
  versioning: {
    /** Maximum versions per document */
    maxVersionsPerDocument: number;
  };
  reviewGates: {
    /** Default config applied when no per-type override exists */
    defaults: ReviewGateConfig;
    /** Per-type overrides (merged on top of defaults) */
    overrides: Partial<Record<DocumentType, Partial<ReviewGateConfig>>>;
  };
  backwardCascade: {
    /** Maximum cascade depth before human escalation */
    maxDepth: number;
    /** Whether to auto-approve unaffected children after cascade */
    autoApproveUnaffected: boolean;
  };
  storage: {
    /** Maximum documents per pipeline */
    maxDocumentsPerPipeline: number;
    /** Maximum versions per document */
    maxVersionsPerDocument: number;
    /** Maximum total pipeline size in bytes */
    maxTotalSizeBytes: number;
    /** Maximum single document size in bytes */
    maxDocumentSizeBytes: number;
  };
  traceability: {
    /** Whether gap detection runs at review gates */
    gapDetectionAtGates: boolean;
    /** Whether orphan detection runs at review gates */
    orphanDetectionAtGates: boolean;
  };
}

/**
 * Default configuration values.
 * Every field has a default so config.yaml is entirely optional.
 */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  pipeline: {
    maxDepth: 4,
    rootDir: '.autonomous-dev/pipelines',
  },
  decomposition: {
    maxChildrenPerDecomposition: 10,
    maxTotalNodes: 100,
    explosionThresholdPercent: 75,
    smokeTestRequired: true,
  },
  versioning: {
    maxVersionsPerDocument: 20,
  },
  reviewGates: {
    defaults: {
      panelSize: 1,
      maxIterations: 3,
      approvalThreshold: 85,
      regressionMargin: 5,
    },
    overrides: {},
  },
  backwardCascade: {
    maxDepth: 2,
    autoApproveUnaffected: true,
  },
  storage: {
    maxDocumentsPerPipeline: 100,
    maxVersionsPerDocument: 20,
    maxTotalSizeBytes: 500 * 1024 * 1024, // 500 MB
    maxDocumentSizeBytes: 1 * 1024 * 1024, // 1 MB
  },
  traceability: {
    gapDetectionAtGates: true,
    orphanDetectionAtGates: true,
  },
};
```

## Acceptance Criteria
1. `TemplateSection` and `DocumentTemplate` interfaces match TDD Section 3.3.1 structure.
2. All 5 templates have the correct section count: PRD (9), TDD (13), Plan (7), Spec (6), Code (5).
3. `renderTemplate` produces valid Markdown with frontmatter, title, and all template sections including guidance comments.
4. `validateDocument` detects: missing required sections, empty sections, sections below word count, unremoved guidance comments, unknown sections.
5. `validateDocument` returns `valid: true` for a fully authored document with all required sections present, non-empty, and above word count.
6. `getRubric` returns the correct rubric for each type.
7. `PipelineConfig` has typed fields for all sections from TDD Section 4.1.
8. `DEFAULT_PIPELINE_CONFIG` provides valid defaults for every field.
9. `pipeline.maxDepth` is hardcoded to 4 (not configurable).

## Test Cases

### Unit Tests: `tests/pipeline/templates/template-definitions.test.ts`
- `PRD template has 9 sections` (and correct IDs)
- `TDD template has 13 sections`
- `Plan template has 7 sections`
- `Spec template has 6 sections`
- `Code template has 5 sections`
- `All templates have valid version strings`
- `All template sections have unique IDs within their template`
- `All required sections have minWordCount > 0`

### Unit Tests: `tests/pipeline/template-engine/template-engine.test.ts`
- `getTemplate returns correct template for each type`
- `getTemplate throws for unknown type`
- `renderTemplate produces markdown starting with ---`
- `renderTemplate includes all section headings`
- `renderTemplate includes guidance comments`
- `renderTemplate applies title to frontmatter and H1`
- `renderTemplate applies frontmatter overrides`
- `validateDocument returns valid for fully authored document`
- `validateDocument detects missing required section`
- `validateDocument detects empty required section`
- `validateDocument detects section below word count`
- `validateDocument detects unremoved guidance comments`
- `validateDocument detects unknown sections when customSectionsAllowed=false`
- `getRubric returns PRD rubric for PRD type`

### Snapshot Tests: `tests/pipeline/templates/snapshots/`
- `PRD template renders to expected markdown` (snapshot)
- `TDD template renders to expected markdown` (snapshot)
- `Plan template renders to expected markdown` (snapshot)
- `Spec template renders to expected markdown` (snapshot)
- `Code template renders to expected markdown` (snapshot)

### Unit Tests: `tests/pipeline/types/config.test.ts`
- `DEFAULT_PIPELINE_CONFIG has all required fields`
- `DEFAULT_PIPELINE_CONFIG.pipeline.maxDepth is 4`
- `DEFAULT_PIPELINE_CONFIG.storage limits are correct`
- `DEFAULT_PIPELINE_CONFIG.decomposition.maxChildrenPerDecomposition is 10`
- `DEFAULT_PIPELINE_CONFIG.backwardCascade.maxDepth is 2`
