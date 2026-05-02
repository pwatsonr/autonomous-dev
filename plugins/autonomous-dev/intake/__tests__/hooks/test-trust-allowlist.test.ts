/**
 * TrustValidator: allowlist-mode truth table (SPEC-019-3-05).
 *
 * Allowlist mode = explicit operator opt-in only. Plugin id MUST appear in
 * `extensions.allowlist`; signature is NOT consulted; meta-review trigger is
 * orthogonal (still evaluated but unable to reject in allowlist mode unless
 * the agent spawner returns FAIL).
 *
 * The audit emitter is the in-memory variant from audit-emitter.ts so tests
 * can assert on the entries written for both pass and reject paths.
 *
 * @module __tests__/hooks/test-trust-allowlist
 */

import {
  TrustValidator,
  type AgentSpawner,
} from '../../hooks/trust-validator';
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
    trust_mode: 'allowlist',
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

/** Stub pipeline; trust-validator skeleton never calls into it. */
const STUB_PIPELINE = {} as unknown as ValidationPipeline;

/**
 * Build a TrustValidator with a recording audit emitter and a verifier
 * spy. The verifier defaults to "always reject" so allowlist-mode tests
 * can assert it was never even called.
 */
function build(
  config: ExtensionsConfig,
  opts: {
    verifyImpl?: (m: string, s: string) => Promise<boolean>;
    agentSpawner?: AgentSpawner;
  } = {},
): {
  validator: TrustValidator;
  audit: InMemoryAuditWriter;
  verifySpy: jest.Mock;
} {
  const audit = new InMemoryAuditWriter();
  const emitter = new TrustAuditEmitter(audit);
  const verifySpy = jest.fn(opts.verifyImpl ?? (async () => false));
  // Subclass SignatureVerifier so we can stub `verify` without touching
  // the file system. Allowlist mode is supposed to NEVER call this.
  const verifier = new SignatureVerifier('/nonexistent');
  (verifier as unknown as { verify: typeof verifySpy }).verify = verifySpy;
  const validator = new TrustValidator(config, STUB_PIPELINE, '/nonexistent', {
    signatureVerifier: verifier,
    auditEmitter: emitter,
    agentSpawner: opts.agentSpawner,
  });
  return { validator, audit, verifySpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrustValidator: allowlist mode truth table', () => {
  it('trusts a plugin on the allowlist', async () => {
    const { validator, audit } = build(
      makeConfig({ allowlist: ['com.acme.foo'] }),
    );
    const result = await validator.validatePlugin(
      makeManifest({ id: 'com.acme.foo' }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(true);
    expect(result.requiresMetaReview).toBe(false);

    const entries = audit.entries('trust');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      decision: 'registered',
      pluginId: 'com.acme.foo',
      pluginVersion: '1.0.0',
    });
    expect(typeof entries[0].timestamp).toBe('string');
    expect(entries[0].timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it('rejects a plugin not on the allowlist with the canonical reason', async () => {
    const { validator, audit } = build(
      makeConfig({ allowlist: ['com.acme.foo'] }),
    );
    const result = await validator.validatePlugin(
      makeManifest({ id: 'com.acme.bar' }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe('not in allowlist');

    const entries = audit.entries('trust');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      decision: 'rejected',
      pluginId: 'com.acme.bar',
      reason: 'not in allowlist',
    });
  });

  it('rejects everything when the allowlist is empty', async () => {
    const { validator, audit } = build(makeConfig({ allowlist: [] }));
    const result = await validator.validatePlugin(
      makeManifest({ id: 'com.acme.foo' }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe('not in allowlist');
    expect(audit.entries('trust')[0].decision).toBe('rejected');
  });

  it('does NOT call the signature verifier in allowlist mode', async () => {
    const { validator, verifySpy } = build(
      makeConfig({
        allowlist: ['com.acme.foo'],
        // Even with signature_verification enabled, allowlist mode ignores it.
        signature_verification: true,
      }),
    );
    await validator.validatePlugin(
      makeManifest({ id: 'com.acme.foo' }),
      '/fake/path/hooks.json',
    );
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('is case-sensitive on plugin id (no normalization)', async () => {
    const { validator } = build(makeConfig({ allowlist: ['com.acme.foo'] }));
    const result = await validator.validatePlugin(
      makeManifest({ id: 'com.acme.FOO' }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe('not in allowlist');
  });

  it('does not perform glob/prefix matching — only exact ids match', async () => {
    // Allowlist contains a literal '*' — that must NOT be treated as a
    // wildcard. This locks in the contract that allowlist comparison is
    // strict equality, not glob.
    const { validator } = build(
      makeConfig({ allowlist: ['com.acme.*', 'com.acme.bar'] }),
    );
    const fooResult = await validator.validatePlugin(
      makeManifest({ id: 'com.acme.foo' }),
      '/fake/path/hooks.json',
    );
    expect(fooResult.trusted).toBe(false);

    const barResult = await validator.validatePlugin(
      makeManifest({ id: 'com.acme.bar' }),
      '/fake/path/hooks.json',
    );
    expect(barResult.trusted).toBe(true);

    // The literal '*' entry should match a plugin with id '*' (also exact).
    const literalStarResult = await validator.validatePlugin(
      makeManifest({ id: 'com.acme.*' }),
      '/fake/path/hooks.json',
    );
    expect(literalStarResult.trusted).toBe(true);
  });

  it('emits exactly one audit entry per validatePlugin call (pass path)', async () => {
    const { validator, audit } = build(
      makeConfig({ allowlist: ['com.acme.foo'] }),
    );
    await validator.validatePlugin(
      makeManifest({ id: 'com.acme.foo' }),
      '/fake/path/hooks.json',
    );
    expect(audit.entries('trust')).toHaveLength(1);
  });

  it('emits exactly one audit entry per validatePlugin call (reject path)', async () => {
    const { validator, audit } = build(
      makeConfig({ allowlist: ['com.acme.foo'] }),
    );
    await validator.validatePlugin(
      makeManifest({ id: 'not.in.list' }),
      '/fake/path/hooks.json',
    );
    expect(audit.entries('trust')).toHaveLength(1);
  });

  it('isTrusted reflects the allowlist after construction', () => {
    const { validator } = build(
      makeConfig({ allowlist: ['com.acme.foo', 'com.acme.bar'] }),
    );
    expect(validator.isTrusted('com.acme.foo')).toBe(true);
    expect(validator.isTrusted('com.acme.bar')).toBe(true);
    expect(validator.isTrusted('com.acme.baz')).toBe(false);
  });
});
