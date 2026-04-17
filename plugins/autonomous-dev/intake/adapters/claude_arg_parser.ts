/**
 * Claude App Argument Parser.
 *
 * Tokenizes and parses raw slash-command argument strings into structured
 * positional args and named flags.  Handles double-quoted strings, boolean
 * flags, key-value flags, and validates basic syntax.
 *
 * Implements SPEC-008-2-02, Task 3.
 *
 * @module claude_arg_parser
 */

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when argument parsing or adapter-level input validation fails.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a raw command string into tokens, respecting double-quoted strings.
 *
 * Rules:
 * - Whitespace outside quotes separates tokens.
 * - A double-quote toggles "in quotes" mode; content inside quotes is emitted
 *   as a single token (without the surrounding quotes).
 * - Text adjacent to (but outside) a quoted segment is emitted as a separate
 *   token before the quoted content begins.
 * - Multiple consecutive spaces outside quotes are collapsed.
 * - An unclosed quote throws a {@link ValidationError}.
 *
 * @param raw - The raw argument string.
 * @returns An array of string tokens.
 * @throws {ValidationError} If a quote is opened but never closed.
 */
export function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuotes) {
        tokens.push(current);
        current = '';
        inQuotes = false;
      } else {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
        inQuotes = true;
      }
    } else if (ch === ' ' && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (inQuotes) {
    throw new ValidationError('Unclosed quote in command arguments');
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** The result of parsing a raw command argument string. */
export interface ParsedArgs {
  /** Positional arguments (non-flag tokens). */
  args: string[];
  /** Named flags — boolean (`true`) when no value follows, otherwise string. */
  flags: Record<string, string | boolean>;
}

/**
 * Parse a raw command argument string into positional args and named flags.
 *
 * Flags are identified by the `--` prefix.  A flag whose next token does NOT
 * start with `--` consumes that token as its value; otherwise the flag is
 * treated as a boolean (`true`).  All other tokens are positional args.
 *
 * @param raw - The raw argument string (may be empty/null/undefined).
 * @returns Parsed positional args and flags.
 * @throws {ValidationError} On syntax errors (unclosed quotes, empty flag names).
 *
 * @example
 * ```ts
 * parseCommandArgs('"Build auth" --priority high --force');
 * // => { args: ["Build auth"], flags: { priority: "high", force: true } }
 * ```
 */
export function parseCommandArgs(raw: string): ParsedArgs {
  if (!raw || raw.trim().length === 0) {
    return { args: [], flags: {} };
  }

  const tokens = tokenize(raw.trim());
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].startsWith('--')) {
      const flagName = tokens[i].slice(2);
      if (flagName.length === 0) {
        throw new ValidationError('Empty flag name: --');
      }
      const nextToken = tokens[i + 1];
      if (nextToken && !nextToken.startsWith('--')) {
        flags[flagName] = nextToken;
        i += 2;
      } else {
        flags[flagName] = true;
        i += 1;
      }
    } else {
      args.push(tokens[i]);
      i += 1;
    }
  }

  return { args, flags };
}
