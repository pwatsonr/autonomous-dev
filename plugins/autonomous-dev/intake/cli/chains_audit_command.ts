/**
 * `autonomous-dev chains audit` subcommand group (SPEC-022-3-03, Task 8).
 *
 * Two read-only forensics commands against the chain audit log
 * (`~/.autonomous-dev/chains-audit.log` by default):
 *
 *   - `chains audit verify [--log-path <path>] [--json]`
 *       Walks the log start-to-finish, recomputes every HMAC, verifies
 *       each entry's `prev_hmac` chains to the prior `hmac`. Exits 0
 *       on a clean log; exits 1 on the first verification failure;
 *       exits 2 on a malformed JSONL line.
 *
 *   - `chains audit query [--chain <id>] [--plugin <id>] [--since <iso>]
 *                          [--type <event>] [--log-path <path>] [--json]`
 *       Filter the log; multiple filters AND together. Default output
 *       is one tab-separated summary per matching entry; `--json` emits
 *       JSONL (one entry per line).
 *
 * Pure runner functions (`runChainsAuditVerify`, `runChainsAuditQuery`)
 * with injectable dependencies for unit testability; a thin commander
 * wrapper at the bottom registers `chains audit` under the existing
 * `chains` group.
 *
 * @module cli/chains_audit_command
 */

import { promises as fs } from 'node:fs';
import { Command } from 'commander';

import {
  defaultChainAuditLogPath,
  verifyChain,
} from '../chains/audit-writer';
import { getChainsAuditHmacKey } from '../chains/chains-audit-key';
import type {
  ChainAuditEntry,
  ChainEventType,
} from '../chains/audit-events';

const KNOWN_EVENT_TYPES: ReadonlyArray<ChainEventType> = [
  'chain_started',
  'plugin_invoked',
  'plugin_completed',
  'plugin_failed',
  'artifact_emitted',
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'chain_completed',
  'chain_failed',
];

export interface ChainsAuditStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Injectable key resolver — defaults to {@link getChainsAuditHmacKey}. */
export type ChainsAuditKeyResolver = () => Buffer;

export interface ChainsAuditDeps extends ChainsAuditStreams {
  /** Override the resolved key (tests). */
  keyResolver?: ChainsAuditKeyResolver;
}

export interface ChainsAuditVerifyArgs {
  logPath?: string;
  json?: boolean;
}

export interface ChainsAuditQueryArgs {
  logPath?: string;
  json?: boolean;
  chain?: string;
  plugin?: string;
  since?: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Run `chains audit verify`. Returns the process exit code:
 *   - 0: log verified clean.
 *   - 1: HMAC chain mismatch found.
 *   - 2: malformed JSONL or I/O error.
 */
export async function runChainsAuditVerify(
  args: ChainsAuditVerifyArgs,
  deps: ChainsAuditDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const logPath = args.logPath ?? defaultChainAuditLogPath();

  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Empty/missing log is verifiably clean (zero entries to check).
      if (args.json) {
        stdout.write(`${JSON.stringify({ status: 'ok', entries: 0 })}\n`);
      } else {
        stdout.write('OK: 0 entries verified\n');
      }
      return 0;
    }
    stderr.write(`failed to read ${logPath}: ${(err as Error).message}\n`);
    return 2;
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  const entries: ChainAuditEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]) as ChainAuditEntry);
    } catch {
      const lineNum = i + 1;
      if (args.json) {
        stdout.write(
          `${JSON.stringify({
            status: 'fail',
            line: lineNum,
            reason: 'malformed_jsonl',
          })}\n`,
        );
      } else {
        stderr.write(`FAIL: line ${lineNum} malformed JSONL\n`);
      }
      return 2;
    }
  }

  const keyResolver = deps.keyResolver ?? getChainsAuditHmacKey;
  let key: Buffer;
  try {
    key = keyResolver();
  } catch (err) {
    stderr.write(`failed to resolve audit key: ${(err as Error).message}\n`);
    return 2;
  }

  const result = verifyChain(entries, key);
  if (result.ok) {
    if (args.json) {
      stdout.write(
        `${JSON.stringify({ status: 'ok', entries: entries.length })}\n`,
      );
    } else {
      stdout.write(`OK: ${entries.length} entries verified\n`);
    }
    return 0;
  }
  if (args.json) {
    stdout.write(
      `${JSON.stringify({
        status: 'fail',
        line: result.line,
        reason: result.reason,
      })}\n`,
    );
  } else {
    const r = result.reason ?? 'mismatch';
    const exp = result.details?.expected ?? '';
    const got = result.details?.got ?? '';
    stderr.write(
      `FAIL: line ${result.line} ${r} (expected=${exp} got=${got})\n`,
    );
  }
  return 1;
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

/**
 * Run `chains audit query`. Returns the process exit code:
 *   - 0: success (zero matches is still success).
 *   - 2: flag parse error or malformed log line.
 */
export async function runChainsAuditQuery(
  args: ChainsAuditQueryArgs,
  deps: ChainsAuditDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const logPath = args.logPath ?? defaultChainAuditLogPath();

  // Validate --since up-front so a typo fails fast.
  let sinceMs: number | null = null;
  if (args.since !== undefined && args.since !== '') {
    const ms = Date.parse(args.since);
    if (Number.isNaN(ms)) {
      stderr.write(`invalid --since timestamp: '${args.since}'\n`);
      return 2;
    }
    sinceMs = ms;
  }
  if (args.type !== undefined && args.type !== '') {
    if (!KNOWN_EVENT_TYPES.includes(args.type as ChainEventType)) {
      stderr.write(
        `invalid --type '${args.type}'; expected one of: ${KNOWN_EVENT_TYPES.join(', ')}\n`,
      );
      return 2;
    }
  }

  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No log → no matches → exit 0.
      return 0;
    }
    stderr.write(`failed to read ${logPath}: ${(err as Error).message}\n`);
    return 2;
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    let entry: ChainAuditEntry;
    try {
      entry = JSON.parse(lines[i]) as ChainAuditEntry;
    } catch {
      stderr.write(`malformed JSONL at line ${i + 1}\n`);
      return 2;
    }
    if (!matchesFilters(entry, args, sinceMs)) continue;
    if (args.json) {
      stdout.write(`${JSON.stringify(entry)}\n`);
    } else {
      stdout.write(`${formatSummary(entry)}\n`);
    }
  }
  return 0;
}

/**
 * AND-semantics filter check. Empty filters match everything.
 * `--plugin` matches against `payload.plugin_id`,
 * `payload.producer_plugin_id`, OR `payload.requested_by` so a single
 * plugin id surfaces in every role it plays.
 */
function matchesFilters(
  entry: ChainAuditEntry,
  args: ChainsAuditQueryArgs,
  sinceMs: number | null,
): boolean {
  if (args.chain !== undefined && args.chain !== '' && entry.chain_id !== args.chain) {
    return false;
  }
  if (args.type !== undefined && args.type !== '' && entry.type !== args.type) {
    return false;
  }
  if (sinceMs !== null) {
    const ts = Date.parse(entry.ts);
    if (Number.isNaN(ts) || ts < sinceMs) return false;
  }
  if (args.plugin !== undefined && args.plugin !== '') {
    const p = entry.payload as Record<string, unknown> | undefined;
    const candidates = [
      p?.plugin_id,
      p?.producer_plugin_id,
      p?.requested_by,
      p?.granted_by,
      p?.rejected_by,
    ];
    if (!candidates.some((c) => c === args.plugin)) return false;
  }
  return true;
}

/**
 * Default tab-separated output line: `ts \t type \t chain_id \t summary`.
 * `summary` is event-type-specific — picks the most operator-useful
 * field(s) per event type.
 */
function formatSummary(entry: ChainAuditEntry): string {
  const p = (entry.payload ?? {}) as Record<string, unknown>;
  let summary = '';
  switch (entry.type) {
    case 'chain_started':
      summary = `trigger=${p.trigger} plugins=${
        Array.isArray(p.plugins) ? (p.plugins as string[]).length : 0
      }`;
      break;
    case 'plugin_invoked':
      summary = `plugin=${p.plugin_id} step=${p.step}`;
      break;
    case 'plugin_completed':
      summary = `plugin=${p.plugin_id} step=${p.step} duration_ms=${p.duration_ms}`;
      break;
    case 'plugin_failed':
      summary = `plugin=${p.plugin_id} step=${p.step} error=${p.error_code}`;
      break;
    case 'artifact_emitted':
      summary = `producer=${p.producer_plugin_id} type=${p.artifact_type} signed=${p.signed}`;
      break;
    case 'approval_requested':
      summary = `gate=${p.gate_id} requested_by=${p.requested_by}`;
      break;
    case 'approval_granted':
      summary = `gate=${p.gate_id} granted_by=${p.granted_by}`;
      break;
    case 'approval_rejected':
      summary = `gate=${p.gate_id} rejected_by=${p.rejected_by}`;
      break;
    case 'chain_completed':
      summary = `duration_ms=${p.duration_ms} entries=${p.entries}`;
      break;
    case 'chain_failed':
      summary = `duration_ms=${p.duration_ms} stage=${p.failure_stage} error=${p.error_code}`;
      break;
    default:
      summary = '';
  }
  return [entry.ts, entry.type, entry.chain_id, summary].join('\t');
}

/**
 * Register `audit` as a sub-group under an existing `chains` commander
 * group. Wires the two `verify` and `query` subcommands.
 */
export function registerChainsAudit(
  chainsGroup: Command,
  deps: ChainsAuditDeps = {},
): void {
  const audit = chainsGroup
    .command('audit')
    .description('Inspect the chain forensics log')
    .exitOverride();

  audit
    .command('verify')
    .description('Walk the log and verify the HMAC chain integrity')
    .option('--log-path <path>', 'Override the default log location')
    .option('--json', 'Emit JSON instead of human-readable lines', false)
    .action(async (opts: Record<string, unknown>) => {
      const code = await runChainsAuditVerify(
        {
          logPath:
            typeof opts.logPath === 'string' ? opts.logPath : undefined,
          json: opts.json === true,
        },
        deps,
      );
      if (code !== 0) {
        // Surface a non-success to commander so the top-level catch
        // can exit with the right code. The runner has already written
        // the user-facing message.
        const err = new Error(`chains audit verify failed (exit ${code})`);
        (err as Error & { exitCode?: number }).exitCode = code;
        throw err;
      }
    });

  audit
    .command('query')
    .description('Filter the log by chain, plugin, since-timestamp, or type')
    .option('--chain <chain_id>', 'Restrict to a single chain id')
    .option('--plugin <plugin_id>', 'Match plugin_id, producer_plugin_id, or requested_by')
    .option('--since <iso8601>', 'Inclusive lower bound on entry timestamp')
    .option('--type <event_type>', 'Restrict to a single event type')
    .option('--log-path <path>', 'Override the default log location')
    .option('--json', 'Emit JSONL instead of tab-separated', false)
    .action(async (opts: Record<string, unknown>) => {
      const code = await runChainsAuditQuery(
        {
          chain: typeof opts.chain === 'string' ? opts.chain : undefined,
          plugin: typeof opts.plugin === 'string' ? opts.plugin : undefined,
          since: typeof opts.since === 'string' ? opts.since : undefined,
          type: typeof opts.type === 'string' ? opts.type : undefined,
          logPath:
            typeof opts.logPath === 'string' ? opts.logPath : undefined,
          json: opts.json === true,
        },
        deps,
      );
      if (code !== 0) {
        const err = new Error(`chains audit query failed (exit ${code})`);
        (err as Error & { exitCode?: number }).exitCode = code;
        throw err;
      }
    });
}
