export type AggregationMethod = 'mean' | 'median' | 'min';

export interface RubricCategory {
  /** Unique category identifier, e.g. 'completeness' */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this category measures */
  description: string;
  /** Weight in the aggregate score. All weights in a rubric must sum to 1.0 */
  weight: number;
  /** Minimum acceptable score for this category (0-100) */
  minimumScore: number;
  /** Scoring guide: maps score ranges to descriptions */
  scoringGuide: ScoringGuideEntry[];
}

export interface ScoringGuideEntry {
  /** Inclusive lower bound of the score range */
  min: number;
  /** Inclusive upper bound of the score range */
  max: number;
  /** Description of what this score range means */
  description: string;
}

export interface QualityRubric {
  /** Document type this rubric applies to */
  documentType: string;
  /** Version of the rubric for evolution tracking */
  version: string;
  /** All scoring categories */
  categories: RubricCategory[];
  /** How to aggregate category scores into a single score */
  aggregationMethod: AggregationMethod;
}
