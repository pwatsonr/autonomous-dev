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

import { botNotifier } from '../intake/triggers/bot_notifier';
import { ghChecksClient, type ExecFn } from '../intake/triggers/checks_client';
import { ghIssueFiler, failureFingerprint } from '../intake/triggers/issue_filer';
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

  // Real bot-post notifier from env tokens (best-effort; absent tokens →
  // ok:false, still audited). Echo every attempt to the daemon log for ops.
  const bot = botNotifier({
    discordToken: process.env.DISCORD_BOT_TOKEN,
    slackToken: process.env.SLACK_BOT_TOKEN,
  });
  const notifier: TriggerNotifier = {
    send: async (origin, message) => {
      const out = await bot.send(origin, message);
      process.stdout.write(
        `[trigger-notify ${origin.platform}/${origin.channelId ?? '-'} ok=${out.ok}${
          out.error ? ` err=${out.error}` : ''
        }] ${message.title}\n`,
      );
      return out;
    },
  };

  const res = await runWatchTick({
    storeIO: defaultTriggerStoreIO,
    readOutcome,
    branchFor: (record) => `autonomous/${record.requestId}`,
    checks: ghChecksClient(ghExec),
    now: () => Date.now(),
    audit: logAudit,
    reporter: { notifier, audit: logAudit },
    // Auto-file a GitHub issue on a terminal failure (pipeline failed / watch
    // regressed / expired) on the target repo, deduped by fingerprint.
    issueFiler: ghIssueFiler(ghExec),
  });
  process.stdout.write(
    `watch-tick: started=${res.started} done=${res.reportedDone} failed=${res.reportedFailed} issues=${res.issuesFiled}\n`,
  );
  return 0;
}

/** Minimal `--key value` flag parser for the failure-issue verb. */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      out[key] = next !== undefined && !next.startsWith('--') ? argv[(i += 1)] : '';
    }
  }
  return out;
}

/**
 * `autonomous-dev triggers file-failure-issue` — open (or dedup-comment) a
 * GitHub issue for a failure. Invoked best-effort by the daemon at terminal
 * failure points. Resolves the target repo SLUG from `--repo`, else from
 * `--repo-path` via ownership, else `--system-repo` (for system-level faults).
 */
async function fileFailureIssueCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  let repo = flags['repo'] ?? '';
  if (!repo && flags['repo-path']) {
    try {
      repo = readOwnership().repos.find((r) => r.path === flags['repo-path'])?.id ?? '';
    } catch {
      repo = '';
    }
  }
  if (!repo) repo = flags['system-repo'] ?? '';
  if (!repo) {
    process.stderr.write(
      'file-failure-issue: need --repo <slug>, a resolvable --repo-path, or --system-repo\n',
    );
    return 1;
  }
  const failureClass = flags['class'] || 'failure';
  const requestId = flags['request'] || undefined;
  const phase = flags['phase'] || undefined;
  const detail = (flags['detail'] || '').replace(/[\r\n]+/g, ' ').trim();
  const title = `[autodev:${failureClass}]${requestId ? ` ${requestId}` : ''}${phase ? ` (phase ${phase})` : ''}`;
  const body = [
    `Autonomous-dev recorded a **${failureClass}**.`,
    '',
    requestId ? `- Request: \`${requestId}\`` : '',
    `- Repo: \`${repo}\``,
    phase ? `- Phase: \`${phase}\`` : '',
    detail ? `- Detail: ${detail}` : '',
    '',
    'Filed automatically by autonomous-dev; recurrences dedup onto this issue.',
  ]
    .filter((l) => l !== '')
    .join('\n');
  const res = await ghIssueFiler(ghExec).file({
    repo,
    title,
    body,
    fingerprint: failureFingerprint({ repo, requestId, failureClass, phase }),
  });
  process.stdout.write(
    `file-failure-issue: ok=${res.ok} deduped=${res.deduped ?? false}${res.url ? ` url=${res.url}` : ''}${
      res.error ? ` error=${res.error}` : ''
    }\n`,
  );
  return res.ok ? 0 : 1;
}

/**
 * `autonomous-dev triggers serve` — start the long-running Discord/Slack inbound
 * listeners so a `/autodev` chat command reaches the registered TriggerHandler.
 *
 * The serve graph (concrete platform service construction) lives in the sibling
 * `triggers-serve.ts` entrypoint, which owns its own keep-alive + signal
 * handling. We `exec`-replace this process into it (mirroring the bash
 * `exec bun run …` idiom) so the daemon supervises a single long-lived PID
 * rather than a child of this short-lived dispatcher.
 */
function serveCmd(argv: string[]): never {
  // serve loads the DB (better-sqlite3), which Bun cannot load (#603), so it
  // must run under Node. The launcher normally intercepts `triggers serve` and
  // execs Node directly; this path covers direct invocation
  // (`bun run triggers-cli.ts serve`): build the Node-target bundle if
  // missing/stale, then run it under Node with the plugin-root anchor set so
  // the bundled migrations path resolves correctly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { execFileSync } = require('child_process') as typeof import('child_process');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  const pluginDir = path.resolve(__dirname, '..');
  const serveTs = path.join(__dirname, 'triggers-serve.ts');
  const serveJs = path.join(__dirname, 'triggers-serve.js');
  try {
    if (
      !fs.existsSync(serveJs) ||
      fs.statSync(serveTs).mtimeMs > fs.statSync(serveJs).mtimeMs
    ) {
      execFileSync('bun', ['run', 'build:triggers-serve'], {
        stdio: 'inherit',
        cwd: pluginDir,
      });
    }
    execFileSync('node', [serveJs, ...argv], {
      stdio: 'inherit',
      env: { ...process.env, AUTONOMOUS_DEV_PLUGIN_DIR: pluginDir },
    });
    process.exit(0);
  } catch (err) {
    const code = (err as { status?: number }).status;
    process.exit(typeof code === 'number' ? code : 1);
  }
}

async function main(argv: string[]): Promise<number> {
  const [verb] = argv;
  if (verb === 'watch-tick') return watchTick();
  if (verb === 'file-failure-issue') return fileFailureIssueCmd(argv.slice(1));
  if (verb === 'serve') serveCmd(argv.slice(1)); // never returns
  process.stderr.write(
    'usage: autonomous-dev triggers (watch-tick | file-failure-issue | serve …)\n',
  );
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
