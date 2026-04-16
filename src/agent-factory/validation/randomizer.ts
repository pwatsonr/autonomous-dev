/**
 * Label Randomizer (SPEC-005-4-1, Task 3).
 *
 * Randomizes the labels on a RunPair so that the scorer cannot determine
 * which output is from the current vs. proposed agent.  Uses a
 * cryptographically secure random source (`crypto.randomBytes`).
 *
 * Separation of concerns:
 *   - The RandomizedPair contains NO indication of which output is which.
 *   - The RandomizationMapping is stored separately via the MappingStore.
 *   - De-randomization retrieves the mapping ONLY after scoring is complete.
 *   - Output text is stripped of version metadata before randomization.
 *
 * Exports: `LabelRandomizer`, `InMemoryMappingStore`, `derandomize`
 */

import * as crypto from 'crypto';
import type {
  RunPair,
  RandomizedPair,
  RandomizationMapping,
  DerandomizedPair,
  MappingStore,
} from './types';

// ---------------------------------------------------------------------------
// Version metadata stripping
// ---------------------------------------------------------------------------

/**
 * Patterns that may leak version information in agent output.
 * These are stripped before the output is placed in the RandomizedPair.
 */
const VERSION_METADATA_PATTERNS: RegExp[] = [
  // e.g. "Version: 1.2.3" or "v1.2.3"
  /\b[Vv]ersion[:\s]+\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?\b/g,
  /\bv\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?\b/g,
  // e.g. "agent-name v1.2.3-proposed"
  /\b\S+-proposed\b/g,
];

/**
 * Strip version metadata from output text to prevent the scorer from
 * inferring which output is current vs. proposed.
 */
function stripVersionMetadata(text: string): string {
  let stripped = text;
  for (const pattern of VERSION_METADATA_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0;
    stripped = stripped.replace(pattern, '[VERSION_REDACTED]');
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// InMemoryMappingStore
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of MappingStore.
 *
 * For production use, this can be replaced with a persistent store.
 * The in-memory store is sufficient for a single evaluation run.
 */
export class InMemoryMappingStore implements MappingStore {
  private readonly mappings = new Map<string, RandomizationMapping>();

  store(mapping: RandomizationMapping): void {
    this.mappings.set(mapping.mapping_id, mapping);
  }

  retrieve(mappingId: string): RandomizationMapping {
    const mapping = this.mappings.get(mappingId);
    if (!mapping) {
      throw new Error(`Mapping not found: ${mappingId}`);
    }
    return mapping;
  }

  /**
   * Return the number of stored mappings (useful for testing).
   */
  size(): number {
    return this.mappings.size;
  }
}

// ---------------------------------------------------------------------------
// LabelRandomizer
// ---------------------------------------------------------------------------

export class LabelRandomizer {
  private readonly mappingStore: MappingStore;

  constructor(mappingStore: MappingStore) {
    this.mappingStore = mappingStore;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Randomize a RunPair so the scorer sees two unlabeled outputs.
   *
   * Steps:
   *   1. Strip version metadata from both outputs.
   *   2. Generate a cryptographically secure random bit.
   *   3. Assign outputs to output_1 / output_2 based on the random bit.
   *   4. Store the mapping separately (NOT in the returned pair).
   *   5. Return the RandomizedPair.
   *
   * @param pair  The RunPair containing version_a and version_b outputs.
   * @returns     A RandomizedPair with no version labels.
   */
  randomize(pair: RunPair): RandomizedPair {
    // Step 1: Strip version metadata
    const strippedA = stripVersionMetadata(pair.version_a.output);
    const strippedB = stripVersionMetadata(pair.version_b.output);

    // Step 2: Cryptographically secure random bit
    const randomByte = crypto.randomBytes(1)[0];
    const swapped = (randomByte & 1) === 1;

    // Step 3: Assign based on random bit
    const mappingId = crypto.randomUUID();

    const output1 = swapped ? strippedB : strippedA;
    const output2 = swapped ? strippedA : strippedB;
    const output1Is: 'version_a' | 'version_b' = swapped ? 'version_b' : 'version_a';
    const output2Is: 'version_a' | 'version_b' = swapped ? 'version_a' : 'version_b';

    // Step 4: Store mapping separately
    const mapping: RandomizationMapping = {
      mapping_id: mappingId,
      output_1_is: output1Is,
      output_2_is: output2Is,
    };
    this.mappingStore.store(mapping);

    // Step 5: Return randomized pair (no version info)
    return {
      input: pair.input,
      output_1: output1,
      output_2: output2,
      mapping_id: mappingId,
    };
  }
}

// ---------------------------------------------------------------------------
// De-randomization (standalone function)
// ---------------------------------------------------------------------------

/**
 * De-randomize a scored pair by retrieving the mapping and assigning
 * outputs back to version_a / version_b.
 *
 * This function should ONLY be called after scoring is complete.
 *
 * @param pair          The RandomizedPair (with output_1 and output_2).
 * @param mappingStore  The MappingStore containing the randomization mapping.
 * @returns             A DerandomizedPair with version labels restored.
 */
export function derandomize(
  pair: RandomizedPair,
  mappingStore: MappingStore,
): DerandomizedPair {
  const mapping = mappingStore.retrieve(pair.mapping_id);

  const versionAOutput =
    mapping.output_1_is === 'version_a' ? pair.output_1 : pair.output_2;
  const versionBOutput =
    mapping.output_1_is === 'version_b' ? pair.output_1 : pair.output_2;

  return {
    input: pair.input,
    version_a_output: versionAOutput,
    version_b_output: versionBOutput,
    mapping_id: pair.mapping_id,
  };
}
