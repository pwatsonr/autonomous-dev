/**
 * SPEC-022-3-01 unit tests — capability-scoped artifact reads.
 *
 * Covers the truth table:
 *
 *   | consumes[]                                                | call                               | result            |
 *   |-----------------------------------------------------------|------------------------------------|-------------------|
 *   | [{security-findings@1.0}]                                 | read('security-findings', ...)     | success           |
 *   | [{security-findings@1.0}]                                 | read('code-patches', ...)          | CapabilityError   |
 *   | []                                                        | read(any, ...)                     | CapabilityError   |
 *
 * Also asserts that the capability check runs BEFORE schema lookup —
 * a denied capability MUST NOT trigger a schema-cache compile.
 *
 * @module tests/chains/test-capability-scope
 */

import * as path from 'node:path';

import { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import {
  CapabilityError,
  type ConsumerPluginRef,
} from '../../intake/chains/types';
import {
  clearSchemaCache,
  getCompileCount,
} from '../../intake/chains/schema-cache';
import { createTempRequestDir, cleanupTempDir } from '../helpers/chain-fixtures';

const FIXTURE_SCHEMA_ROOT = path.resolve(__dirname, 'fixtures', 'schemas');

describe('ArtifactRegistry.read — capability scope (SPEC-022-3-01)', () => {
  let tempRoot: string;
  let registry: ArtifactRegistry;

  beforeEach(async () => {
    clearSchemaCache();
    tempRoot = await createTempRequestDir();
    registry = new ArtifactRegistry();
    await registry.loadSchemas(FIXTURE_SCHEMA_ROOT);
    // Persist artifacts of BOTH types so the test isolates the capability
    // check (artifact existence is not the gating factor).
    await registry.persist(
      tempRoot,
      'security-findings',
      'cap-1',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
    );
    await registry.persist(
      tempRoot,
      'code-patches',
      'cap-2',
      { patches: [{ file: 'a', hunks: ['@@'] }] },
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
    clearSchemaCache();
  });

  it('declared consumes succeeds', async () => {
    const consumer: ConsumerPluginRef = {
      pluginId: 'P',
      consumes: [{ artifact_type: 'security-findings', schema_version: '1.0' }],
    };
    const out = await registry.read('security-findings', 'cap-1', consumer, tempRoot);
    expect(out.artifact_type).toBe('security-findings');
  });

  it('undeclared artifact type throws CapabilityError', async () => {
    const consumer: ConsumerPluginRef = {
      pluginId: 'P',
      consumes: [{ artifact_type: 'security-findings', schema_version: '1.0' }],
    };
    await expect(
      registry.read('code-patches', 'cap-2', consumer, tempRoot),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('CapabilityError carries CAPABILITY_DENIED code and identifies plugin + type', async () => {
    const consumer: ConsumerPluginRef = {
      pluginId: 'plugin-zed',
      consumes: [],
    };
    let caught: CapabilityError | undefined;
    try {
      await registry.read('security-findings', 'cap-1', consumer, tempRoot);
    } catch (err) {
      caught = err as CapabilityError;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(caught!.code).toBe('CAPABILITY_DENIED');
    expect(caught!.pluginId).toBe('plugin-zed');
    expect(caught!.artifactType).toBe('security-findings');
    expect(caught!.message).toContain('plugin-zed');
    expect(caught!.message).toContain('security-findings');
  });

  it('capability check runs BEFORE schema-cache compile (no compile on denial)', async () => {
    clearSchemaCache();
    const before = getCompileCount();
    const consumer: ConsumerPluginRef = {
      pluginId: 'P',
      consumes: [],
    };
    await expect(
      registry.read('security-findings', 'cap-1', consumer, tempRoot),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(getCompileCount()).toBe(before);
  });

  it('empty consumes[] denies every artifact', async () => {
    const consumer: ConsumerPluginRef = {
      pluginId: 'P',
      consumes: [],
    };
    await expect(
      registry.read('security-findings', 'cap-1', consumer, tempRoot),
    ).rejects.toBeInstanceOf(CapabilityError);
    await expect(
      registry.read('code-patches', 'cap-2', consumer, tempRoot),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});
