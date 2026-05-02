/**
 * TrustValidator: strict-mode truth table (SPEC-019-3-05).
 *
 * Strict mode = allowlist AND valid signature both required, PLUS the
 * privileged-reviewer arm: any plugin declaring a `code-review` or
 * `security-review` reviewer slot MUST also appear on
 * `extensions.privileged_reviewers`.
 *
 * The truth table is the cartesian product of four binary axes:
 *   - allowlisted ∈ {yes, no}
 *   - signed ∈ {yes, no}
 *   - declares-privileged-slot ∈ {yes, no}
 *   - in-privileged-reviewers ∈ {yes, no}
 *
 * That is 16 rows. The expected verdict is determined by the first
 * failing step in the seven-step pipeline (allowlist → signature →
 * capability/privileged-reviewer). The privileged-reviewer arm only
 * fires when the plugin is *also* allowlisted AND signed (later step).
 *
 * Each row asserts the trusted bool, the canonical reason string (when
 * rejected), and the audit-emitter's recorded decision.
 *
 * @module __tests__/hooks/test-trust-strict
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

const PLUGIN_ID = 'com.acme.foo';

function makeConfig(over: Partial<ExtensionsConfig> = {}): ExtensionsConfig {
  return {
    allowlist: [],
    privileged_reviewers: [],
    trust_mode: 'strict',
    signature_verification: true,
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
    id: PLUGIN_ID,
    name: 'Acme Foo',
    version: '1.0.0',
    hooks: [
      {
        // Use a non-critical hook point + warn so meta-review trigger
        // conditions (#5 + #6) stay quiet for the baseline cases.
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

/**
 * The agent spawner is wired with a fixed PASS verdict so any plugin
 * that triggers meta-review (e.g. via the privileged reviewer slot) is
 * not gated by it — the strict-mode truth table is about the explicit
 * gates, not about meta-review.
 */
const PASSING_AGENT: AgentSpawner = {
  invoke: async () => ({ pass: true, findings: [] }),
};

function build(
  config: ExtensionsConfig,
  signed: boolean,
): {
  validator: TrustValidator;
  audit: InMemoryAuditWriter;
  verifySpy: jest.Mock;
} {
  const audit = new InMemoryAuditWriter();
  const emitter = new TrustAuditEmitter(audit);
  const verifySpy = jest.fn(async () => signed);
  const verifier = new SignatureVerifier('/nonexistent');
  (verifier as unknown as { verify: typeof verifySpy }).verify = verifySpy;
  const validator = new TrustValidator(config, STUB_PIPELINE, '/nonexistent', {
    signatureVerifier: verifier,
    auditEmitter: emitter,
    agentSpawner: PASSING_AGENT,
  });
  return { validator, audit, verifySpy };
}

// ---------------------------------------------------------------------------
// 16-row truth table
// ---------------------------------------------------------------------------

interface Row {
  allowlisted: boolean;
  signed: boolean;
  privSlot: boolean;
  inPrivReviewers: boolean;
  /** Expected outcome. */
  trusted: boolean;
  /** Expected canonical reason (when rejected). */
  reason?: string;
}

/**
 * Step ordering (TDD-019 §10.2): allowlist → signature → capability arm.
 * The first failure short-circuits, so the expected reason follows that
 * order.
 */
const ROWS: Row[] = [
  // --- not allowlisted: always rejected at allowlist step ---
  { allowlisted: false, signed: false, privSlot: false, inPrivReviewers: false, trusted: false, reason: 'strict mode: plugin not in allowlist' },
  { allowlisted: false, signed: false, privSlot: false, inPrivReviewers: true,  trusted: false, reason: 'strict mode: plugin not in allowlist' },
  { allowlisted: false, signed: false, privSlot: true,  inPrivReviewers: false, trusted: false, reason: 'strict mode: plugin not in allowlist' },
  { allowlisted: false, signed: false, privSlot: true,  inPrivReviewers: true,  trusted: false, reason: 'strict mode: plugin not in allowlist' },
  { allowlisted: false, signed: true,  privSlot: false, inPrivReviewers: false, trusted: false, reason: 'strict mode: plugin not in allowlist' },
  { allowlisted: false, signed: true,  privSlot: false, inPrivReviewers: true,  trusted: false, reason: 'strict mode: plugin not in allowlist' },
  { allowlisted: false, signed: true,  privSlot: true,  inPrivReviewers: false, trusted: false, reason: 'strict mode: plugin not in allowlist' },
  { allowlisted: false, signed: true,  privSlot: true,  inPrivReviewers: true,  trusted: false, reason: 'strict mode: plugin not in allowlist' },

  // --- allowlisted, unsigned: rejected at signature step ---
  { allowlisted: true,  signed: false, privSlot: false, inPrivReviewers: false, trusted: false, reason: 'strict mode: missing or invalid signature' },
  { allowlisted: true,  signed: false, privSlot: false, inPrivReviewers: true,  trusted: false, reason: 'strict mode: missing or invalid signature' },
  { allowlisted: true,  signed: false, privSlot: true,  inPrivReviewers: false, trusted: false, reason: 'strict mode: missing or invalid signature' },
  { allowlisted: true,  signed: false, privSlot: true,  inPrivReviewers: true,  trusted: false, reason: 'strict mode: missing or invalid signature' },

  // --- allowlisted + signed, no privileged slot: trusted regardless of priv list ---
  { allowlisted: true,  signed: true,  privSlot: false, inPrivReviewers: false, trusted: true },
  { allowlisted: true,  signed: true,  privSlot: false, inPrivReviewers: true,  trusted: true },

  // --- allowlisted + signed + privileged slot: gated on priv-reviewers list ---
  { allowlisted: true,  signed: true,  privSlot: true,  inPrivReviewers: false, trusted: false, reason: 'strict mode: privileged reviewer not in privileged_reviewers list' },
  { allowlisted: true,  signed: true,  privSlot: true,  inPrivReviewers: true,  trusted: true },
];

function describeRow(r: Row): string {
  return [
    r.allowlisted ? 'allow=Y' : 'allow=N',
    r.signed ? 'sig=Y' : 'sig=N',
    r.privSlot ? 'slot=Y' : 'slot=N',
    r.inPrivReviewers ? 'prl=Y' : 'prl=N',
    '->',
    r.trusted ? 'TRUST' : `REJECT(${r.reason ?? '?'})`,
  ].join(' ');
}

describe('TrustValidator: strict mode truth table (16 rows)', () => {
  for (const row of ROWS) {
    it(describeRow(row), async () => {
      const config = makeConfig({
        allowlist: row.allowlisted ? [PLUGIN_ID] : [],
        privileged_reviewers: row.inPrivReviewers ? [PLUGIN_ID] : [],
      });
      const manifest = makeManifest({
        reviewer_slots: row.privSlot ? ['code-review'] : [],
      });

      const { validator, audit } = build(config, row.signed);
      const result = await validator.validatePlugin(
        manifest,
        '/fake/path/hooks.json',
      );

      expect(result.trusted).toBe(row.trusted);
      if (!row.trusted) {
        expect(result.reason).toBe(row.reason);
      }

      // Audit-emission contract: exactly one entry per validatePlugin
      // call, and its decision matches the verdict. (Meta-review may
      // emit an extra entry — covered separately below.)
      const entries = audit.entries('trust');
      const decisionEntries = entries.filter(
        (e) =>
          e.decision === 'registered' || e.decision === 'rejected',
      );
      expect(decisionEntries).toHaveLength(1);
      expect(decisionEntries[0].decision).toBe(
        row.trusted ? 'registered' : 'rejected',
      );
      if (!row.trusted) {
        expect(decisionEntries[0].reason).toBe(row.reason);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Privileged-reviewer-arm scoping
// ---------------------------------------------------------------------------

describe('TrustValidator: privileged-reviewer arm scoping', () => {
  it('does NOT fire in allowlist mode (privileged slot off-list still trusted)', async () => {
    const { validator } = build(
      makeConfig({
        trust_mode: 'allowlist',
        allowlist: [PLUGIN_ID],
        privileged_reviewers: [], // not on the list
        signature_verification: false,
      }),
      true,
    );
    const result = await validator.validatePlugin(
      makeManifest({ reviewer_slots: ['code-review'] }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(true);
  });

  it('does NOT fire in permissive mode (privileged slot off-list still trusted)', async () => {
    const { validator } = build(
      makeConfig({
        trust_mode: 'permissive',
        allowlist: [], // permissive ignores allowlist
        privileged_reviewers: [],
        signature_verification: false,
      }),
      true,
    );
    const result = await validator.validatePlugin(
      makeManifest({ reviewer_slots: ['security-review'] }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(true);
  });

  it('treats `security-review` slot identically to `code-review`', async () => {
    const { validator } = build(
      makeConfig({
        allowlist: [PLUGIN_ID],
        privileged_reviewers: [], // not on the list
      }),
      true,
    );
    const result = await validator.validatePlugin(
      makeManifest({ reviewer_slots: ['security-review'] }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe(
      'strict mode: privileged reviewer not in privileged_reviewers list',
    );
  });

  it('non-privileged reviewer slots do not trigger the arm', async () => {
    const { validator } = build(
      makeConfig({
        allowlist: [PLUGIN_ID],
        privileged_reviewers: [],
      }),
      true,
    );
    const result = await validator.validatePlugin(
      // 'doc-review' is not a privileged slot.
      makeManifest({ reviewer_slots: ['doc-review'] }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Meta-review verdict emission (privileged-slot triggers meta-review)
// ---------------------------------------------------------------------------

describe('TrustValidator: meta-review verdict emission in strict mode', () => {
  it('emits a meta-review-verdict entry IN ADDITION to registered when the agent runs', async () => {
    // Fully-trusted privileged plugin: passes allowlist + signature + priv
    // arm; but the privileged reviewer slot triggers meta-review, which
    // returns PASS via PASSING_AGENT.
    const { validator, audit } = build(
      makeConfig({
        allowlist: [PLUGIN_ID],
        privileged_reviewers: [PLUGIN_ID],
      }),
      true,
    );
    const result = await validator.validatePlugin(
      makeManifest({ reviewer_slots: ['code-review'] }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(true);

    const entries = audit.entries('trust');
    expect(entries.map((e) => e.decision).sort()).toEqual(
      ['meta-review-verdict', 'registered'].sort(),
    );

    const metaEntry = entries.find(
      (e) => e.decision === 'meta-review-verdict',
    );
    expect(metaEntry).toBeDefined();
    expect(metaEntry?.metaReviewVerdict).toEqual({
      pass: true,
      findings: [],
    });

    const registered = entries.find((e) => e.decision === 'registered');
    expect(registered?.metaReviewVerdict).toEqual({
      pass: true,
      findings: [],
    });
  });

  it('failing meta-review verdict produces a rejected entry referencing the findings', async () => {
    const failingAgent: AgentSpawner = {
      invoke: async () => ({
        pass: false,
        findings: ['unsafe network capability'],
      }),
    };
    const audit = new InMemoryAuditWriter();
    const emitter = new TrustAuditEmitter(audit);
    const verifier = new SignatureVerifier('/nonexistent');
    (verifier as unknown as { verify: jest.Mock }).verify = jest.fn(
      async () => true,
    );
    const validator = new TrustValidator(
      makeConfig({
        allowlist: [PLUGIN_ID],
        privileged_reviewers: [PLUGIN_ID],
      }),
      STUB_PIPELINE,
      '/nonexistent',
      {
        signatureVerifier: verifier,
        auditEmitter: emitter,
        agentSpawner: failingAgent,
      },
    );

    const result = await validator.validatePlugin(
      makeManifest({ reviewer_slots: ['code-review'] }),
      '/fake/path/hooks.json',
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe(
      'meta-review FAIL: unsafe network capability',
    );

    const entries = audit.entries('trust');
    expect(entries).toHaveLength(2);
    const meta = entries.find((e) => e.decision === 'meta-review-verdict');
    expect(meta?.metaReviewVerdict).toEqual({
      pass: false,
      findings: ['unsafe network capability'],
    });
    const rejected = entries.find((e) => e.decision === 'rejected');
    expect(rejected?.reason).toBe('meta-review FAIL: unsafe network capability');
  });
});
