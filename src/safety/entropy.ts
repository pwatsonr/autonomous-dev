/**
 * Shannon entropy calculator and high-entropy secret detector.
 *
 * Provides a generic detector for secrets that don't match any specific
 * pattern but exhibit high Shannon entropy in a sensitive context
 * (password=, secret=, token=, key=).
 *
 * Based on SPEC-007-2-1 and TDD section 3.4.3.
 */

import type { Redaction } from './types';

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

/**
 * Compute the Shannon entropy (bits per character) of a string.
 *
 * For a string of length N with character frequencies f_i, entropy is:
 *   H = - sum( (f_i / N) * log2(f_i / N) )
 *
 * Edge cases:
 * - Empty string returns 0.
 * - Single unique character returns 0.
 *
 * @param s  The input string.
 * @returns  Shannon entropy in bits per character.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;

  const freq: Record<string, number> = {};
  for (const c of s) {
    freq[c] = (freq[c] || 0) + 1;
  }

  let entropy = 0;
  const len = s.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

// ---------------------------------------------------------------------------
// High-entropy context detector
// ---------------------------------------------------------------------------

/**
 * Regex that matches value assignments in sensitive contexts.
 *
 * Captures the value portion (group 1) from patterns like:
 *   password=<value>
 *   secret: <value>
 *   token = <value>
 *   key=<value>
 */
const HIGH_ENTROPY_CONTEXT_REGEX =
  /(?:password|secret|token|key)\s*[=:]\s*(\S{20,})/gi;

/**
 * Minimum Shannon entropy (bits/char) to flag a value as a potential secret.
 */
const ENTROPY_THRESHOLD = 4.5;

/**
 * Minimum character length for a value to be considered for entropy analysis.
 */
const MIN_VALUE_LENGTH = 20;

/**
 * Detect high-entropy strings in sensitive assignment contexts.
 *
 * Scans the input text for patterns like `password=<value>` where `<value>`
 * is at least 20 characters long and has Shannon entropy exceeding 4.5
 * bits/char.
 *
 * @param text  The input text to scan.
 * @returns  Array of redaction records for detected high-entropy secrets.
 */
export function detectHighEntropySecrets(text: string): Redaction[] {
  const redactions: Redaction[] = [];

  // Reset lastIndex in case the regex was used before
  HIGH_ENTROPY_CONTEXT_REGEX.lastIndex = 0;

  let match;
  while ((match = HIGH_ENTROPY_CONTEXT_REGEX.exec(text)) !== null) {
    const value = match[1];
    if (value.length > MIN_VALUE_LENGTH && shannonEntropy(value) > ENTROPY_THRESHOLD) {
      redactions.push({
        type: 'secret',
        position: match.index,
        original_length: match[0].length,
        patternName: 'high_entropy',
      });
    }
  }

  return redactions;
}
