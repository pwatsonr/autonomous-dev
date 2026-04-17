/**
 * Unit tests for the effectiveness writeback (SPEC-007-5-2, Task 4).
 *
 * Covers test cases TC-5-2-13 through TC-5-2-17.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  writeEffectivenessResult,
  splitFrontmatterAndBody,
  findPendingEffectivenessObservations,
} from '../../src/governance/effectiveness-writeback';
import type { EffectivenessResult } from '../../src/governance/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eff-writeback-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeObservationFile(
  overrides: Record<string, string | null> = {},
  body: string = '# Observation\n\nSome detailed body content.\n\n## Evidence\n\nLog data here.\n',
): string {
  const defaults: Record<string, string | null> = {
    id: 'OBS-20260301-120000-abc1',
    service: 'api-gateway',
    fingerprint: 'fp-abc123',
    triage_status: 'promoted',
    triage_decision: 'promote',
    linked_deployment: 'deploy-001',
    effectiveness: null,
    effectiveness_detail: null,
    target_metric: 'rate(http_errors_total[5m])',
    metric_direction: 'decrease',
  };
  const merged = { ...defaults, ...overrides };
  const lines = ['---'];
  for (const [key, value] of Object.entries(merged)) {
    lines.push(`${key}: ${value === null ? 'null' : value}`);
  }
  lines.push('---');
  lines.push(body);
  return lines.join('\n');
}

function makeImprovedResult(): EffectivenessResult {
  return {
    status: 'improved',
    detail: {
      pre_fix_avg: 12.3,
      post_fix_avg: 0.6,
      improvement_pct: 95.1,
      measured_window: '2026-03-08 to 2026-03-15',
    },
  };
}

function makePendingResult(): EffectivenessResult {
  return {
    status: 'pending',
    reason: 'Post-fix window not elapsed',
  };
}

function makeDegradedResult(): EffectivenessResult {
  return {
    status: 'degraded',
    detail: {
      pre_fix_avg: 0.5,
      post_fix_avg: 3.0,
      improvement_pct: -500.0,
      measured_window: '2026-03-08 to 2026-03-15',
    },
  };
}

// ---------------------------------------------------------------------------
// splitFrontmatterAndBody
// ---------------------------------------------------------------------------

describe('splitFrontmatterAndBody', () => {
  it('parses valid frontmatter and body', () => {
    const content = '---\nid: OBS-001\nservice: api\n---\n# Body\n';
    const { frontmatter, body } = splitFrontmatterAndBody(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.id).toBe('OBS-001');
    expect(frontmatter!.service).toBe('api');
    expect(body).toBe('# Body\n');
  });

  it('returns null frontmatter for content without delimiters', () => {
    const content = 'Just regular markdown without frontmatter.';
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter).toBeNull();
  });

  it('handles null values', () => {
    const content = '---\nid: OBS-001\neffectiveness: null\n---\n';
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.effectiveness).toBeNull();
  });

  it('handles numeric values', () => {
    const content = '---\npre_fix_avg: 12.3\ncount: 5\n---\n';
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.pre_fix_avg).toBe(12.3);
    expect(frontmatter!.count).toBe(5);
  });

  it('handles nested objects (effectiveness_detail)', () => {
    const content = [
      '---',
      'id: OBS-001',
      'effectiveness_detail:',
      '  pre_fix_avg: 12.3',
      '  post_fix_avg: 0.6',
      '  improvement_pct: 95.1',
      '  measured_window: "2026-03-08 to 2026-03-15"',
      '---',
      '# Body',
    ].join('\n');
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.effectiveness_detail).toEqual({
      pre_fix_avg: 12.3,
      post_fix_avg: 0.6,
      improvement_pct: 95.1,
      measured_window: '2026-03-08 to 2026-03-15',
    });
  });
});

// ---------------------------------------------------------------------------
// writeEffectivenessResult
// ---------------------------------------------------------------------------

describe('writeEffectivenessResult', () => {
  // TC-5-2-13: Writeback updates frontmatter
  it('TC-5-2-13: updates frontmatter with effectiveness and detail', async () => {
    const filePath = path.join(tmpDir, 'OBS-001.md');
    await fs.writeFile(filePath, makeObservationFile(), 'utf-8');

    const result = await writeEffectivenessResult(filePath, makeImprovedResult());
    expect(result.updated).toBe(true);

    const content = await fs.readFile(filePath, 'utf-8');
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.effectiveness).toBe('improved');
    expect(frontmatter!.effectiveness_detail).toBeDefined();
    expect(frontmatter!.effectiveness_detail.pre_fix_avg).toBe(12.3);
    expect(frontmatter!.effectiveness_detail.post_fix_avg).toBe(0.6);
    expect(frontmatter!.effectiveness_detail.improvement_pct).toBe(95.1);
    expect(frontmatter!.effectiveness_detail.measured_window).toBe('2026-03-08 to 2026-03-15');
  });

  // TC-5-2-14: Writeback preserves Markdown body
  it('TC-5-2-14: preserves Markdown body content exactly after writeback', async () => {
    // Create a substantial body (200 lines)
    const bodyLines: string[] = ['# Observation Report\n'];
    for (let i = 1; i <= 200; i++) {
      bodyLines.push(`Line ${i}: This is detailed observation content with special chars: <>&"'\n`);
    }
    const body = bodyLines.join('');

    const filePath = path.join(tmpDir, 'OBS-002.md');
    await fs.writeFile(filePath, makeObservationFile({}, body), 'utf-8');

    await writeEffectivenessResult(filePath, makeImprovedResult());

    const content = await fs.readFile(filePath, 'utf-8');
    const { body: resultBody } = splitFrontmatterAndBody(content);
    expect(resultBody).toBe(body);
  });

  // TC-5-2-15: Writeback idempotency
  it('TC-5-2-15: skips writeback when effectiveness is already terminal (improved)', async () => {
    const filePath = path.join(tmpDir, 'OBS-003.md');
    await fs.writeFile(
      filePath,
      makeObservationFile({ effectiveness: 'improved' }),
      'utf-8',
    );

    const result = await writeEffectivenessResult(filePath, makeImprovedResult());
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('Already evaluated: improved');
  });

  it('skips writeback when effectiveness is degraded', async () => {
    const filePath = path.join(tmpDir, 'OBS-004.md');
    await fs.writeFile(
      filePath,
      makeObservationFile({ effectiveness: 'degraded' }),
      'utf-8',
    );

    const result = await writeEffectivenessResult(filePath, makeImprovedResult());
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('Already evaluated: degraded');
  });

  it('skips writeback when effectiveness is unchanged', async () => {
    const filePath = path.join(tmpDir, 'OBS-005.md');
    await fs.writeFile(
      filePath,
      makeObservationFile({ effectiveness: 'unchanged' }),
      'utf-8',
    );

    const result = await writeEffectivenessResult(filePath, makeImprovedResult());
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('Already evaluated: unchanged');
  });

  // TC-5-2-16: Writeback handles pending->improved
  it('TC-5-2-16: updates from pending to improved', async () => {
    const filePath = path.join(tmpDir, 'OBS-006.md');
    await fs.writeFile(
      filePath,
      makeObservationFile({ effectiveness: 'pending' }),
      'utf-8',
    );

    const result = await writeEffectivenessResult(filePath, makeImprovedResult());
    expect(result.updated).toBe(true);

    const content = await fs.readFile(filePath, 'utf-8');
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.effectiveness).toBe('improved');
  });

  it('updates from null to degraded', async () => {
    const filePath = path.join(tmpDir, 'OBS-007.md');
    await fs.writeFile(filePath, makeObservationFile(), 'utf-8');

    const result = await writeEffectivenessResult(filePath, makeDegradedResult());
    expect(result.updated).toBe(true);

    const content = await fs.readFile(filePath, 'utf-8');
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.effectiveness).toBe('degraded');
    expect(frontmatter!.effectiveness_detail.improvement_pct).toBe(-500);
  });

  it('sets effectiveness_detail to null when result has no detail', async () => {
    const filePath = path.join(tmpDir, 'OBS-008.md');
    await fs.writeFile(filePath, makeObservationFile(), 'utf-8');

    const result = await writeEffectivenessResult(filePath, makePendingResult());
    expect(result.updated).toBe(true);

    const content = await fs.readFile(filePath, 'utf-8');
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.effectiveness).toBe('pending');
    expect(frontmatter!.effectiveness_detail).toBeNull();
  });

  it('returns error when file has no frontmatter', async () => {
    const filePath = path.join(tmpDir, 'OBS-bad.md');
    await fs.writeFile(filePath, '# Just a markdown file\n', 'utf-8');

    const result = await writeEffectivenessResult(filePath, makeImprovedResult());
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('Failed to parse YAML frontmatter');
  });

  it('preserves other frontmatter fields', async () => {
    const filePath = path.join(tmpDir, 'OBS-009.md');
    await fs.writeFile(filePath, makeObservationFile(), 'utf-8');

    await writeEffectivenessResult(filePath, makeImprovedResult());

    const content = await fs.readFile(filePath, 'utf-8');
    const { frontmatter } = splitFrontmatterAndBody(content);
    expect(frontmatter!.id).toBe('OBS-20260301-120000-abc1');
    expect(frontmatter!.service).toBe('api-gateway');
    expect(frontmatter!.triage_decision).toBe('promote');
    expect(frontmatter!.linked_deployment).toBe('deploy-001');
  });
});

// ---------------------------------------------------------------------------
// findPendingEffectivenessObservations
// ---------------------------------------------------------------------------

describe('findPendingEffectivenessObservations', () => {
  // TC-5-2-17: Find pending observations
  it('TC-5-2-17: returns only eligible pending file paths', async () => {
    const obsDir = path.join(tmpDir, '.autonomous-dev', 'observations', '2026', '03');
    await fs.mkdir(obsDir, { recursive: true });

    // 1. Promoted + deployed + pending (effectiveness: null) -- ELIGIBLE
    await fs.writeFile(
      path.join(obsDir, 'OBS-20260301-001.md'),
      makeObservationFile({ effectiveness: null }),
      'utf-8',
    );

    // 2. Promoted + deployed + pending (effectiveness: pending) -- ELIGIBLE
    await fs.writeFile(
      path.join(obsDir, 'OBS-20260301-002.md'),
      makeObservationFile({ effectiveness: 'pending' }),
      'utf-8',
    );

    // 3. Promoted + no deployment -- NOT ELIGIBLE
    await fs.writeFile(
      path.join(obsDir, 'OBS-20260301-003.md'),
      makeObservationFile({ linked_deployment: null }),
      'utf-8',
    );

    // 4. Dismissed -- NOT ELIGIBLE
    await fs.writeFile(
      path.join(obsDir, 'OBS-20260301-004.md'),
      makeObservationFile({ triage_decision: 'dismiss' }),
      'utf-8',
    );

    // 5. Promoted + deployed + already improved -- NOT ELIGIBLE
    await fs.writeFile(
      path.join(obsDir, 'OBS-20260301-005.md'),
      makeObservationFile({ effectiveness: 'improved' }),
      'utf-8',
    );

    const results = await findPendingEffectivenessObservations(tmpDir);

    expect(results).toHaveLength(2);
    expect(results.some((r) => r.includes('OBS-20260301-001.md'))).toBe(true);
    expect(results.some((r) => r.includes('OBS-20260301-002.md'))).toBe(true);
    expect(results.some((r) => r.includes('OBS-20260301-003.md'))).toBe(false);
    expect(results.some((r) => r.includes('OBS-20260301-004.md'))).toBe(false);
    expect(results.some((r) => r.includes('OBS-20260301-005.md'))).toBe(false);
  });

  it('returns empty array when observations directory does not exist', async () => {
    const results = await findPendingEffectivenessObservations('/nonexistent/path');
    expect(results).toEqual([]);
  });

  it('skips non-OBS files', async () => {
    const obsDir = path.join(tmpDir, '.autonomous-dev', 'observations', '2026', '03');
    await fs.mkdir(obsDir, { recursive: true });

    // Non-OBS file
    await fs.writeFile(
      path.join(obsDir, 'README.md'),
      makeObservationFile(),
      'utf-8',
    );

    // Valid OBS file
    await fs.writeFile(
      path.join(obsDir, 'OBS-20260301-001.md'),
      makeObservationFile(),
      'utf-8',
    );

    const results = await findPendingEffectivenessObservations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('OBS-20260301-001.md');
  });

  it('skips non-year and non-month directories', async () => {
    const obsRoot = path.join(tmpDir, '.autonomous-dev', 'observations');
    await fs.mkdir(path.join(obsRoot, '2026', '03'), { recursive: true });
    await fs.mkdir(path.join(obsRoot, 'invalid-dir', '03'), { recursive: true });
    await fs.mkdir(path.join(obsRoot, '2026', 'xx'), { recursive: true });

    await fs.writeFile(
      path.join(obsRoot, '2026', '03', 'OBS-valid.md'),
      makeObservationFile(),
      'utf-8',
    );
    await fs.writeFile(
      path.join(obsRoot, 'invalid-dir', '03', 'OBS-skip.md'),
      makeObservationFile(),
      'utf-8',
    );
    await fs.writeFile(
      path.join(obsRoot, '2026', 'xx', 'OBS-skip.md'),
      makeObservationFile(),
      'utf-8',
    );

    const results = await findPendingEffectivenessObservations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('OBS-valid.md');
  });

  it('handles multiple year/month directories', async () => {
    const obsRoot = path.join(tmpDir, '.autonomous-dev', 'observations');
    await fs.mkdir(path.join(obsRoot, '2025', '12'), { recursive: true });
    await fs.mkdir(path.join(obsRoot, '2026', '01'), { recursive: true });

    await fs.writeFile(
      path.join(obsRoot, '2025', '12', 'OBS-202512-001.md'),
      makeObservationFile(),
      'utf-8',
    );
    await fs.writeFile(
      path.join(obsRoot, '2026', '01', 'OBS-202601-001.md'),
      makeObservationFile(),
      'utf-8',
    );

    const results = await findPendingEffectivenessObservations(tmpDir);
    expect(results).toHaveLength(2);
  });
});
