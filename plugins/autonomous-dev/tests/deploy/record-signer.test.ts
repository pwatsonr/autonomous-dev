/**
 * SPEC-023-1-01 deploy record-signer tests.
 *
 * Roundtrip + tamper detection on individual records, a 100-record
 * sweep for both, plus key-bootstrap permission/regeneration tests.
 *
 * @module tests/deploy/record-signer.test
 */

import { mkdtempSync, statSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalJson,
  loadDeployKey,
  signDeploymentRecord,
  verifyDeploymentRecord,
} from '../../intake/deploy/record-signer';
import { InsecureKeyPermissionsError } from '../../intake/deploy/errors';
import type { DeploymentRecord } from '../../intake/deploy/types';
import { canonicalJSON } from '../../intake/chains/canonical-json';

function fixtureRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    deployId: '01JABCDEFGHIJKLMNOPQRSTUVW',
    backend: 'local',
    environment: 'integration-test',
    artifactId: '01JZYXWVUTSRQPONMLKJIHGFED',
    deployedAt: '2026-05-02T12:00:00.000Z',
    status: 'deployed',
    details: { pr_url: 'https://github.com/o/r/pull/42', branch: 'main' },
    hmac: '',
    ...overrides,
  };
}

const TEST_KEY = Buffer.alloc(32, 0xab);

describe('SPEC-023-1-01 canonicalJson', () => {
  it('produces byte-identical output regardless of object key insertion order', () => {
    const a: Omit<DeploymentRecord, 'hmac'> = {
      deployId: 'D',
      backend: 'b',
      environment: 'e',
      artifactId: 'A',
      deployedAt: '2026-01-01T00:00:00.000Z',
      status: 'deployed',
      details: { z: 1, a: 2, m: 3 },
    };
    const b: Omit<DeploymentRecord, 'hmac'> = {
      details: { m: 3, a: 2, z: 1 },
      status: 'deployed',
      deployedAt: '2026-01-01T00:00:00.000Z',
      artifactId: 'A',
      environment: 'e',
      backend: 'b',
      deployId: 'D',
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('matches the chain-layer canonicalJSON output exactly', () => {
    const r = fixtureRecord();
    const expected = canonicalJSON({
      deployId: r.deployId,
      backend: r.backend,
      environment: r.environment,
      artifactId: r.artifactId,
      deployedAt: r.deployedAt,
      status: r.status,
      details: r.details,
    });
    expect(canonicalJson(r)).toBe(expected);
  });
});

describe('SPEC-023-1-01 sign/verify roundtrip', () => {
  it('signed record has a 64-char lowercase hex hmac', () => {
    const signed = signDeploymentRecord(fixtureRecord(), TEST_KEY);
    expect(signed.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyDeploymentRecord returns valid: true on the signed record', () => {
    const signed = signDeploymentRecord(fixtureRecord(), TEST_KEY);
    expect(verifyDeploymentRecord(signed, TEST_KEY)).toEqual({ valid: true });
  });

  it('does not mutate the input record', () => {
    const r = fixtureRecord();
    const signed = signDeploymentRecord(r, TEST_KEY);
    expect(r.hmac).toBe('');
    expect(signed).not.toBe(r);
  });

  it('mutating environment after signing invalidates the hmac', () => {
    const signed = signDeploymentRecord(fixtureRecord(), TEST_KEY);
    const tampered = { ...signed, environment: 'prod' };
    const result = verifyDeploymentRecord(tampered, TEST_KEY);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('mutating details.* after signing invalidates the hmac', () => {
    const signed = signDeploymentRecord(fixtureRecord(), TEST_KEY);
    const tampered: DeploymentRecord = {
      ...signed,
      details: { ...signed.details, pr_url: 'https://evil.example.com/pull/1' },
    };
    expect(verifyDeploymentRecord(tampered, TEST_KEY).valid).toBe(false);
  });

  it('mutating deployedAt after signing invalidates the hmac', () => {
    const signed = signDeploymentRecord(fixtureRecord(), TEST_KEY);
    const tampered = { ...signed, deployedAt: '2026-12-31T23:59:59.999Z' };
    expect(verifyDeploymentRecord(tampered, TEST_KEY).valid).toBe(false);
  });

  it('rejects an empty/missing hmac', () => {
    const r = fixtureRecord();
    expect(verifyDeploymentRecord(r, TEST_KEY).valid).toBe(false);
  });

  it('rejects a non-hex hmac', () => {
    const r = fixtureRecord({ hmac: 'X'.repeat(64) });
    expect(verifyDeploymentRecord(r, TEST_KEY).valid).toBe(false);
  });

  it('100-record sweep: every signed record verifies', () => {
    for (let i = 0; i < 100; i++) {
      const signed = signDeploymentRecord(
        fixtureRecord({
          deployId: `D-${i}`,
          environment: `env-${i}`,
          details: { i, label: `record-${i}` },
        }),
        TEST_KEY,
      );
      expect(verifyDeploymentRecord(signed, TEST_KEY).valid).toBe(true);
    }
  });

  it('100-record tamper sweep: every mutation is detected', () => {
    for (let i = 0; i < 100; i++) {
      const signed = signDeploymentRecord(
        fixtureRecord({
          deployId: `D-${i}`,
          details: { i },
        }),
        TEST_KEY,
      );
      const mutated: DeploymentRecord = {
        ...signed,
        details: { ...signed.details, i: i + 1 },
      };
      expect(verifyDeploymentRecord(mutated, TEST_KEY).valid).toBe(false);
    }
  });
});

describe('SPEC-023-1-01 loadDeployKey bootstrap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deploy-key-'));
  });

  it('uses DEPLOY_HMAC_KEY env var when set', () => {
    const hexKey = 'aa'.repeat(32);
    const key = loadDeployKey({
      env: { DEPLOY_HMAC_KEY: hexKey },
      keyPath: join(tmpDir, 'never-touched'),
      logger: { warn: () => {} },
    });
    expect(key.equals(Buffer.from(hexKey, 'hex'))).toBe(true);
    expect(existsSync(join(tmpDir, 'never-touched'))).toBe(false);
  });

  it('reads existing key file with mode 0600', () => {
    const path = join(tmpDir, 'deploy-key');
    // First load to generate.
    const first = loadDeployKey({ env: {}, keyPath: path, logger: { warn: () => {} } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Second load reads it back.
    const second = loadDeployKey({ env: {}, keyPath: path, logger: { warn: () => {} } });
    expect(first.equals(second)).toBe(true);
  });

  it('creates a fresh 0600 key file when absent and warns', () => {
    const path = join(tmpDir, 'fresh', 'deploy-key');
    const warnings: string[] = [];
    loadDeployKey({
      env: {},
      keyPath: path,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(warnings.some((w) => /auto-generated/i.test(w))).toBe(true);
    // 64 hex chars (32 bytes).
    expect(readFileSync(path, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws InsecureKeyPermissionsError when key file has mode 0644', () => {
    const path = join(tmpDir, 'deploy-key');
    loadDeployKey({ env: {}, keyPath: path, logger: { warn: () => {} } });
    chmodSync(path, 0o644);
    let caught: unknown;
    try {
      loadDeployKey({ env: {}, keyPath: path, logger: { warn: () => {} } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InsecureKeyPermissionsError);
    expect((caught as Error).message).toMatch(/insecure permissions/);
  });
});
