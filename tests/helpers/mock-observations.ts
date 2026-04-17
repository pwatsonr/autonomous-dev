/**
 * Factory functions for creating test observation files (SPEC-007-5-6).
 *
 * Used across unit, integration, and E2E tests for deterministic test data.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ObservationSummary } from '../../src/governance/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Observation frontmatter fields used in mock generation.
 * Mirrors the full observation frontmatter contract.
 */
export interface ObservationFrontmatter {
  id: string;
  timestamp: string;
  service: string;
  repo: string;
  type: string;
  severity: string;
  confidence: number;
  triage_status: string;
  triage_decision: string | null;
  triage_by: string | null;
  triage_at: string | null;
  triage_reason: string | null;
  defer_until: string | null;
  cooldown_active: boolean;
  linked_prd: string | null;
  linked_deployment: string | null;
  effectiveness: string | null;
  effectiveness_detail: string | null;
  observation_run_id: string;
  tokens_consumed: number;
  fingerprint: string;
  occurrence_count: number;
  error_class?: string;
  target_metric?: string;
  metric_direction?: string;
  data_sources: {
    prometheus: string;
    grafana: string;
    opensearch: string;
    sentry: string;
  };
  related_observations: string[];
  oscillation_warning: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let mockIdCounter = 0;

export function generateMockObservationId(): string {
  mockIdCounter++;
  const pad = mockIdCounter.toString().padStart(4, '0');
  return `OBS-20260408-143000-m${pad}`;
}

export function resetMockIdCounter(): void {
  mockIdCounter = 0;
}

// ---------------------------------------------------------------------------
// File builders
// ---------------------------------------------------------------------------

/**
 * Build YAML frontmatter + Markdown body for a mock observation file.
 */
export function buildMockObservationFile(fm: ObservationFrontmatter): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(fm)) {
    if (key === 'data_sources') {
      lines.push('data_sources:');
      const ds = value as Record<string, string>;
      for (const [dsKey, dsValue] of Object.entries(ds)) {
        lines.push(`  ${dsKey}: ${dsValue}`);
      }
    } else if (key === 'related_observations') {
      const arr = value as string[];
      if (arr.length === 0) {
        lines.push('related_observations: []');
      } else {
        lines.push('related_observations:');
        for (const item of arr) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === 'string') {
      // Quote strings that contain special YAML characters
      if (value.includes(':') || value.includes('#') || value === '') {
        lines.push(`${key}: "${value}"`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`# Observation: ${fm.id}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`Mock observation for service ${fm.service}.`);
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push('Mock evidence data.');
  lines.push('');
  return lines.join('\n');
}

/**
 * Write a mock observation file to the observations directory.
 * Follows the YYYY/MM directory layout convention.
 */
export function writeToObservationDir(rootDir: string, id: string, content: string): string {
  // Extract date parts from ID: OBS-YYYYMMDD-HHMMSS-xxxx
  const match = id.match(/^OBS-(\d{4})(\d{2})(\d{2})/);
  let year = '2026';
  let month = '04';
  if (match) {
    year = match[1];
    month = match[2];
  }

  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations', year, month);
  const filePath = path.join(obsDir, `${id}.md`);

  // Synchronous for simpler test setup
  const fsSync = require('fs');
  fsSync.mkdirSync(obsDir, { recursive: true });
  fsSync.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

// ---------------------------------------------------------------------------
// Factory: single observation
// ---------------------------------------------------------------------------

/**
 * Create a mock observation file on disk with the given frontmatter overrides.
 * Returns the file path and generated ID.
 */
export async function createMockObservation(
  rootDir: string,
  overrides: Partial<ObservationFrontmatter> = {},
): Promise<{ filePath: string; id: string }> {
  const id = overrides.id ?? generateMockObservationId();
  const defaults: ObservationFrontmatter = {
    id,
    timestamp: '2026-04-08T14:30:00Z',
    service: 'api-gateway',
    repo: 'org/api-gateway',
    type: 'error',
    severity: 'P1',
    confidence: 0.87,
    triage_status: 'pending',
    triage_decision: null,
    triage_by: null,
    triage_at: null,
    triage_reason: null,
    defer_until: null,
    cooldown_active: false,
    linked_prd: null,
    linked_deployment: null,
    effectiveness: null,
    effectiveness_detail: null,
    observation_run_id: 'RUN-20260408-143000',
    tokens_consumed: 35000,
    fingerprint: 'abc123def456',
    occurrence_count: 1,
    data_sources: {
      prometheus: 'available',
      grafana: 'available',
      opensearch: 'available',
      sentry: 'not_configured',
    },
    related_observations: [],
    oscillation_warning: false,
    ...overrides,
  };

  // Ensure id is consistent
  defaults.id = id;

  const content = buildMockObservationFile(defaults);
  const filePath = writeToObservationDir(rootDir, id, content);
  return { filePath, id };
}

// ---------------------------------------------------------------------------
// Factory: observation series
// ---------------------------------------------------------------------------

/**
 * Create N mock observations for the same service+error class,
 * spread across the given number of days.
 */
export async function createObservationSeries(
  rootDir: string,
  service: string,
  errorClass: string,
  count: number,
  spreadDays: number,
  baseDate: string = '2026-04-08T14:30:00Z',
): Promise<Array<{ filePath: string; id: string }>> {
  const results: Array<{ filePath: string; id: string }> = [];
  const base = new Date(baseDate);
  const intervalMs = (spreadDays * 24 * 60 * 60 * 1000) / count;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(base.getTime() - (count - 1 - i) * intervalMs);
    // Build an id from the timestamp
    const ts = timestamp.toISOString();
    const datePart = ts.slice(0, 10).replace(/-/g, '');
    const timePart = ts.slice(11, 19).replace(/:/g, '');
    const suffix = i.toString().padStart(4, '0');
    const id = `OBS-${datePart}-${timePart}-s${suffix}`;

    const result = await createMockObservation(rootDir, {
      id,
      service,
      fingerprint: `${errorClass}-fingerprint`,
      error_class: errorClass,
      timestamp: timestamp.toISOString(),
    });
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Factory: observation summaries (for oscillation tests)
// ---------------------------------------------------------------------------

/**
 * Create an array of ObservationSummary mocks for oscillation tests.
 * The last one is marked as the current observation.
 */
export function createMockSummaries(count: number): ObservationSummary[] {
  const summaries: ObservationSummary[] = [];
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    summaries.push({
      id: `OBS-${(i + 1).toString().padStart(3, '0')}`,
      triage_status: isLast ? 'pending' : 'promoted',
      effectiveness: isLast ? null : (i % 2 === 0 ? 'degraded' : 'unchanged'),
      is_current: isLast,
    });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Update helper
// ---------------------------------------------------------------------------

/**
 * Update a mock observation file's frontmatter fields.
 * Reads the file, modifies frontmatter, and writes back.
 */
export async function updateMockObservation(
  rootDir: string,
  filePath: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const updatedLines: string[] = [];
  let inFrontmatter = false;
  let frontmatterDone = false;
  let dashCount = 0;

  for (const line of lines) {
    if (line === '---') {
      dashCount++;
      if (dashCount === 1) {
        inFrontmatter = true;
        updatedLines.push(line);
        continue;
      }
      if (dashCount === 2) {
        // Add any new keys not yet in frontmatter
        for (const [key, value] of Object.entries(updates)) {
          const exists = updatedLines.some(l => l.startsWith(`${key}:`));
          if (!exists) {
            updatedLines.push(`${key}: ${formatValue(value)}`);
          }
        }
        inFrontmatter = false;
        frontmatterDone = true;
        updatedLines.push(line);
        continue;
      }
    }

    if (inFrontmatter && !frontmatterDone) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        if (key in updates) {
          updatedLines.push(`${key}: ${formatValue(updates[key])}`);
          continue;
        }
      }
    }

    updatedLines.push(line);
  }

  await fs.writeFile(filePath, updatedLines.join('\n'), 'utf-8');
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.includes(':') || value.includes('#') || value === '') {
      return `"${value}"`;
    }
    return value;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Helpers for reading observations
// ---------------------------------------------------------------------------

/**
 * List all observation files in the rootDir and return parsed frontmatter.
 */
export async function listObservations(rootDir: string): Promise<Array<{
  id: string;
  filePath: string;
  severity: string;
  triage_status: string;
  triage_decision: string | null;
  triage_by: string | null;
  oscillation_warning: boolean;
  effectiveness: string | null;
  effectiveness_detail: Record<string, unknown> | null;
  [key: string]: unknown;
}>> {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  const results: any[] = [];

  const walkDir = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'digests') {
        await walkDir(fullPath);
      } else if (entry.name.startsWith('OBS-') && entry.name.endsWith('.md')) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const fm = parseFrontmatter(content);
        if (fm) {
          results.push({
            ...fm,
            filePath: fullPath,
          });
        }
      }
    }
  };

  await walkDir(obsDir);
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Read a single observation by ID.
 */
export async function readObservation(rootDir: string, id: string): Promise<any> {
  const observations = await listObservations(rootDir);
  return observations.find(o => o.id === id) ?? null;
}

function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const result: Record<string, any> = {};
  const lines = match[1].split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Skip indented lines (nested objects)
    if (line.startsWith('  ')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    let value: any = trimmed.substring(colonIdx + 1).trim();

    if (value === 'null' || value === '~' || value === '') value = null;
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.substring(1, value.length - 1).trim();
      value = inner ? inner.split(',').map((s: string) => s.trim()) : [];
    } else if ((value.startsWith('"') && value.endsWith('"')) ||
               (value.startsWith("'") && value.endsWith("'"))) {
      value = value.substring(1, value.length - 1);
    } else if (/^-?\d+$/.test(value)) {
      value = parseInt(value, 10);
    } else if (/^-?\d+\.\d+$/.test(value)) {
      value = parseFloat(value);
    }

    result[key] = value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

/**
 * Create a temporary test directory structure with standard subdirs.
 */
export async function setupTestDir(): Promise<string> {
  const os = require('os');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adev-test-'));
  const dirs = [
    '.autonomous-dev/observations',
    '.autonomous-dev/prd',
    '.autonomous-dev/prd/cancelled',
    '.autonomous-dev/deployments',
    '.autonomous-dev/overrides',
    '.autonomous-dev/logs/intelligence',
  ];

  for (const dir of dirs) {
    await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
  }

  return tmpDir;
}

/**
 * Check whether a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
