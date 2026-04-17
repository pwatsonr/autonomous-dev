import {
  type DocumentType,
  type Rubric,
  type RubricCategory,
  DOCUMENT_TYPES,
  isDocumentType,
} from './types';
import { PRD_RUBRIC } from './rubrics/prd-rubric';
import { TDD_RUBRIC } from './rubrics/tdd-rubric';
import { PLAN_RUBRIC } from './rubrics/plan-rubric';
import { SPEC_RUBRIC } from './rubrics/spec-rubric';
import { CODE_RUBRIC } from './rubrics/code-rubric';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Thrown when a rubric is not found in the registry. */
export class RubricNotFoundError extends Error {
  constructor(documentType: string) {
    super(`No rubric registered for document type: ${documentType}`);
    this.name = 'RubricNotFoundError';
  }
}

/** Thrown when a rubric fails validation during registration. */
export class RubricValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Rubric validation failed:\n  - ${errors.join('\n  - ')}`);
    this.name = 'RubricValidationError';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/** Result of rubric validation. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Deep-freeze utility
// ---------------------------------------------------------------------------

/**
 * Recursively freezes an object and all its nested objects/arrays.
 * Returns the same object, deeply frozen.
 */
function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Deep-clone utility
// ---------------------------------------------------------------------------

/**
 * Returns a deep clone of the given object via structured clone.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

// ---------------------------------------------------------------------------
// RubricRegistry
// ---------------------------------------------------------------------------

/**
 * Registry for storing, validating, and retrieving rubrics.
 *
 * Initialized with hardcoded default rubrics for all 5 document types.
 * Supports overrides via `registerRubric()`.
 *
 * Returned rubrics are deep-frozen copies -- they cannot be mutated.
 */
export class RubricRegistry {
  private rubrics: Map<DocumentType, Readonly<Rubric>>;

  /**
   * Creates a new RubricRegistry.
   * @param overrides Optional map of rubrics to override defaults.
   */
  constructor(overrides?: Map<DocumentType, Rubric>) {
    this.rubrics = new Map();
    this.registerDefaults();

    if (overrides) {
      for (const [type, rubric] of overrides) {
        this.registerRubric(rubric);
      }
    }
  }

  /**
   * Returns a deep-frozen copy of the rubric for the given document type.
   * @throws RubricNotFoundError if the type is not registered.
   */
  getRubric(documentType: DocumentType): Readonly<Rubric> {
    const rubric = this.rubrics.get(documentType);
    if (!rubric) {
      throw new RubricNotFoundError(documentType);
    }
    // Return a deep-frozen clone so callers cannot mutate the registry's copy
    return deepFreeze(deepClone(rubric) as Rubric);
  }

  /**
   * Validates a rubric against all invariant rules.
   *
   * Validation rules:
   *  1. categories array is non-empty
   *  2. Every category has non-empty id, name, description
   *  3. Every category weight is a number > 0
   *  4. Sum of all category weights equals 100 within +/- 0.01
   *  5. Every category min_threshold is null or a number in 0-100
   *  6. Every category has valid calibration with non-empty score_0, score_50, score_100
   *  7. approval_threshold is a number in 0-100
   *  8. document_type is a valid DocumentType
   *  9. version is a non-empty string
   * 10. No duplicate category id values
   */
  validateRubric(rubric: Rubric): ValidationResult {
    const errors: string[] = [];

    // Rule 9: version is non-empty
    if (typeof rubric.version !== 'string' || rubric.version.length === 0) {
      errors.push('version must be a non-empty string.');
    }

    // Rule 8: valid document_type
    if (!isDocumentType(rubric.document_type)) {
      errors.push(
        `document_type "${rubric.document_type}" is not a valid DocumentType. Valid values: ${DOCUMENT_TYPES.join(', ')}.`
      );
    }

    // Rule 7: approval_threshold in 0-100
    if (
      typeof rubric.approval_threshold !== 'number' ||
      rubric.approval_threshold < 0 ||
      rubric.approval_threshold > 100
    ) {
      errors.push('approval_threshold must be a number between 0 and 100.');
    }

    // Rule 1: non-empty categories
    if (!Array.isArray(rubric.categories) || rubric.categories.length === 0) {
      errors.push('categories must be a non-empty array.');
      return { valid: false, errors };
    }

    // Rule 10: no duplicate category IDs
    const ids = rubric.categories.map((c) => c.id);
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
      errors.push(`Duplicate category IDs found: ${[...new Set(duplicates)].join(', ')}.`);
    }

    // Per-category validation
    for (const category of rubric.categories) {
      const prefix = `Category "${category.id || '(empty)'}"`;

      // Rule 2: non-empty id, name, description
      if (typeof category.id !== 'string' || category.id.length === 0) {
        errors.push(`${prefix}: id must be a non-empty string.`);
      }
      if (typeof category.name !== 'string' || category.name.length === 0) {
        errors.push(`${prefix}: name must be a non-empty string.`);
      }
      if (typeof category.description !== 'string' || category.description.length === 0) {
        errors.push(`${prefix}: description must be a non-empty string.`);
      }

      // Rule 3: weight > 0
      if (typeof category.weight !== 'number' || category.weight <= 0) {
        errors.push(`${prefix}: weight must be a number greater than 0.`);
      }

      // Rule 5: min_threshold is null or 0-100
      if (category.min_threshold !== null) {
        if (
          typeof category.min_threshold !== 'number' ||
          category.min_threshold < 0 ||
          category.min_threshold > 100
        ) {
          errors.push(`${prefix}: min_threshold must be null or a number between 0 and 100.`);
        }
      }

      // Rule 6: valid calibration
      if (!category.calibration) {
        errors.push(`${prefix}: calibration is required.`);
      } else {
        if (typeof category.calibration.score_0 !== 'string' || category.calibration.score_0.length === 0) {
          errors.push(`${prefix}: calibration.score_0 must be a non-empty string.`);
        }
        if (typeof category.calibration.score_50 !== 'string' || category.calibration.score_50.length === 0) {
          errors.push(`${prefix}: calibration.score_50 must be a non-empty string.`);
        }
        if (typeof category.calibration.score_100 !== 'string' || category.calibration.score_100.length === 0) {
          errors.push(`${prefix}: calibration.score_100 must be a non-empty string.`);
        }
      }
    }

    // Rule 4: weights sum to 100 within tolerance
    const weightSum = rubric.categories.reduce((sum, c) => sum + c.weight, 0);
    if (Math.abs(weightSum - 100) > 0.01) {
      errors.push(
        `Category weights must sum to 100 (within +/- 0.01). Actual sum: ${weightSum}.`
      );
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validates and registers a rubric, overwriting any existing rubric for the same document type.
   * @throws RubricValidationError if the rubric fails validation.
   */
  registerRubric(rubric: Rubric): void {
    const result = this.validateRubric(rubric);
    if (!result.valid) {
      throw new RubricValidationError(result.errors);
    }
    // Store a deep-frozen clone
    this.rubrics.set(rubric.document_type, deepFreeze(deepClone(rubric) as Rubric));
  }

  /**
   * Returns all document types that have registered rubrics.
   */
  listDocumentTypes(): DocumentType[] {
    return Array.from(this.rubrics.keys());
  }

  /**
   * Registers the hardcoded default rubrics for all 5 document types.
   */
  private registerDefaults(): void {
    const defaults: Rubric[] = [
      PRD_RUBRIC,
      TDD_RUBRIC,
      PLAN_RUBRIC,
      SPEC_RUBRIC,
      CODE_RUBRIC,
    ];

    for (const rubric of defaults) {
      // Store a deep-frozen clone of each default
      this.rubrics.set(rubric.document_type, deepFreeze(deepClone(rubric) as Rubric));
    }
  }
}

/** Singleton instance for global access. */
export const rubricRegistry = new RubricRegistry();
