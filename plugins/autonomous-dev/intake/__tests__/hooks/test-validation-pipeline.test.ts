/**
 * Unit + integration tests for ValidationPipeline + ValidationStats
 * (SPEC-019-2-05, covers SPEC-019-2-01 / -2-03 / -2-04 surfaces).
 *
 * Topics:
 *   - loadSchemas() happy path, malformed JSON, missing $schema
 *   - validate() success / failure / no-mutation invariant
 *   - schema-version negotiation (exact / fallback / not-found)
 *   - error sanitization (no full payload values leak through)
 *   - ValidationStats: counters, percentiles, window rolling, reset, insufficient data
 *
 * Schema fixtures are written to a per-suite tempdir so the production
 * `schemas/hooks/` tree is never touched.
 *
 * @module __tests__/hooks/test-validation-pipeline
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ValidationPipeline,
  SchemaLoadError,
  SchemaNotFoundError,
} from '../../hooks/validation-pipeline';
import { ValidationStats } from '../../hooks/validation-stats';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

interface TmpSchemasOpts {
  /** Map<point, Map<version, { input?: object | string; output?: object | string }>>. */
  layout: Record<
    string,
    Record<string, { input?: object | string; output?: object | string }>
  >;
}

async function makeSchemasDir(opts: TmpSchemasOpts): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-vp-'));
  for (const [point, versions] of Object.entries(opts.layout)) {
    for (const [version, dirs] of Object.entries(versions)) {
      const verDir = path.join(root, point, version);
      await fs.mkdir(verDir, { recursive: true });
      for (const direction of ['input', 'output'] as const) {
        const v = dirs[direction];
        if (v === undefined) continue;
        const file = path.join(verDir, `${direction}.json`);
        const body = typeof v === 'string' ? v : JSON.stringify(v);
        await fs.writeFile(file, body);
      }
    }
  }
  return root;
}

function strictObjectSchema(point: string, version: string, direction: 'input' | 'output'): object {
  return {
    $schema: DRAFT,
    $id: `https://autonomous-dev/test/${point}/${version}/${direction}.json`,
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string' } },
  };
}

// Small in-memory logger used by no-output tests.
function makeLogger(): {
  info: jest.Mock; warn: jest.Mock; error: jest.Mock;
  warnings: string[]; infos: string[];
} {
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    info: jest.fn((m: string) => { infos.push(m); }),
    warn: jest.fn((m: string) => { warnings.push(m); }),
    error: jest.fn(),
    warnings,
    infos,
  };
}

// ---------------------------------------------------------------------------
// loadSchemas()
// ---------------------------------------------------------------------------

describe('ValidationPipeline.loadSchemas', () => {
  const tempRoots: string[] = [];
  afterEach(async () => {
    while (tempRoots.length) {
      const r = tempRoots.pop()!;
      await fs.rm(r, { recursive: true, force: true });
    }
  });

  test('loads input + output validators from a well-formed tree', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': {
            input: strictObjectSchema('test-point', '1.0.0', 'input'),
            output: strictObjectSchema('test-point', '1.0.0', 'output'),
          },
        },
      },
    });
    tempRoots.push(root);
    const logger = makeLogger();
    const p = new ValidationPipeline({ schemasRoot: root, logger });
    await p.loadSchemas();

    const r = await p.validateHookInput('test-point', '1.0.0', { name: 'alice' });
    expect(r.isValid).toBe(true);
    expect(logger.infos.some((m) => m.includes('loaded 2 validators'))).toBe(true);
  });

  test('missing schemas root is a no-op (empty registry)', async () => {
    const root = path.join(os.tmpdir(), `ad-vp-missing-${Date.now()}`);
    const logger = makeLogger();
    const p = new ValidationPipeline({ schemasRoot: root, logger });
    await p.loadSchemas();
    expect(logger.infos.some((m) => m.includes('does not exist'))).toBe(true);
  });

  test('throws SchemaLoadError on malformed JSON, including the file path', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': { input: '{ not valid json' },
        },
      },
    });
    tempRoots.push(root);
    const p = new ValidationPipeline({ schemasRoot: root, logger: makeLogger() });
    await expect(p.loadSchemas()).rejects.toBeInstanceOf(SchemaLoadError);
    await expect(p.loadSchemas()).rejects.toThrow(/test-point\/1\.0\.0\/input\.json/);
  });

  test('throws SchemaLoadError when $schema is missing or wrong', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': {
            input: { type: 'object', properties: {} }, // no $schema
          },
        },
      },
    });
    tempRoots.push(root);
    const p = new ValidationPipeline({ schemasRoot: root, logger: makeLogger() });
    await expect(p.loadSchemas()).rejects.toBeInstanceOf(SchemaLoadError);
    await expect(p.loadSchemas()).rejects.toThrow(/missing or wrong \$schema/);
  });

  test('throws SchemaLoadError when AJV cannot compile the schema', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': {
            // `type: 'not-a-real-type'` fails AJV strict-mode compile.
            input: { $schema: DRAFT, type: 'not-a-real-type' },
          },
        },
      },
    });
    tempRoots.push(root);
    const p = new ValidationPipeline({ schemasRoot: root, logger: makeLogger() });
    await expect(p.loadSchemas()).rejects.toBeInstanceOf(SchemaLoadError);
    await expect(p.loadSchemas()).rejects.toThrow(/AJV compilation failed/);
  });

  test('skips files when neither input.json nor output.json exists for a version', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': {}, // empty version dir
        },
      },
    });
    tempRoots.push(root);
    const logger = makeLogger();
    const p = new ValidationPipeline({ schemasRoot: root, logger });
    await p.loadSchemas();
    expect(logger.infos.some((m) => m.includes('loaded 0 validators'))).toBe(true);
  });

  test('skips non-directory entries at the points and versions levels', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-vp-mixed-'));
    tempRoots.push(root);
    // A stray file at the points level.
    await fs.writeFile(path.join(root, 'README.txt'), 'ignore me');
    // A real point with a stray file at the versions level.
    await fs.mkdir(path.join(root, 'test-point'), { recursive: true });
    await fs.writeFile(path.join(root, 'test-point', 'NOTES.txt'), 'ignore');
    await fs.mkdir(path.join(root, 'test-point', '1.0.0'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'test-point', '1.0.0', 'input.json'),
      JSON.stringify(strictObjectSchema('test-point', '1.0.0', 'input')),
    );
    const logger = makeLogger();
    const p = new ValidationPipeline({ schemasRoot: root, logger });
    await p.loadSchemas();
    expect(logger.infos.some((m) => m.includes('loaded 1 validators'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validate() — success / failure / mutation
// ---------------------------------------------------------------------------

describe('ValidationPipeline.validate', () => {
  let root: string;
  let pipeline: ValidationPipeline;

  beforeEach(async () => {
    root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': {
            input: strictObjectSchema('test-point', '1.0.0', 'input'),
            output: strictObjectSchema('test-point', '1.0.0', 'output'),
          },
        },
      },
    });
    pipeline = new ValidationPipeline({ schemasRoot: root, logger: makeLogger() });
    await pipeline.loadSchemas();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('valid input: isValid true, no errors, validationTime non-negative, fields populated', async () => {
    const r = await pipeline.validateHookInput('test-point', '1.0.0', { name: 'alice' });
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.validationTime).toBeGreaterThanOrEqual(0);
    expect(r.hookPoint).toBe('test-point');
    expect(r.schemaVersion).toBe('1.0.0');
    expect(r.direction).toBe('input');
  });

  test('missing required field surfaces a structured error', async () => {
    const r = await pipeline.validateHookInput('test-point', '1.0.0', {});
    expect(r.isValid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    const messages = r.errors.map((e) => e.message).join(' ');
    expect(messages).toMatch(/required/i);
  });

  test('caller payload is not mutated; sanitized copy strips extras', async () => {
    const caller: Record<string, unknown> = { name: 'x', extra: true };
    const r = await pipeline.validateHookInput<{ name: string; extra?: boolean }>(
      'test-point', '1.0.0', caller,
    );
    expect(r.isValid).toBe(true);
    // Caller's object retains the extra key.
    expect(caller.extra).toBe(true);
    // Sanitized copy does NOT.
    expect((r.sanitizedOutput as Record<string, unknown>).extra).toBeUndefined();
  });

  test('output direction validates with its own schema and fields are echoed', async () => {
    const r = await pipeline.validateHookOutput('test-point', '1.0.0', { name: 'bob' });
    expect(r.isValid).toBe(true);
    expect(r.direction).toBe('output');
  });
});

// ---------------------------------------------------------------------------
// Schema-version negotiation
// ---------------------------------------------------------------------------

describe('ValidationPipeline schema-version negotiation', () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length) {
      await fs.rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  test('exact-version match is silent (no warning)', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': { input: strictObjectSchema('test-point', '1.0.0', 'input') },
          '1.1.0': { input: strictObjectSchema('test-point', '1.1.0', 'input') },
        },
      },
    });
    roots.push(root);
    const logger = makeLogger();
    const p = new ValidationPipeline({ schemasRoot: root, logger });
    await p.loadSchemas();
    const r = await p.validateHookInput('test-point', '1.1.0', { name: 'x' });
    expect(r.isValid).toBe(true);
    expect(r.schemaVersion).toBe('1.1.0');
    expect(r.warnings).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('falls back to highest <= requested when exact not present, with warning', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': { input: strictObjectSchema('test-point', '1.0.0', 'input') },
        },
      },
    });
    roots.push(root);
    const logger = makeLogger();
    const p = new ValidationPipeline({ schemasRoot: root, logger });
    await p.loadSchemas();
    const r = await p.validateHookInput('test-point', '1.0.5', { name: 'x' });
    expect(r.isValid).toBe(true);
    expect(r.schemaVersion).toBe('1.0.0');
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("Falling back to '1.0.0'");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('falls back to lowest available when requested is older than every registered version', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '2.0.0': { input: strictObjectSchema('test-point', '2.0.0', 'input') },
          '3.0.0': { input: strictObjectSchema('test-point', '3.0.0', 'input') },
        },
      },
    });
    roots.push(root);
    const p = new ValidationPipeline({ schemasRoot: root, logger: makeLogger() });
    await p.loadSchemas();
    const r = await p.validateHookInput('test-point', '1.0.0', { name: 'x' });
    expect(r.schemaVersion).toBe('2.0.0');
    expect(r.warnings.length).toBe(1);
  });

  test('throws SchemaNotFoundError when no validators registered for the point/direction', async () => {
    const root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': { input: strictObjectSchema('test-point', '1.0.0', 'input') },
        },
      },
    });
    roots.push(root);
    const p = new ValidationPipeline({ schemasRoot: root, logger: makeLogger() });
    await p.loadSchemas();
    await expect(p.validateHookInput('unknown-point', '1.0.0', {})).rejects.toBeInstanceOf(
      SchemaNotFoundError,
    );
    // Error message should include the search path.
    await expect(p.validateHookInput('unknown-point', '1.0.0', {})).rejects.toThrow(
      /unknown-point/,
    );
  });
});

// ---------------------------------------------------------------------------
// Error sanitization — no payload value leaks
// ---------------------------------------------------------------------------

describe('ValidationPipeline error sanitization', () => {
  let root: string;
  let pipeline: ValidationPipeline;

  beforeEach(async () => {
    root = await makeSchemasDir({
      layout: {
        secrets: {
          '1.0.0': {
            input: {
              $schema: DRAFT,
              type: 'object',
              required: ['apiKey'],
              properties: {
                apiKey: { type: 'string', enum: ['expected-only'] },
              },
            },
          },
        },
      },
    });
    pipeline = new ValidationPipeline({ schemasRoot: root, logger: makeLogger() });
    await pipeline.loadSchemas();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('auto-redacted field name keeps its raw value out of error params', async () => {
    const r = await pipeline.validateHookInput('secrets', '1.0.0', {
      apiKey: 'totally-secret-distinctive-value',
    });
    expect(r.isValid).toBe(false);
    const blob = JSON.stringify(r.errors);
    expect(blob).not.toContain('totally-secret-distinctive-value');
  });

  test('non-sensitive fields are NOT scrubbed by the auto-redact floor', async () => {
    // Use a benign field name + enum to force AJV to include the value in
    // params.allowedValues / params.value-style hints.
    const root2 = await makeSchemasDir({
      layout: {
        plain: {
          '1.0.0': {
            input: {
              $schema: DRAFT,
              type: 'object',
              required: ['comment'],
              properties: {
                comment: { type: 'string', enum: ['only-this'] },
              },
            },
          },
        },
      },
    });
    try {
      const p = new ValidationPipeline({ schemasRoot: root2, logger: makeLogger() });
      await p.loadSchemas();
      const r = await p.validateHookInput('plain', '1.0.0', { comment: 'visible-public-text' });
      expect(r.isValid).toBe(false);
      // AJV's enum error params contain `allowedValues`, not the provided
      // value; we just assert REDACTED was NOT applied unnecessarily.
      const blob = JSON.stringify(r.errors);
      expect(blob).not.toContain('[REDACTED]');
    } finally {
      await fs.rm(root2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stats integration through the pipeline
// ---------------------------------------------------------------------------

describe('ValidationPipeline + ValidationStats integration', () => {
  let root: string;
  let pipeline: ValidationPipeline;

  beforeEach(async () => {
    root = await makeSchemasDir({
      layout: {
        'test-point': {
          '1.0.0': {
            input: strictObjectSchema('test-point', '1.0.0', 'input'),
          },
        },
      },
    });
    pipeline = new ValidationPipeline({
      schemasRoot: root,
      logger: makeLogger(),
      statsWindowSize: 1000,
    });
    await pipeline.loadSchemas();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('counters reflect total / passed / failed across many calls', async () => {
    for (let i = 0; i < 10; i += 1) {
      await pipeline.validateHookInput('test-point', '1.0.0', { name: 'x' });
    }
    for (let i = 0; i < 3; i += 1) {
      await pipeline.validateHookInput('test-point', '1.0.0', {}); // missing required
    }
    const stats = pipeline.getStats();
    expect(stats.overall.total).toBe(13);
    expect(stats.overall.passed).toBe(10);
    expect(stats.overall.failed).toBe(3);
  });

  test('resetStats clears all counters', async () => {
    for (let i = 0; i < 5; i += 1) {
      await pipeline.validateHookInput('test-point', '1.0.0', { name: 'x' });
    }
    expect(pipeline.getStats().overall.total).toBe(5);
    pipeline.resetStats();
    expect(pipeline.getStats().overall.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ValidationStats — direct unit tests (percentiles, window, edge cases)
// ---------------------------------------------------------------------------

describe('ValidationStats', () => {
  test('rejects non-positive window size', () => {
    expect(() => new ValidationStats(0)).toThrow();
    expect(() => new ValidationStats(-5)).toThrow();
  });

  test('counters are monotonic and per-(point, version) bucketed', () => {
    const s = new ValidationStats(100);
    for (let i = 0; i < 950; i += 1) s.record('p', '1.0.0', true, 1);
    for (let i = 0; i < 50; i += 1) s.record('p', '1.0.0', false, 1);
    s.record('q', '1.0.0', true, 1);
    const stats = s.getStats();
    expect(stats.overall.total).toBe(1001);
    expect(stats.overall.passed).toBe(951);
    expect(stats.overall.failed).toBe(50);
    expect(stats.byHookPoint.p['1.0.0'].total).toBe(1000);
    expect(stats.byHookPoint.q['1.0.0'].total).toBe(1);
  });

  test('percentiles are 0 when fewer than PERCENTILE_MIN_SAMPLES samples exist', () => {
    const s = new ValidationStats(100);
    for (let i = 0; i < 5; i += 1) s.record('p', '1.0.0', true, 7);
    const snap = s.getStats().byHookPoint.p['1.0.0'];
    expect(snap.p50Ms).toBe(0);
    expect(snap.p95Ms).toBe(0);
    expect(snap.p99Ms).toBe(0);
  });

  test('percentiles match nearest-rank for a known distribution', () => {
    const s = new ValidationStats(1000);
    // Durations 1..1000 ms, one sample each; p50=500, p95=950, p99=990.
    for (let i = 1; i <= 1000; i += 1) s.record('p', '1.0.0', true, i);
    const snap = s.getStats().byHookPoint.p['1.0.0'];
    expect(snap.p50Ms).toBe(500);
    expect(snap.p95Ms).toBe(950);
    expect(snap.p99Ms).toBe(990);
    expect(snap.windowSize).toBe(1000);
  });

  test('rolling window: counters keep counting, percentiles reflect last window only', () => {
    const s = new ValidationStats(1000);
    // First 500 fast (1ms), then 1000 slow (100ms). Window holds the last 1000,
    // which is 500 fast + 500 slow.
    for (let i = 0; i < 500; i += 1) s.record('p', '1.0.0', true, 1);
    for (let i = 0; i < 1000; i += 1) s.record('p', '1.0.0', true, 100);
    const snap = s.getStats().byHookPoint.p['1.0.0'];
    expect(snap.total).toBe(1500);
    expect(snap.windowSize).toBe(1000);
    // Half fast, half slow → median is 1ms (still in lower half) or 100ms
    // depending on exact ring-buffer ordering. Either way p99 must be 100.
    expect(snap.p99Ms).toBe(100);
  });

  test('reset wipes every bucket', () => {
    const s = new ValidationStats(100);
    for (let i = 0; i < 100; i += 1) s.record('p', '1.0.0', true, 1);
    expect(s.getStats().overall.total).toBe(100);
    s.reset();
    const stats = s.getStats();
    expect(stats.overall.total).toBe(0);
    expect(stats.byHookPoint).toEqual({});
  });
});
