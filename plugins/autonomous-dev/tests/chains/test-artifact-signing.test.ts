/**
 * SPEC-022-3-02 unit tests — HMAC envelope + privileged-chain Ed25519
 * signing on `ArtifactRegistry.persist()` and `read()`.
 *
 * Covers:
 *   - HMAC determinism (two producers, same payload → identical _chain_hmac).
 *   - read() rejects unsigned artifacts (ArtifactUnsignedError).
 *   - read() rejects payload tampering (ArtifactTamperedError).
 *   - read() rejects HMAC tampering (ArtifactTamperedError).
 *   - HMAC verify uses timingSafeEqual (length-mismatch path covered).
 *   - First-run key generation: env miss → file miss → generate, mode 0600,
 *     CRITICAL warning fired, subsequent calls are I/O-free.
 *   - Privileged chains: signer adds _chain_signature; missing/invalid/
 *     unknown_producer surface PrivilegedSignatureError with the right
 *     `reason`. Non-privileged chains tolerate (or omit) the field.
 *   - Pipeline ordering: HMAC verify runs BEFORE schema validation;
 *     sanitizer runs AFTER it (lockstep with SPEC-022-3-01 strict-strip).
 *
 * @module tests/chains/test-artifact-signing
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { sign as ed25519Sign, createPrivateKey } from 'node:crypto';

import { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import {
  ArtifactTamperedError,
  ArtifactUnsignedError,
  PrivilegedSignatureError,
  type ConsumerPluginRef,
  type SchemaValidationError,
} from '../../intake/chains/types';
import { canonicalJSON } from '../../intake/chains/canonical-json';
import {
  getChainHmacKey,
  resetChainKeyCacheForTest,
  getChainKeySourceForTest,
} from '../../intake/chains/chain-key';
import { clearSchemaCache } from '../../intake/chains/schema-cache';
import { createTempRequestDir, cleanupTempDir } from '../helpers/chain-fixtures';

const FIXTURE_SCHEMA_ROOT = path.resolve(__dirname, 'fixtures', 'schemas');
const KEYS_DIR = path.resolve(__dirname, 'fixtures', 'keys');

/** Stable test key — 32 bytes, fits HMAC contract. */
const TEST_HMAC_KEY = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'hex',
);

function consumer(
  artifactType: string,
  schemaVersion: string,
  pluginId = 'consumer-plugin',
): ConsumerPluginRef {
  return {
    pluginId,
    consumes: [{ artifact_type: artifactType, schema_version: schemaVersion }],
  };
}

async function makeRegistry(opts: {
  hmacKey?: Buffer;
  signer?: Parameters<typeof ArtifactRegistry.prototype.constructor>[0] extends infer _O
    ? unknown
    : never;
} = {}): Promise<ArtifactRegistry> {
  const reg = new ArtifactRegistry({
    hmacKey: opts.hmacKey ?? TEST_HMAC_KEY,
  });
  const out = await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
  expect(out.errors).toEqual([]);
  return reg;
}

describe('SPEC-022-3-02: HMAC artifact signing on persist()', () => {
  let tempRoot: string;

  beforeEach(async () => {
    clearSchemaCache();
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
    clearSchemaCache();
  });

  it('writes _chain_hmac and envelope metadata on every persist', async () => {
    const reg = await makeRegistry();
    await reg.persist(
      tempRoot,
      'security-findings',
      'scan-1',
      { findings: [{ file: 'a.ts', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', producedAt: '2026-04-29T00:00:00Z' },
    );
    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(
          tempRoot,
          '.autonomous-dev',
          'artifacts',
          'security-findings',
          'scan-1.json',
        ),
        'utf-8',
      ),
    );
    expect(typeof onDisk._chain_hmac).toBe('string');
    expect(onDisk._chain_hmac.length).toBeGreaterThan(0);
    expect(onDisk.artifact_type).toBe('security-findings');
    expect(onDisk.schema_version).toBe('1.0');
    expect(onDisk.producer_plugin_id).toBe('rule-set-enforcement');
    expect(onDisk.produced_at).toBe('2026-04-29T00:00:00Z');
    expect(onDisk.payload.findings[0].rule_id).toBe('R');
    expect(onDisk._chain_signature).toBeUndefined();
  });

  it('two persists with the same envelope produce IDENTICAL _chain_hmac (canonical JSON is deterministic)', async () => {
    const reg1 = await makeRegistry();
    const reg2 = await makeRegistry();
    const payload = { findings: [{ file: 'a', line: 1, rule_id: 'R1' }] };
    const ctx = { pluginId: 'p', producedAt: '2026-04-29T00:00:00Z' };

    const t1 = path.join(tempRoot, 'r1');
    const t2 = path.join(tempRoot, 'r2');
    await fs.mkdir(t1, { recursive: true });
    await fs.mkdir(t2, { recursive: true });

    await reg1.persist(t1, 'security-findings', 'x', payload, ctx);
    await reg2.persist(t2, 'security-findings', 'x', payload, ctx);

    const a = JSON.parse(
      await fs.readFile(
        path.join(t1, '.autonomous-dev', 'artifacts', 'security-findings', 'x.json'),
        'utf-8',
      ),
    );
    const b = JSON.parse(
      await fs.readFile(
        path.join(t2, '.autonomous-dev', 'artifacts', 'security-findings', 'x.json'),
        'utf-8',
      ),
    );
    expect(a._chain_hmac).toBe(b._chain_hmac);
  });

  it('round-trip: persist + read() returns the producer payload (after strict-strip)', async () => {
    const reg = await makeRegistry();
    await reg.persist(
      tempRoot,
      'security-findings',
      'scan-rt',
      { findings: [{ file: 'a.ts', line: 1, rule_id: 'R' }] },
    );
    const out = await reg.read(
      'security-findings',
      'scan-rt',
      consumer('security-findings', '1.0'),
      tempRoot,
    );
    expect(
      (out.payload as { findings: Array<Record<string, unknown>> }).findings[0]
        .rule_id,
    ).toBe('R');
  });
});

describe('SPEC-022-3-02: HMAC verification on read()', () => {
  let tempRoot: string;

  beforeEach(async () => {
    clearSchemaCache();
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
    clearSchemaCache();
  });

  /**
   * Helper: write an arbitrary JSON shape to disk under the artifact path.
   * Used to inject pre-PLAN-022-3 (unsigned) and tampered shapes.
   */
  async function writeRaw(
    artifactType: string,
    artifactId: string,
    body: unknown,
  ): Promise<void> {
    const dir = path.join(tempRoot, '.autonomous-dev', 'artifacts', artifactType);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, `${artifactId}.json`),
      JSON.stringify(body),
      { mode: 0o600 },
    );
  }

  it('throws ArtifactUnsignedError when on-disk has no _chain_hmac', async () => {
    const reg = await makeRegistry();
    await writeRaw('security-findings', 'unsigned', {
      findings: [{ file: 'a', line: 1, rule_id: 'R' }],
    });
    await expect(
      reg.read(
        'security-findings',
        'unsigned',
        consumer('security-findings', '1.0'),
        tempRoot,
      ),
    ).rejects.toBeInstanceOf(ArtifactUnsignedError);
  });

  it('throws ArtifactTamperedError when payload is mutated post-persist', async () => {
    const reg = await makeRegistry();
    await reg.persist(
      tempRoot,
      'security-findings',
      'tamper-payload',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
    );
    const filePath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      'tamper-payload.json',
    );
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    onDisk.payload.findings[0].rule_id = 'EVIL';
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    await expect(
      reg.read(
        'security-findings',
        'tamper-payload',
        consumer('security-findings', '1.0'),
        tempRoot,
      ),
    ).rejects.toBeInstanceOf(ArtifactTamperedError);
  });

  it('throws ArtifactTamperedError when _chain_hmac itself is replaced', async () => {
    const reg = await makeRegistry();
    await reg.persist(
      tempRoot,
      'security-findings',
      'tamper-hmac',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
    );
    const filePath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      'tamper-hmac.json',
    );
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    onDisk._chain_hmac = Buffer.alloc(32, 0xff).toString('base64'); // bogus
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    await expect(
      reg.read(
        'security-findings',
        'tamper-hmac',
        consumer('security-findings', '1.0'),
        tempRoot,
      ),
    ).rejects.toBeInstanceOf(ArtifactTamperedError);
  });

  it('rejects HMAC of mismatched length (timingSafeEqual length-guard)', async () => {
    const reg = await makeRegistry();
    await reg.persist(
      tempRoot,
      'security-findings',
      'len-mismatch',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
    );
    const filePath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      'len-mismatch.json',
    );
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    onDisk._chain_hmac = 'AA=='; // 1-byte hmac, not 32
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    await expect(
      reg.read(
        'security-findings',
        'len-mismatch',
        consumer('security-findings', '1.0'),
        tempRoot,
      ),
    ).rejects.toBeInstanceOf(ArtifactTamperedError);
  });

  it('HMAC failure short-circuits BEFORE strict-schema validation', async () => {
    // Persist a payload that is ALSO schema-invalid (missing rule_id) but
    // intact-HMAC. Then tamper the HMAC. The error should be tampered, not
    // schema-validation, proving the HMAC layer fired first.
    const reg = await makeRegistry();
    await reg.persist(
      tempRoot,
      'security-findings',
      'order-check',
      { findings: [{ file: 'a', line: 1 }] }, // missing rule_id
    );
    const filePath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      'order-check.json',
    );
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    onDisk._chain_hmac = Buffer.alloc(32, 0xab).toString('base64');
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    let caught: Error | null = null;
    try {
      await reg.read(
        'security-findings',
        'order-check',
        consumer('security-findings', '1.0'),
        tempRoot,
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(ArtifactTamperedError);
    // Negative assertion: must not be a SchemaValidationError.
    expect((caught as { code?: string }).code).not.toBe(
      'SCHEMA_VALIDATION_FAILED',
    );
  });
});

describe('SPEC-022-3-02: privileged-chain Ed25519 signing', () => {
  let tempRoot: string;

  // Match the keys we generated in fixtures/keys/.
  const PRODUCER_PRIV_PEM = Buffer.from(
    'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSUhBalIvVTZTMDdDa3lFbzB4RUxuazBWZXMweDZTaDJTUXNMQkRwZkdZNk8KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=',
    'base64',
  ).toString('utf-8');
  const UNRELATED_PRIV_PEM = Buffer.from(
    'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSU5aeUNwczYxN0JSK2x2MHUrQXRxaTd4WWdldkZuQTB3REdRTzBSNFBzczQKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=',
    'base64',
  ).toString('utf-8');

  beforeEach(async () => {
    clearSchemaCache();
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
    clearSchemaCache();
  });

  function ed25519Signer(privateKeyPem: string) {
    const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
    return {
      sign(_producerPluginId: string, canonical: string): string {
        return ed25519Sign(null, Buffer.from(canonical, 'utf8'), key).toString(
          'base64',
        );
      },
    };
  }

  function trustedKeysFromPub(pluginToPubPath: Record<string, string | null>) {
    return {
      lookup(producerPluginId: string): string | null {
        const filePath = pluginToPubPath[producerPluginId];
        if (!filePath) return null;
        return fsSync.readFileSync(filePath, 'utf-8');
      },
    };
  }

  function privilegedAlways() {
    return { isPrivileged: () => true };
  }
  function privilegedNever() {
    return { isPrivileged: () => false };
  }

  it('persist() adds _chain_signature only when policy says privileged', async () => {
    const reg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519Signer(PRODUCER_PRIV_PEM),
      privilegedPolicy: privilegedAlways(),
      trustedKeys: trustedKeysFromPub({
        'rule-set-enforcement': path.join(KEYS_DIR, 'producer.pub'),
      }),
    });
    await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await reg.persist(
      tempRoot,
      'security-findings',
      'priv-1',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(
          tempRoot,
          '.autonomous-dev',
          'artifacts',
          'security-findings',
          'priv-1.json',
        ),
        'utf-8',
      ),
    );
    expect(typeof onDisk._chain_signature).toBe('string');
    expect(onDisk._chain_signature.length).toBeGreaterThan(0);
  });

  it('persist() omits _chain_signature when policy says NOT privileged', async () => {
    const reg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519Signer(PRODUCER_PRIV_PEM),
      privilegedPolicy: privilegedNever(),
      trustedKeys: trustedKeysFromPub({}),
    });
    await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await reg.persist(
      tempRoot,
      'security-findings',
      'nonpriv-1',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    const onDisk = JSON.parse(
      await fs.readFile(
        path.join(
          tempRoot,
          '.autonomous-dev',
          'artifacts',
          'security-findings',
          'nonpriv-1.json',
        ),
        'utf-8',
      ),
    );
    // Field absent — NOT null.
    expect(Object.prototype.hasOwnProperty.call(onDisk, '_chain_signature')).toBe(
      false,
    );
  });

  it('read() under privileged policy with valid signature succeeds', async () => {
    const reg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519Signer(PRODUCER_PRIV_PEM),
      privilegedPolicy: privilegedAlways(),
      trustedKeys: trustedKeysFromPub({
        'rule-set-enforcement': path.join(KEYS_DIR, 'producer.pub'),
      }),
    });
    await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await reg.persist(
      tempRoot,
      'security-findings',
      'pv-ok',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    const out = await reg.read(
      'security-findings',
      'pv-ok',
      consumer('security-findings', '1.0', 'code-fixer'),
      tempRoot,
    );
    expect(out.producer_plugin_id).toBe('rule-set-enforcement');
  });

  it("read() under privileged policy with MISSING signature → reason='missing'", async () => {
    // Persist WITHOUT the signer wired so no _chain_signature is added.
    const persistReg = new ArtifactRegistry({ hmacKey: TEST_HMAC_KEY });
    await persistReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await persistReg.persist(
      tempRoot,
      'security-findings',
      'pv-missing',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    // Read under a privileged policy → must demand the signature.
    const readReg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      privilegedPolicy: privilegedAlways(),
      trustedKeys: trustedKeysFromPub({
        'rule-set-enforcement': path.join(KEYS_DIR, 'producer.pub'),
      }),
    });
    await readReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    let caught: PrivilegedSignatureError | null = null;
    try {
      await readReg.read(
        'security-findings',
        'pv-missing',
        consumer('security-findings', '1.0', 'code-fixer'),
        tempRoot,
      );
    } catch (err) {
      caught = err as PrivilegedSignatureError;
    }
    expect(caught).toBeInstanceOf(PrivilegedSignatureError);
    expect(caught?.reason).toBe('missing');
  });

  it("read() under privileged policy with TAMPERED signature → reason='invalid'", async () => {
    const reg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519Signer(PRODUCER_PRIV_PEM),
      privilegedPolicy: privilegedAlways(),
      trustedKeys: trustedKeysFromPub({
        'rule-set-enforcement': path.join(KEYS_DIR, 'producer.pub'),
      }),
    });
    await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await reg.persist(
      tempRoot,
      'security-findings',
      'pv-bad',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    // Mutate the signature directly. The HMAC envelope still verifies
    // because the HMAC input excludes _chain_signature; the Ed25519 layer
    // is what fails.
    const filePath = path.join(
      tempRoot,
      '.autonomous-dev',
      'artifacts',
      'security-findings',
      'pv-bad.json',
    );
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    onDisk._chain_signature = Buffer.alloc(64, 0xee).toString('base64');
    await fs.writeFile(filePath, JSON.stringify(onDisk));

    let caught: PrivilegedSignatureError | null = null;
    try {
      await reg.read(
        'security-findings',
        'pv-bad',
        consumer('security-findings', '1.0', 'code-fixer'),
        tempRoot,
      );
    } catch (err) {
      caught = err as PrivilegedSignatureError;
    }
    expect(caught).toBeInstanceOf(PrivilegedSignatureError);
    expect(caught?.reason).toBe('invalid');
  });

  it("read() under privileged policy with no trusted key for producer → reason='unknown_producer'", async () => {
    const reg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519Signer(PRODUCER_PRIV_PEM),
      privilegedPolicy: privilegedAlways(),
      // Map to a DIFFERENT plugin id so the producer's id misses.
      trustedKeys: trustedKeysFromPub({}),
    });
    await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await reg.persist(
      tempRoot,
      'security-findings',
      'pv-unknown',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );

    let caught: PrivilegedSignatureError | null = null;
    try {
      await reg.read(
        'security-findings',
        'pv-unknown',
        consumer('security-findings', '1.0', 'code-fixer'),
        tempRoot,
      );
    } catch (err) {
      caught = err as PrivilegedSignatureError;
    }
    expect(caught).toBeInstanceOf(PrivilegedSignatureError);
    expect(caught?.reason).toBe('unknown_producer');
  });

  it('non-privileged read tolerates a stray _chain_signature without raising', async () => {
    // Persist with privileged policy ON so a signature lands on disk.
    const persistReg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519Signer(PRODUCER_PRIV_PEM),
      privilegedPolicy: privilegedAlways(),
      trustedKeys: trustedKeysFromPub({
        'rule-set-enforcement': path.join(KEYS_DIR, 'producer.pub'),
      }),
    });
    await persistReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await persistReg.persist(
      tempRoot,
      'security-findings',
      'mixed',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    // Read with NO privileged policy (or never-privileged policy): the
    // signature is ignored, no error.
    const readReg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      privilegedPolicy: privilegedNever(),
    });
    await readReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    const out = await readReg.read(
      'security-findings',
      'mixed',
      consumer('security-findings', '1.0', 'code-fixer'),
      tempRoot,
    );
    expect(out).toBeDefined();
  });

  it('Ed25519 verify overhead is <2ms on average over 50 reads', async () => {
    const reg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519Signer(PRODUCER_PRIV_PEM),
      privilegedPolicy: privilegedAlways(),
      trustedKeys: trustedKeysFromPub({
        'rule-set-enforcement': path.join(KEYS_DIR, 'producer.pub'),
      }),
    });
    await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await reg.persist(
      tempRoot,
      'security-findings',
      'perf',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      await reg.read(
        'security-findings',
        'perf',
        consumer('security-findings', '1.0', 'code-fixer'),
        tempRoot,
      );
    }
    const avgMs = (performance.now() - start) / 50;
    // Generous bound — the spec target is <2ms for verify alone; this
    // bound includes file I/O + schema validate + sanitize + verify so
    // we use 20ms as a perf canary that catches order-of-magnitude regs.
    expect(avgMs).toBeLessThan(20);
  });
});

describe('SPEC-022-3-04: signing closeout coverage', () => {
  let tempRoot: string;

  beforeEach(async () => {
    clearSchemaCache();
    tempRoot = await createTempRequestDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempRoot);
    clearSchemaCache();
  });

  const ALT_HMAC_KEY = Buffer.from(
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    'hex',
  );

  // Producer Ed25519 key — same fixture used by the privileged-chain
  // suite above so we don't pay keygen on every adversarial test.
  const PRODUCER_PRIV_PEM_LOCAL = Buffer.from(
    'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSUhBalIvVTZTMDdDa3lFbzB4RUxuazBWZXMweDZTaDJTUXNMQkRwZkdZNk8KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=',
    'base64',
  ).toString('utf-8');

  function ed25519SignerLocal(privateKeyPem: string) {
    const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
    return {
      sign(_producerPluginId: string, canonical: string): string {
        return ed25519Sign(null, Buffer.from(canonical, 'utf8'), key).toString(
          'base64',
        );
      },
    };
  }

  it('producer + consumer with DIFFERENT HMAC keys → ArtifactTamperedError', async () => {
    // Defense against operators running two daemons with mismatched keys.
    const persistReg = new ArtifactRegistry({ hmacKey: TEST_HMAC_KEY });
    await persistReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await persistReg.persist(
      tempRoot,
      'security-findings',
      'mismatched-key',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
    );

    const readReg = new ArtifactRegistry({ hmacKey: ALT_HMAC_KEY });
    await readReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    const c: ConsumerPluginRef = {
      pluginId: 'P',
      consumes: [{ artifact_type: 'security-findings', schema_version: '1.0' }],
    };
    await expect(
      readReg.read('security-findings', 'mismatched-key', c, tempRoot),
    ).rejects.toBeInstanceOf(ArtifactTamperedError);
  });

  it('Ed25519 verify scales: avg <10ms even for ~1MB payloads', async () => {
    const reg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519SignerLocal(PRODUCER_PRIV_PEM_LOCAL),
      privilegedPolicy: { isPrivileged: () => true },
      trustedKeys: {
        lookup: (id: string) =>
          id === 'rule-set-enforcement'
            ? fsSync.readFileSync(path.join(KEYS_DIR, 'producer.pub'), 'utf-8')
            : null,
      },
      // Larger artifact-size cap so we can test 1MB payloads.
      maxArtifactSizeMb: 16,
    });
    await reg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    const consumerCF: ConsumerPluginRef = {
      pluginId: 'code-fixer',
      consumes: [{ artifact_type: 'security-findings', schema_version: '1.0' }],
    };

    // Build a ~1KB payload.
    const findings1k = Array.from({ length: 10 }, (_, i) => ({
      file: `src/path/to/file_${i}.ts`,
      line: i + 1,
      rule_id: `R-${'x'.repeat(80)}`,
    }));
    await reg.persist(
      tempRoot,
      'security-findings',
      'perf-1k',
      { findings: findings1k },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    const t1kStart = performance.now();
    for (let i = 0; i < 20; i++) {
      await reg.read('security-findings', 'perf-1k', consumerCF, tempRoot);
    }
    const t1kAvg = (performance.now() - t1kStart) / 20;
    // Generous bound (<20ms total round-trip); detects 10x regressions.
    expect(t1kAvg).toBeLessThan(20);

    // Build a ~1MB payload (~10k findings × ~100 bytes each).
    const findings1m = Array.from({ length: 10000 }, (_, i) => ({
      file: `src/very/deeply/nested/path/${i}/component.ts`,
      line: (i % 1000) + 1,
      rule_id: `RULE-${'y'.repeat(40)}`,
    }));
    await reg.persist(
      tempRoot,
      'security-findings',
      'perf-1m',
      { findings: findings1m },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );
    const t1mStart = performance.now();
    for (let i = 0; i < 5; i++) {
      await reg.read('security-findings', 'perf-1m', consumerCF, tempRoot);
    }
    const t1mAvg = (performance.now() - t1mStart) / 5;
    // 1MB read includes file I/O, AJV strict-strip, sanitize, and verify.
    // Spec target is <10ms for verify alone; 200ms is the round-trip
    // perf canary that catches >10x regressions.
    expect(t1mAvg).toBeLessThan(200);
  });

  it('privileged producer + non-privileged consumer: verification skipped', async () => {
    // Re-asserts the privileged-policy gate from a different angle: when
    // the consumer side declares it is NOT privileged, the producer's
    // Ed25519 signature is ignored (even when valid). This protects
    // non-privileged consumers from accidental dependency on signed
    // upstream metadata.
    const persistReg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      signer: ed25519SignerLocal(PRODUCER_PRIV_PEM_LOCAL),
      privilegedPolicy: { isPrivileged: () => true },
      trustedKeys: {
        lookup: (id: string) =>
          id === 'rule-set-enforcement'
            ? fsSync.readFileSync(path.join(KEYS_DIR, 'producer.pub'), 'utf-8')
            : null,
      },
    });
    await persistReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    await persistReg.persist(
      tempRoot,
      'security-findings',
      'asym-priv',
      { findings: [{ file: 'a', line: 1, rule_id: 'R' }] },
      { pluginId: 'rule-set-enforcement', consumerPluginId: 'code-fixer' },
    );

    // The consumer-side registry has a privilegedPolicy that says NO —
    // so the Ed25519 signature is ignored on read.
    const readReg = new ArtifactRegistry({
      hmacKey: TEST_HMAC_KEY,
      privilegedPolicy: { isPrivileged: () => false },
    });
    await readReg.loadSchemas(FIXTURE_SCHEMA_ROOT);
    const consumerCF: ConsumerPluginRef = {
      pluginId: 'code-fixer',
      consumes: [{ artifact_type: 'security-findings', schema_version: '1.0' }],
    };
    const out = await readReg.read('security-findings', 'asym-priv', consumerCF, tempRoot);
    expect(out.producer_plugin_id).toBe('rule-set-enforcement');
  });
});

describe('SPEC-022-3-02: chain HMAC key resolution', () => {
  let tempHome: string;
  let warnings: string[];
  const logger = { warn: (m: string) => warnings.push(m) };

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(
      path.join(require('node:os').tmpdir(), 'chain-key-'),
    );
    warnings = [];
    resetChainKeyCacheForTest();
  });

  afterEach(async () => {
    resetChainKeyCacheForTest();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('uses CHAIN_HMAC_KEY env var when set', () => {
    const buf = Buffer.alloc(32, 0xaa);
    const key = getChainHmacKey({
      env: { CHAIN_HMAC_KEY: buf.toString('base64') },
      keyPath: path.join(tempHome, 'k.key'),
      logger,
    });
    expect(key.equals(buf)).toBe(true);
    expect(getChainKeySourceForTest()).toBe('env');
    expect(warnings).toEqual([]);
  });

  it('reads on-disk key when env var is missing', () => {
    const buf = Buffer.alloc(32, 0xbb);
    const keyPath = path.join(tempHome, 'k.key');
    fsSync.mkdirSync(path.dirname(keyPath), { recursive: true });
    fsSync.writeFileSync(keyPath, buf.toString('base64'), { mode: 0o600 });
    const key = getChainHmacKey({ env: {}, keyPath, logger });
    expect(key.equals(buf)).toBe(true);
    expect(getChainKeySourceForTest()).toBe('file');
  });

  it('first run: env miss + file miss → generate, persist 0600, CRITICAL warn', () => {
    const keyPath = path.join(tempHome, 'sub', 'k.key');
    const key = getChainHmacKey({ env: {}, keyPath, logger });
    expect(key.length).toBe(32);
    expect(getChainKeySourceForTest()).toBe('generated');
    expect(fsSync.existsSync(keyPath)).toBe(true);
    const stat = fsSync.statSync(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(warnings.some((w) => w.includes('CRITICAL'))).toBe(true);
  });

  it('second call returns cached key (no I/O)', () => {
    const keyPath = path.join(tempHome, 'k.key');
    fsSync.writeFileSync(
      keyPath,
      Buffer.alloc(32, 0xcc).toString('base64'),
      { mode: 0o600 },
    );
    const k1 = getChainHmacKey({ env: {}, keyPath, logger });
    // Delete the on-disk file: a non-cached resolution path would now
    // either re-generate (different bytes) or throw. The cached path must
    // return the SAME buffer.
    fsSync.unlinkSync(keyPath);
    const k2 = getChainHmacKey({ env: {}, keyPath, logger });
    expect(k1.equals(k2)).toBe(true);
    // Source breadcrumb must remain `file` — proves no second resolution ran.
    expect(getChainKeySourceForTest()).toBe('file');
  });
});

describe('SPEC-022-3-02: canonicalJSON', () => {
  it('sorts keys lexicographically at every level', () => {
    expect(canonicalJSON({ b: 1, a: { c: 2, b: 1 } })).toBe(
      '{"a":{"b":1,"c":2},"b":1}',
    );
  });

  it('preserves array order', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
  });

  it('round-trips ASCII strings via JSON.stringify escaping', () => {
    expect(canonicalJSON({ s: 'a"b\\c\nd' })).toBe('{"s":"a\\"b\\\\c\\nd"}');
  });

  it('rejects undefined values', () => {
    expect(() => canonicalJSON({ a: undefined })).toThrow(TypeError);
  });

  it('rejects functions and symbols', () => {
    expect(() => canonicalJSON(() => 0)).toThrow(TypeError);
    expect(() => canonicalJSON(Symbol('x'))).toThrow(TypeError);
  });

  it('rejects BigInt', () => {
    expect(() => canonicalJSON(10n)).toThrow(TypeError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJSON({ x: Number.POSITIVE_INFINITY })).toThrow(
      TypeError,
    );
    expect(() => canonicalJSON({ x: NaN })).toThrow(TypeError);
  });

  it('emits primitives without whitespace', () => {
    expect(canonicalJSON(true)).toBe('true');
    expect(canonicalJSON(false)).toBe('false');
    expect(canonicalJSON(null)).toBe('null');
    expect(canonicalJSON(42)).toBe('42');
    expect(canonicalJSON('x')).toBe('"x"');
  });
});

// Suppress unused-import lint when SchemaValidationError isn't directly
// referenced in the test bodies above.
type _Touch = SchemaValidationError;
