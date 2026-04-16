/**
 * PII Scrubber — Stage 1 of the Data Safety Pipeline.
 *
 * Implements 11 deterministic regex-based patterns for detecting and
 * redacting Personally Identifiable Information (PII) from text.
 *
 * Patterns are applied in a specific order to avoid cross-matching
 * (e.g. email runs before IPv6 compressed, US phone before intl phone).
 *
 * Based on SPEC-007-2-1 and TDD section 3.4.2.
 */

import type { PatternDefinition, Redaction, ScrubStageResult } from './types';

// ---------------------------------------------------------------------------
// PII pattern definitions (ordered)
// ---------------------------------------------------------------------------

/**
 * The 11 PII patterns in execution order.
 *
 * Order matters:
 * - Email before IPv6 compressed (domain could match IPv6 compressed)
 * - US phone before international phone (US is more specific)
 * - Credit card Amex after standard credit card (Amex is more specific with 3[47] prefix)
 */
export const PII_PATTERNS: PatternDefinition[] = [
  {
    name: 'email',
    type: 'email',
    regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    replacement: '[REDACTED:email]',
  },
  {
    name: 'phone_us',
    type: 'phone',
    regex: /\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replacement: '[REDACTED:phone]',
  },
  {
    name: 'phone_intl',
    type: 'phone',
    regex: /\+\d{1,3}[-.\s]?\d{4,14}/g,
    replacement: '[REDACTED:phone]',
  },
  {
    name: 'ssn',
    type: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED:ssn]',
  },
  {
    name: 'credit_card',
    type: 'credit_card',
    regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    replacement: '[REDACTED:credit_card]',
  },
  {
    name: 'credit_card_amex',
    type: 'credit_card',
    regex: /\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g,
    replacement: '[REDACTED:credit_card]',
  },
  {
    name: 'ipv4',
    type: 'ip',
    regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: '[REDACTED:ip]',
  },
  {
    name: 'ipv6_full',
    type: 'ip',
    regex: /\b([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    replacement: '[REDACTED:ip]',
  },
  {
    name: 'ipv6_compressed',
    type: 'ip',
    regex: /\b([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g,
    replacement: '[REDACTED:ip]',
    falsePositiveCheck: (match: string, _context: string): boolean => {
      // Reject matches that look like timestamps (HH:MM:SS or HH:MM:SS.mmm)
      const timestampPattern = /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/;
      if (timestampPattern.test(match)) return true; // IS a false positive
      // Reject if it matches ISO 8601 time portion
      const isoTimePattern = /^\d{2}:\d{2}:\d{2}/;
      if (isoTimePattern.test(match)) return true;
      return false; // NOT a false positive, proceed with redaction
    },
  },
  {
    name: 'jwt',
    type: 'jwt',
    regex: /\beyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\b/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'uuid_user_context',
    type: 'user_id',
    regex: /(?<=(?:user_id|customer_id|account_id)\s*[=:]\s*)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    replacement: '[REDACTED:user_id]',
    contextRequired: {
      fieldNames: ['user_id', 'customer_id', 'account_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Pattern application engine
// ---------------------------------------------------------------------------

/**
 * Apply a single pattern to text, collecting redactions.
 *
 * Handles false-positive checks, custom replacement functions, and
 * tracking of redaction metadata.
 *
 * @param text     The current text (may already have prior redactions applied).
 * @param pattern  The pattern to apply.
 * @returns  Object with the updated text and any new redactions.
 */
function applyPattern(
  text: string,
  pattern: PatternDefinition,
): { text: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];

  // Reset lastIndex for global regexes
  pattern.regex.lastIndex = 0;

  const newText = text.replace(pattern.regex, (match, ...args) => {
    // In replace callback, args = [...groups, offset, fullString, namedGroups?]
    // Find the offset by locating the first number argument from the end
    let offset = 0;
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === 'number') {
        offset = args[i] as number;
        break;
      }
    }

    // Check for false positives
    if (pattern.falsePositiveCheck && pattern.falsePositiveCheck(match, text)) {
      return match; // Keep original — false positive
    }

    redactions.push({
      type: pattern.type,
      position: offset,
      original_length: match.length,
      patternName: pattern.name,
    });

    // Use custom replacement function if available, otherwise static string
    if (pattern.replaceFunc) {
      return pattern.replaceFunc(match);
    }
    return pattern.replacement;
  });

  return { text: newText, redactions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrub PII from the given text using all 11 built-in patterns.
 *
 * Patterns are applied sequentially in the defined order. Each pattern
 * operates on the output of the previous pattern, so earlier redactions
 * prevent later patterns from matching the same text.
 *
 * @param input            The raw input text.
 * @param customPatterns   Optional additional patterns to apply after the
 *                         built-in patterns.
 * @returns  A `ScrubStageResult` with the scrubbed text and redaction metadata.
 */
export function scrubPii(
  input: string,
  customPatterns?: PatternDefinition[],
): ScrubStageResult {
  let text = input;
  const allRedactions: Redaction[] = [];

  const patterns = customPatterns
    ? [...PII_PATTERNS, ...customPatterns]
    : PII_PATTERNS;

  for (const pattern of patterns) {
    const result = applyPattern(text, pattern);
    text = result.text;
    allRedactions.push(...result.redactions);
  }

  return {
    text,
    redactions: allRedactions,
    redactionCount: allRedactions.length,
  };
}
