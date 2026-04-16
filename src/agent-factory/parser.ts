/**
 * Agent definition frontmatter parser (SPEC-005-1-1, Task 1).
 *
 * Extracts YAML frontmatter from agent `.md` files, parses it into a
 * typed `ParsedAgent` structure, and separates the Markdown body
 * (used as `system_prompt`).
 *
 * The parser is intentionally lenient about missing fields — that is
 * the validator's responsibility. It only fails on:
 *   - Missing frontmatter delimiters (no `---`)
 *   - YAML syntax errors
 */

import {
  ParsedAgent,
  ParsedAgentResult,
  ParserError,
  QualityDimension,
  VersionHistoryEntry,
  AgentRole,
  RiskTier,
} from './types';

// Re-export for convenience
export type { ParsedAgentResult };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses an agent definition file from the filesystem.
 *
 * Reads the file at `filePath`, then delegates to `parseAgentString`.
 * File I/O errors are returned as `ParserError` entries.
 */
export function parseAgentFile(filePath: string): ParsedAgentResult {
  let content: string;
  try {
    // Use Node built-in; callers are expected to run in Node context.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  return parseAgentString(content);
}

/**
 * Parses an in-memory agent definition string.
 *
 * Steps:
 *   1. Extract YAML frontmatter between `---` delimiters.
 *   2. Parse the YAML into a raw object.
 *   3. Map raw fields onto the typed `ParsedAgent` structure.
 *   4. Capture everything after the closing `---` as `system_prompt`.
 */
export function parseAgentString(content: string): ParsedAgentResult {
  // ----- Step 1: extract frontmatter -----
  const extraction = extractFrontmatter(content);
  if (!extraction.ok) {
    return { success: false, errors: extraction.errors };
  }

  // ----- Step 2: parse YAML -----
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(extraction.yaml);
  } catch (err) {
    if (err instanceof YamlParseError) {
      return {
        success: false,
        errors: [{ message: err.message, line: err.line }],
      };
    }
    return {
      success: false,
      errors: [
        {
          message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  // ----- Step 3: map to ParsedAgent -----
  const agent = mapToParsedAgent(raw, extraction.body);

  return { success: true, agent, errors: [] };
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

interface ExtractionSuccess {
  ok: true;
  yaml: string;
  body: string;
}

interface ExtractionFailure {
  ok: false;
  errors: ParserError[];
}

type ExtractionResult = ExtractionSuccess | ExtractionFailure;

/**
 * Splits content into raw YAML frontmatter and the Markdown body.
 *
 * Frontmatter is delimited by `---` on its own line at the very start.
 * Only the first and second `---` lines are treated as delimiters;
 * any subsequent `---` in the body is preserved verbatim.
 */
function extractFrontmatter(content: string): ExtractionResult {
  const DELIMITER = '---';

  // The document must start with ---
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1) {
    if (content.replace(/\r$/, '') === DELIMITER) {
      return {
        ok: false,
        errors: [{ message: 'No YAML frontmatter found (opening delimiter but no closing delimiter)' }],
      };
    }
    return {
      ok: false,
      errors: [{ message: 'No YAML frontmatter found' }],
    };
  }

  const firstLine = content.substring(0, firstNewline).replace(/\r$/, '');
  if (firstLine !== DELIMITER) {
    return {
      ok: false,
      errors: [{ message: 'No YAML frontmatter found' }],
    };
  }

  // Search for the closing delimiter
  const afterFirstDelimiter = firstNewline + 1;
  let closingDelimStart = -1;
  let searchPos = afterFirstDelimiter;

  while (searchPos < content.length) {
    const lineEnd = content.indexOf('\n', searchPos);
    const lineEndPos = lineEnd === -1 ? content.length : lineEnd;
    const line = content.substring(searchPos, lineEndPos).replace(/\r$/, '');

    if (line === DELIMITER) {
      closingDelimStart = searchPos;
      break;
    }

    if (lineEnd === -1) break;
    searchPos = lineEnd + 1;
  }

  if (closingDelimStart === -1) {
    return {
      ok: false,
      errors: [{ message: 'No YAML frontmatter found (opening delimiter but no closing delimiter)' }],
    };
  }

  const yaml = content.substring(afterFirstDelimiter, closingDelimStart);

  // Body: everything after the closing delimiter line
  const closingLineEnd = content.indexOf('\n', closingDelimStart);
  const body = closingLineEnd === -1 ? '' : content.substring(closingLineEnd + 1);

  return { ok: true, yaml, body };
}

// ---------------------------------------------------------------------------
// Lightweight YAML parser
// ---------------------------------------------------------------------------

/**
 * Custom error for YAML parse failures that includes a line number.
 */
class YamlParseError extends Error {
  public readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = 'YamlParseError';
    this.line = line;
  }
}

/**
 * A lightweight YAML parser that handles:
 *   - Simple scalars: key: value
 *   - Quoted strings (single and double)
 *   - Flow-style arrays: key: [a, b, c]
 *   - Block-style arrays: key:\n  - item1\n  - item2
 *   - Block-style array of objects (for evaluation_rubric / version_history)
 *   - Booleans, nulls, numbers
 *
 * This is NOT a full YAML parser. It covers the subset needed for
 * agent definition frontmatter.
 */
function parseYaml(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '');

    // Skip blank lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Top-level key: must not be indented
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new YamlParseError(
        `Invalid YAML at line ${i + 1}: no key-value separator found`,
        i + 1,
      );
    }

    const key = line.substring(0, colonIdx).trim();
    const rawValue = line.substring(colonIdx + 1).trim();

    if (key === '') {
      throw new YamlParseError(
        `Invalid YAML at line ${i + 1}: empty key`,
        i + 1,
      );
    }

    // Check if this is a block-style sequence or mapping (value is empty,
    // and the next line starts with "  -" or is indented)
    if (rawValue === '' && i + 1 < lines.length) {
      const nextLine = lines[i + 1].replace(/\r$/, '');
      if (/^\s+-\s/.test(nextLine) || /^\s+-$/.test(nextLine)) {
        // Block-style array: collect all indented "- " lines
        const items = parseBlockArray(lines, i + 1);
        result[key] = items.values;
        i = items.nextIndex;
        continue;
      }
    }

    result[key] = parseScalarValue(rawValue);
    i++;
  }

  return result;
}

/**
 * Parse a block-style YAML array starting at `startLine`.
 * Handles both simple items (`- value`) and object items
 * (`- key: value\n  key2: value2`).
 */
function parseBlockArray(
  lines: string[],
  startLine: number,
): { values: unknown[]; nextIndex: number } {
  const values: unknown[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '');

    // Stop if we hit a non-indented, non-blank line (back to top-level)
    if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('\t')) {
      break;
    }

    // Skip blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Must be a "  - " item
    const dashMatch = line.match(/^(\s+)-\s*(.*)/);
    if (!dashMatch) {
      // Not an array item; probably back to top-level
      break;
    }

    const afterDash = dashMatch[2].trim();

    // Check if this dash line has a key: value (object item on same line)
    const objColonIdx = afterDash.indexOf(':');
    if (objColonIdx !== -1 && !afterDash.startsWith('[') && !afterDash.startsWith('"') && !afterDash.startsWith("'")) {
      // Object item — collect this line and subsequent indented lines
      const obj: Record<string, unknown> = {};
      const firstKey = afterDash.substring(0, objColonIdx).trim();
      const firstVal = afterDash.substring(objColonIdx + 1).trim();
      obj[firstKey] = parseScalarValue(firstVal);
      i++;

      // Collect continuation lines (deeper indentation than the dash)
      const dashIndent = dashMatch[1].length + 2; // "  - " -> indent + dash + space
      while (i < lines.length) {
        const contLine = lines[i].replace(/\r$/, '');
        if (contLine.trim() === '') {
          i++;
          continue;
        }
        // Count leading whitespace
        const contIndent = contLine.length - contLine.trimStart().length;
        if (contIndent < dashIndent) {
          break;
        }
        const contColonIdx = contLine.indexOf(':');
        if (contColonIdx === -1) break;
        const contKey = contLine.substring(0, contColonIdx).trim();
        const contVal = contLine.substring(contColonIdx + 1).trim();
        obj[contKey] = parseScalarValue(contVal);
        i++;
      }

      values.push(obj);
    } else {
      // Simple scalar item
      values.push(parseScalarValue(afterDash));
      i++;
    }
  }

  return { values, nextIndex: i };
}

/**
 * Parse a single YAML scalar value (not a key).
 */
function parseScalarValue(rawValue: string): unknown {
  // Null
  if (rawValue === 'null' || rawValue === '~' || rawValue === '') {
    return null;
  }

  // Boolean
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;

  // Flow-style array
  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    const inner = rawValue.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => parseScalarValue(item.trim()));
  }

  // Double-quoted string
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1);
  }

  // Single-quoted string
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }

  // Integer
  if (/^-?\d+$/.test(rawValue)) {
    return parseInt(rawValue, 10);
  }

  // Float
  if (/^-?\d+\.\d+$/.test(rawValue)) {
    return parseFloat(rawValue);
  }

  // Plain string
  return rawValue;
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

/**
 * Maps a raw YAML object plus the Markdown body into a `ParsedAgent`.
 *
 * Applies type coercion where possible:
 *   - `turn_limit` string -> number
 *   - `temperature` string -> number
 *   - `tools` / `expertise` ensure array
 *   - `evaluation_rubric` maps objects to QualityDimension[]
 *   - `version_history` maps objects to VersionHistoryEntry[]
 */
function mapToParsedAgent(
  raw: Record<string, unknown>,
  body: string,
): ParsedAgent {
  return {
    name: asString(raw.name),
    version: asString(raw.version),
    role: asString(raw.role) as AgentRole,
    model: asString(raw.model),
    temperature: asNumber(raw.temperature),
    turn_limit: asInteger(raw.turn_limit),
    tools: asStringArray(raw.tools),
    expertise: asStringArray(raw.expertise),
    evaluation_rubric: asQualityDimensions(raw.evaluation_rubric),
    version_history: asVersionHistory(raw.version_history),
    risk_tier: raw.risk_tier !== undefined && raw.risk_tier !== null
      ? (asString(raw.risk_tier) as RiskTier)
      : undefined,
    frozen: raw.frozen !== undefined && raw.frozen !== null
      ? Boolean(raw.frozen)
      : undefined,
    description: asString(raw.description),
    system_prompt: body,
  };
}

function asString(val: unknown): string {
  if (val === undefined || val === null) return '';
  return String(val);
}

function asNumber(val: unknown): number {
  if (val === undefined || val === null) return NaN;
  if (typeof val === 'number') return val;
  const n = Number(val);
  return isNaN(n) ? NaN : n;
}

function asInteger(val: unknown): number {
  const n = asNumber(val);
  return isNaN(n) ? NaN : Math.trunc(n);
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map((v) => String(v));
}

function asQualityDimensions(val: unknown): QualityDimension[] {
  if (!Array.isArray(val)) return [];
  return val.map((item) => {
    if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      return {
        name: asString(obj.name),
        weight: asNumber(obj.weight),
        description: asString(obj.description),
      };
    }
    return { name: '', weight: 0, description: '' };
  });
}

function asVersionHistory(val: unknown): VersionHistoryEntry[] {
  if (!Array.isArray(val)) return [];
  return val.map((item) => {
    if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      return {
        version: asString(obj.version),
        date: asString(obj.date),
        change: asString(obj.change),
      };
    }
    return { version: '', date: '', change: '' };
  });
}
