# SPEC-003-1-03: Frontmatter Schema, Parser, Validator, and ID Generator

## Metadata
- **Parent Plan**: PLAN-003-1
- **Tasks Covered**: Task 6, Task 7, Task 8
- **Estimated effort**: 13 hours

## Description
Implement the YAML frontmatter subsystem: type definitions for all frontmatter fields, a parser that extracts and deserializes the `---` delimited header from Markdown, a validator that enforces all rules from TDD Section 3.2.2 (required fields, types, regex patterns, cross-field consistency), and a deterministic document ID generator.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/types/frontmatter.ts` | Create |
| `src/pipeline/frontmatter/parser.ts` | Create |
| `src/pipeline/frontmatter/validator.ts` | Create |
| `src/pipeline/frontmatter/id-generator.ts` | Create |
| `src/pipeline/frontmatter/index.ts` | Create (barrel) |

## Implementation Details

### Task 6a: `src/pipeline/types/frontmatter.ts`

```typescript
import { DocumentType } from './document-type';

export type DocumentStatus =
  | 'draft'
  | 'in-review'
  | 'approved'
  | 'revision-requested'
  | 'rejected'
  | 'cancelled'
  | 'stale';

export type ExecutionMode = 'parallel' | 'sequential';
export type DependencyType = 'blocks' | 'informs';
export type Priority = 'critical' | 'high' | 'normal' | 'low';

export type VersionReason =
  | 'INITIAL'
  | 'REVIEW_REVISION'
  | 'BACKWARD_CASCADE'
  | 'ROLLBACK';

export interface DocumentFrontmatter {
  /** Document ID, e.g. "PRD-001" or "TDD-001-01" */
  id: string;
  /** Title of the document */
  title: string;
  /** Pipeline this document belongs to */
  pipeline_id: string;
  /** Document type */
  type: DocumentType;
  /** Current status */
  status: DocumentStatus;
  /** Current version string, e.g. "1.0" */
  version: string;
  /** ISO 8601 creation timestamp */
  created_at: string;
  /** ISO 8601 last-update timestamp */
  updated_at: string;
  /** Agent ID that authored or last revised this document */
  author_agent: string;
  /** Parent document ID (null for root PRDs) */
  parent_id: string | null;
  /** Array of section IDs in the parent that this document addresses */
  traces_from: string[];
  /** Array of child document IDs produced by decomposition */
  traces_to: string[];
  /** Depth in pipeline (0 = PRD, 4 = CODE) */
  depth: number;
  /** 0-based index among siblings */
  sibling_index: number;
  /** Total number of siblings in this decomposition */
  sibling_count: number;
  /** IDs of sibling documents this one depends on */
  depends_on: string[];
  /** Type of each dependency (parallel array with depends_on) */
  dependency_type: DependencyType[];
  /** Whether this document can execute in parallel or must be sequential */
  execution_mode: ExecutionMode;
  /** Pipeline priority */
  priority: Priority;
}
```

### Task 6b: `src/pipeline/frontmatter/parser.ts`

```typescript
import yaml from 'js-yaml';
import { DocumentFrontmatter } from '../types/frontmatter';

/**
 * Result of parsing a Markdown document's frontmatter.
 */
export interface ParseResult {
  /** Parsed frontmatter object (may be partial/untyped before validation) */
  frontmatter: Partial<DocumentFrontmatter>;
  /** Raw YAML string between the --- delimiters */
  rawYaml: string;
  /** Markdown body after the frontmatter block */
  body: string;
  /** Full raw content of the document */
  rawContent: string;
}

export interface ParseError {
  code: 'NO_FRONTMATTER' | 'MALFORMED_YAML' | 'EMPTY_FRONTMATTER';
  message: string;
  line?: number;
}

/**
 * Extracts YAML frontmatter from a Markdown document.
 *
 * Algorithm:
 * 1. Check if content starts with '---\n' (or '---\r\n').
 * 2. Find the closing '---\n' delimiter.
 * 3. Extract the YAML string between the delimiters.
 * 4. Parse with js-yaml safeLoad.
 * 5. Return ParseResult with frontmatter, body, rawYaml, rawContent.
 *
 * Edge cases:
 * - No frontmatter: return ParseError with code NO_FRONTMATTER.
 * - Empty frontmatter (---\n---): return ParseError with code EMPTY_FRONTMATTER.
 * - Malformed YAML: return ParseError with code MALFORMED_YAML and line number.
 * - Frontmatter only (no body): body is empty string.
 *
 * @param content Raw Markdown file content
 * @returns ParseResult on success
 * @throws FrontmatterParseError on failure
 */
export function parseFrontmatter(content: string): ParseResult {
  // Implementation: regex-free approach using indexOf for robustness
  const DELIMITER = '---';
  const firstDelimEnd = content.indexOf('\n', 0);
  // ... validate first line is exactly '---'
  // ... find second '---' on its own line
  // ... extract yaml substring, parse with js-yaml
  // ... return { frontmatter, rawYaml, body, rawContent }
}
```

### Task 7: `src/pipeline/frontmatter/validator.ts`

```typescript
export interface ValidationError {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface FrontmatterValidationResult {
  valid: boolean;
  errors: ValidationError[];   // blocking issues
  warnings: ValidationError[]; // non-blocking issues
}

/**
 * Validates parsed frontmatter against TDD Section 3.2.2 rules.
 *
 * Validation rules (all from TDD Section 3.2.2):
 *
 * Required fields (error if missing):
 *   id, title, pipeline_id, type, status, version, created_at,
 *   updated_at, author_agent, depth, sibling_index, sibling_count,
 *   execution_mode, priority
 *
 * Conditionally required:
 *   parent_id    - required when depth > 0
 *   traces_from  - required when depth > 0 (must be non-empty)
 *
 * Type checks:
 *   id           - string matching /^(PRD|TDD|PLAN|SPEC|CODE)-\d{3}(-\d{2})?$/
 *   pipeline_id  - string matching /^PIPE-\d{4}-\d{4}-\d{3}$/
 *   version      - string matching /^\d+\.\d+$/
 *   type         - must be valid DocumentType enum value
 *   status       - must be valid DocumentStatus value
 *   depth        - integer 0-4
 *   created_at   - valid ISO 8601 datetime
 *   updated_at   - valid ISO 8601 datetime
 *   priority     - one of: critical, high, normal, low
 *   execution_mode - one of: parallel, sequential
 *
 * Cross-field consistency:
 *   depth matches getDepth(type)
 *   updated_at >= created_at
 *   depends_on.length === dependency_type.length
 *   sibling_index < sibling_count
 *   parent_id is null when depth === 0
 *   parent_id is non-null when depth > 0
 *
 * Warnings (non-blocking):
 *   Unknown fields (not in schema) - preserved but warned
 *   traces_to is empty for non-CODE document (may not have decomposed yet)
 */
export function validateFrontmatter(
  frontmatter: Partial<DocumentFrontmatter>,
): FrontmatterValidationResult { ... }
```

### Task 8: `src/pipeline/frontmatter/id-generator.ts`

```typescript
import { DocumentType } from '../types/document-type';

/**
 * Interface for the atomic counter backing the ID generator.
 * Injectable for testability (in-memory counter for tests,
 * file-based counter for production).
 */
export interface IdCounter {
  /** Returns and increments the next sequence number for the given scope. */
  next(scope: string): Promise<number>;
}

/**
 * In-memory counter for testing.
 */
export class InMemoryIdCounter implements IdCounter {
  private counters: Map<string, number> = new Map();
  async next(scope: string): Promise<number> {
    const current = this.counters.get(scope) ?? 0;
    const next = current + 1;
    this.counters.set(scope, next);
    return next;
  }
}

/**
 * Generates deterministic document IDs.
 *
 * Format:
 *   Root PRDs: {TYPE}-{SEQ}        e.g. "PRD-001"
 *   Children:  {TYPE}-{PIPE_SEQ}-{DOC_SEQ}  e.g. "TDD-001-01"
 *
 * Where:
 *   TYPE     = DocumentType enum value
 *   SEQ      = 3-digit zero-padded pipeline sequence
 *   PIPE_SEQ = pipeline sequence from pipeline ID (e.g., "001" from "PIPE-2026-0408-001")
 *   DOC_SEQ  = 2-digit zero-padded document sequence within type
 *
 * @param type The document type
 * @param pipelineId The pipeline ID (used to extract PIPE_SEQ)
 * @param counter The counter to use for sequence generation
 * @returns Generated document ID string
 */
export async function generateDocumentId(
  type: DocumentType,
  pipelineId: string,
  counter: IdCounter,
): Promise<string> {
  const pipeSeq = pipelineId.split('-').pop()!; // "001" from "PIPE-2026-0408-001"
  const docSeq = await counter.next(`${pipelineId}:${type}`);

  if (type === DocumentType.PRD) {
    return `PRD-${pipeSeq}`;
  }

  return `${type}-${pipeSeq}-${String(docSeq).padStart(2, '0')}`;
}
```

### Barrel: `src/pipeline/frontmatter/index.ts`

```typescript
export { parseFrontmatter, type ParseResult, type ParseError } from './parser';
export { validateFrontmatter, type FrontmatterValidationResult, type ValidationError } from './validator';
export { generateDocumentId, type IdCounter, InMemoryIdCounter } from './id-generator';
```

## Acceptance Criteria
1. `parseFrontmatter` correctly extracts YAML between `---` delimiters and returns typed `ParseResult`.
2. `parseFrontmatter` throws structured `ParseError` for: no frontmatter, empty frontmatter, malformed YAML.
3. Documents with no body (frontmatter only) return empty string for `body`.
4. `validateFrontmatter` enforces all required fields -- returns error for each missing required field.
5. `validateFrontmatter` enforces regex patterns: `id` matches `^(PRD|TDD|PLAN|SPEC|CODE)-\d{3}(-\d{2})?$`, `pipeline_id` matches `^PIPE-\d{4}-\d{4}-\d{3}$`, `version` matches `^\d+\.\d+$`.
6. Cross-field validations: `depth` matches `getDepth(type)`, `updated_at >= created_at`, `depends_on.length === dependency_type.length`, `sibling_index < sibling_count`.
7. Unknown fields produce warnings, not errors (preserved in output).
8. `generateDocumentId` produces IDs matching the documented format.
9. Root PRDs use format `PRD-{SEQ}` without document sequence.
10. ID counter is injectable; `InMemoryIdCounter` prevents collisions.

## Test Cases

### Unit Tests: `tests/pipeline/frontmatter/parser.test.ts`
- `parses valid frontmatter with all fields`
- `returns body after frontmatter`
- `throws NO_FRONTMATTER when document has no --- delimiter`
- `throws EMPTY_FRONTMATTER when --- immediately followed by ---`
- `throws MALFORMED_YAML for invalid YAML syntax`
- `handles document with frontmatter but no body`
- `handles multiline YAML strings in frontmatter`
- `preserves raw YAML string in result`
- `handles Windows line endings (CRLF)`
- `handles frontmatter with special characters`

### Unit Tests: `tests/pipeline/frontmatter/validator.test.ts`
- `returns valid for complete, correct frontmatter`
- `returns error for each missing required field` (parameterized)
- `returns error when id does not match regex pattern`
- `returns error when pipeline_id does not match regex`
- `returns error when version does not match regex`
- `returns error when type is not a valid DocumentType`
- `returns error when status is not a valid DocumentStatus`
- `returns error when depth does not match type`
- `returns error when updated_at < created_at`
- `returns error when depends_on.length !== dependency_type.length`
- `returns error when sibling_index >= sibling_count`
- `returns error when parent_id is null and depth > 0`
- `returns error when parent_id is non-null and depth === 0`
- `returns warning for unknown fields`
- `returns error when traces_from is empty for depth > 0`

### Unit Tests: `tests/pipeline/frontmatter/id-generator.test.ts`
- `generates PRD ID as PRD-{SEQ} format`
- `generates TDD ID as TDD-{SEQ}-{DOC_SEQ} format`
- `generates PLAN, SPEC, CODE IDs correctly`
- `sequential calls produce incrementing document sequences`
- `different types have independent counters`
- `pads sequences with leading zeros`
- `InMemoryIdCounter starts at 1`
- `no collisions across 10,000 generated IDs` (property-based)
