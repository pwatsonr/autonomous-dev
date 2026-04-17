/**
 * ReviewerOutputValidator: validates and recovers LLM reviewer output.
 *
 * Handles JSON extraction from markdown, lenient parsing (trailing commas,
 * single-line comments), schema validation, score clamping, and missing
 * category detection.
 *
 * Based on SPEC-004-2-3 section 2.
 */

import type {
  Rubric,
  ReviewOutput,
  CategoryScore,
  Finding,
  FindingSeverity,
  CriticalSub,
} from './types';
import { isFindingSeverity, isCriticalSub } from './types';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result of validating and parsing raw reviewer output. */
export interface ValidationParseResult {
  success: boolean;
  review_output: ReviewOutput | null;
  warnings: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a JSON string from raw LLM output that may be wrapped in
 * markdown code blocks or contain surrounding prose.
 */
function extractJSON(raw: string): string {
  const trimmed = raw.trim();

  // 1. Try direct parse
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // continue to fallback strategies
  }

  // 2. Look for ```json ... ``` block
  const jsonBlockMatch = trimmed.match(/```json\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }

  // 3. Look for ``` ... ``` block
  const codeBlockMatch = trimmed.match(/```\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // 4. Look for { ... } (first to last brace)
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('No JSON found in output');
}

/**
 * Lenient JSON parse: strips trailing commas and single-line comments
 * before attempting JSON.parse.
 */
function lenientParse(raw: string): unknown {
  // First try strict parse
  try {
    return JSON.parse(raw);
  } catch {
    // continue to lenient strategies
  }

  // Strip single-line comments (// ...) — must not be inside strings
  // Simple approach: remove lines that are only comments, and trailing comments
  let cleaned = raw.replace(/^\s*\/\/.*$/gm, '');
  // Remove inline trailing comments (after values, before newlines)
  cleaned = cleaned.replace(/,\s*\/\/.*$/gm, ',');
  cleaned = cleaned.replace(/(["\d\w\]}\s])\s*\/\/.*$/gm, '$1');

  // Strip trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

  return JSON.parse(cleaned);
}

/**
 * Validates an ISO 8601 timestamp string.
 */
function isValidISO8601(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const date = new Date(value);
  if (isNaN(date.getTime())) return false;
  // Must look like an ISO date, not just any parseable date string
  return /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{4}\/\d{2}\/\d{2}/.test(value);
}

/**
 * Clamp a numeric score to the 0-100 range.
 */
function clampScore(score: number): number {
  if (score < 0) return 0;
  if (score > 100) return 100;
  return Math.round(score);
}

// ---------------------------------------------------------------------------
// ReviewerOutputValidator
// ---------------------------------------------------------------------------

export class ReviewerOutputValidator {
  /**
   * Validate and parse raw LLM output into a ReviewOutput.
   *
   * @param rawOutput - The raw string response from the LLM
   * @param rubric - The rubric used for this review (for category validation)
   * @param reviewerId - System-assigned reviewer ID (overrides whatever the LLM returns)
   * @returns ValidationParseResult with success status, parsed output, warnings, and errors
   */
  validateAndParse(
    rawOutput: string,
    rubric: Rubric,
    reviewerId: string,
  ): ValidationParseResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    // --- Step 1: JSON extraction ---
    let jsonStr: string;
    try {
      jsonStr = extractJSON(rawOutput);
    } catch {
      return {
        success: false,
        review_output: null,
        warnings,
        errors: ['Failed to extract JSON from output.'],
      };
    }

    // --- Step 2: JSON parsing (strict then lenient) ---
    let parsed: Record<string, unknown>;
    try {
      parsed = lenientParse(jsonStr) as Record<string, unknown>;
    } catch (e) {
      return {
        success: false,
        review_output: null,
        warnings,
        errors: [`JSON parse error: ${(e as Error).message}`],
      };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        success: false,
        review_output: null,
        warnings,
        errors: ['Parsed JSON is not an object.'],
      };
    }

    // --- Step 3: Schema validation ---

    // Required top-level string fields
    const requiredStringFields = [
      'reviewer_id',
      'reviewer_role',
      'document_id',
      'document_version',
      'summary',
    ] as const;

    for (const field of requiredStringFields) {
      if (typeof parsed[field] !== 'string' || (parsed[field] as string).trim().length === 0) {
        errors.push(`Missing or empty required field: '${field}'.`);
      }
    }

    // timestamp: valid ISO 8601
    if (typeof parsed['timestamp'] !== 'string' || !isValidISO8601(parsed['timestamp'] as string)) {
      errors.push("Missing or invalid 'timestamp' (must be valid ISO 8601).");
    }

    // scoring_mode
    const scoringMode = parsed['scoring_mode'];
    if (scoringMode !== 'per_section' && scoringMode !== 'document_level') {
      errors.push("'scoring_mode' must be 'per_section' or 'document_level'.");
    }

    // category_scores: non-empty array
    if (!Array.isArray(parsed['category_scores']) || (parsed['category_scores'] as unknown[]).length === 0) {
      errors.push("'category_scores' must be a non-empty array.");
    }

    // findings: must be array (can be empty)
    if (!Array.isArray(parsed['findings'])) {
      errors.push("'findings' must be an array.");
    }

    // Bail early if required field errors exist
    if (errors.length > 0) {
      return { success: false, review_output: null, warnings, errors };
    }

    // --- CategoryScore validation ---
    const rawCategoryScores = parsed['category_scores'] as Record<string, unknown>[];
    const validatedCategoryScores: CategoryScore[] = [];
    const validScoringMode = scoringMode as 'per_section' | 'document_level';

    for (const rawCS of rawCategoryScores) {
      const categoryId = rawCS['category_id'];
      if (typeof categoryId !== 'string' || categoryId.trim().length === 0) {
        errors.push("CategoryScore missing 'category_id'.");
        continue;
      }

      // Check category_id matches rubric
      const rubricCategory = rubric.categories.find(c => c.id === categoryId);
      if (!rubricCategory) {
        warnings.push(`Category '${categoryId}' not in rubric; keeping as-is.`);
      }

      // Score validation and clamping
      let score = rawCS['score'];
      if (typeof score !== 'number') {
        errors.push(`Score for category '${categoryId}' is not a number.`);
        continue;
      }
      const original = score as number;
      const clamped = clampScore(original);
      if (clamped !== original) {
        warnings.push(`Score for category '${categoryId}' was ${original}, clamped to ${clamped}.`);
      }
      score = clamped;

      // justification
      const justification = rawCS['justification'];
      if (typeof justification !== 'string' || (justification as string).trim().length === 0) {
        errors.push(`CategoryScore for '${categoryId}' missing 'justification'.`);
        continue;
      }

      // section_scores
      let sectionScores: CategoryScore['section_scores'] = null;
      if (validScoringMode === 'per_section') {
        const rawSS = rawCS['section_scores'];
        if (rawSS !== null && rawSS !== undefined && Array.isArray(rawSS)) {
          sectionScores = (rawSS as Record<string, unknown>[]).map(ss => {
            let ssScore = ss['score'] as number;
            if (typeof ssScore === 'number') {
              const origSS = ssScore;
              ssScore = clampScore(ssScore);
              if (ssScore !== origSS) {
                warnings.push(
                  `Section score for '${ss['section_id']}' in category '${categoryId}' was ${origSS}, clamped to ${ssScore}.`,
                );
              }
            }
            return {
              section_id: String(ss['section_id'] ?? ''),
              score: typeof ssScore === 'number' ? ssScore : 0,
            };
          });
        }
      } else {
        // For document_level scoring mode, just pass through what's there
        if (rawCS['section_scores'] !== null && rawCS['section_scores'] !== undefined && Array.isArray(rawCS['section_scores'])) {
          sectionScores = (rawCS['section_scores'] as Record<string, unknown>[]).map(ss => ({
            section_id: String(ss['section_id'] ?? ''),
            score: typeof ss['score'] === 'number' ? clampScore(ss['score'] as number) : 0,
          }));
        }
      }

      validatedCategoryScores.push({
        category_id: categoryId,
        score: score as number,
        section_scores: sectionScores,
        justification: justification as string,
      });
    }

    // Bail if category score errors
    if (errors.length > 0) {
      return { success: false, review_output: null, warnings, errors };
    }

    // --- Missing category detection ---
    const presentCategoryIds = new Set(validatedCategoryScores.map(cs => cs.category_id));
    const autoFindings: Finding[] = [];

    for (const rubricCat of rubric.categories) {
      if (!presentCategoryIds.has(rubricCat.id)) {
        // Add a zero-score CategoryScore
        validatedCategoryScores.push({
          category_id: rubricCat.id,
          score: 0,
          section_scores: null,
          justification: 'Category not evaluated by reviewer.',
        });

        // Determine the section_id for the auto-generated finding
        // Use the first section mapped to this category, or "document" if none
        const sectionId = this.findSectionForCategory(rubric, rubricCat.id);

        autoFindings.push({
          id: `sys-missing-${rubricCat.id}`,
          section_id: sectionId,
          category_id: rubricCat.id,
          severity: 'critical',
          critical_sub: 'blocking',
          upstream_defect: false,
          description: `Reviewer did not evaluate category '${rubricCat.name}'. Scoring as 0 with critical finding.`,
          evidence: `Category '${rubricCat.id}' is absent from the reviewer's output.`,
          suggested_resolution: 'Re-run review or manually evaluate this category.',
        });

        warnings.push(
          `Missing category '${rubricCat.id}' assigned score 0 with critical:blocking finding.`,
        );
      }
    }

    // --- Finding validation ---
    const rawFindings = parsed['findings'] as Record<string, unknown>[];
    const validatedFindings: Finding[] = [];

    for (const rawF of rawFindings) {
      // Required string fields
      const findingId = rawF['id'];
      if (typeof findingId !== 'string' || (findingId as string).trim().length === 0) {
        errors.push("Finding missing required field 'id'.");
        continue;
      }

      const sectionId = rawF['section_id'];
      if (typeof sectionId !== 'string' || (sectionId as string).trim().length === 0) {
        errors.push(`Finding '${findingId}' missing required field 'section_id'.`);
        return { success: false, review_output: null, warnings, errors };
      }

      const categoryId = rawF['category_id'];
      if (typeof categoryId !== 'string' || (categoryId as string).trim().length === 0) {
        errors.push(`Finding '${findingId}' missing required field 'category_id'.`);
        return { success: false, review_output: null, warnings, errors };
      }

      // severity
      const severity = rawF['severity'];
      if (!isFindingSeverity(severity)) {
        errors.push(
          `Finding '${findingId}' has invalid severity '${String(severity)}'. Must be one of: critical, major, minor, suggestion.`,
        );
        return { success: false, review_output: null, warnings, errors };
      }

      // critical_sub
      let criticalSub: CriticalSub | null = null;
      if (severity === 'critical') {
        if (rawF['critical_sub'] !== undefined && rawF['critical_sub'] !== null) {
          if (!isCriticalSub(rawF['critical_sub'])) {
            errors.push(
              `Finding '${findingId}' has invalid critical_sub '${String(rawF['critical_sub'])}'.`,
            );
            return { success: false, review_output: null, warnings, errors };
          }
          criticalSub = rawF['critical_sub'] as CriticalSub;
        } else {
          criticalSub = 'blocking';
          warnings.push(
            `Finding '${findingId}' is severity 'critical' but has no critical_sub. Defaulting to 'blocking'.`,
          );
        }
      } else if (rawF['critical_sub'] !== undefined && rawF['critical_sub'] !== null) {
        criticalSub = isCriticalSub(rawF['critical_sub']) ? rawF['critical_sub'] as CriticalSub : null;
      }

      // upstream_defect
      const upstreamDefect = typeof rawF['upstream_defect'] === 'boolean'
        ? rawF['upstream_defect'] as boolean
        : false;

      // description
      const description = rawF['description'];
      if (typeof description !== 'string' || (description as string).trim().length === 0) {
        errors.push(`Finding '${findingId}' missing required field 'description'.`);
        return { success: false, review_output: null, warnings, errors };
      }

      // evidence
      const evidence = rawF['evidence'];
      if (typeof evidence !== 'string' || (evidence as string).trim().length === 0) {
        errors.push(`Finding '${findingId}' missing required field 'evidence'.`);
        return { success: false, review_output: null, warnings, errors };
      }

      // suggested_resolution
      let suggestedResolution = '';
      if (typeof rawF['suggested_resolution'] === 'string') {
        suggestedResolution = rawF['suggested_resolution'] as string;
      }

      // For critical/major: warn if no suggested_resolution
      if ((severity === 'critical' || severity === 'major') && suggestedResolution.trim().length === 0) {
        warnings.push(
          `Finding '${findingId}' is severity '${severity}' but has no suggested_resolution.`,
        );
      }

      validatedFindings.push({
        id: findingId as string,
        section_id: sectionId as string,
        category_id: categoryId as string,
        severity: severity as FindingSeverity,
        critical_sub: criticalSub,
        upstream_defect: upstreamDefect,
        description: description as string,
        evidence: evidence as string,
        suggested_resolution: suggestedResolution,
      });
    }

    // Bail if finding errors
    if (errors.length > 0) {
      return { success: false, review_output: null, warnings, errors };
    }

    // Combine validated findings with auto-generated findings for missing categories
    const allFindings = [...validatedFindings, ...autoFindings];

    // --- Step 4: Override reviewer_id ---
    const reviewOutput: ReviewOutput = {
      reviewer_id: reviewerId,
      reviewer_role: parsed['reviewer_role'] as string,
      document_id: parsed['document_id'] as string,
      document_version: parsed['document_version'] as string,
      timestamp: parsed['timestamp'] as string,
      scoring_mode: validScoringMode,
      category_scores: validatedCategoryScores,
      findings: allFindings,
      summary: parsed['summary'] as string,
    };

    return {
      success: true,
      review_output: reviewOutput,
      warnings,
      errors,
    };
  }

  /**
   * Find the first section mapped to a given category in the rubric context.
   * Falls back to "document" if no section mapping is available.
   */
  private findSectionForCategory(_rubric: Rubric, _categoryId: string): string {
    // The rubric itself doesn't contain section mappings; the section mappings
    // module does. Since the output validator doesn't have access to section
    // mappings by design, we use "document" as the default.
    return 'document';
  }
}
