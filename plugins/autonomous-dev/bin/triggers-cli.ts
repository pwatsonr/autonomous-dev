#!/usr/bin/env bun
/**
 * ONBOARD Phase 4 (#596) — triggers CLI (bun-run, OUTSIDE tsconfig).
 *
 * `autonomous-dev triggers watch-tick` runs one periodic tick: detect
 * completions of enqueued triggers (read each request's state.json), report
 * terminal status, and advance the stabilization watches (CI via `gh`). All
 * real-world wiring lives here; the logic is the unit-tested intake/triggers
 * modules. The supervisor loop invokes this each daemon iteration.
 *
 * The watch branch is `autonomous/<requestId>` (the pipeline's PR-branch
 * convention). The NOTIFIER is a logging stub until Discord/Slack bot tokens
 * are provisioned (see docs/ONBOARD-phase4-deploy.md) — swap `logNotifier` for
 * the real bot-post at activation.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { ghChecksClient, type ExecFn } from '../intake/triggers/checks_client';
import type { TriggerAuditSink, TriggerNotifier } from '../intake/triggers/trigger_reporter';
import { defaultTriggerStoreIO, type TriggerRecord } from '../intake/triggers/trigger_store';
import { outcomeFromState, runWatchTick, type RequestOutcome } from '../intake/triggers/watch_tick';
import { readOwnership } from '../src/ownership/store';

const execFileAsync = promisify(execFile);

/** Path-safe request id (matches the store's isRecord guard). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;
/** A state.json is tiny; cap the read to avoid OOM on a buggy/huge file. */
const MAX_STATE_BYTES = 1_000_000;

/** Real `gh` runner for the checks client. Never throws — non-zero/spawn-error
 *  → { ok:false }, which the checks client maps to `unknown` (the watch holds). */
const ghExec: ExecFn = async (cmd, args) => {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 20_000 });
    return { stdout, ok: true };
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? '';
    return { stdout, ok: false };
  }
};

/** v1 logging notifier — DEPLOY swaps this for the bot-post once tokens exist. */
const logNotifier: TriggerNotifier = {
  send: async (origin, message) => {
    process.stdout.write(
      `[trigger-notify ${origin.platform}/${origin.channelId ?? '-'}] ${message.title}: ${message.body}\n`,
    );
    return { ok: true };
  },
};

const logAudit: TriggerAuditSink = {
  append: (e) => {
    process.stdout.write(`[trigger-audit] ${JSON.stringify(e)}\n`);
  },
};

async function watchTick(): Promise<number> {
  // Read ownership once; map repo id → local path for the state.json read.
  const own = readOwnership();
  const pathById = new Map(
    own.repos.filter((r) => typeof r.path === 'string').map((r) => [r.id, r.path as string]),
  );

  const readOutcome = (record: TriggerRecord): RequestOutcome => {
    // Defense in depth: the store already drops non-path-safe requestIds on
    // load (isRecord), but re-check here before composing a filesystem path.
    if (!SAFE_REQUEST_ID.test(record.requestId)) return { status: 'unknown' };
    const repoPath = pathById.get(record.targetRepo);
    if (repoPath === undefined) return { status: 'unknown' };
    const stateFile = path.join(
      repoPath,
      '.autonomous-dev',
      'requests',
      record.requestId,
      'state.json',
    );
    try {
      // A state.json is tiny; cap the read so a buggy/huge file can't OOM the tick.
      if (fs.statSync(stateFile).size > MAX_STATE_BYTES) return { status: 'unknown' };
      const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      return outcomeFromState(parsed as { status?: unknown });
    } catch {
      return { status: 'unknown' };
    }
  };

  const res = await runWatchTick({
    storeIO: defaultTriggerStoreIO,
    readOutcome,
    branchFor: (record) => `autonomous/${record.requestId}`,
    checks: ghChecksClient(ghExec),
    now: () => Date.now(),
    audit: logAudit,
    reporter: { notifier: logNotifier, audit: logAudit },
  });
  process.stdout.write(
    `watch-tick: started=${res.started} done=${res.reportedDone} failed=${res.reportedFailed}\n`,
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [verb] = argv;
  if (verb === 'watch-tick') return watchTick();
  process.stderr.write('usage: autonomous-dev triggers watch-tick\n');
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
