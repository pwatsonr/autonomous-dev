/**
 * Harness abstraction + implementations for the reliability runner (#524).
 *
 * The orchestration in {@link runBatch} talks to the pipeline only through
 * the {@link Harness} interface — submit, status, readPhaseHistory. Two
 * implementations satisfy it:
 *
 *   - {@link CliHarness}: the real path. Shells out to
 *     `bin/autonomous-dev.sh request submit|status` and reads the per-request
 *     `.autonomous-dev/requests/<id>/state.json` off disk. Used for live
 *     batches (each ~$3/~30min — see README).
 *   - {@link MockHarness}: an in-memory stub that advances a scripted
 *     lifecycle and returns canned `phase_history`. Drives `--dry-run` and
 *     the runner unit test with no daemon.
 *
 * `runBatch` itself is pure with respect to the injected harness + a clock,
 * so the dry-run test exercises the full submit->poll->read->record wiring
 * deterministically.
 *
 * @module tools/reliability/harness
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { summarizePhaseHistory } from './aggregate';
import { assertRepoAllowed } from './guard';
import type {
  PhaseHistoryEntry,
  RequestStatus,
  RunResult,
  Task,
  TerminalStatus,
} from './types';
import { TERMINAL_STATUSES, TIMEOUT_STATUS } from './types';

/** Result of one `request status` poll, narrowed to what the runner needs. */
export interface StatusSnapshot {
  status: RequestStatus;
  currentPhase: string;
  blocker: string | null;
}

/** The pipeline operations the runner depends on. */
export interface Harness {
  /** Submit a request; resolves to the new request ID. */
  submit(repo: string, task: Task): Promise<string>;
  /** Poll a single status snapshot for a request. */
  status(repo: string, requestId: string): Promise<StatusSnapshot>;
  /** Read the request's `phase_history` from its on-disk `state.json`. */
  readPhaseHistory(repo: string, requestId: string): Promise<PhaseHistoryEntry[]>;
}

/** Tunables for one batch. Timeouts/intervals are in milliseconds. */
export interface BatchConfig {
  repo: string;
  repeats: number;
  /** Per-run cap on polling before recording 'timeout'. */
  pollTimeoutMs: number;
  /** Delay between status polls. */
  pollIntervalMs: number;
  dryRun?: boolean;
  /** Injectable clock (defaults to Date.now) — lets tests run instantly. */
  now?: () => number;
  /** Injectable sleep (defaults to real setTimeout) — no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional sink for human-facing progress lines (defaults to no-op). */
  log?: (line: string) => void;
}

function isTerminal(s: RequestStatus): s is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Orchestrate one full batch: for each task x repeat, submit, poll to a
 * terminal status (or timeout), read `phase_history`, and emit a
 * {@link RunResult}. Pure with respect to the injected `harness`/clock —
 * the same harness + config produce the same results array.
 *
 * The repo guard is enforced up-front so a bad `--repo` fails before any
 * submission, in both live and dry-run modes.
 */
export async function runBatch(
  harness: Harness,
  tasks: Task[],
  cfg: BatchConfig,
): Promise<RunResult[]> {
  assertRepoAllowed(cfg.repo);

  const now = cfg.now ?? Date.now;
  const sleep = cfg.sleep ?? realSleep;
  const log = cfg.log ?? (() => {});
  const results: RunResult[] = [];

  for (const task of tasks) {
    for (let repeat = 1; repeat <= cfg.repeats; repeat++) {
      const startedAt = now();
      log(`[${task.id}] repeat ${repeat}/${cfg.repeats}: submitting…`);

      let requestId: string;
      try {
        requestId = await harness.submit(cfg.repo, task);
      } catch (err) {
        // A failed submission is itself a (terminal) data point, not a crash.
        log(`[${task.id}] repeat ${repeat}: submit failed: ${asMessage(err)}`);
        results.push({
          taskId: task.id,
          sizeClass: task.sizeClass,
          repeat,
          status: 'failed',
          terminalPhase: 'submit',
          perPhaseRetries: {},
          totalRetries: 0,
          blocker: `submit failed: ${asMessage(err)}`,
          costUsd: 0,
          wallClockMs: now() - startedAt,
          dryRun: cfg.dryRun,
        });
        continue;
      }

      // -- Poll to a terminal state (or give up at the timeout). -----------
      let snapshot: StatusSnapshot | null = null;
      const deadline = startedAt + cfg.pollTimeoutMs;
      while (now() < deadline) {
        snapshot = await harness.status(cfg.repo, requestId);
        log(`[${task.id}] ${requestId}: status=${snapshot.status} phase=${snapshot.currentPhase}`);
        if (isTerminal(snapshot.status)) break;
        await sleep(cfg.pollIntervalMs);
      }

      const timedOut = !snapshot || !isTerminal(snapshot.status);

      // -- Read phase_history for retry/cost attribution. ------------------
      let phaseHistory: PhaseHistoryEntry[] = [];
      try {
        phaseHistory = await harness.readPhaseHistory(cfg.repo, requestId);
      } catch (err) {
        log(`[${task.id}] ${requestId}: could not read state.json: ${asMessage(err)}`);
      }
      const { perPhaseRetries, totalRetries, costUsd } =
        summarizePhaseHistory(phaseHistory);

      results.push({
        taskId: task.id,
        sizeClass: task.sizeClass,
        repeat,
        requestId,
        status: timedOut ? TIMEOUT_STATUS : (snapshot!.status as TerminalStatus),
        terminalPhase: snapshot?.currentPhase ?? 'unknown',
        perPhaseRetries,
        totalRetries,
        blocker: snapshot?.blocker ?? null,
        costUsd,
        wallClockMs: now() - startedAt,
        dryRun: cfg.dryRun,
      });
    }
  }

  return results;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Real CLI-backed harness
// ---------------------------------------------------------------------------

/** Absolute path to the plugin's CLI entrypoint. */
export const CLI_PATH = path.resolve(__dirname, '..', '..', 'bin', 'autonomous-dev.sh');

/**
 * Live harness: shells out to `autonomous-dev.sh` and reads `state.json`.
 * Parses the CLI's pretty-printed JSON (`formatResult` emits
 * `JSON.stringify(data, null, 2)` for object payloads).
 */
export class CliHarness implements Harness {
  constructor(
    private readonly cliPath: string = CLI_PATH,
    /** For tests: swap the subprocess runner. */
    private readonly run: (args: string[]) => string = (args) =>
      execFileSync(CLI_PATH, args, { encoding: 'utf8' }),
  ) {}

  async submit(repo: string, task: Task): Promise<string> {
    const out = this.run([
      'request',
      'submit',
      task.description,
      '--repo',
      repo,
      '--size',
      task.sizeClass,
    ]);
    const data = parseCliJson(out);
    const id = data.requestId ?? data.id;
    if (typeof id !== 'string') {
      throw new Error(`submit returned no requestId; got: ${out.slice(0, 200)}`);
    }
    return id;
  }

  async status(_repo: string, requestId: string): Promise<StatusSnapshot> {
    const out = this.run(['request', 'status', requestId]);
    const data = parseCliJson(out);
    return {
      status: String(data.status) as RequestStatus,
      currentPhase: String(data.currentPhase ?? data.current_phase ?? 'unknown'),
      blocker: (data.blocker as string | null) ?? null,
    };
  }

  async readPhaseHistory(repo: string, requestId: string): Promise<PhaseHistoryEntry[]> {
    const statePath = path.join(
      repo,
      '.autonomous-dev',
      'requests',
      requestId,
      'state.json',
    );
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { phase_history?: PhaseHistoryEntry[] };
    return parsed.phase_history ?? [];
  }
}

/**
 * Extract the JSON object the CLI prints. `formatResult` writes pretty JSON
 * for object payloads, but the script may emit unrelated lines (build
 * notices, etc.) on stderr; we only ever pass it stdout, and grab the first
 * balanced `{ … }` block to be defensive about trailing newlines.
 */
export function parseCliJson(stdout: string): Record<string, any> {
  // The CLI prints a non-JSON preamble (e.g. "Building CLI adapter…") and MORE
  // THAN ONE JSON value on stdout — a single-line `{"event":"migration.complete"}`
  // followed by the pretty-printed command payload. Collect every top-level
  // balanced `{ … }` group with a string-aware scan and return the LAST one that
  // parses; that is the payload. (#546: the old first-`{`→last-`}` slice spanned
  // both objects and produced invalid JSON, failing every live submit/status.)
  const groups: string[] = [];
  let depth = 0;
  let startIdx = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && startIdx >= 0) {
        groups.push(stdout.slice(startIdx, i + 1));
        startIdx = -1;
      }
    }
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(groups[i]) as Record<string, any>;
    } catch {
      // Not valid JSON (e.g. a brace inside prose) — try the previous group.
    }
  }
  throw new Error(`expected JSON object in CLI output; got: ${stdout.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Mock harness (drives --dry-run and the runner unit test)
// ---------------------------------------------------------------------------

/** A scripted lifecycle for one task in {@link MockHarness}. */
export interface MockScript {
  /** Statuses returned on successive `status` polls, last one terminal. */
  statusSequence: RequestStatus[];
  /** `currentPhase` reported at the terminal poll. */
  terminalPhase: string;
  /** `blocker` reported at the terminal poll (default null). */
  blocker?: string | null;
  /** `phase_history` returned by `readPhaseHistory`. */
  phaseHistory: PhaseHistoryEntry[];
}

/**
 * In-memory harness with no daemon. Each task id maps to a {@link MockScript};
 * unknown tasks fall back to {@link MockHarness.defaultScript}. Per-call
 * poll cursors are tracked by request id so repeats advance independently.
 */
export class MockHarness implements Harness {
  private counter = 0;
  private readonly pollCursor = new Map<string, number>();
  private readonly idToTask = new Map<string, string>();

  constructor(
    private readonly scripts: Record<string, MockScript> = {},
    private readonly defaultScript: MockScript = MockHarness.cleanDoneScript(),
  ) {}

  /** A canned, single-poll, clean 'done' run across the standard phases. */
  static cleanDoneScript(): MockScript {
    return {
      statusSequence: ['done'],
      terminalPhase: 'monitor',
      blocker: null,
      phaseHistory: [
        { state: 'prd', retry_count: 0, exit_reason: 'completed', cost_usd: 0.4 },
        { state: 'code', retry_count: 0, exit_reason: 'completed', cost_usd: 1.1 },
        { state: 'code_review', retry_count: 0, exit_reason: 'completed', cost_usd: 0.3 },
        { state: 'integration', retry_count: 0, exit_reason: 'completed', cost_usd: 0.2 },
        { state: 'monitor', retry_count: 0, exit_reason: 'completed', cost_usd: 0.1 },
      ],
    };
  }

  private scriptFor(taskId: string): MockScript {
    return this.scripts[taskId] ?? this.defaultScript;
  }

  async submit(_repo: string, task: Task): Promise<string> {
    this.counter += 1;
    const id = `REQ-DRYRUN-${String(this.counter).padStart(4, '0')}`;
    this.idToTask.set(id, task.id);
    this.pollCursor.set(id, 0);
    return id;
  }

  async status(_repo: string, requestId: string): Promise<StatusSnapshot> {
    const taskId = this.idToTask.get(requestId) ?? '';
    const script = this.scriptFor(taskId);
    const cursor = this.pollCursor.get(requestId) ?? 0;
    const idx = Math.min(cursor, script.statusSequence.length - 1);
    this.pollCursor.set(requestId, cursor + 1);
    const status = script.statusSequence[idx];
    const atTerminal = idx === script.statusSequence.length - 1;
    return {
      status,
      currentPhase: atTerminal ? script.terminalPhase : 'active',
      blocker: atTerminal ? script.blocker ?? null : null,
    };
  }

  async readPhaseHistory(_repo: string, requestId: string): Promise<PhaseHistoryEntry[]> {
    const taskId = this.idToTask.get(requestId) ?? '';
    return this.scriptFor(taskId).phaseHistory;
  }
}
