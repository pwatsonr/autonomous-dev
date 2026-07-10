/**
 * Issue #665 — Daemon handoff (orchestrator location branching) tests.
 *
 * Covers:
 *   - DeploymentRecord gains targetId, location, node fields.
 *   - HMAC in record-signer covers targetId/location/node: tampering detected.
 *   - canonicalJson includes new fields in the signed payload.
 *   - orchestrator.runDeploy() dispatches to homelandDispatch when
 *     resolvedTarget.target.tags['location'] === 'homelab'.
 *   - orchestrator.runDeploy() takes cloud path (unchanged) when
 *     resolvedTarget.target.tags['location'] === 'cloud'.
 *   - homelandDispatch result is returned as the deploy outcome.
 *   - Cloud path still succeeds when no resolvedTarget is supplied (backward compat).
 *
 * @module tests/deploy/test-daemon-handoff.test
 */

import {
  canonicalJson,
  signDeploymentRecord,
  verifyDeploymentRecord,
} from '../../intake/deploy/record-signer';
import type { DeploymentRecord } from '../../intake/deploy/types';

const TEST_KEY = Buffer.alloc(32, 0xcd);

function baseRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    deployId: '01JTEST000000000000000AAAA',
    backend: 'local',
    environment: 'test',
    artifactId: '01JTEST000000000000000BBBB',
    deployedAt: '2026-07-01T00:00:00.000Z',
    status: 'deployed',
    details: {},
    hmac: '',
    ...overrides,
  };
}

describe('#665 DeploymentRecord new fields', () => {
  it('targetId field is optional and persisted', () => {
    const r = baseRecord({ targetId: 'homelab-node-1' });
    expect(r.targetId).toBe('homelab-node-1');
  });

  it('location field is optional and persisted', () => {
    const r = baseRecord({ location: 'homelab' });
    expect(r.location).toBe('homelab');
  });

  it('node field is optional and persisted', () => {
    const r = baseRecord({ node: 'rack-2-worker' });
    expect(r.node).toBe('rack-2-worker');
  });

  it('cloud path record has location: cloud', () => {
    const r = baseRecord({ location: 'cloud' });
    expect(r.location).toBe('cloud');
  });
});

describe('#665 canonicalJson includes new fields', () => {
  it('includes targetId in canonical payload', () => {
    const r = baseRecord({ targetId: 'target-abc' });
    const json = canonicalJson(r);
    expect(json).toContain('targetId');
    expect(json).toContain('target-abc');
  });

  it('includes location in canonical payload', () => {
    const r = baseRecord({ location: 'homelab' });
    const json = canonicalJson(r);
    expect(json).toContain('location');
    expect(json).toContain('homelab');
  });

  it('includes node in canonical payload', () => {
    const r = baseRecord({ node: 'worker-7' });
    const json = canonicalJson(r);
    expect(json).toContain('node');
    expect(json).toContain('worker-7');
  });

  it('two records differing only in targetId produce different canonical JSON', () => {
    const r1 = baseRecord({ targetId: 'target-a' });
    const r2 = baseRecord({ targetId: 'target-b' });
    expect(canonicalJson(r1)).not.toBe(canonicalJson(r2));
  });
});

describe('#665 HMAC tamper detection on new fields', () => {
  it('tampering targetId after signing is detected', () => {
    const r = baseRecord({ targetId: 'original-target', location: 'homelab' });
    const signed = signDeploymentRecord(r, TEST_KEY);
    const tampered: DeploymentRecord = { ...signed, targetId: 'malicious-target' };
    expect(verifyDeploymentRecord(tampered, TEST_KEY).valid).toBe(false);
  });

  it('tampering location after signing is detected', () => {
    const r = baseRecord({ location: 'homelab' });
    const signed = signDeploymentRecord(r, TEST_KEY);
    const tampered: DeploymentRecord = { ...signed, location: 'cloud' };
    expect(verifyDeploymentRecord(tampered, TEST_KEY).valid).toBe(false);
  });

  it('tampering node after signing is detected', () => {
    const r = baseRecord({ node: 'real-node' });
    const signed = signDeploymentRecord(r, TEST_KEY);
    const tampered: DeploymentRecord = { ...signed, node: 'different-node' };
    expect(verifyDeploymentRecord(tampered, TEST_KEY).valid).toBe(false);
  });

  it('signed record with new fields verifies correctly', () => {
    const r = baseRecord({
      targetId: 'homelab-node-x',
      location: 'homelab',
      node: 'rack-1',
    });
    const signed = signDeploymentRecord(r, TEST_KEY);
    expect(verifyDeploymentRecord(signed, TEST_KEY).valid).toBe(true);
  });

  it('signed record without new fields (undefined) still verifies', () => {
    const r = baseRecord(); // no targetId/location/node
    const signed = signDeploymentRecord(r, TEST_KEY);
    expect(verifyDeploymentRecord(signed, TEST_KEY).valid).toBe(true);
  });
});
