/**
 * TASK-012 / TASK-014 — Scan orchestrator for the self-improvement loop.
 *
 * `scanEnrolledRepos` is the main entry point called once per watch-tick.
 * It iterates enrolled repos, fetches open actionable issues, runs the
 * guard pipeline, submits fix requests, and reconciles the ledger.
 *
 * NFR-RELIABILITY-01: this function NEVER propagates exceptions. All
 * uncaught errors are emitted as `self_improve_error` events and the
 * function always resolves with a partial `ScanResult`.
 *
 * @module intake/triggers/self_improve/scan
 */

import type { SelfImproveConfig } from './config';
import { readSelfImproveConfig } from './config';
import type { LedgerIO } from './ledger';
import { loadLedger, saveLedger, makeReader, makeMutator, toHourKey } from './ledger';
import type { GhIssueClient } from './gh_issues';
import type { EvidenceDeps, Ownership } from './evidence';
import { checkEvidence } from './evidence';
import type { SubmitDeps } from './submit';
import { submitFromIssue } from './submit';
import type { EventEmitter } from './events';
import { createEmitter } from './events';
import { classify } from './actionable';
import { evaluateGuards } from './guards';
import type { GuardId } from './guards';
import { DETECTED_LABELS } from './labels';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Aggregated result of one scan pass. */
export interface ScanResult {
  scanned: number;
  submitted: number;
  skipped: Record<GuardId, number>;
  errors: number;
}

/** Full dependency bundle for `scanEnrolledRepos`. */
export interface SelfImproveDeps {
  config: SelfImproveConfig;
  ownership: Ownership;
  ledgerIO: LedgerIO;
  gh: GhIssueClient;
  evidence: EvidenceDeps;
  submit: SubmitDeps;
  emit: EventEmitter;
  fnRegistry: Set<string>;
  now: () => number;
  /** Optional: read the current status of an in-flight request. */
  readRequestStatus?: (id: string) => Promise<'active' | 'terminal' | null>;
  /** Optional: read the final cost of a completed request. */
  readRequestCost?: (id: string) => Promise<number>;
  /** Optional: cancel an orphaned request. */
  requestCancel?: (id: string, reason: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default deps builder
// ---------------------------------------------------------------------------

/**
 * Build production-ready `SelfImproveDeps` from the real environment.
 *
 * Returns `null` when `AUTONOMOUS_DEV_SELF_IMPROVE !== '1'` so callers can
 * skip the scan without wiring any deps.
 *
 * @returns A `SelfImproveDeps` bundle, or `null` when disabled.
 */
export function buildDefaultSelfImproveDeps(): SelfImproveDeps | null {
  const cfg = readSelfImproveConfig(process.env);
  if (!cfg.enabled) return null;

  // Lazy imports — keep heavy modules out of the critical path for tests
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { execFile } = require('child_process') as typeof import('child_process');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { promisify } = require('util') as typeof import('util');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto') as typeof import('crypto');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { readOwnership } = require('../../../src/ownership/store') as typeof import('../../../src/ownership/store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { ghIssueClient } = require('./gh_issues') as typeof import('./gh_issues');

  const execFileAsync = promisify(execFile);

  const ghExec = async (cmd: string, args: string[]) => {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 20_000 });
      return { stdout, ok: true };
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout ?? '';
      return { stdout, ok: false };
    }
  };

  const rawOwnership = readOwnership();
  const ownership: Ownership = {
    repos: rawOwnership.repos.map((r) => ({
      repoId: r.id,
      path: r.path ?? '',
      enrolled: r.participate_in_auto_improvement === true,
    })),
  };

  const ledgerIO: LedgerIO = {
    homedir: () => nodeOs.homedir(),
    readFile: (p) => (nodeFs.existsSync(p) ? nodeFs.readFileSync(p, 'utf-8') : undefined),
    writeFile: (p, data) => {
      nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true });
      nodeFs.writeFileSync(p, data, { encoding: 'utf-8', mode: 0o600 });
    },
    mkdirp: (p, mode) => nodeFs.mkdirSync(p, { recursive: true, mode }),
    chmod: (p, mode) => nodeFs.chmodSync(p, mode),
    openExclusive: (p) => nodeFs.openSync(p, nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY),
    closeAndUnlink: (fd, p) => {
      if (fd >= 0) try { nodeFs.closeSync(fd); } catch { /* ignore */ }
      try { nodeFs.unlinkSync(p); } catch { /* ignore */ }
    },
    statMtimeMs: (p) => {
      try { return nodeFs.statSync(p).mtimeMs; } catch { return null; }
    },
    now: () => Date.now(),
    randSuffix: () => `${process.pid}.${nodeCrypto.randomBytes(4).toString('hex')}`,
  };

  const auditPath = nodePath.join(nodeOs.homedir(), '.autonomous-dev', 'audit.log');

  const auditFn = (record: object) => {
    try {
      nodeFs.mkdirSync(nodePath.dirname(auditPath), { recursive: true });
      nodeFs.appendFileSync(auditPath, JSON.stringify(record) + '\n');
    } catch {
      // best-effort
    }
  };

  const emit = createEmitter({ audit: auditFn, now: () => Date.now() });

  const evidenceDeps: EvidenceDeps = {
    readState: async (repoPath, requestId) => {
      try {
        const p = nodePath.join(repoPath, '.autonomous-dev', 'requests', requestId, 'state.json');
        if (!nodeFs.existsSync(p)) return null;
        return JSON.parse(nodeFs.readFileSync(p, 'utf-8')) as { status?: unknown };
      } catch {
        return null;
      }
    },
    fetchIssueEvents: async (repoId, issueNumber) => {
      return ghIssueClient(ghExec).getEvents(repoId, issueNumber);
    },
    timeoutMs: cfg.evidenceTimeoutMs,
    botLogin: cfg.botLogin,
  };

  // Load false-negative registry
  let fnRegistry = new Set<string>();
  if (cfg.fnRegistryPath) {
    try {
      const raw = nodeFs.readFileSync(cfg.fnRegistryPath, 'utf-8');
      const parsed = JSON.parse(raw) as { entries?: Array<{ fingerprint?: string }> };
      if (parsed?.entries) {
        fnRegistry = new Set(
          parsed.entries.map((e) => e.fingerprint ?? '').filter(Boolean),
        );
      }
    } catch {
      // Missing or corrupt registry → empty set (not an error per spec)
    }
  }

  const gh = ghIssueClient(ghExec);

  // Submit deps — for buildDefaultSelfImproveDeps, requestSubmit is wired
  // through the cli_adapter_entry routerProvider
  const submitDeps: SubmitDeps = {
    requestSubmit: async (input) => {
      // Dynamically import to avoid circular deps in tests
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const entry = require('../../adapters/cli_adapter_entry') as
        typeof import('../../adapters/cli_adapter_entry');
      const router = await entry.routerProvider();
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const { buildCommand } = require('../../adapters/cli_adapter') as
        typeof import('../../adapters/cli_adapter');
      const cmd = buildCommand('submit', {
        description: input.description,
        repo: input.repo,
        priority: input.priority,
        type: input.type,
      });
      const result = await router.route(cmd);
      if (!result.success) throw new Error(result.error ?? 'submit failed');
      const data = result.data as { requestId?: string; id?: string } | undefined;
      const requestId = data?.requestId ?? data?.id ?? 'UNKNOWN';
      return { requestId };
    },
    postGithubComment: async (repoId, issueNumber, body) => {
      await gh.comment(repoId, issueNumber, body);
    },
    ledger: makeMutator(
      { version: 1, entries: {}, windowCosts: {} },
      cfg,
      Date.now(),
    ),
    emit,
    now: () => Date.now(),
    resolveRepoPath: (repoId) => {
      return ownership.repos.find((r) => r.repoId === repoId)?.path ?? repoId;
    },
  };

  return {
    config: cfg,
    ownership,
    ledgerIO,
    gh,
    evidence: evidenceDeps,
    submit: submitDeps,
    emit,
    fnRegistry,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Run one self-improvement scan pass over all enrolled repos.
 *
 * NFR-RELIABILITY-01: never propagates exceptions. All errors are emitted
 * as `self_improve_error` events and a partial `ScanResult` is returned.
 *
 * @param deps - All scan dependencies.
 * @param now - Clock function (epoch ms).
 * @returns A `ScanResult` summary of the scan pass.
 */
export async function scanEnrolledRepos(
  deps: SelfImproveDeps,
  now: () => number,
): Promise<ScanResult> {
  const result: ScanResult = {
    scanned: 0,
    submitted: 0,
    skipped: {} as Record<GuardId, number>,
    errors: 0,
  };

  // Step 1: check global kill-switch
  if (!deps.config.enabled) {
    deps.emit({
      type: 'self_improve_disabled',
      ts: new Date(now()).toISOString(),
    });
    return result;
  }

  // Step 2: emit config warnings
  for (const w of deps.config.configWarnings) {
    deps.emit({
      type: 'self_improve_config_invalid',
      ts: new Date(now()).toISOString(),
      envVar: w.envVar,
      raw: w.raw,
      fallback: w.fallback,
    });
  }

  // Step 3: load ledger
  const ledgerFile = loadLedger(deps.ledgerIO);
  for (const w of ledgerFile.loadWarnings ?? []) {
    deps.emit({
      type: 'self_improve_error',
      ts: new Date(now()).toISOString(),
      error: `Ledger corrupt; started with empty state. raw: ${w.raw}`,
      code: 'LEDGER_CORRUPT',
    });
    result.errors += 1;
  }

  const mutator = makeMutator(ledgerFile, deps.config, now());
  const reader = makeReader(ledgerFile, deps.config, now());

  // Step 4: wrap remaining body in top-level catch (NFR-RELIABILITY-01)
  try {
    // Step 5: reconciler pass — resolve in-flight requests
    const inFlightEntries = Object.entries(ledgerFile.entries).filter(
      ([, e]) => e.status === 'in_flight',
    );
    for (const [key, entry] of inFlightEntries) {
      if (!deps.readRequestStatus) continue;
      const lastReqId = entry.requestIds[entry.requestIds.length - 1];
      if (!lastReqId) continue;
      try {
        const status = await deps.readRequestStatus(lastReqId);
        if (status === 'terminal') {
          let costUsd = 0;
          if (deps.readRequestCost) {
            try {
              costUsd = await deps.readRequestCost(lastReqId);
            } catch {
              // cost read failure → 0
            }
          }
          mutator.recordOutcome(
            key,
            entry.lastOutcome === 'failed' || entry.lastOutcome === 'cancelled'
              ? entry.lastOutcome
              : 'success',
            costUsd,
          );
          // Re-create reader to pick up the new counts after reconciliation
          // (we mutate the shared ledgerFile object in place)
        }
      } catch (err) {
        deps.emit({
          type: 'self_improve_error',
          ts: new Date(now()).toISOString(),
          error: err instanceof Error ? err.message : String(err),
          code: 'SUBMIT_PARTIAL',
        });
        result.errors += 1;
      }
    }

    // Step 6: iterate enrolled repos
    const enrolledRepos = deps.ownership.repos.filter((r) => r.enrolled);
    let tickSubmittedSoFar = 0;
    const openIssueKeys = new Set<string>();

    // Capture a pre-tick concurrency/cost snapshot (after the reconcile pass
    // above but before any new submissions). GD4/GD5/GD6/GD7 should count only
    // requests that were in-flight BEFORE this tick; within one tick the
    // per-tick cap GD11 is the limiting factor. The per-issue NA2 dedup still
    // uses a live reader so we never double-submit the same key in one tick.
    const preTick = makeReader(ledgerFile, deps.config, now());
    const preConcurrencyGlobal = preTick.countActiveGlobal();
    const preCostLast24h = preTick.costLast24h();
    const preCostLast7d = preTick.costLast7d();

    for (const repo of enrolledRepos) {
      // Per-tick submission cap check (stop querying more repos if at cap)
      if (tickSubmittedSoFar >= deps.config.maxIssuesPerTick) break;

      // Fetch open issues
      let listResult: Awaited<ReturnType<GhIssueClient['listOpen']>>;
      try {
        listResult = await deps.gh.listOpen(repo.repoId, DETECTED_LABELS, 100);
      } catch (err) {
        deps.emit({
          type: 'self_improve_error',
          ts: new Date(now()).toISOString(),
          error: err instanceof Error ? err.message : String(err),
          code: 'GH_LIST_FAILED',
          repoId: repo.repoId,
        });
        result.errors += 1;
        continue;
      }

      if (listResult.truncated) {
        deps.emit({
          type: 'self_improve_error',
          ts: new Date(now()).toISOString(),
          error: `Issue list truncated for ${repo.repoId}; processing first 200 issues only`,
          code: 'GH_LIST_TRUNCATED',
          repoId: repo.repoId,
        });
        result.errors += 1;
      }

      // Sort issues FIFO (ascending updatedAt)
      const sortedIssues = [...listResult.issues].sort((a, b) =>
        a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0,
      );

      // Capture pre-tick per-repo concurrency once per repo (also stable
      // across submissions within this repo's issue loop).
      const preConcurrencyPerRepo = preTick.countActivePerRepo(repo.repoId);

      for (const issue of sortedIssues) {
        result.scanned += 1;
        const key = `${issue.repoId}#${issue.number}`;
        openIssueKeys.add(key);

        // Classify
        const classification = classify(issue, { botLogin: deps.config.botLogin });

        // Emit detected event if matched
        if (classification.matched !== null) {
          deps.emit({
            type: 'self_improve_issue_detected',
            ts: new Date(now()).toISOString(),
            repoId: issue.repoId,
            issueNumber: issue.number,
            class: classification.matched.id,
          });
        }

        // Check evidence (only when classified)
        let evidence: { ok: boolean; reason?: string; detail?: unknown } | null = null;
        if (classification.matched !== null) {
          try {
            evidence = await checkEvidence(
              classification.matched.id,
              issue,
              deps.ownership,
              deps.evidence,
            );
          } catch {
            evidence = { ok: false as const, reason: 'EVIDENCE_TIMEOUT' };
          }
        }

        // GD4/GD5/GD6/GD7 use the pre-tick snapshot so that submissions made
        // earlier in this tick do not artificially inflate the concurrency/cost
        // view and block later issues before GD11 (tick cap) can apply.
        // NA2/NA3/NA4 use a live reader so in-tick dedup and attempt tracking
        // remain accurate.
        const liveReader = makeReader(ledgerFile, deps.config, now());
        const concurrencyView = {
          activeGlobal: preConcurrencyGlobal,
          activePerRepo: preConcurrencyPerRepo,
        };
        const costWindow = {
          last24h: preCostLast24h,
          last7d: preCostLast7d,
        };

        // Evaluate guards
        const guardResult = evaluateGuards({
          env: deps.config,
          ownership: deps.ownership,
          ledger: liveReader,
          issue,
          klass: classification.matched?.id ?? null,
          evidence,
          now: now(),
          fnRegistry: deps.fnRegistry,
          tickSubmittedSoFar,
          concurrencyView,
          costWindow,
        });

        if (!guardResult.ok) {
          // Increment skip counter
          const guardId = guardResult.trip.guard;
          result.skipped[guardId] = (result.skipped[guardId] ?? 0) + 1;
          deps.emit({
            type: 'self_improve_issue_skipped',
            ts: new Date(now()).toISOString(),
            repoId: issue.repoId,
            issueNumber: issue.number,
            guard: guardId,
            evidence: guardResult.trip.evidence,
          });
          continue;
        }

        // Guards passed — submit fix request
        const submitDeps: SubmitDeps = {
          ...deps.submit,
          ledger: mutator,
          emit: deps.emit,
          now,
        };

        const outcome = await submitFromIssue(
          issue,
          classification.matched!.id,
          deps.config,
          submitDeps,
        );

        if (outcome.ok) {
          result.submitted += 1;
          tickSubmittedSoFar += 1;
        } else {
          result.errors += 1;
        }
      }
    }

    // Capture in-flight entries BEFORE reconcile() changes their status.
    // reconcile() may flip in_flight → idle for entries whose issue key is
    // absent from openIssueKeys, which would cause the orphan-cancel pass to
    // skip them (it checks `entry.status === 'in_flight'`).
    const inFlightBeforeReconcile = new Map<string, string>(); // key → lastReqId
    {
      const snapPre = mutator.snapshot();
      for (const [key, entry] of Object.entries(snapPre.entries)) {
        if (entry.status !== 'in_flight') continue;
        const lastReqId = entry.requestIds[entry.requestIds.length - 1];
        if (lastReqId) inFlightBeforeReconcile.set(key, lastReqId);
      }
    }

    // Step 7: reconcile ledger against open issue keys
    mutator.reconcile(openIssueKeys);

    // Step 8: orphan cancel pass — use the pre-reconcile snapshot so that
    // entries whose issue closed (not in openIssueKeys) are still visible.
    if (deps.requestCancel) {
      for (const [key, lastReqId] of inFlightBeforeReconcile) {
        if (openIssueKeys.has(key)) continue; // issue still open; not orphaned
        try {
          await deps.requestCancel(lastReqId, 'self-improve-orphan');
          deps.emit({
            type: 'self_improve_error',
            ts: new Date(now()).toISOString(),
            error: `Cancelled orphaned request ${lastReqId}`,
            code: 'SUBMIT_PARTIAL',
          });
        } catch (err) {
          result.errors += 1;
          deps.emit({
            type: 'self_improve_error',
            ts: new Date(now()).toISOString(),
            error: err instanceof Error ? err.message : String(err),
            code: 'SUBMIT_PARTIAL',
          });
        }
      }
    }

    // Step 9: persist ledger
    try {
      await saveLedger(mutator.snapshot(), deps.ledgerIO);
    } catch (err) {
      deps.emit({
        type: 'self_improve_error',
        ts: new Date(now()).toISOString(),
        error: err instanceof Error ? err.message : String(err),
        code: 'LOCK_BUSY',
      });
      result.errors += 1;
    }
  } catch (err) {
    // NFR-RELIABILITY-01: catch-all — never propagate
    deps.emit({
      type: 'self_improve_error',
      ts: new Date(now()).toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    result.errors += 1;
  }

  // Step 10: emit tick summary
  deps.emit({
    type: 'self_improve_tick_summary',
    ts: new Date(now()).toISOString(),
    scanned: result.scanned,
    submitted: result.submitted,
    skipped: result.skipped,
    errors: result.errors,
  });

  return result;
}
