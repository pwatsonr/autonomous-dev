/**
 * Effectiveness writeback (SPEC-007-5-2, Task 4).
 *
 * Persists effectiveness evaluation results back into the observation report's
 * YAML frontmatter. This closes the feedback loop: the system not only detects
 * problems and generates fix PRDs, but also verifies whether the fix was
 * successful.
 *
 * The writeback updates the observation file in-place, adding the
 * `effectiveness` and `effectiveness_detail` fields to the YAML frontmatter
 * without disturbing the Markdown body or other frontmatter fields.
 */

import * as fs from 'fs/promises';
import type { EffectivenessResult } from './types';

// ---------------------------------------------------------------------------
// Writeback
// ---------------------------------------------------------------------------

/**
 * Write the effectiveness result back into the observation report's
 * YAML frontmatter without modifying the Markdown body.
 *
 * Strategy:
 * 1. Read the entire file
 * 2. Split into frontmatter (between --- delimiters) and body
 * 3. Parse frontmatter as flat YAML key-value pairs
 * 4. Update effectiveness and effectiveness_detail fields
 * 5. Re-serialize frontmatter
 * 6. Reassemble and write back
 *
 * Idempotency: If effectiveness is already set to a terminal value
 * (improved, degraded, unchanged), the writeback is skipped.
 */
export async function writeEffectivenessResult(
  filePath: string,
  result: EffectivenessResult,
): Promise<{ updated: boolean; reason?: string }> {
  const content = await fs.readFile(filePath, 'utf-8');

  const { frontmatter, body } = splitFrontmatterAndBody(content);
  if (!frontmatter) {
    return { updated: false, reason: 'Failed to parse YAML frontmatter' };
  }

  // Idempotency guard: skip if already evaluated with a terminal status
  const current = frontmatter.effectiveness;
  if (current === 'improved' || current === 'degraded' || current === 'unchanged') {
    return { updated: false, reason: `Already evaluated: ${current}` };
  }

  // Update fields
  frontmatter.effectiveness = result.status;

  if (result.detail) {
    frontmatter.effectiveness_detail = {
      pre_fix_avg: result.detail.pre_fix_avg,
      post_fix_avg: result.detail.post_fix_avg,
      improvement_pct: result.detail.improvement_pct,
      measured_window: result.detail.measured_window,
    };
  } else {
    frontmatter.effectiveness_detail = null;
  }

  // Re-serialize frontmatter
  const newFrontmatter = serializeFrontmatter(frontmatter);

  const newContent = `---\n${newFrontmatter}---\n${body}`;

  await fs.writeFile(filePath, newContent, 'utf-8');
  return { updated: true };
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Split a YAML-frontmatter Markdown file into its components.
 * Preserves the exact body content (everything after the closing ---).
 */
export function splitFrontmatterAndBody(content: string): {
  frontmatter: Record<string, any> | null;
  body: string;
  rawPrefix: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content, rawPrefix: '' };
  }

  try {
    const frontmatter = parseSimpleYaml(match[1]);
    return {
      frontmatter,
      body: match[2],
      rawPrefix: match[1],
    };
  } catch {
    return { frontmatter: null, body: content, rawPrefix: '' };
  }
}

// ---------------------------------------------------------------------------
// Lightweight YAML parser (flat key-value + one level nesting)
// ---------------------------------------------------------------------------

/**
 * Parse flat YAML key-value pairs. Handles scalars, quoted strings, null,
 * booleans, numbers, and nested object blocks (for effectiveness_detail).
 */
function parseSimpleYaml(yamlStr: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = yamlStr.split('\n');
  let currentObject: Record<string, any> | null = null;
  let currentObjectKey: string | null = null;

  for (const line of lines) {
    const cleaned = line.replace(/\r$/, '');
    if (cleaned.trim() === '' || cleaned.trim().startsWith('#')) continue;

    // Detect indented lines (part of a nested object)
    if (/^  \S/.test(cleaned) && currentObjectKey !== null) {
      const colonIdx = cleaned.indexOf(':');
      if (colonIdx !== -1) {
        const key = cleaned.substring(0, colonIdx).trim();
        const rawValue = cleaned.substring(colonIdx + 1).trim();
        if (currentObject) {
          currentObject[key] = parseYamlValue(rawValue);
        }
        continue;
      }
    }

    // Top-level key: flush any pending nested object
    if (currentObjectKey !== null && currentObject !== null) {
      result[currentObjectKey] = currentObject;
      currentObject = null;
      currentObjectKey = null;
    }

    const colonIdx = cleaned.indexOf(':');
    if (colonIdx === -1) continue;

    const key = cleaned.substring(0, colonIdx).trim();
    const rawValue = cleaned.substring(colonIdx + 1).trim();

    if (key === '') continue;

    // Check if this starts a nested object (value is empty, next lines are indented)
    if (rawValue === '') {
      currentObjectKey = key;
      currentObject = {};
      continue;
    }

    result[key] = parseYamlValue(rawValue);
  }

  // Flush any remaining nested object
  if (currentObjectKey !== null && currentObject !== null) {
    result[currentObjectKey] = currentObject;
  }

  return result;
}

function parseYamlValue(rawValue: string): any {
  if (rawValue === 'null' || rawValue === '~' || rawValue === '') return null;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;

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
// Lightweight YAML serializer (flat key-value + one level nesting)
// ---------------------------------------------------------------------------

function serializeFrontmatter(fm: Record<string, any>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Nested object (one level deep)
      lines.push(`${key}:`);
      for (const [subKey, subValue] of Object.entries(value)) {
        lines.push(`  ${subKey}: ${serializeYamlValue(subValue)}`);
      }
    } else {
      lines.push(`${key}: ${serializeYamlValue(value)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function serializeYamlValue(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // Quote strings that contain special characters or look like other types
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
// Pending observation finder
// ---------------------------------------------------------------------------

/**
 * Find all observations eligible for effectiveness evaluation:
 * - triage_decision is 'promote'
 * - linked_deployment is set
 * - effectiveness is null or 'pending'
 *
 * Returns file paths for the runner to process.
 */
export async function findPendingEffectivenessObservations(
  rootDir: string,
): Promise<string[]> {
  const obsDir = `${rootDir}/.autonomous-dev/observations`;
  const results: string[] = [];

  // Walk all year/month directories
  const years = await safeReadDir(obsDir);
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const months = await safeReadDir(`${obsDir}/${year}`);
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue;
      const files = await safeReadDir(`${obsDir}/${year}/${month}`);
      for (const file of files) {
        if (!file.endsWith('.md') || !file.startsWith('OBS-')) continue;
        const filePath = `${obsDir}/${year}/${month}/${file}`;
        const content = await fs.readFile(filePath, 'utf-8');
        const { frontmatter } = splitFrontmatterAndBody(content);
        if (!frontmatter) continue;

        if (
          frontmatter.triage_decision === 'promote' &&
          frontmatter.linked_deployment &&
          (frontmatter.effectiveness === null ||
            frontmatter.effectiveness === undefined ||
            frontmatter.effectiveness === 'pending')
        ) {
          results.push(filePath);
        }
      }
    }
  }

  return results;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
