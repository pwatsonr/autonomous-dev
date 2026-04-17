/**
 * Validation types (SPEC-005-4-1).
 *
 * Shared type definitions for the A/B evaluation pipeline:
 * historical input selection, blind running, and label randomization.
 */

import type { ToolCallRecord } from '../metrics/types';

// ---------------------------------------------------------------------------
// Input Selector types
// ---------------------------------------------------------------------------

/** A single historical input selected for A/B validation. */
export interface SelectedInput {
  /** UUID v4 identifying this selection. */
  input_id: string;
  /** Reference to the historical invocation from which this input was drawn. */
  original_invocation_id: string;
  /** The actual input text to be re-run against both agent versions. */
  input_content: string;
  /** SHA-256 hex digest of the input content. */
  input_hash: string;
  /** Classified domain tag (e.g. "typescript", "python"). */
  input_domain: string;
  /** Quality score from the original invocation. */
  original_quality_score: number;
  /** Why this input was selected (e.g. "below-median", "above-median", "weakness-domain"). */
  selection_reason: string;
}

/** Result of the input selection process. */
export interface InputSelectionResult {
  success: boolean;
  inputs: SelectedInput[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Blind Runner types
// ---------------------------------------------------------------------------

/** Result of running a single agent version on a selected input. */
export interface RunResult {
  output: string;
  /** SHA-256 hex digest of the output. */
  output_hash: string;
  input_tokens: number;
  output_tokens: number;
  wall_clock_ms: number;
  turn_count: number;
  tool_calls: ToolCallRecord[];
  error?: string;
}

/** Paired results from running both agent versions on the same input. */
export interface RunPair {
  input: SelectedInput;
  /** Output from the current (baseline) agent version. */
  version_a: RunResult;
  /** Output from the proposed agent version. */
  version_b: RunResult;
}

/** Cumulative token consumption tracker across all validation runs. */
export interface TokenTracker {
  cumulative_tokens: number;
  budget: number;
  remaining: number;
  exceeded: boolean;
}

// ---------------------------------------------------------------------------
// Randomizer types
// ---------------------------------------------------------------------------

/** A pair of outputs with labels stripped -- no indication of which is current vs. proposed. */
export interface RandomizedPair {
  input: SelectedInput;
  output_1: string;
  output_2: string;
  /** UUID for the mapping record (used to de-randomize after scoring). */
  mapping_id: string;
}

/** Internal mapping record that tracks which output is which version. */
export interface RandomizationMapping {
  mapping_id: string;
  output_1_is: 'version_a' | 'version_b';
  output_2_is: 'version_a' | 'version_b';
}

/** Result of de-randomization: scores correctly assigned back to versions. */
export interface DerandomizedPair {
  input: SelectedInput;
  version_a_output: string;
  version_b_output: string;
  mapping_id: string;
}

/** Storage interface for randomization mappings. */
export interface MappingStore {
  store(mapping: RandomizationMapping): void;
  retrieve(mappingId: string): RandomizationMapping;
}
