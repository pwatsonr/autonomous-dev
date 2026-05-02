/**
 * TrustValidator: permissive-mode truth table (SPEC-019-3-05).
 *
 * Permissive mode = trust by default. Two sub-modes:
 *   - signature_verification: false → every plugin trusted, signature
 *     verifier never called.
 *   - signature_verification: true → trust gated on signature; unsigned or
 *     bad-signature plugins rejected with the canonical reason string.
 *
 * Allowlist is advisory in permissive mode (it is NOT consulted by
 * stepTrustStatus). The tests verify both signature-on and signature-off
 * arms and assert the audit-emission contract on both paths.
 *
 * @module __tests__/hooks/test-trust-permissive
 */

import { TrustValidator } from '../../hooks/trust-validator';
import {
  InMemoryAuditWriter,
  TrustAuditEmitter,
} from '../../hooks/audit-emitter';
import {
  type ExtensionsConfig,
  type HookManifest,
  HookPoint,
  FailureMode,
} from '../../hooks/types';
import type { ValidationPipeline } from '../../hooks/validation-pipeline';
import { SignatureVerifier } from '../../hooks/signature-verifier';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<ExtensionsConfig> = {}): ExtensionsConfig {
  return {
    allowlist: [],
    privileged_reviewers: [],
    trust_mode: 'permissive',
    signature_verification: false,
    auto_update_allowed: false,
    max_plugins_per_hook_point: 16,
    global_resource_limits: {
      max_total_memory_mb: 256,
      max_concurrent_executions: 4,
      max_execution_time_seconds: 30,
    },
    ...over,
  };
}

function makeManifest(over: Partial<HookManifest> = {}): HookManifest {
  return {
    id: 'com.acme.foo',
    name: 'Acme Foo',
    version: '1.0.0',
    hooks: [
      {
        id: 'h1',
        hook_point: HookPoint.IntakePreValidate,
        entry_point: './h.js',
        priority: 0,
        failure_mode: FailureMode.Warn,
      },
    ],
    ...over,
  };
}

const STUB_PIPELINE = {} as unknown as ValidationPipeline;

function build(
  config: ExtensionsConfig,
  verifyImpl: (m: string, s: string) => Promise<boolean> = async () => false,
): {
  validator: TrustValidator;
  audit: InMemoryAuditWriter;
  verifySpy: jest.Mock;
} {
  const audit = new InMemoryAuditWriter();
  const emitter = new TrustAuditEmitter(audit);
  const verifySpy = jest.fn(verifyImpl);
  const verifier = new SignatureVerifier('/nonexistent');
  (verifier as unknown as { verify: typeof verifySpy }).verify = verifySpy;
  const validator = new TrustValidator(config, STUB_PIPELINE, '/nonexistent', {
    signatureVerifier: verifier,
    auditEmitter: emitter,
  });
  return { validator, audit, verifySpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrustValidator: permissive mode truth table', () => {
  describe('signature_verification: false', () => {
    it('trusts every plugin regardless of allowlist', async () => {
      const { validator, audit, verifySpy } = build(
        makeConfig({ signature_verification: false, allowlist: [] }),
      );
      const result = await validator.validatePlugin(
        makeManifest({ id: 'com.random.thing' }),
        '/fake/path/hooks.json',
      );
      expect(result.trusted).toBe(true);
      expect(verifySpy).not.toHaveBeenCalled();
      expect(audit.entries('trust')[0].decision).toBe('registered');
    });

    it('does not consult the allowlist (off-allowlist plugin still trusted)', async () => {
      const { validator } = build(
        makeConfig({
          signature_verification: false,
          allowlist: ['com.acme.foo'],
        }),
      );
      const result = await validator.validatePlugin(
        makeManifest({ id: 'com.something.else' }),
        '/fake/path/hooks.json',
      );
      expect(result.trusted).toBe(true);
    });
  });

  describe('signature_verification: true', () => {
    it('trusts a signed plugin (signature verifier returns true)', async () => {
      const { validator, audit, verifySpy } = build(
        makeConfig({ signature_verification: true }),
        async () => true,
      );
      const result = await validator.validatePlugin(
        makeManifest({ id: 'com.acme.foo' }),
        '/fake/path/hooks.json',
      );
      expect(result.trusted).toBe(true);
      expect(verifySpy).toHaveBeenCalledTimes(1);
      // Path passed through as-is, plus the conventional `.sig` suffix.
      expect(verifySpy).toHaveBeenCalledWith(
        '/fake/path/hooks.json',
        '/fake/path/hooks.json.sig',
      );
      expect(audit.entries('trust')[0].decision).toBe('registered');
    });

    it('rejects an unsigned plugin with the canonical reason', async () => {
      const { validator, audit } = build(
        makeConfig({ signature_verification: true }),
        async () => false,
      );
      const result = await validator.validatePlugin(
        makeManifest({ id: 'com.acme.foo' }),
        '/fake/path/hooks.json',
      );
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe(
        'permissive mode requires valid signature; none found or invalid',
      );
      expect(audit.entries('trust')).toHaveLength(1);
      expect(audit.entries('trust')[0]).toMatchObject({
        decision: 'rejected',
        pluginId: 'com.acme.foo',
        reason:
          'permissive mode requires valid signature; none found or invalid',
      });
    });

    it('signed plugin off the allowlist is still trusted (allowlist advisory)', async () => {
      const { validator } = build(
        makeConfig({
          signature_verification: true,
          allowlist: ['com.acme.bar'],
        }),
        async () => true,
      );
      const result = await validator.validatePlugin(
        makeManifest({ id: 'com.acme.foo' }),
        '/fake/path/hooks.json',
      );
      expect(result.trusted).toBe(true);
    });

    it('signature verifier called exactly once per validatePlugin call', async () => {
      const { validator, verifySpy } = build(
        makeConfig({ signature_verification: true }),
        async () => true,
      );
      await validator.validatePlugin(
        makeManifest(),
        '/fake/path/hooks.json',
      );
      expect(verifySpy).toHaveBeenCalledTimes(1);
    });
  });

  it('emits exactly one audit entry per validatePlugin call (pass)', async () => {
    const { validator, audit } = build(makeConfig());
    await validator.validatePlugin(makeManifest(), '/fake/path/hooks.json');
    expect(audit.entries('trust')).toHaveLength(1);
  });

  it('emits exactly one audit entry per validatePlugin call (reject)', async () => {
    const { validator, audit } = build(
      makeConfig({ signature_verification: true }),
      async () => false,
    );
    await validator.validatePlugin(makeManifest(), '/fake/path/hooks.json');
    expect(audit.entries('trust')).toHaveLength(1);
  });
});
