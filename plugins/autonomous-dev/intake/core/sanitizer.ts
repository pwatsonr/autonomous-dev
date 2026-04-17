/**
 * Prompt injection sanitizer with externalized YAML rules.
 *
 * Loads injection detection rules from a YAML configuration file,
 * validates them, and applies them to incoming text. Supports three
 * actions: block (reject), flag (mark for review), and escape
 * (neutralize template delimiters).
 *
 * @module sanitizer
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity levels for injection rules. */
export type Severity = 'critical' | 'high' | 'medium';

/** Actions taken when a rule matches. */
export type RuleAction = 'block' | 'flag' | 'escape';

/**
 * A single injection detection rule loaded from YAML.
 */
export interface InjectionRule {
  /** Unique identifier for the rule. */
  id: string;
  /** Regular expression pattern to match against input text. */
  pattern: string;
  /** Severity of the injection attempt. */
  severity: Severity;
  /** Action to take when the rule matches. */
  action: RuleAction;
  /** Human-readable description of what the rule detects. */
  message: string;
}

/**
 * A rule that was triggered during sanitization, with match count.
 */
export interface AppliedRule {
  /** The rule ID that matched. */
  ruleId: string;
  /** Severity of the matched rule. */
  severity: Severity;
  /** Action taken for this match. */
  action: RuleAction;
  /** Number of matches found in the text. */
  matchCount: number;
}

/**
 * Result of running the sanitization pipeline on an input text.
 */
export interface SanitizationResult {
  /** The text after sanitization (escaping applied; original preserved for block/flag). */
  sanitizedText: string;
  /** Whether the input was blocked (critical injection detected). */
  blocked: boolean;
  /** Whether the input was flagged for human review. */
  flaggedForReview: boolean;
  /** List of rules that matched, with details. */
  appliedRules: AppliedRule[];
}

/**
 * Raw shape of the YAML rule file.
 */
interface RuleFile {
  version: number;
  rules: InjectionRule[];
}

// ---------------------------------------------------------------------------
// Escape characters map
// ---------------------------------------------------------------------------

/**
 * Characters that get backslash-escaped by the `escape` action.
 * This neutralizes template delimiters without destroying readability.
 */
const ESCAPE_CHARS: Record<string, string> = {
  '{': '\\{',
  '}': '\\}',
  '$': '\\$',
  '<': '\\<',
  '>': '\\>',
  '%': '\\%',
};

// ---------------------------------------------------------------------------
// Rule loading and validation
// ---------------------------------------------------------------------------

/**
 * Load and validate injection rules from a YAML file.
 *
 * Validates:
 * - The file has a `version: 1` field.
 * - Each rule has required fields: `id`, `pattern`, `severity`, `action`, `message`.
 * - Each `pattern` is a valid regular expression.
 *
 * @param filePath  Absolute path to the YAML rule file.
 * @returns An array of validated injection rules.
 * @throws If the file is invalid, a rule is malformed, or a pattern is not valid regex.
 */
export function loadRules(filePath: string): InjectionRule[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw) as RuleFile;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid rule file: unable to parse YAML from ${filePath}`);
  }

  if (parsed.version !== 1) {
    throw new Error(
      `Invalid rule file: expected version 1, got ${parsed.version ?? 'undefined'}`,
    );
  }

  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error('Invalid rule file: rules array is missing or empty.');
  }

  const requiredFields: Array<keyof InjectionRule> = [
    'id',
    'pattern',
    'severity',
    'action',
    'message',
  ];

  const validSeverities: Severity[] = ['critical', 'high', 'medium'];
  const validActions: RuleAction[] = ['block', 'flag', 'escape'];

  for (const rule of parsed.rules) {
    // Check required fields
    for (const field of requiredFields) {
      if (rule[field] === undefined || rule[field] === null || rule[field] === '') {
        throw new Error(
          `Invalid rule "${rule.id ?? 'unknown'}": missing required field "${field}".`,
        );
      }
    }

    // Validate severity
    if (!validSeverities.includes(rule.severity)) {
      throw new Error(
        `Invalid rule "${rule.id}": severity must be one of ${validSeverities.join(', ')}, got "${rule.severity}".`,
      );
    }

    // Validate action
    if (!validActions.includes(rule.action)) {
      throw new Error(
        `Invalid rule "${rule.id}": action must be one of ${validActions.join(', ')}, got "${rule.action}".`,
      );
    }

    // Validate pattern is a valid regex
    try {
      new RegExp(rule.pattern, 'g');
    } catch (err) {
      throw new Error(
        `Invalid rule "${rule.id}": pattern is not a valid regex: ${(err as Error).message}`,
      );
    }
  }

  return parsed.rules;
}

// ---------------------------------------------------------------------------
// Sanitization pipeline
// ---------------------------------------------------------------------------

/**
 * Apply escape action to text: backslash-escape template delimiter characters.
 *
 * @param text     The text to escape.
 * @param pattern  The regex pattern that matched (used to identify match regions).
 * @returns The text with special characters escaped in matched regions.
 */
function applyEscape(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => {
    let escaped = '';
    for (const char of match) {
      escaped += ESCAPE_CHARS[char] ?? char;
    }
    return escaped;
  });
}

/**
 * Sanitize input text by applying all loaded injection rules.
 *
 * Processing pipeline:
 * 1. Iterate all rules in order.
 * 2. For each rule, compile a RegExp and test against the current text.
 * 3. On match:
 *    - `block`: set `blocked = true`; do not modify text (preserve for audit).
 *    - `flag`: set `flaggedForReview = true`; do not modify text.
 *    - `escape`: replace special chars in matched regions with backslash-escaped versions.
 * 4. Append to `appliedRules` with `matchCount`.
 * 5. All rules are checked even if blocked (to collect the full audit trail).
 * 6. Return the complete `SanitizationResult`.
 *
 * @param text   The raw input text to sanitize.
 * @param rules  The injection rules to apply (from {@link loadRules}).
 * @returns A {@link SanitizationResult} describing what happened.
 */
export function sanitize(text: string, rules: InjectionRule[]): SanitizationResult {
  let sanitizedText = text;
  let blocked = false;
  let flaggedForReview = false;
  const appliedRules: AppliedRule[] = [];

  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, 'g');
    const matches = sanitizedText.match(regex);

    if (!matches || matches.length === 0) {
      continue;
    }

    const matchCount = matches.length;

    switch (rule.action) {
      case 'block':
        blocked = true;
        // Do not modify text; preserve for audit.
        break;

      case 'flag':
        flaggedForReview = true;
        // Do not modify text.
        break;

      case 'escape':
        // Replace special characters in matched regions.
        sanitizedText = applyEscape(sanitizedText, new RegExp(rule.pattern, 'g'));
        break;
    }

    appliedRules.push({
      ruleId: rule.id,
      severity: rule.severity,
      action: rule.action,
      matchCount,
    });
  }

  return {
    sanitizedText,
    blocked,
    flaggedForReview,
    appliedRules,
  };
}
