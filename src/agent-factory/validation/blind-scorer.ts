/**
 * Blind Scorer (SPEC-005-4-2, Tasks 4).
 *
 * Invokes the appropriate reviewer agent to score two outputs
 * without knowledge of which is current vs. proposed. Uses
 * median-of-3 scoring for consistency and robustness.
 *
 * Key design principles:
 *   - Scoring prompt contains ONLY "Output 1" / "Output 2" labels.
 *   - No version, "current", "proposed", or "version_a" / "version_b" text.
 *   - Reviewer selection is based on the target agent's role.
 *   - All scoring invocations tagged with `environment: 'validation'`.
 *
 * Exports: `BlindScorer`
 */

import type { AgentRole, QualityDimension } from '../types';
import type {
  RandomizedPair,
  ScoringResult,
  ScoringRound,
  DimensionScores,
  MedianScores,
} from '../improvement/types';

// ---------------------------------------------------------------------------
// Reviewer agent selection map (SPEC-005-4-2)
// ---------------------------------------------------------------------------

/**
 * Maps the target agent's role to the reviewer agent name that
 * should score its outputs.
 */
const REVIEWER_MAP: Record<AgentRole, string> = {
  author: 'doc-reviewer',
  executor: 'quality-reviewer',
  reviewer: 'architecture-reviewer',
  meta: 'architecture-reviewer',
};

// ---------------------------------------------------------------------------
// Reviewer invoker interface
// ---------------------------------------------------------------------------

/**
 * Interface for invoking a reviewer agent. The caller supplies an
 * implementation that routes to the appropriate runtime. This keeps
 * the scorer testable without real agent invocations.
 */
export interface ReviewerInvoker {
  invoke(
    reviewerName: string,
    prompt: string,
    options: { environment: 'validation' },
  ): Promise<{ invocation_id: string; output: string }>;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface BlindScorerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: BlindScorerLogger = {
  info: (msg: string) => console.log(`[blind-scorer] ${msg}`),
  warn: (msg: string) => console.warn(`[blind-scorer] ${msg}`),
  error: (msg: string) => console.error(`[blind-scorer] ${msg}`),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of scoring rounds for median-of-3. */
const SCORING_ROUNDS = 3;

/** Minimum score allowed per dimension. */
const MIN_SCORE = 1.0;

/** Maximum score allowed per dimension. */
const MAX_SCORE = 5.0;

// ---------------------------------------------------------------------------
// Version metadata stripping
// ---------------------------------------------------------------------------

/**
 * Strip version metadata from output text to prevent the scorer
 * from identifying which version produced the output.
 *
 * Removes patterns like "Version 1.0.0", "v1.2.3", version headers,
 * and common version labels.
 */
export function stripVersionMetadata(output: string): string {
  return output
    // "Version X.Y.Z" headers (case-insensitive)
    .replace(/\bVersion\s+\d+\.\d+\.\d+\b/gi, '')
    // "vX.Y.Z" patterns
    .replace(/\bv\d+\.\d+\.\d+\b/g, '')
    // Clean up any double spaces or empty header lines left behind
    .replace(/ {2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// BlindScorer
// ---------------------------------------------------------------------------

export interface BlindScorerOptions {
  reviewerInvoker: ReviewerInvoker;
  logger?: BlindScorerLogger;
}

/**
 * Scores two randomized outputs using the appropriate reviewer agent.
 *
 * The scorer:
 *   1. Selects the reviewer based on the target agent's role.
 *   2. Builds a scoring prompt with only "Output 1" / "Output 2" labels.
 *   3. Runs the prompt 3 times (median-of-3).
 *   4. Computes median scores per dimension per output.
 *   5. Computes scoring variance across rounds.
 *
 * Partial failure handling:
 *   - 1 round fails -> median of 2 (which is the mean).
 *   - 2 rounds fail -> uses the single remaining round.
 *   - All 3 fail -> returns ScoringResult with error.
 */
export class BlindScorer {
  private readonly reviewerInvoker: ReviewerInvoker;
  private readonly logger: BlindScorerLogger;

  constructor(opts: BlindScorerOptions) {
    this.reviewerInvoker = opts.reviewerInvoker;
    this.logger = opts.logger ?? defaultLogger;
  }

  /**
   * Select the appropriate reviewer agent name based on the target
   * agent's role.
   */
  static selectReviewer(targetRole: AgentRole): string {
    return REVIEWER_MAP[targetRole];
  }

  /**
   * Score a randomized pair using the appropriate reviewer agent.
   *
   * @param pair       The randomized output pair (no version info).
   * @param rubric     The target agent's evaluation rubric dimensions.
   * @param targetRole The target agent's role (determines reviewer selection).
   * @returns          ScoringResult with median scores and variance.
   */
  async score(
    pair: RandomizedPair,
    rubric: QualityDimension[],
    targetRole: AgentRole,
  ): Promise<ScoringResult> {
    const reviewerName = BlindScorer.selectReviewer(targetRole);
    this.logger.info(
      `Scoring input ${pair.input.input_id} with reviewer '${reviewerName}' (target role: ${targetRole})`,
    );

    // Strip version metadata from outputs before scoring
    const output1 = stripVersionMetadata(pair.output_1);
    const output2 = stripVersionMetadata(pair.output_2);

    // Build the scoring prompt
    const prompt = buildScoringPrompt(
      pair.input.input_content,
      output1,
      output2,
      rubric,
    );

    // Run 3 scoring rounds
    const rounds: ScoringRound[] = [];
    const errors: string[] = [];

    for (let roundNum = 1; roundNum <= SCORING_ROUNDS; roundNum++) {
      try {
        const round = await this.executeRound(
          roundNum,
          reviewerName,
          prompt,
          rubric,
        );
        rounds.push(round);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Scoring round ${roundNum} failed for input ${pair.input.input_id}: ${message}`,
        );
        errors.push(`Round ${roundNum}: ${message}`);
      }
    }

    // All 3 rounds failed
    if (rounds.length === 0) {
      this.logger.error(
        `All scoring rounds failed for input ${pair.input.input_id}`,
      );
      return {
        input_id: pair.input.input_id,
        rounds: [],
        median_scores: {
          output_1: { scores: {}, overall: 0 },
          output_2: { scores: {}, overall: 0 },
        },
        scoring_variance: 0,
        error: `All ${SCORING_ROUNDS} scoring rounds failed: ${errors.join('; ')}`,
      };
    }

    // Compute median scores
    const medianScores = computeMedianScores(rounds, rubric);

    // Compute scoring variance
    const scoringVariance = computeScoringVariance(rounds, rubric);

    this.logger.info(
      `Scoring complete for input ${pair.input.input_id}: ` +
      `${rounds.length}/${SCORING_ROUNDS} rounds succeeded, variance=${scoringVariance.toFixed(4)}`,
    );

    return {
      input_id: pair.input.input_id,
      rounds,
      median_scores: medianScores,
      scoring_variance: scoringVariance,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: execute a single scoring round
  // -------------------------------------------------------------------------

  private async executeRound(
    roundNumber: number,
    reviewerName: string,
    prompt: string,
    rubric: QualityDimension[],
  ): Promise<ScoringRound> {
    const result = await this.reviewerInvoker.invoke(
      reviewerName,
      prompt,
      { environment: 'validation' },
    );

    // Parse the reviewer's JSON output
    const parsed = parseReviewerOutput(result.output, rubric);

    return {
      round_number: roundNumber,
      reviewer_invocation_id: result.invocation_id,
      output_1_scores: parsed.output_1_scores,
      output_2_scores: parsed.output_2_scores,
      output_1_overall: parsed.output_1_scores.overall,
      output_2_overall: parsed.output_2_scores.overall,
      free_text_comparison: parsed.comparison,
    };
  }
}

// ---------------------------------------------------------------------------
// Scoring prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the scoring prompt for the reviewer agent.
 *
 * IMPORTANT: This prompt must NOT contain any text that would allow
 * the scorer to identify which output is current vs. proposed.
 * No "version_a", "version_b", "current", "proposed" references.
 */
export function buildScoringPrompt(
  inputContent: string,
  output1: string,
  output2: string,
  rubric: QualityDimension[],
): string {
  const dimensionLines = rubric.map(
    (dim) =>
      `- **${dim.name}** (weight: ${dim.weight}): ${dim.description}\n` +
      `  Score Output 1: ___\n` +
      `  Score Output 2: ___`,
  ).join('\n');

  return `You are scoring two outputs produced by an agent for the same input.
Do NOT attempt to determine which output is "better" overall -- score each independently.

## Original Input
${inputContent}

## Output 1
${output1}

## Output 2
${output2}

## Evaluation Rubric
Score each output on every dimension (1.0 to 5.0):
${dimensionLines}

## Instructions
1. Score each output independently on each dimension.
2. Provide a brief free-text comparison (2-3 sentences).
3. Output a JSON object with:
   {
     "output_1_scores": { "dimension_name": score, ... },
     "output_2_scores": { "dimension_name": score, ... },
     "comparison": "free text"
   }`;
}

// ---------------------------------------------------------------------------
// Reviewer output parsing
// ---------------------------------------------------------------------------

interface ParsedReviewerOutput {
  output_1_scores: DimensionScores;
  output_2_scores: DimensionScores;
  comparison: string;
}

/**
 * Parse the reviewer agent's JSON output into structured scores.
 *
 * Handles:
 *   - Raw JSON string
 *   - JSON wrapped in ```json ... ``` code blocks
 *   - JSON wrapped in ``` ... ``` code blocks
 *
 * Validates and clamps scores to [1.0, 5.0].
 */
export function parseReviewerOutput(
  output: string,
  rubric: QualityDimension[],
): ParsedReviewerOutput {
  const json = extractJson(output);
  if (!json) {
    throw new Error('Failed to extract JSON from reviewer output');
  }

  let parsed: {
    output_1_scores?: Record<string, number>;
    output_2_scores?: Record<string, number>;
    comparison?: string;
  };

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Failed to parse reviewer JSON: ${json.substring(0, 200)}`);
  }

  if (!parsed.output_1_scores || typeof parsed.output_1_scores !== 'object') {
    throw new Error('Missing or invalid output_1_scores in reviewer response');
  }
  if (!parsed.output_2_scores || typeof parsed.output_2_scores !== 'object') {
    throw new Error('Missing or invalid output_2_scores in reviewer response');
  }

  const output1Scores = buildDimensionScores(parsed.output_1_scores, rubric);
  const output2Scores = buildDimensionScores(parsed.output_2_scores, rubric);

  return {
    output_1_scores: output1Scores,
    output_2_scores: output2Scores,
    comparison: typeof parsed.comparison === 'string' ? parsed.comparison : '',
  };
}

// ---------------------------------------------------------------------------
// DimensionScores construction
// ---------------------------------------------------------------------------

/**
 * Build a DimensionScores object from raw score map and rubric.
 *
 * - Validates each score is a number in [1.0, 5.0], clamping out-of-range values.
 * - Computes the weighted mean as the overall score.
 * - Missing dimensions get a default score of 3.0 (neutral).
 */
export function buildDimensionScores(
  rawScores: Record<string, number>,
  rubric: QualityDimension[],
): DimensionScores {
  const scores: Record<string, number> = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const dim of rubric) {
    const raw = rawScores[dim.name];
    let score: number;

    if (typeof raw === 'number' && !isNaN(raw)) {
      score = clampScore(raw);
    } else {
      // Missing dimension: default to 3.0 (neutral midpoint)
      score = 3.0;
    }

    scores[dim.name] = score;
    weightedSum += score * dim.weight;
    totalWeight += dim.weight;
  }

  const overall = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return { scores, overall };
}

// ---------------------------------------------------------------------------
// Median computation
// ---------------------------------------------------------------------------

/**
 * Compute median scores across all successful rounds.
 *
 * For each dimension, for each output:
 *   - Collect the scores across rounds.
 *   - Take the median value.
 * Recompute overall as weighted mean of median dimension scores.
 */
export function computeMedianScores(
  rounds: ScoringRound[],
  rubric: QualityDimension[],
): MedianScores {
  const output1Scores: Record<string, number> = {};
  const output2Scores: Record<string, number> = {};

  for (const dim of rubric) {
    const o1Values = rounds
      .map((r) => r.output_1_scores.scores[dim.name])
      .filter((v) => typeof v === 'number' && !isNaN(v));
    const o2Values = rounds
      .map((r) => r.output_2_scores.scores[dim.name])
      .filter((v) => typeof v === 'number' && !isNaN(v));

    output1Scores[dim.name] = medianOfValues(o1Values);
    output2Scores[dim.name] = medianOfValues(o2Values);
  }

  // Recompute overall as weighted mean
  const output1Overall = computeWeightedMean(output1Scores, rubric);
  const output2Overall = computeWeightedMean(output2Scores, rubric);

  return {
    output_1: { scores: output1Scores, overall: output1Overall },
    output_2: { scores: output2Scores, overall: output2Overall },
  };
}

// ---------------------------------------------------------------------------
// Scoring variance computation
// ---------------------------------------------------------------------------

/**
 * Compute the scoring variance across rounds.
 *
 * For each dimension, for each output, compute the variance of scores
 * across rounds. Return the average of all these variances.
 */
export function computeScoringVariance(
  rounds: ScoringRound[],
  rubric: QualityDimension[],
): number {
  if (rounds.length < 2) return 0;

  const variances: number[] = [];

  for (const dim of rubric) {
    // Output 1 variance for this dimension
    const o1Values = rounds
      .map((r) => r.output_1_scores.scores[dim.name])
      .filter((v) => typeof v === 'number' && !isNaN(v));
    if (o1Values.length >= 2) {
      variances.push(variance(o1Values));
    }

    // Output 2 variance for this dimension
    const o2Values = rounds
      .map((r) => r.output_2_scores.scores[dim.name])
      .filter((v) => typeof v === 'number' && !isNaN(v));
    if (o2Values.length >= 2) {
      variances.push(variance(o2Values));
    }
  }

  if (variances.length === 0) return 0;
  return variances.reduce((sum, v) => sum + v, 0) / variances.length;
}

// ---------------------------------------------------------------------------
// JSON extraction (same pattern as analyzer.ts)
// ---------------------------------------------------------------------------

/**
 * Extract JSON from agent output text.
 *
 * Handles:
 *   - ```json { ... } ```
 *   - ``` { ... } ```
 *   - Raw JSON object at start of string
 */
function extractJson(output: string): string | null {
  // Try to find JSON in a code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      return candidate;
    }
  }

  // Try raw JSON (first { to last })
  const trimmed = output.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/**
 * Compute the median of an array of numbers.
 *
 * - 0 values -> 0
 * - 1 value -> that value
 * - 2 values -> mean (median-of-2 per spec)
 * - 3+ values -> standard median
 */
function medianOfValues(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Compute sample variance of an array of numbers.
 */
function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const sumSqDiffs = values.reduce((s, v) => s + (v - avg) ** 2, 0);
  return sumSqDiffs / (values.length - 1);
}

/**
 * Compute weighted mean from dimension scores and rubric.
 */
function computeWeightedMean(
  scores: Record<string, number>,
  rubric: QualityDimension[],
): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const dim of rubric) {
    const score = scores[dim.name];
    if (typeof score === 'number' && !isNaN(score)) {
      weightedSum += score * dim.weight;
      totalWeight += dim.weight;
    }
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Clamp a score to the valid range [1.0, 5.0].
 */
function clampScore(score: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));
}
