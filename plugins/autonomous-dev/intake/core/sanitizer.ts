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
import * as path from 'path';

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
// Pattern compilation
// ---------------------------------------------------------------------------

/**
 * Compile a rule pattern into a RegExp. The YAML rules are authored with the
 * PCRE/Python inline case-insensitive flag `(?i)`, which JavaScript's RegExp
 * does not support (it throws at construction). Strip any `(?i)` and fold it
 * into the JS `i` flag so the rule matches case-insensitively as written.
 */
function compilePattern(pattern: string, baseFlags = 'g'): RegExp {
  let source = pattern;
  let flags = baseFlags;
  if (source.includes('(?i)')) {
    source = source.replace(/\(\?i\)/g, '');
    if (!flags.includes('i')) flags += 'i';
  }
  return new RegExp(source, flags);
}

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

    // Validate pattern is a valid regex (via the (?i)-aware compiler).
    try {
      compilePattern(rule.pattern);
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
    const regex = compilePattern(rule.pattern);
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
        sanitizedText = applyEscape(sanitizedText, compilePattern(rule.pattern));
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

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------

/**
 * Absolute path to the injection rules shipped with the plugin
 * (`intake/config/injection-rules.yaml`). Resolved relative to this module so
 * it is correct whether sanitizer runs from source (ts-jest, `intake/core`) or
 * bundled into `intake/adapters/cli_adapter.js` — both sit one level under
 * `intake/`, so `../config` lands on the same file.
 *
 * #603: when bundled into `bin/triggers-serve.js` (the listener), `__dirname`
 * is `bin/`, so `../config` resolves wrong and the injection filter silently
 * fails to load. Prefer the stable plugin-root anchor the launcher exports;
 * fall back to `__dirname` for unbundled/test runs.
 */
export function defaultInjectionRulesPath(): string {
  const pluginRoot = process.env.AUTONOMOUS_DEV_PLUGIN_DIR;
  return pluginRoot
    ? path.join(pluginRoot, 'intake', 'config', 'injection-rules.yaml')
    : path.resolve(__dirname, '..', 'config', 'injection-rules.yaml');
}

/**
 * Best-effort load of the shipped default injection rules. On a missing or
 * corrupt file it logs to stderr and returns `[]` (degrade to "no extra
 * filtering") rather than throwing and bricking router construction. The
 * injection_corpus test gates the shipped file, so `[]` only happens on a
 * genuine deploy-time config fault. Production router builders pass the result
 * to the Submit/Trigger handlers so chat-originated input is sanitized.
 */
export function loadDefaultInjectionRules(): InjectionRule[] {
  try {
    return loadRules(defaultInjectionRulesPath());
  } catch (err) {
    process.stderr.write(
      `[sanitizer] failed to load default injection rules: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return [];
  }
}
