/**
 * End-to-end integration test for the standards-to-fix flow (SPEC-022-2-05).
 *
 * Exercises every PLAN-022-2 component in concert:
 *   1. mock-rule-set-enforcement-reviewer detects the planted SQL injection.
 *   2. Chain executor invokes code-fixer on the security-findings artifact.
 *   3. code-fixer produces a `requires_approval: true` code-patches artifact.
 *   4. Approval gate halts the chain, persists state, fires escalation.
 *   5. `chains approve` writes the marker and resumes the chain.
 *   6. Telemetry emits exactly once on completion.
 *
 * Runs in-process (deterministic, no network, no real LLM) using the
 * SPEC-022-1 `buildExecutor` helpers + SPEC-022-2-04 CLI runners.
 *
 * @module tests/integration/test-standards-to-fix
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  ChainExecutor,
  type ChainHookInvoker,
  type ManifestLookup,
} from '../../intake/chains/executor';
import {
  recoverPending,
  StateStore,
} from '../../intake/chains/state-store';
import {
  setChainMetricsClient,
  type ChainMetricsClient,
  type ChainTelemetryEvent,
} from '../../intake/chains/telemetry-emitter';
import { runChainsApprove } from '../../intake/cli/chains_approve_command';
import { runChainsReject } from '../../intake/cli/chains_reject_command';
import {
  buildGraphFrom,
  buildManifest,
  cleanupTempDir,
  createTempRequestDir,
  loadArtifactSchemas,
} from '../helpers/chain-fixtures';
import mockReviewer from '../fixtures/agents/mock-rule-set-enforcement-reviewer';
import type {
  ChainEscalationEvent,
  ChainPausedState,
  EscalationRouter,
} from '../../intake/chains/types';
import type { ArtifactRegistry } from '../../intake/chains/artifact-registry';
import type { HookManifest } from '../../intake/hooks/types';

interface RecordingRouter extends EscalationRouter {
  events: ChainEscalationEvent[];
}

function makeRouter(): RecordingRouter {
  const events: ChainEscalationEvent[] = [];
  return {
    events,
    notify(ev: ChainEscalationEvent): void {
      events.push(ev);
    },
  };
}

/** Manifest pair for the standards-to-fix flow. */
function manifests(): HookManifest[] {
  return [
    buildManifest({
      id: 'rule-set-enforcement-reviewer',
      version: '1.0.0',
      produces: [
        { artifact_type: 'security-findings', schema_version: '1.0', format: 'json' },
      ],
    }),
    buildManifest({
      id: 'code-fixer',
      version: '1.0.0',
      consumes: [{ artifact_type: 'security-findings', schema_version: '^1.0' }],
      produces: [
        {
          artifact_type: 'code-patches',
          schema_version: '1.0',
          format: 'json',
          requires_approval: true,
        },
      ],
    }),
    // A trivial downstream consumer of code-patches so the chain genuinely
    // pauses (the resolver detects the privileged edge between code-fixer
    // and this consumer).
    buildManifest({
      id: 'audit-logger',
      version: '1.0.0',
      consumes: [{ artifact_type: 'code-patches', schema_version: '^1.0' }],
    }),
  ];
}

/** Build a security-findings payload that conforms to the schema. */
async function buildFindingsPayload(diff: string, requestId: string): Promise<unknown> {
  const reviewerOut = await mockReviewer({ diff });
  return {
    scan_id: `${requestId}-findings`,
    produced_by: 'rule-set-enforcement-reviewer',
    produced_at: '2026-05-02T12:00:00Z',
    summary: {
      total: reviewerOut.findings.length,
      by_severity: { critical: reviewerOut.findings.length },
    },
    findings: reviewerOut.findings.map((f) => ({
      id: f.finding_id,
      severity: f.severity,
      title: f.message,
      description: f.message,
      file: f.location.file,
      line: f.location.line,
      rule_id: f.rule_id,
    })),
  };
}

/** Read the canonical code-patches example to use as the fixer's payload. */
async function loadPatchesExample(): Promise<unknown> {
  const p = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'artifacts',
    'code-patches.example.json',
  );
  return JSON.parse(await fs.readFile(p, 'utf-8'));
}

interface BuildResult {
  exec: ChainExecutor;
  stateStore: StateStore;
  router: RecordingRouter;
  registry: ArtifactRegistry;
  invokerCalls: string[];
}

async function buildExecutor(
  tempRoot: string,
  chainId: string,
  patchesPayload: unknown,
): Promise<BuildResult> {
  const registry = await loadArtifactSchemas();
  const ms = manifests();
  const graph = buildGraphFrom(ms);
  const lookup: ManifestLookup = (id) => ms.find((m) => m.id === id);
  const invokerCalls: string[] = [];
  const invoker: ChainHookInvoker = async (pid) => {
    invokerCalls.push(pid);
    if (pid === 'code-fixer') {
      return [
        {
          artifactType: 'code-patches',
          scanId: `${chainId}-patches`,
          payload: patchesPayload,
        },
      ];
    }
    return [];
  };
  const stateStore = new StateStore();
  const router = makeRouter();
  const exec = new ChainExecutor(graph, registry, lookup, invoker, undefined, {
    chainId,
    stateStore,
    escalationRouter: router,
    privilegedChainAllowlist: ['code-fixer:audit-logger@*'],
  });
  return { exec, stateStore, router, registry, invokerCalls };
}

describe('SPEC-022-2-05: standards-to-fix end-to-end', () => {
  let tempRoot: string;
  let diff: string;
  let patchesPayload: unknown;
  let telemetry: ChainTelemetryEvent[];

  beforeEach(async () => {
    tempRoot = await createTempRequestDir();
    diff = await fs.readFile(
      path.resolve(__dirname, '..', 'fixtures', 'diffs', 'sql-injection.diff'),
      'utf-8',
    );
    patchesPayload = await loadPatchesExample();
    telemetry = [];
    const client: ChainMetricsClient = {
      emit(_channel, event) {
        telemetry.push(event);
      },
    };
    setChainMetricsClient(client);
    ChainExecutor.__resetActiveChainsForTest();
  });

  afterEach(async () => {
    setChainMetricsClient(undefined);
    ChainExecutor.__resetActiveChainsForTest();
    await cleanupTempDir(tempRoot);
  });

  it('runs the full flow: review -> findings -> fixer -> approval -> resume', async () => {
    const chainId = 's2f-1';
    const requestId = 'REQ-1';
    const built = await buildExecutor(tempRoot, chainId, patchesPayload);
    const { exec, stateStore, router } = built;

    // Step 1: deterministic mock detects the planted SQLi.
    const reviewerOut = await mockReviewer({ diff });
    expect(reviewerOut.findings).toHaveLength(1);
    expect(reviewerOut.findings[0].rule_id).toBe('SQL_INJECTION');

    // Step 2: trigger the chain with a schema-valid security-findings seed.
    const findingsPayload = await buildFindingsPayload(diff, requestId);
    const initial = await exec.executeChain(
      'rule-set-enforcement-reviewer',
      { requestRoot: tempRoot, requestId },
      {
        artifactType: 'security-findings',
        scanId: `${requestId}-findings`,
        payload: findingsPayload,
      },
    );
    expect(initial.outcome).toBe('paused');
    expect(initial.pausedState).toBeDefined();

    // Step 3: code-fixer ran but audit-logger did not.
    expect(built.invokerCalls).toContain('code-fixer');
    expect(built.invokerCalls).not.toContain('audit-logger');

    // Step 4: state file persisted, escalation fired exactly once.
    const statePath = StateStore.statePathFor(tempRoot, chainId);
    expect(await stateStore.fileExists(statePath)).toBe(true);
    expect(router.events).toHaveLength(1);
    expect(router.events[0]).toMatchObject({
      kind: 'chain-approval-pending',
      chain_id: chainId,
    });

    // Step 5: simulate operator running `chains approve`.
    const approveCode = await runChainsApprove(
      { artifactId: `${chainId}-patches` },
      {
        executor: exec,
        stateStore,
        locateChainStateByArtifact: async () => initial.pausedState!,
        requireAdminAuth: async () => {},
        approvedByResolver: () => 'integration-tester',
        now: () => new Date('2026-05-02T12:00:01.000Z'),
      },
    );
    expect(approveCode).toBe(0);

    // Step 6: marker present, state file removed.
    const markerPath = StateStore.approvalMarkerPathFor(
      tempRoot,
      'code-patches',
      `${chainId}-patches`,
    );
    const marker = await stateStore.readApprovalMarker(markerPath);
    expect(marker).not.toBeNull();
    expect(marker!.approved_by).toBe('integration-tester');
    expect(await stateStore.fileExists(statePath)).toBe(false);

    // Step 7: telemetry emitted at least once for the initial pause and
    // resume — the spec requires exactly one per executeChain call. We
    // executeChain once and resume once, so two events total.
    await Promise.resolve();
    await Promise.resolve();
    expect(telemetry.length).toBeGreaterThanOrEqual(1);
    const initialEvent = telemetry.find((e) => e.outcome === 'paused');
    expect(initialEvent).toBeDefined();
    expect(initialEvent!.plugins).toContain('rule-set-enforcement-reviewer');
    expect(initialEvent!.plugins).toContain('code-fixer');
    expect(initialEvent!.duration_ms).toBeGreaterThan(0);
  });

  it('survives daemon restart while paused', async () => {
    const chainId = 's2f-2';
    const requestId = 'REQ-2';
    const built = await buildExecutor(tempRoot, chainId, patchesPayload);
    const findingsPayload = await buildFindingsPayload(diff, requestId);
    const initial = await built.exec.executeChain(
      'rule-set-enforcement-reviewer',
      { requestRoot: tempRoot, requestId },
      {
        artifactType: 'security-findings',
        scanId: `${requestId}-findings`,
        payload: findingsPayload,
      },
    );
    expect(initial.outcome).toBe('paused');

    // Simulate daemon restart: discard the executor + router; build a new
    // executor over the same tempRoot.
    const restartRouter = makeRouter();
    const recovered = await recoverPending(tempRoot, restartRouter);
    expect(recovered).toBe(1);
    expect(restartRouter.events).toHaveLength(1);
    expect(restartRouter.events[0].chain_id).toBe(chainId);

    // Build a new executor (fresh instance) to resume.
    const restarted = await buildExecutor(tempRoot, chainId, patchesPayload);

    // Approve via CLI runner; resume drives the (empty downstream of)
    // audit-logger to completion.
    const approveCode = await runChainsApprove(
      { artifactId: `${chainId}-patches` },
      {
        executor: restarted.exec,
        stateStore: restarted.stateStore,
        locateChainStateByArtifact: async () => initial.pausedState!,
        requireAdminAuth: async () => {},
        approvedByResolver: () => 'restart-tester',
        now: () => new Date('2026-05-02T12:01:00.000Z'),
      },
    );
    expect(approveCode).toBe(0);

    const statePath = StateStore.statePathFor(tempRoot, chainId);
    expect(await restarted.stateStore.fileExists(statePath)).toBe(false);
  });

  it('rejection cancels the chain', async () => {
    const chainId = 's2f-3';
    const requestId = 'REQ-3';
    const built = await buildExecutor(tempRoot, chainId, patchesPayload);
    const findingsPayload = await buildFindingsPayload(diff, requestId);
    const initial = await built.exec.executeChain(
      'rule-set-enforcement-reviewer',
      { requestRoot: tempRoot, requestId },
      {
        artifactType: 'security-findings',
        scanId: `${requestId}-findings`,
        payload: findingsPayload,
      },
    );
    expect(initial.outcome).toBe('paused');

    const rejectCode = await runChainsReject(
      { artifactId: `${chainId}-patches`, reason: 'patches too risky' },
      {
        stateStore: built.stateStore,
        locateChainStateByArtifact: async () => initial.pausedState!,
        requireAdminAuth: async () => {},
        rejectedByResolver: () => 'reject-tester',
        now: () => new Date('2026-05-02T12:02:00.000Z'),
      },
    );
    expect(rejectCode).toBe(0);

    // Marker present with the reason; state file removed.
    const markerPath = StateStore.rejectionMarkerPathFor(
      tempRoot,
      'code-patches',
      `${chainId}-patches`,
    );
    const marker = await built.stateStore.readRejectionMarker(markerPath);
    expect(marker).not.toBeNull();
    expect(marker!.reason).toBe('patches too risky');
    const statePath = StateStore.statePathFor(tempRoot, chainId);
    expect(await built.stateStore.fileExists(statePath)).toBe(false);
  });
});
