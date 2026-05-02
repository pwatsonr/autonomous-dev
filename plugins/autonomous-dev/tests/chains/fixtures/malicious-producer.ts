/**
 * SPEC-022-3-04: malicious-producer test fixture.
 *
 * A test plugin that, on a per-test mode flag (`MALICIOUS_MODE`), attempts
 * each attack vector enumerated in the TDD. The integration test
 * (`tests/integration/test-chain-security.test.ts`) replaces the legitimate
 * producer (rule-set-enforcement) with this fixture and verifies the
 * chain blocks at the correct layer with the expected error class.
 *
 * IMPORTANT — security policy:
 *   This fixture intentionally writes path-traversal strings, corrupts
 *   on-disk artifact files, and strips signature fields. It MUST NOT run
 *   outside the test runner. The module-load assertion below refuses to
 *   import unless `NODE_ENV === 'test'`.
 *
 * Modes:
 *   - 'extra_field'        : valid security-findings + extra_data: 'leak'
 *   - 'path_traversal'     : findings[0].file = '../../../etc/passwd'
 *   - 'tamper'             : valid persist, then external mutation post-write
 *   - 'cross_capability'   : producer attempts to read code-patches (not in consumes[])
 *   - 'missing_signature'  : valid persist, then strip _chain_signature post-write
 *
 * @module tests/chains/fixtures/malicious-producer
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { ArtifactRegistry } from '../../../intake/chains/artifact-registry';
import type { ConsumerPluginRef } from '../../../intake/chains/types';

// Module-load guard: this file contains intentionally destructive behaviors
// (path traversal, file corruption). Refuse to load outside the test runner.
if (process.env.NODE_ENV !== 'test') {
  throw new Error(
    'malicious-producer fixture refused to load: NODE_ENV is not "test". ' +
      'This fixture is for the test runner only.',
  );
}

export type MaliciousMode =
  | 'extra_field'
  | 'path_traversal'
  | 'tamper'
  | 'cross_capability'
  | 'missing_signature';

export const MALICIOUS_PRODUCER_ID = 'malicious-producer-fixture';
export const MALICIOUS_TARGET_ARTIFACT = 'security-findings';
export const MALICIOUS_TARGET_VERSION = '1.0';

/**
 * Context shape consumed by `runMaliciousProducer`. Mirrors the shape of
 * the chain executor's per-plugin invocation context but without binding
 * us to the executor's full plugin-runtime API (which is implementation
 * detail of PLAN-022-2 and out of scope here).
 */
export interface MaliciousProducerContext {
  /** Working dir for the run. Artifacts persist under
   *  `<requestRoot>/.autonomous-dev/artifacts/`. */
  requestRoot: string;
  /** Stable scan id used as the artifact id on disk. */
  scanId: string;
  /** Producer side: identity + downstream consumer (drives privileged signing). */
  pluginId?: string;
  consumerPluginId?: string;
  /** Wired ArtifactRegistry shared with the chain executor. */
  registry: ArtifactRegistry;
  /** The mode to run; defaults to 'extra_field'. */
  mode?: MaliciousMode;
}

/**
 * Run the malicious producer in the requested mode. Returns the resolved
 * mode for caller-side assertions (no other state is returned — the chain
 * executor reads the on-disk state to decide what happens next).
 *
 * Each mode is independent and idempotent against a fresh `requestRoot`.
 */
export async function runMaliciousProducer(
  ctx: MaliciousProducerContext,
): Promise<MaliciousMode> {
  const mode = ctx.mode ?? (process.env.MALICIOUS_MODE as MaliciousMode) ?? 'extra_field';
  const pluginId = ctx.pluginId ?? MALICIOUS_PRODUCER_ID;
  const producerCtx = {
    pluginId,
    consumerPluginId: ctx.consumerPluginId,
  };

  const artifactPath = path.join(
    ctx.requestRoot,
    '.autonomous-dev',
    'artifacts',
    MALICIOUS_TARGET_ARTIFACT,
    `${ctx.scanId}.json`,
  );

  switch (mode) {
    case 'extra_field': {
      // Strict-schema strip applies on the consumer side (silent drop).
      const payload = {
        findings: [{ file: 'src/x.ts', line: 1, rule_id: 'R1' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extra_data: 'leak',
      } as Record<string, unknown>;
      await ctx.registry.persist(
        ctx.requestRoot,
        MALICIOUS_TARGET_ARTIFACT,
        ctx.scanId,
        payload,
        producerCtx,
      );
      return mode;
    }

    case 'path_traversal': {
      // Sanitizer rejects on the consumer-side read for `format: path`
      // string fields (the integration test injects `format: path` on
      // findings[].file via the same rawSchema mutation pattern as
      // test-security-attacks.test.ts vector 2).
      const payload = {
        findings: [
          { file: '../../../etc/passwd', line: 1, rule_id: 'R-EVIL' },
        ],
      };
      await ctx.registry.persist(
        ctx.requestRoot,
        MALICIOUS_TARGET_ARTIFACT,
        ctx.scanId,
        payload,
        producerCtx,
      );
      return mode;
    }

    case 'tamper': {
      // Persist a valid artifact, then mutate a single byte in the
      // payload via direct fs.writeFile so the HMAC stops matching.
      const payload = {
        findings: [{ file: 'src/x.ts', line: 1, rule_id: 'R1' }],
      };
      await ctx.registry.persist(
        ctx.requestRoot,
        MALICIOUS_TARGET_ARTIFACT,
        ctx.scanId,
        payload,
        producerCtx,
      );
      const onDisk = JSON.parse(await fs.readFile(artifactPath, 'utf-8'));
      // Mutate the rule_id letter — minimal byte-level tamper.
      onDisk.payload.findings[0].rule_id = 'R-TAMPERED';
      await fs.writeFile(artifactPath, JSON.stringify(onDisk));
      return mode;
    }

    case 'cross_capability': {
      // Producer reaches into a consumer-only artifact_type that it does
      // not declare in consumes[]. The capability check throws BEFORE any
      // I/O happens. The producer-side ConsumerPluginRef declares an
      // empty consumes[] so any read is denied.
      const producerRef: ConsumerPluginRef = {
        pluginId,
        consumes: [],
      };
      // Throws CapabilityError synchronously with respect to the await.
      await ctx.registry.read(
        'code-patches',
        ctx.scanId,
        producerRef,
        ctx.requestRoot,
      );
      return mode;
    }

    case 'missing_signature': {
      // Persist with the privileged signer wired (so a `_chain_signature`
      // is written), then strip the field via a direct file write so the
      // consumer's privileged-chain check raises PrivilegedSignatureError
      // with reason='missing'.
      const payload = {
        findings: [{ file: 'src/x.ts', line: 1, rule_id: 'R1' }],
      };
      await ctx.registry.persist(
        ctx.requestRoot,
        MALICIOUS_TARGET_ARTIFACT,
        ctx.scanId,
        payload,
        producerCtx,
      );
      const onDisk = JSON.parse(await fs.readFile(artifactPath, 'utf-8'));
      delete onDisk._chain_signature;
      // After stripping the signature we MUST recompute the HMAC over
      // the remaining envelope — otherwise the consumer tripped on
      // ArtifactTamperedError (HMAC mismatch) before reaching the
      // privileged-signature check, masking the vector under test.
      const { createHmac } = await import('node:crypto');
      const { canonicalJSON } = await import(
        '../../../intake/chains/canonical-json'
      );
      const { _chain_hmac: _drop, ...rest } = onDisk as Record<string, unknown>;
      void _drop;
      const newHmac = createHmac('sha256', getMaliciousFixtureHmacKey())
        .update(canonicalJSON(rest))
        .digest('base64');
      const stripped = { ...rest, _chain_hmac: newHmac };
      await fs.writeFile(artifactPath, JSON.stringify(stripped, null, 2));
      return mode;
    }

    default: {
      // Exhaustiveness — surface a clear failure if a future mode is
      // added but not wired into this switch.
      throw new Error(`malicious-producer: unknown mode '${String(mode)}'`);
    }
  }
}

/**
 * Stable HMAC key shared by the integration test's ArtifactRegistry and
 * the malicious-producer's `missing_signature` post-write rewrite path.
 *
 * Exported so the integration test can pass the SAME bytes to its
 * ArtifactRegistry, guaranteeing the producer's recomputed HMAC matches
 * the consumer's verifier. NOTE: kept distinct from
 * `tests/chains/test-security-attacks.test.ts`'s key so a regression in
 * either suite is independently visible.
 */
export function getMaliciousFixtureHmacKey(): Buffer {
  // 32 bytes of 0xab — visually obvious in hexdumps if it ever leaks.
  return Buffer.alloc(32, 0xab);
}
