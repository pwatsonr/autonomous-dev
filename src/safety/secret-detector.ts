/**
 * Secret Detector — Stage 2 of the Data Safety Pipeline.
 *
 * Implements 15 deterministic regex-based patterns for detecting and
 * redacting secrets (API keys, tokens, connection strings, etc.) plus
 * a Shannon entropy-based generic detector and an environment variable
 * pattern that preserves key names.
 *
 * Based on SPEC-007-2-1 and TDD section 3.4.3.
 */

import type { PatternDefinition, Redaction, ScrubStageResult } from './types';
import { detectHighEntropySecrets } from './entropy';

// ---------------------------------------------------------------------------
// Secret pattern definitions
// ---------------------------------------------------------------------------

/**
 * The 15 secret patterns in execution order, plus the env var pattern.
 */
export const SECRET_PATTERNS: PatternDefinition[] = [
  {
    name: 'aws_access_key',
    type: 'secret',
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'aws_secret_key',
    type: 'secret',
    regex: /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'stripe_secret',
    type: 'secret',
    regex: /sk_live_[a-zA-Z0-9]{24,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'stripe_publishable',
    type: 'secret',
    regex: /pk_live_[a-zA-Z0-9]{24,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'github_pat',
    type: 'secret',
    regex: /ghp_[a-zA-Z0-9]{36}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'github_app',
    type: 'secret',
    regex: /ghs_[a-zA-Z0-9]{36}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'github_oauth',
    type: 'secret',
    regex: /gho_[a-zA-Z0-9]{36}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'gitlab_pat',
    type: 'secret',
    regex: /glpat-[a-zA-Z0-9\-]{20,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'gcp_service_account',
    type: 'secret',
    regex: /"private_key":\s*"-----BEGIN [A-Z ]+ KEY-----/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'gcp_api_key',
    type: 'secret',
    regex: /AIza[0-9A-Za-z\-_]{35}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'slack_bot_token',
    type: 'secret',
    regex: /xoxb-[0-9]{10,}-[a-zA-Z0-9]{24,}/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'slack_webhook',
    type: 'secret',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9]+\/B[a-zA-Z0-9]+\/[a-zA-Z0-9]+/g,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'generic_bearer',
    type: 'secret',
    regex: /(?:bearer|Bearer|BEARER)\s+[a-zA-Z0-9\-_.~+/]+=*/gi,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'basic_auth',
    type: 'secret',
    regex: /(?:basic|Basic|BASIC)\s+[a-zA-Z0-9+/]+=*/gi,
    replacement: '[SECRET_REDACTED]',
  },
  {
    name: 'private_key_block',
    type: 'secret',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '[SECRET_REDACTED]',
  },
];

// ---------------------------------------------------------------------------
// Environment variable pattern
// ---------------------------------------------------------------------------

/**
 * Pattern for environment variable assignments that contain secrets.
 *
 * Preserves the key name while replacing only the value:
 *   MY_SECRET_KEY=abc123  ->  MY_SECRET_KEY=[SECRET_REDACTED]
 */
export const ENV_VAR_PATTERN: PatternDefinition = {
  name: 'env_var',
  type: 'secret',
  regex: /(?:.*_KEY|.*_SECRET|.*_TOKEN|.*_PASSWORD)\s*[=:]\s*\S+/gi,
  replacement: '', // Unused — replaceFunc handles replacement
  replaceFunc: (match: string): string => {
    const separatorIdx = match.search(/[=:]/);
    const keyPart = match.substring(0, separatorIdx);
    const separator = match[separatorIdx];
    return `${keyPart.trim()}${separator}[SECRET_REDACTED]`;
  },
};

// ---------------------------------------------------------------------------
// Pattern application engine
// ---------------------------------------------------------------------------

/**
 * Apply a single pattern to text, collecting redactions.
 *
 * @param text     The current text.
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
      return match;
    }

    redactions.push({
      type: pattern.type,
      position: offset,
      original_length: match.length,
      patternName: pattern.name,
    });

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
 * Detect and redact secrets from the given text.
 *
 * Applies the 15 built-in secret patterns, the environment variable
 * pattern, and the Shannon entropy-based generic detector (in that order).
 *
 * @param input            The raw input text (typically already PII-scrubbed).
 * @param customPatterns   Optional additional patterns to apply after the
 *                         built-in patterns but before the entropy detector.
 * @returns  A `ScrubStageResult` with the scrubbed text and redaction metadata.
 */
export function detectSecrets(
  input: string,
  customPatterns?: PatternDefinition[],
): ScrubStageResult {
  let text = input;
  const allRedactions: Redaction[] = [];

  // 1. Apply the 15 core secret patterns
  for (const pattern of SECRET_PATTERNS) {
    const result = applyPattern(text, pattern);
    text = result.text;
    allRedactions.push(...result.redactions);
  }

  // 2. Apply custom patterns (if any)
  if (customPatterns) {
    for (const pattern of customPatterns) {
      const result = applyPattern(text, pattern);
      text = result.text;
      allRedactions.push(...result.redactions);
    }
  }

  // 3. Apply the environment variable pattern
  const envResult = applyPattern(text, ENV_VAR_PATTERN);
  text = envResult.text;
  allRedactions.push(...envResult.redactions);

  // 4. Run the Shannon entropy-based generic detector (last)
  const entropyRedactions = detectHighEntropySecrets(text);
  if (entropyRedactions.length > 0) {
    // Apply entropy-based redactions by replacing matched regions
    // Process in reverse order to preserve position indices
    const sortedRedactions = [...entropyRedactions].sort(
      (a, b) => b.position - a.position,
    );

    for (const redaction of sortedRedactions) {
      const before = text.substring(0, redaction.position);
      const after = text.substring(redaction.position + redaction.original_length);

      // Preserve the key= prefix and only replace the value
      const matchedText = text.substring(
        redaction.position,
        redaction.position + redaction.original_length,
      );
      const separatorIdx = matchedText.search(/[=:]/);
      if (separatorIdx !== -1) {
        const keyPart = matchedText.substring(0, separatorIdx + 1);
        text = `${before}${keyPart}[SECRET_REDACTED]${after}`;
      } else {
        text = `${before}[SECRET_REDACTED]${after}`;
      }
    }

    allRedactions.push(...entropyRedactions);
  }

  return {
    text,
    redactions: allRedactions,
    redactionCount: allRedactions.length,
  };
}
