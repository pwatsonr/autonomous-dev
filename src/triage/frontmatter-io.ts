/**
 * Observation frontmatter I/O helpers (SPEC-007-4-2).
 *
 * Provides read, validate, and update operations on observation Markdown
 * files with YAML frontmatter. Uses the project's lightweight YAML parser
 * conventions (flat key-value pairs).
 */

import * as fs from 'fs/promises';
import type {
  ObservationFrontmatter,
  ObservationValidationResult,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DELIMITER = '---';

// ---------------------------------------------------------------------------
// Required frontmatter fields for triage processing
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: ReadonlyArray<keyof ObservationFrontmatter> = [
  'id',
  'service',
  'triage_status',
];

// ---------------------------------------------------------------------------
// YAML parsing (lightweight, flat key-value)
// ---------------------------------------------------------------------------

/**
 * Parses a flat YAML string into a key-value record.
 * Handles: scalars, quoted strings, null, booleans, numbers, flow arrays.
 */
function parseSimpleYaml(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');

  for (const line of lines) {
    const cleaned = line.replace(/\r$/, '');
    if (cleaned.trim() === '' || cleaned.trim().startsWith('#')) continue;

    const colonIdx = cleaned.indexOf(':');
    if (colonIdx === -1) continue;

    const key = cleaned.substring(0, colonIdx).trim();
    const rawValue = cleaned.substring(colonIdx + 1).trim();

    if (key === '') continue;
    result[key] = parseYamlValue(rawValue);
  }

  return result;
}

function parseYamlValue(rawValue: string): unknown {
  if (rawValue === 'null' || rawValue === '~' || rawValue === '') return null;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;

  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    const inner = rawValue.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => parseYamlValue(item.trim()));
  }

  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1);
  }
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }

  if (/^-?\d+$/.test(rawValue)) return parseInt(rawValue, 10);
  if (/^-?\d+\.\d+$/.test(rawValue)) return parseFloat(rawValue);

  return rawValue;
}

// ---------------------------------------------------------------------------
// YAML serialization (flat key-value)
// ---------------------------------------------------------------------------

function serializeYamlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((v) => serializeYamlValue(v)).join(', ')}]`;
  }
  if (typeof value === 'string') {
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

// ---------------------------------------------------------------------------
// Read & validate
// ---------------------------------------------------------------------------

/**
 * Reads an observation Markdown file and validates its frontmatter
 * for triage processing.
 *
 * Checks:
 *   - File has YAML frontmatter delimiters (---)
 *   - Required fields are present (id, service, triage_status)
 *   - YAML is parseable
 *
 * @param filePath Absolute path to the observation .md file
 * @returns Validation result with parsed frontmatter or errors
 */
export async function validateOnRead(
  filePath: string,
): Promise<ObservationValidationResult> {
  const errors: string[] = [];

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    return {
      valid: false,
      frontmatter: null,
      body: '',
      rawContent: '',
      errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Find frontmatter delimiters
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1 || content.substring(0, firstNewline).replace(/\r$/, '') !== DELIMITER) {
    return {
      valid: false,
      frontmatter: null,
      body: content,
      rawContent: content,
      errors: ['No frontmatter found: file does not start with ---'],
    };
  }

  // Find closing delimiter
  let closingStart = -1;
  let searchPos = firstNewline + 1;
  while (searchPos < content.length) {
    const lineEnd = content.indexOf('\n', searchPos);
    const lineEndPos = lineEnd === -1 ? content.length : lineEnd;
    const line = content.substring(searchPos, lineEndPos).replace(/\r$/, '');
    if (line === DELIMITER) {
      closingStart = searchPos;
      break;
    }
    if (lineEnd === -1) break;
    searchPos = lineEnd + 1;
  }

  if (closingStart === -1) {
    return {
      valid: false,
      frontmatter: null,
      body: content,
      rawContent: content,
      errors: ['No closing frontmatter delimiter (---) found'],
    };
  }

  const rawYaml = content.substring(firstNewline + 1, closingStart);
  const closingLineEnd = content.indexOf('\n', closingStart);
  const body = closingLineEnd === -1 ? '' : content.substring(closingLineEnd + 1);

  // Parse YAML
  let parsed: Record<string, unknown>;
  try {
    parsed = parseSimpleYaml(rawYaml);
  } catch (err) {
    return {
      valid: false,
      frontmatter: null,
      body,
      rawContent: content,
      errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (parsed[field] === undefined || parsed[field] === null) {
      errors.push(`Required field '${field}' is missing`);
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      frontmatter: null,
      body,
      rawContent: content,
      errors,
    };
  }

  const frontmatter: ObservationFrontmatter = {
    id: parsed.id as string,
    service: parsed.service as string,
    fingerprint: (parsed.fingerprint as string) ?? '',
    triage_status: (parsed.triage_status as string) ?? 'pending',
    triage_decision: (parsed.triage_decision as string | null) ?? null,
    triage_by: (parsed.triage_by as string | null) ?? null,
    triage_at: (parsed.triage_at as string | null) ?? null,
    triage_reason: (parsed.triage_reason as string | null) ?? null,
    defer_until: (parsed.defer_until as string | null) ?? null,
    linked_prd: (parsed.linked_prd as string | null) ?? null,
    ...parsed,
  };

  return {
    valid: true,
    frontmatter,
    body,
    rawContent: content,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Read frontmatter (convenience)
// ---------------------------------------------------------------------------

/**
 * Reads and returns just the frontmatter of an observation file.
 * Throws if the file is invalid.
 */
export async function readFrontmatter(
  filePath: string,
): Promise<ObservationFrontmatter> {
  const result = await validateOnRead(filePath);
  if (!result.valid || !result.frontmatter) {
    throw new Error(
      `Invalid observation file ${filePath}: ${result.errors.join('; ')}`,
    );
  }
  return result.frontmatter;
}

// ---------------------------------------------------------------------------
// Update frontmatter
// ---------------------------------------------------------------------------

/**
 * Updates specific frontmatter fields in an observation Markdown file.
 *
 * Algorithm:
 *   1. Read the file
 *   2. Parse existing frontmatter
 *   3. Merge updates
 *   4. Re-serialize frontmatter
 *   5. Write back to disk
 *
 * @param filePath Absolute path to the observation .md file
 * @param updates  Key-value pairs to merge into frontmatter
 */
export async function updateFrontmatter(
  filePath: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    throw new Error(`No frontmatter found in ${filePath}`);
  }

  const frontmatter = parseSimpleYaml(fmMatch[1]);
  Object.assign(frontmatter, updates);

  const body = content.slice(fmMatch[0].length);

  // Re-serialize frontmatter
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${serializeYamlValue(value)}`);
  }
  lines.push('---');

  const newContent = lines.join('\n') + body;
  await fs.writeFile(filePath, newContent, 'utf-8');
}

// ---------------------------------------------------------------------------
// Append to body
// ---------------------------------------------------------------------------

/**
 * Appends text to the Markdown body of an observation file (after frontmatter).
 */
export async function appendToBody(
  filePath: string,
  text: string,
): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  await fs.writeFile(filePath, content + text, 'utf-8');
}

// ---------------------------------------------------------------------------
// Extract error class from observation file
// ---------------------------------------------------------------------------

/**
 * Extracts the error_class field from an observation file's frontmatter.
 * Returns 'unknown' if not found.
 */
export async function extractErrorClass(filePath: string): Promise<string> {
  const result = await validateOnRead(filePath);
  if (!result.valid || !result.frontmatter) return 'unknown';
  return (result.frontmatter['error_class'] as string) ?? 'unknown';
}
