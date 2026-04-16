import { DocumentFrontmatter } from '../types/frontmatter';

/**
 * Result of parsing a Markdown document's frontmatter.
 */
export interface ParseResult {
  /** Parsed frontmatter object (may be partial/untyped before validation) */
  frontmatter: Partial<DocumentFrontmatter>;
  /** Raw YAML string between the --- delimiters */
  rawYaml: string;
  /** Markdown body after the frontmatter block */
  body: string;
  /** Full raw content of the document */
  rawContent: string;
}

export interface ParseError {
  code: 'NO_FRONTMATTER' | 'MALFORMED_YAML' | 'EMPTY_FRONTMATTER';
  message: string;
  line?: number;
}

/**
 * Custom error class for frontmatter parsing failures.
 */
export class FrontmatterParseError extends Error {
  public readonly code: ParseError['code'];
  public readonly line?: number;

  constructor(error: ParseError) {
    super(error.message);
    this.name = 'FrontmatterParseError';
    this.code = error.code;
    this.line = error.line;
  }
}

/**
 * Parses a simple YAML key-value string into an object.
 *
 * Handles:
 * - Simple scalars: key: value
 * - Quoted strings: key: "value" or key: 'value'
 * - Arrays in flow style: key: [a, b, c]
 * - Null values: key: null or key: ~
 * - Booleans: true/false
 * - Numbers: integers and floats
 * - Empty values: key: (treated as empty string)
 *
 * This is a lightweight parser for flat YAML frontmatter.
 * It does NOT handle nested objects or block-style arrays.
 */
function parseSimpleYaml(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');

    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }

    // Match key: value pattern
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new FrontmatterParseError({
        code: 'MALFORMED_YAML',
        message: `Invalid YAML at line ${i + 1}: no key-value separator found`,
        line: i + 1,
      });
    }

    const key = line.substring(0, colonIdx).trim();
    let rawValue = line.substring(colonIdx + 1).trim();

    if (key === '') {
      throw new FrontmatterParseError({
        code: 'MALFORMED_YAML',
        message: `Invalid YAML at line ${i + 1}: empty key`,
        line: i + 1,
      });
    }

    result[key] = parseYamlValue(rawValue);
  }

  return result;
}

/**
 * Parses a single YAML scalar or flow-style array value.
 */
function parseYamlValue(rawValue: string): unknown {
  // Null
  if (rawValue === 'null' || rawValue === '~' || rawValue === '') {
    return null;
  }

  // Boolean
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;

  // Flow-style array: [item1, item2, ...]
  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    const inner = rawValue.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => parseYamlValue(item.trim()));
  }

  // Quoted string (double quotes)
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1);
  }

  // Quoted string (single quotes)
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

/**
 * Extracts YAML frontmatter from a Markdown document.
 *
 * Algorithm:
 * 1. Check if content starts with '---\n' (or '---\r\n').
 * 2. Find the closing '---\n' delimiter.
 * 3. Extract the YAML string between the delimiters.
 * 4. Parse the YAML string.
 * 5. Return ParseResult with frontmatter, body, rawYaml, rawContent.
 *
 * Edge cases:
 * - No frontmatter: throws FrontmatterParseError with code NO_FRONTMATTER.
 * - Empty frontmatter (---\n---): throws FrontmatterParseError with code EMPTY_FRONTMATTER.
 * - Malformed YAML: throws FrontmatterParseError with code MALFORMED_YAML and line number.
 * - Frontmatter only (no body): body is empty string.
 *
 * @param content Raw Markdown file content
 * @returns ParseResult on success
 * @throws FrontmatterParseError on failure
 */
export function parseFrontmatter(content: string): ParseResult {
  const DELIMITER = '---';

  // Normalize: find the first line
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1) {
    // Entire content is one line
    if (content.replace(/\r$/, '') === DELIMITER) {
      throw new FrontmatterParseError({
        code: 'NO_FRONTMATTER',
        message: 'Document has opening delimiter but no closing delimiter',
      });
    }
    throw new FrontmatterParseError({
      code: 'NO_FRONTMATTER',
      message: 'Document does not start with frontmatter delimiter (---)',
    });
  }

  const firstLine = content.substring(0, firstNewline).replace(/\r$/, '');
  if (firstLine !== DELIMITER) {
    throw new FrontmatterParseError({
      code: 'NO_FRONTMATTER',
      message: 'Document does not start with frontmatter delimiter (---)',
    });
  }

  // Search for the closing delimiter starting after the first line
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
    throw new FrontmatterParseError({
      code: 'NO_FRONTMATTER',
      message: 'Document has opening delimiter but no closing delimiter',
    });
  }

  // Extract the raw YAML between delimiters
  const rawYaml = content.substring(afterFirstDelimiter, closingDelimStart);

  // Check for empty frontmatter
  if (rawYaml.replace(/\r/g, '').trim() === '') {
    throw new FrontmatterParseError({
      code: 'EMPTY_FRONTMATTER',
      message: 'Frontmatter block is empty',
    });
  }

  // Parse the YAML
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseSimpleYaml(rawYaml);
  } catch (err) {
    if (err instanceof FrontmatterParseError) {
      throw err;
    }
    throw new FrontmatterParseError({
      code: 'MALFORMED_YAML',
      message: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Extract body: everything after closing delimiter line
  const closingLineEnd = content.indexOf('\n', closingDelimStart);
  const body =
    closingLineEnd === -1 ? '' : content.substring(closingLineEnd + 1);

  return {
    frontmatter: frontmatter as Partial<DocumentFrontmatter>,
    rawYaml,
    body,
    rawContent: content,
  };
}

/**
 * Serializes a DocumentFrontmatter object back into a YAML frontmatter
 * string suitable for prepending to a Markdown body.
 *
 * @param frontmatter The frontmatter object to serialize
 * @returns String with --- delimiters and YAML content
 */
export function serializeFrontmatter(
  frontmatter: Partial<DocumentFrontmatter>,
): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${serializeYamlValue(value)}`);
  }

  lines.push('---');
  return lines.join('\n') + '\n';
}

/**
 * Serializes a value to a YAML-compatible string representation.
 */
function serializeYamlValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => serializeYamlValue(v));
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'string') {
    // Quote strings that contain special characters
    if (
      value.includes(':') ||
      value.includes('#') ||
      value.includes('[') ||
      value.includes(']') ||
      value.includes(',') ||
      value.includes('"') ||
      value.includes("'") ||
      value === 'true' ||
      value === 'false' ||
      value === 'null' ||
      value === '~' ||
      value === '' ||
      /^-?\d+(\.\d+)?$/.test(value)
    ) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}
