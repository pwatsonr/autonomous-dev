import { DocumentType, getDepth, PIPELINE_ORDER } from '../types/document-type';
import {
  DocumentFrontmatter,
  DocumentStatus,
  ExecutionMode,
  Priority,
  DOCUMENT_STATUSES,
  EXECUTION_MODES,
  PRIORITIES,
  REQUIRED_FIELDS,
  ALL_KNOWN_FIELDS,
} from '../types/frontmatter';

export interface ValidationError {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface FrontmatterValidationResult {
  valid: boolean;
  errors: ValidationError[]; // blocking issues
  warnings: ValidationError[]; // non-blocking issues
}

/** Regex patterns for field validation */
const ID_PATTERN = /^(PRD|TDD|PLAN|SPEC|CODE)-\d{3}(-\d{2})?$/;
const PIPELINE_ID_PATTERN = /^PIPE-\d{4}-\d{4}-\d{3}$/;
const VERSION_PATTERN = /^\d+\.\d+$/;

/** Valid DocumentType values as strings */
const VALID_DOCUMENT_TYPES: readonly string[] = Object.values(DocumentType);

/**
 * Validates an ISO 8601 datetime string.
 * Accepts formats like: 2026-04-08T10:00:00Z, 2026-04-08T10:00:00.000Z,
 * 2026-04-08T10:00:00+00:00
 */
function isValidIso8601(value: string): boolean {
  const date = new Date(value);
  return !isNaN(date.getTime());
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
): FrontmatterValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const fm = frontmatter as Record<string, unknown>;

  // ---------------------------------------------------------------
  // 1. Required fields
  // ---------------------------------------------------------------
  for (const field of REQUIRED_FIELDS) {
    if (fm[field] === undefined || fm[field] === null) {
      errors.push({
        field,
        code: 'REQUIRED_FIELD_MISSING',
        message: `Required field '${field}' is missing`,
        severity: 'error',
      });
    }
  }

  // ---------------------------------------------------------------
  // 2. Type/format checks (only if field is present)
  // ---------------------------------------------------------------

  // id: string matching pattern
  if (fm.id !== undefined && fm.id !== null) {
    if (typeof fm.id !== 'string' || !ID_PATTERN.test(fm.id)) {
      errors.push({
        field: 'id',
        code: 'INVALID_FORMAT',
        message: `id '${fm.id}' does not match pattern ${ID_PATTERN}`,
        severity: 'error',
      });
    }
  }

  // pipeline_id: string matching pattern
  if (fm.pipeline_id !== undefined && fm.pipeline_id !== null) {
    if (
      typeof fm.pipeline_id !== 'string' ||
      !PIPELINE_ID_PATTERN.test(fm.pipeline_id)
    ) {
      errors.push({
        field: 'pipeline_id',
        code: 'INVALID_FORMAT',
        message: `pipeline_id '${fm.pipeline_id}' does not match pattern ${PIPELINE_ID_PATTERN}`,
        severity: 'error',
      });
    }
  }

  // version: string matching pattern (coerce numbers to string for ergonomics)
  if (fm.version !== undefined && fm.version !== null) {
    const versionStr =
      typeof fm.version === 'number' ? String(fm.version) : fm.version;
    if (typeof versionStr !== 'string' || !VERSION_PATTERN.test(versionStr)) {
      errors.push({
        field: 'version',
        code: 'INVALID_FORMAT',
        message: `version '${fm.version}' does not match pattern ${VERSION_PATTERN}`,
        severity: 'error',
      });
    }
  }

  // type: valid DocumentType
  if (fm.type !== undefined && fm.type !== null) {
    if (!VALID_DOCUMENT_TYPES.includes(fm.type as string)) {
      errors.push({
        field: 'type',
        code: 'INVALID_ENUM',
        message: `type '${fm.type}' is not a valid DocumentType (${VALID_DOCUMENT_TYPES.join(', ')})`,
        severity: 'error',
      });
    }
  }

  // status: valid DocumentStatus
  if (fm.status !== undefined && fm.status !== null) {
    if (!(DOCUMENT_STATUSES as readonly string[]).includes(fm.status as string)) {
      errors.push({
        field: 'status',
        code: 'INVALID_ENUM',
        message: `status '${fm.status}' is not a valid DocumentStatus (${DOCUMENT_STATUSES.join(', ')})`,
        severity: 'error',
      });
    }
  }

  // depth: integer 0-4
  if (fm.depth !== undefined && fm.depth !== null) {
    if (
      typeof fm.depth !== 'number' ||
      !Number.isInteger(fm.depth) ||
      fm.depth < 0 ||
      fm.depth > 4
    ) {
      errors.push({
        field: 'depth',
        code: 'INVALID_RANGE',
        message: `depth must be an integer between 0 and 4, got '${fm.depth}'`,
        severity: 'error',
      });
    }
  }

  // created_at: valid ISO 8601
  if (fm.created_at !== undefined && fm.created_at !== null) {
    if (typeof fm.created_at !== 'string' || !isValidIso8601(fm.created_at)) {
      errors.push({
        field: 'created_at',
        code: 'INVALID_FORMAT',
        message: `created_at '${fm.created_at}' is not a valid ISO 8601 datetime`,
        severity: 'error',
      });
    }
  }

  // updated_at: valid ISO 8601
  if (fm.updated_at !== undefined && fm.updated_at !== null) {
    if (typeof fm.updated_at !== 'string' || !isValidIso8601(fm.updated_at)) {
      errors.push({
        field: 'updated_at',
        code: 'INVALID_FORMAT',
        message: `updated_at '${fm.updated_at}' is not a valid ISO 8601 datetime`,
        severity: 'error',
      });
    }
  }

  // priority: one of critical, high, normal, low
  if (fm.priority !== undefined && fm.priority !== null) {
    if (!(PRIORITIES as readonly string[]).includes(fm.priority as string)) {
      errors.push({
        field: 'priority',
        code: 'INVALID_ENUM',
        message: `priority '${fm.priority}' is not valid (${PRIORITIES.join(', ')})`,
        severity: 'error',
      });
    }
  }

  // execution_mode: one of parallel, sequential
  if (fm.execution_mode !== undefined && fm.execution_mode !== null) {
    if (!(EXECUTION_MODES as readonly string[]).includes(fm.execution_mode as string)) {
      errors.push({
        field: 'execution_mode',
        code: 'INVALID_ENUM',
        message: `execution_mode '${fm.execution_mode}' is not valid (${EXECUTION_MODES.join(', ')})`,
        severity: 'error',
      });
    }
  }

  // ---------------------------------------------------------------
  // 3. Cross-field consistency
  // ---------------------------------------------------------------

  // depth matches getDepth(type)
  if (
    fm.type !== undefined &&
    fm.type !== null &&
    fm.depth !== undefined &&
    fm.depth !== null &&
    VALID_DOCUMENT_TYPES.includes(fm.type as string)
  ) {
    const expectedDepth = getDepth(fm.type as DocumentType);
    if (fm.depth !== expectedDepth) {
      errors.push({
        field: 'depth',
        code: 'DEPTH_TYPE_MISMATCH',
        message: `depth ${fm.depth} does not match expected depth ${expectedDepth} for type '${fm.type}'`,
        severity: 'error',
      });
    }
  }

  // updated_at >= created_at
  if (
    fm.created_at !== undefined &&
    fm.created_at !== null &&
    fm.updated_at !== undefined &&
    fm.updated_at !== null &&
    typeof fm.created_at === 'string' &&
    typeof fm.updated_at === 'string' &&
    isValidIso8601(fm.created_at) &&
    isValidIso8601(fm.updated_at)
  ) {
    const created = new Date(fm.created_at as string).getTime();
    const updated = new Date(fm.updated_at as string).getTime();
    if (updated < created) {
      errors.push({
        field: 'updated_at',
        code: 'TIMESTAMP_ORDER',
        message: `updated_at (${fm.updated_at}) must be >= created_at (${fm.created_at})`,
        severity: 'error',
      });
    }
  }

  // depends_on.length === dependency_type.length
  const dependsOn = fm.depends_on as unknown[] | undefined;
  const depType = fm.dependency_type as unknown[] | undefined;
  if (Array.isArray(dependsOn) && Array.isArray(depType)) {
    if (dependsOn.length !== depType.length) {
      errors.push({
        field: 'dependency_type',
        code: 'ARRAY_LENGTH_MISMATCH',
        message: `depends_on has ${dependsOn.length} entries but dependency_type has ${depType.length}`,
        severity: 'error',
      });
    }
  }

  // sibling_index < sibling_count
  if (
    fm.sibling_index !== undefined &&
    fm.sibling_index !== null &&
    fm.sibling_count !== undefined &&
    fm.sibling_count !== null &&
    typeof fm.sibling_index === 'number' &&
    typeof fm.sibling_count === 'number'
  ) {
    if (fm.sibling_index >= fm.sibling_count) {
      errors.push({
        field: 'sibling_index',
        code: 'SIBLING_INDEX_OUT_OF_RANGE',
        message: `sibling_index (${fm.sibling_index}) must be < sibling_count (${fm.sibling_count})`,
        severity: 'error',
      });
    }
  }

  // parent_id consistency with depth
  if (fm.depth !== undefined && fm.depth !== null && typeof fm.depth === 'number') {
    if (fm.depth === 0 && fm.parent_id !== undefined && fm.parent_id !== null) {
      errors.push({
        field: 'parent_id',
        code: 'PARENT_ID_DEPTH_MISMATCH',
        message: 'parent_id must be null when depth is 0',
        severity: 'error',
      });
    }
    if (fm.depth > 0 && (fm.parent_id === undefined || fm.parent_id === null)) {
      errors.push({
        field: 'parent_id',
        code: 'PARENT_ID_REQUIRED',
        message: `parent_id is required when depth > 0 (depth=${fm.depth})`,
        severity: 'error',
      });
    }
  }

  // ---------------------------------------------------------------
  // 4. Conditionally required fields
  // ---------------------------------------------------------------

  // traces_from required and non-empty when depth > 0
  if (fm.depth !== undefined && fm.depth !== null && typeof fm.depth === 'number' && fm.depth > 0) {
    const tracesFrom = fm.traces_from as unknown[] | undefined;
    if (!Array.isArray(tracesFrom) || tracesFrom.length === 0) {
      errors.push({
        field: 'traces_from',
        code: 'TRACES_FROM_REQUIRED',
        message: `traces_from must be a non-empty array when depth > 0 (depth=${fm.depth})`,
        severity: 'error',
      });
    }
  }

  // ---------------------------------------------------------------
  // 5. Warnings
  // ---------------------------------------------------------------

  // Unknown fields
  const knownSet = new Set(ALL_KNOWN_FIELDS);
  for (const key of Object.keys(fm)) {
    if (!knownSet.has(key)) {
      warnings.push({
        field: key,
        code: 'UNKNOWN_FIELD',
        message: `Unknown field '${key}' is not part of the frontmatter schema`,
        severity: 'warning',
      });
    }
  }

  // traces_to empty for non-CODE (informational warning)
  if (
    fm.type !== undefined &&
    fm.type !== null &&
    fm.type !== DocumentType.CODE
  ) {
    const tracesTo = fm.traces_to as unknown[] | undefined;
    if (Array.isArray(tracesTo) && tracesTo.length === 0) {
      warnings.push({
        field: 'traces_to',
        code: 'EMPTY_TRACES_TO',
        message: `traces_to is empty for type '${fm.type}' (may not have decomposed yet)`,
        severity: 'warning',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
