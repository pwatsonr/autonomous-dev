/**
 * SPEC-022-3-01 unit tests — strict-schema consumer boundary.
 *
 * Covers:
 *   - Extra-field stripping (`removeAdditional: 'all'`).
 *   - Version narrowing (consumer at 1.0 sees no 1.1 fields).
 *   - SchemaValidationError on payload violation.
 *   - SchemaNotFoundError on unknown (type, version).
 *   - Schema-cache memoization (compile exactly once for repeat reads).
 *   - On-disk artifact is untouched even when validation strips fields.
 *
 * @module tests/chains/test-strict-schema
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import {
  SchemaNotFoundError,
  SchemaValidationError,
  type ConsumerPluginRef,
} from '../../intake/chains/types';
import {
  clearSchemaCache,
  getCompileCount,
} from '../../intake/chains/schema-cache';
import { createTempRequestDir, cleanupTempDir } from '../helpers/chain-fixtures';

const FIXTURE_SCHEMA_ROOT = path.resolve(
  __dirname,
  'fixtures',
  'schemas',
);

describe('ArtifactRegistry.read — strict-schema (SPEC-022-3-01)', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;

  beforeEach(async () => {
    clearSchemaCache();
    tempRoot = await createTempRequestDir();
    registry = new ArtifactRegistry();
    const out = await registry.loadSchemas(FIXTURE_SCHEMA_ROOT);
    expect(out.errors).toEqual([]);
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
    clearSchemaCache();
  });

  function consumer(
    artifactType: string,
    schemaVersion: string,
  ): ConsumerPluginRef {
    return {
      pluginId: 'consumer-plugin',
      consumes: [{ artifact_type: artifactType, schema_version: schemaVersion }],
    };
  }

  it('strips extra fields the producer leaked', async () => {
    const payload = {
      findings: [{ file: 'src/x.ts', line: 1, rule_id: 'R1' }],
      extra_data: 'leaked secret',
    };
    await registry.persist(tempRoot, 'security-findings', 'scan-extra', payload);

    const out = await registry.read(
      'security-findings',
      'scan-extra',
      consumer('security-findings', '1.0'),
      tempRoot,
    );
    expect(out.payload).toBeDefined();
    expect((out.payload as Record<string, unknown>).extra_data).toBeUndefined();
    expect((out.payload as { findings: unknown[] }).findings).toHaveLength(1);
    // The schema_version returned is the CONSUMER's, not the producer's.
    expect(out.schema_version).toBe('1.0');
    // On-disk file is untouched.
    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(
          tempRoot,
          '.autonomous-dev',
          'artifacts',
          'security-findings',
          'scan-extra.json',
        ),
        'utf-8',
      ),
    );
    expect(onDisk.extra_data).toBe('leaked secret');
  });

  it('narrows a 1.1 producer payload to a 1.0 consumer (drops severity)', async () => {
    const payload = {
      findings: [
        {
          file: 'src/y.ts',
          line: 42,
          rule_id: 'R2',
          severity: 'high',
        },
      ],
    };
    await registry.persist(
      tempRoot,
      'security-findings',
      'scan-narrow',
      payload,
    );

    const out = await registry.read(
      'security-findings',
      'scan-narrow',
      consumer('security-findings', '1.0'),
      tempRoot,
    );
    const finding = (out.payload as { findings: Array<Record<string, unknown>> })
      .findings[0];
    expect(finding.severity).toBeUndefined();
    expect(finding.file).toBe('src/y.ts');
  });

  it('throws SchemaValidationError when payload violates the consumer schema', async () => {
    // Missing required `rule_id` triggers AJV failure. Persist via raw
    // file write because persist() does not enforce strict-schema (the
    // producer side intentionally preserves extras for the new validator
    // to strip).
    const dir = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
    );
    await fs.mkdir(dir, { recursive: true });
    const bad = { findings: [{ file: 'src/z.ts', line: 1 }] };
    await fs.writeFile(
      path.join(dir, 'scan-bad.json'),
      JSON.stringify(bad),
      { mode: 0o600 },
    );

    await expect(
      registry.read(
        'security-findings',
        'scan-bad',
        consumer('security-findings', '1.0'),
        tempRoot,
      ),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('throws SchemaNotFoundError when the consumer requests an unknown version', async () => {
    await registry.persist(
      tempRoot,
      'security-findings',
      'scan-uv',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
    );
    await expect(
      registry.read(
        'security-findings',
        'scan-uv',
        consumer('security-findings', '9.9'),
        tempRoot,
      ),
    ).rejects.toBeInstanceOf(SchemaNotFoundError);
  });

  it('caches the compiled validator: 100 reads compile exactly once', async () => {
    await registry.persist(
      tempRoot,
      'security-findings',
      'scan-cache',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
    );
    const before = getCompileCount();
    for (let i = 0; i < 100; i++) {
      await registry.read(
        'security-findings',
        'scan-cache',
        consumer('security-findings', '1.0'),
        tempRoot,
      );
    }
    const after = getCompileCount();
    expect(after - before).toBe(1);
  });

  it('returned payload is a fresh object — re-reading the on-disk file shows extras preserved', async () => {
    const payload = {
      findings: [{ file: 'src/x.ts', line: 1, rule_id: 'R1' }],
      extra_data: 'still-here',
    };
    await registry.persist(
      tempRoot,
      'security-findings',
      'scan-fresh',
      payload,
    );
    await registry.read(
      'security-findings',
      'scan-fresh',
      consumer('security-findings', '1.0'),
      tempRoot,
    );
    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(
          tempRoot,
          '.autonomous-dev',
          'artifacts',
          'security-findings',
          'scan-fresh.json',
        ),
        'utf-8',
      ),
    );
    expect(onDisk.extra_data).toBe('still-here');
  });
});
