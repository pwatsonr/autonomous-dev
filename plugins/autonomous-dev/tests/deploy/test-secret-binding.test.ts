/**
 * Issue #667 — Secret binding tests.
 *
 * Covers:
 *   - SecretBinding type shape (credentialRef, injectAs, name).
 *   - resolveSecretBindings JIT resolution via CredentialProxy.
 *   - Resolved bindings carry env/file injection type + secret material.
 *   - Persisted bindings (recordSafeBindings) contain only refHash, never material.
 *   - refHash is a deterministic SHA-256 hex of credentialRef.
 *   - Permission-denied scenario: proxy throws, resolveSecretBindings rejects.
 *   - Both 'env' and 'file' injectAs modes are supported.
 *
 * @module tests/deploy/test-secret-binding.test
 */

import { createHash } from 'node:crypto';
import {
  resolveSecretBindings,
  toRecordSafeBindings,
  type SecretBinding,
  type ResolvedSecretBinding,
  type RecordSafeBinding,
} from '../../intake/deploy/secret-binding';
import type { CredentialProxy } from '../../intake/deploy/credential-proxy-types';

/** Build a minimal CredentialProxy stub that returns fixed secret material. */
function makeProxy(secretsByRef: Record<string, string>): CredentialProxy {
  return {
    async acquire(provider, operationName, scope) {
      const ref = scope.resource;
      const material = secretsByRef[ref];
      if (material === undefined) {
        throw new Error(`permission denied for ref: ${ref}`);
      }
      return {
        cloud: provider,
        expiresAt: new Date(Date.now() + 900_000),
        tokenId: `tok-${ref}`,
        token: material,
      };
    },
  };
}

function refHash(credentialRef: string): string {
  return createHash('sha256').update(credentialRef).digest('hex');
}

describe('#667 SecretBinding types', () => {
  it('accepts env injectAs shape', () => {
    const b: SecretBinding = {
      credentialRef: 'vault/prod/db-password',
      injectAs: 'env',
      name: 'DB_PASSWORD',
    };
    expect(b.injectAs).toBe('env');
  });

  it('accepts file injectAs shape', () => {
    const b: SecretBinding = {
      credentialRef: 'vault/prod/ssh-key',
      injectAs: 'file',
      name: '/run/secrets/ssh_key',
    };
    expect(b.injectAs).toBe('file');
  });
});

describe('#667 resolveSecretBindings', () => {
  it('resolves env binding with secret material', async () => {
    const proxy = makeProxy({ 'vault/prod/db-pw': 's3cr3t' });
    const bindings: SecretBinding[] = [
      { credentialRef: 'vault/prod/db-pw', injectAs: 'env', name: 'DB_PW' },
    ];
    const resolved = await resolveSecretBindings(bindings, proxy);
    expect(resolved).toHaveLength(1);
    const r = resolved[0] as ResolvedSecretBinding;
    expect(r.injectAs).toBe('env');
    expect(r.name).toBe('DB_PW');
    expect(r.secretMaterial).toBe('s3cr3t');
    expect(r.credentialRef).toBe('vault/prod/db-pw');
  });

  it('resolves file binding with secret material', async () => {
    const proxy = makeProxy({ 'vault/prod/cert': '-----BEGIN CERT-----' });
    const bindings: SecretBinding[] = [
      { credentialRef: 'vault/prod/cert', injectAs: 'file', name: '/run/secrets/cert' },
    ];
    const resolved = await resolveSecretBindings(bindings, proxy);
    expect(resolved[0].injectAs).toBe('file');
    expect((resolved[0] as ResolvedSecretBinding).secretMaterial).toBe('-----BEGIN CERT-----');
  });

  it('resolves multiple bindings in order', async () => {
    const proxy = makeProxy({
      'vault/a': 'aaa',
      'vault/b': 'bbb',
    });
    const bindings: SecretBinding[] = [
      { credentialRef: 'vault/a', injectAs: 'env', name: 'A' },
      { credentialRef: 'vault/b', injectAs: 'env', name: 'B' },
    ];
    const resolved = await resolveSecretBindings(bindings, proxy);
    expect(resolved).toHaveLength(2);
    expect((resolved[0] as ResolvedSecretBinding).secretMaterial).toBe('aaa');
    expect((resolved[1] as ResolvedSecretBinding).secretMaterial).toBe('bbb');
  });

  it('throws on permission denied (proxy throws)', async () => {
    const proxy = makeProxy({}); // empty — all refs denied
    const bindings: SecretBinding[] = [
      { credentialRef: 'vault/secret', injectAs: 'env', name: 'VAL' },
    ];
    await expect(resolveSecretBindings(bindings, proxy)).rejects.toThrow(/permission denied/i);
  });

  it('returns empty array for empty bindings', async () => {
    const proxy = makeProxy({});
    const resolved = await resolveSecretBindings([], proxy);
    expect(resolved).toEqual([]);
  });
});

describe('#667 toRecordSafeBindings', () => {
  it('returns only refHash — no secretMaterial', () => {
    const resolved: ResolvedSecretBinding[] = [
      {
        credentialRef: 'vault/prod/db-pw',
        injectAs: 'env',
        name: 'DB_PW',
        secretMaterial: 's3cr3t',
      },
    ];
    const safe = toRecordSafeBindings(resolved);
    expect(safe).toHaveLength(1);
    const s = safe[0] as RecordSafeBinding;
    expect(s.refHash).toBe(refHash('vault/prod/db-pw'));
    expect(s.injectAs).toBe('env');
    expect(s.name).toBe('DB_PW');
    // secretMaterial must not appear in the safe binding
    expect(Object.keys(s)).not.toContain('secretMaterial');
    expect(Object.keys(s)).not.toContain('credentialRef');
  });

  it('refHash is stable SHA-256 hex of credentialRef', () => {
    const ref = 'vault/some/secret';
    const resolved: ResolvedSecretBinding[] = [
      { credentialRef: ref, injectAs: 'file', name: '/run/sec', secretMaterial: 'x' },
    ];
    const safe = toRecordSafeBindings(resolved);
    expect(safe[0].refHash).toBe(refHash(ref));
  });

  it('returns empty for empty input', () => {
    expect(toRecordSafeBindings([])).toEqual([]);
  });
});
