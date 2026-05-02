/**
 * CLI Adapter — Bash-to-TypeScript bridge for the `autonomous-dev request`
 * command family.
 *
 * The bash dispatcher (`bin/autonomous-dev.sh`) performs early validation
 * (request ID regex, priority allowlist) and then `exec`s into this module
 * via `node`. This adapter:
 *   1. Registers all 10 request subcommands with `commander.js`.
 *   2. Performs TS-level validation that bash cannot conveniently do
 *      (ISO-8601 deadlines, repo identifier formats, request types).
 *   3. Builds an `IncomingCommand` per the canonical
 *      `intake/adapters/adapter_interface.ts` shape.
 *   4. Routes the command through `IntakeRouter` and writes the result.
 *
 * IncomingCommand mapping (spec → canonical interface)
 * ----------------------------------------------------
 * The literal field names in SPEC-011-1-03 differ from the canonical
 * `IncomingCommand` type defined in `adapter_interface.ts`. The canonical
 * shape is the source of truth; the spec is conceptual. The mapping is:
 *
 *   spec `commandType`       → canonical `commandName`
 *   spec `requestId`         → first element of canonical `args`
 *   spec `payload`           → canonical `flags` (Record<string, string|boolean>)
 *                              non-boolean values are coerced via `String(v)`,
 *                              undefined values are omitted
 *   spec `source.operatorId` → canonical `source.userId`
 *                              (from `os.userInfo().username`)
 *   spec `source.invokedAt`  → canonical `source.timestamp` (Date)
 *   spec `source.cwd`        → no canonical home; stashed as
 *                              `flags.__cwd = process.cwd()`
 *   canonical `rawText`      → `process.argv.slice(2).join(' ')`
 *   canonical `source.channelType` → always `'cli'`
 *
 * IntakeRouter construction
 * -------------------------
 * SPEC-011-1-03 sketches `new IntakeRouter()` but the real constructor
 * requires `IntakeRouterDeps` (see `intake/core/intake_router.ts:62-94`).
 * `initRouter()` builds the deps using the same defaults as the integration
 * tests in `intake/__tests__/integration/`. Optional dependencies
 * (`claudeClient`, `duplicateDetector`, `injectionRules`) are left undefined
 * for now; the SubmitHandler tolerates this for non-NLP code paths.
 *
 * @module cli_adapter
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from 'commander';

import type {
  ChannelType,
  IncomingCommand,
  CommandResult,
} from './adapter_interface';
import { loadBugContext } from '../cli/bug-context-loader';
import { registerStandardsCommand } from './cli_adapter_standards';
import {
  formatErrors,
  runInteractivePrompts,
  validateBugReport,
  defaultPromptIO,
  type PromptIO,
} from '../cli/bug-prompts';
import type { BugReport, Severity } from '../types/bug-report';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All valid `--type` values for `request submit`. */
export const VALID_REQUEST_TYPES = [
  'feature',
  'bug',
  'infra',
  'refactor',
  'hotfix',
] as const;

/** Strict ISO-8601 with timezone (Z or ±HH:MM). */
const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** GitHub-style `org/repo` identifier. */
const GH_REPO_REGEX = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

// ---------------------------------------------------------------------------
// Router contract (kept narrow for testability — mirrors claude_adapter)
// ---------------------------------------------------------------------------

/**
 * Minimal router contract consumed by the CLI adapter. Mirrors the same
 * pattern used in `claude_adapter.ts` so unit tests can inject mocks
 * without pulling in the concrete `IntakeRouter`.
 */
export interface IntakeRouterLike {
  route(command: IncomingCommand): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Validators (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse and validate an ISO-8601 deadline.
 *
 * @throws {InvalidArgumentError} when the value is not strict ISO-8601 with
 *   timezone, is unparseable, or is in the past.
 */
export function parseDeadline(value: string): string {
  if (!ISO_8601_REGEX.test(value)) {
    throw new InvalidArgumentError(
      `'${value}' is not a valid ISO 8601 timestamp`,
    );
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new InvalidArgumentError(`'${value}' is not a parseable date`);
  }
  if (date.getTime() < Date.now()) {
    throw new InvalidArgumentError(`deadline '${value}' is in the past`);
  }
  // Return the original string so the router sees a stable serialization.
  return value;
}

/**
 * Parse and validate a `--repo` value.
 *
 * Accepts either:
 *   - GitHub-style `org/repo`, or
 *   - an absolute path to an existing directory.
 *
 * @throws {InvalidArgumentError} on format mismatch or missing directory.
 */
export function parseRepo(value: string): string {
  if (GH_REPO_REGEX.test(value)) return value;
  if (path.isAbsolute(value)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(value);
    } catch {
      throw new InvalidArgumentError(
        `repo path '${value}' does not exist or is not a directory`,
      );
    }
    if (!stat.isDirectory()) {
      throw new InvalidArgumentError(
        `repo path '${value}' does not exist or is not a directory`,
      );
    }
    return value;
  }
  throw new InvalidArgumentError(
    `'${value}' is not a valid repo identifier. Use 'org/repo' or an absolute path`,
  );
}

/**
 * Parse and validate a `--type` value against {@link VALID_REQUEST_TYPES}.
 *
 * @throws {InvalidArgumentError} when the value is not in the allowlist.
 */
export function parseType(value: string): string {
  if (!(VALID_REQUEST_TYPES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(
      `type '${value}' invalid. Valid: ${VALID_REQUEST_TYPES.join(', ')}`,
    );
  }
  return value;
}

/**
 * Parse and validate `--lines` (positive integer).
 *
 * @throws {InvalidArgumentError} when the value cannot be parsed as a
 *   positive integer.
 */
export function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(
      `'${value}' is not a positive integer`,
    );
  }
  return n;
}

/**
 * Parse and validate `--state` (must be `active` or `all`).
 */
export function parseListState(value: string): string {
  if (value !== 'active' && value !== 'all') {
    throw new InvalidArgumentError(
      `state '${value}' invalid. Valid: active, all`,
    );
  }
  return value;
}

/**
 * Commander collector for repeatable flags (e.g. `--repro-step a --repro-step b`).
 * Appends each occurrence onto the accumulated array and returns it.
 */
export function collectArray(value: string, prev: string[]): string[] {
  return [...(prev ?? []), value];
}

/** Fields that may NEVER be modified after a request has been submitted. */
export const IMMUTABLE_FIELDS = [
  'request_type',
  'id',
  'created_at',
  'source_channel',
] as const;

/**
 * Audit log file used by the CLI when no daemon-backed AuditLogger is
 * available. Each rejection appends a single JSON line so downstream
 * tooling can `tail -f` the file. Override with `AUTONOMOUS_DEV_AUDIT_LOG`
 * (used by the test suite to redirect into a tmpdir).
 */
export function auditLogPath(): string {
  if (process.env.AUTONOMOUS_DEV_AUDIT_LOG) {
    return process.env.AUTONOMOUS_DEV_AUDIT_LOG;
  }
  return path.join(
    process.env.HOME ?? os.homedir(),
    '.autonomous-dev',
    'audit.log',
  );
}

/**
 * Append a `request.edit_rejected` event to the audit log file
 * (SPEC-018-3-03 AC #2). Emits the same JSON shape as the in-process
 * AuditLogger.logEditRejected() so log consumers see one stream.
 *
 * Best-effort — failures to write the audit line do NOT block the
 * primary CLI rejection (which is the contract).
 */
export function appendEditRejectedAudit(
  requestId: string,
  attemptedField: string,
  reason: string,
): void {
  const logPath = auditLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const entry = {
      level: 'info',
      msg: 'request.edit_rejected',
      ts: new Date().toISOString(),
      type: 'request.edit_rejected',
      request_id: requestId,
      attempted_field: attemptedField,
      reason,
      user_id: os.userInfo().username,
      source_channel: 'cli',
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort; do not surface audit-log IO failures.
  }
}

/**
 * Reject an attempted mutation of an immutable field. Writes the
 * canonical `Error: <field> is immutable after submission` line to
 * stderr, audits the rejection, and throws an
 * {@link InvalidArgumentError} so the top-level handler exits with
 * code 1.
 */
export function rejectImmutable(requestId: string, fieldName: string): never {
  const reason = `${fieldName} is immutable after submission`;
  appendEditRejectedAudit(requestId, fieldName, reason);
  process.stderr.write(`Error: ${reason}\n`);
  throw new InvalidArgumentError(reason);
}

/**
 * Build a {@link BugReport} from CLI inputs for the `submit-bug`
 * subcommand. Three input modes, in priority order:
 *
 *   1. `--bug-context-path` — load + validate JSON file, ignore other flags.
 *   2. Non-TTY stdin or `--non-interactive` — assemble from flags only.
 *   3. TTY stdin — drive {@link runInteractivePrompts}.
 *
 * On validation or load failure this writes to stderr and throws an
 * {@link InvalidArgumentError} so commander's top-level handler exits 1.
 *
 * Exported for unit testing. The optional `io` arg lets tests inject a
 * fake {@link PromptIO} for the interactive path.
 */
export async function collectBugReport(
  opts: Record<string, unknown>,
  io?: PromptIO,
): Promise<BugReport | null> {
  // Mode 1: path-supplied JSON
  if (opts.bugContextPath) {
    const result = loadBugContext(String(opts.bugContextPath));
    if (!result.ok) {
      process.stderr.write(`Error: ${result.error}\n`);
      throw new InvalidArgumentError(result.error);
    }
    return result.report;
  }

  const isInteractive = process.stdin.isTTY === true && !opts.nonInteractive;
  let report: Partial<BugReport>;

  if (isInteractive) {
    // Mode 3: interactive prompts (re-prompt inline on per-field failures).
    const handle = (): void => {
      process.stderr.write('\nCancelled — no request submitted.\n');
      process.exit(130);
    };
    process.once('SIGINT', handle);
    try {
      report = await runInteractivePrompts(io ?? defaultPromptIO());
    } finally {
      process.removeListener('SIGINT', handle);
    }
  } else {
    // Mode 2: build directly from flags. Missing-required-field detection
    // happens in validateBugReport below — this assembly stays mechanical.
    const reproSteps = (opts.reproStep as string[] | undefined) ?? [];
    const errMessages = (opts.errorMessage as string[] | undefined) ?? [];
    const components = (opts.component as string[] | undefined) ?? [];
    const labels = (opts.label as string[] | undefined) ?? [];

    const partial: Partial<BugReport> = {};
    if (opts.title !== undefined) partial.title = String(opts.title);
    if (opts.description !== undefined) partial.description = String(opts.description);
    if (reproSteps.length > 0) partial.reproduction_steps = reproSteps;
    if (opts.expected !== undefined) partial.expected_behavior = String(opts.expected);
    if (opts.actual !== undefined) partial.actual_behavior = String(opts.actual);
    // error_messages is required in the schema (≥0 items) — always present.
    partial.error_messages = errMessages;
    // environment block — always assemble; missing fields surface as errors.
    partial.environment = {
      os: opts.os !== undefined ? String(opts.os) : '',
      runtime: opts.runtime !== undefined ? String(opts.runtime) : '',
      version: opts.version !== undefined ? String(opts.version) : '',
    };
    if (opts.severity !== undefined) partial.severity = opts.severity as Severity;
    if (components.length > 0) partial.affected_components = components;
    if (labels.length > 0) partial.labels = labels;
    if (opts.userImpact !== undefined) partial.user_impact = String(opts.userImpact);

    // Strip the empty environment block if the user supplied nothing —
    // that surfaces as a single missing-property error rather than three
    // empty-string errors.
    if (
      partial.environment &&
      partial.environment.os === '' &&
      partial.environment.runtime === '' &&
      partial.environment.version === ''
    ) {
      delete partial.environment;
    }

    report = partial;
  }

  const errors = validateBugReport(report);
  if (errors.length > 0) {
    const msg = `bug report validation failed:\n${formatErrors(errors)}`;
    process.stderr.write(`Error: ${msg}\n`);
    throw new InvalidArgumentError(msg);
  }
  return report as BugReport;
}

// ---------------------------------------------------------------------------
// IncomingCommand construction
// ---------------------------------------------------------------------------

/**
 * Build a canonical {@link IncomingCommand} from CLI inputs.
 *
 * See module-level header for the spec → canonical field mapping.
 *
 * @param commandName The short subcommand name (`submit`, `status`, ...).
 * @param payload     Spec-level payload; coerced into canonical `flags`.
 * @param requestId   Optional request ID; placed first in `args` when set.
 */
export function buildCommand(
  commandName: string,
  payload: Record<string, unknown>,
  requestId?: string,
): IncomingCommand {
  const flags: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') {
      flags[k] = v;
    } else {
      flags[k] = String(v);
    }
  }
  // Stash cwd here since the canonical CommandSource has no field for it.
  flags.__cwd = process.cwd();

  const args: string[] = requestId ? [requestId] : [];

  return {
    commandName,
    args,
    flags,
    rawText: process.argv.slice(2).join(' '),
    source: {
      channelType: 'cli' satisfies ChannelType,
      userId: os.userInfo().username,
      timestamp: new Date(),
    },
  };
}

// ---------------------------------------------------------------------------
// Result formatter (intentionally minimal — full UX is a separate concern)
// ---------------------------------------------------------------------------

/**
 * Format a {@link CommandResult} for the terminal.
 *
 * Color is gated by `process.env.AUTONOMOUS_DEV_COLOR === '1'` (set by
 * the bash dispatcher per SPEC-011-1-02). For now we emit plain text
 * regardless; ANSI styling lands when the CLI formatter (TDD-008-2-03)
 * is wired in.
 */
export function formatResult(result: CommandResult): string {
  if (result.success) {
    if (result.data === undefined || result.data === null) {
      return 'OK\n';
    }
    if (typeof result.data === 'string') {
      return `${result.data}\n`;
    }
    return `${JSON.stringify(result.data, null, 2)}\n`;
  }
  const code = result.errorCode ? ` [${result.errorCode}]` : '';
  return `ERROR${code}: ${result.error ?? 'unknown error'}\n`;
}

// ---------------------------------------------------------------------------
// Program builder
// ---------------------------------------------------------------------------

/**
 * Construct a fresh `commander` program with all 10 request subcommands
 * wired to {@link routerProvider}.
 *
 * Each subcommand handler:
 *   1. Builds an {@link IncomingCommand} via {@link buildCommand}.
 *   2. Awaits `routerProvider().route(command)`.
 *   3. Writes {@link formatResult} to stdout.
 *   4. Throws on non-success so the top-level catch can set exit code 1.
 *
 * The router is provided lazily so test code can swap in a mock without
 * triggering the real {@link initRouter} (which opens sqlite + reads YAML).
 */
export function buildProgram(
  routerProvider: () => IntakeRouterLike | Promise<IntakeRouterLike>,
): Command {
  const program = new Command();

  program
    .name('autonomous-dev request')
    .description('Manage autonomous-dev request lifecycle')
    .exitOverride();

  /**
   * Internal helper: build the command, route it, write the result, and
   * exit with code 1 when the router reports failure. Throws on async
   * errors so the top-level handler sees them.
   */
  const dispatch = async (
    commandName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> => {
    const router = await routerProvider();
    const cmd = buildCommand(commandName, payload, requestId);
    const result = await router.route(cmd);
    if (result.success) {
      process.stdout.write(formatResult(result));
    } else {
      process.stderr.write(formatResult(result));
      // Propagate non-success as a thrown InvalidArgumentError so the
      // top-level handler exits with code 1 (user-facing error).
      throw new InvalidArgumentError(result.error ?? 'command failed');
    }
  };

  // -- submit -------------------------------------------------------------
  program
    .command('submit <description>')
    .description('Submit a new request')
    .addOption(
      new Option('--repo <repo>', 'Target repository (org/repo or absolute path)').argParser(parseRepo),
    )
    .addOption(
      new Option('--priority <priority>', 'Priority: high|normal|low')
        .choices(['high', 'normal', 'low'])
        .default('normal'),
    )
    .addOption(
      new Option('--deadline <iso8601>', 'Deadline (ISO 8601 timestamp)').argParser(parseDeadline),
    )
    .addOption(
      new Option(
        '--type <type>',
        `Request type (one of: ${VALID_REQUEST_TYPES.join(', ')})`,
      )
        .argParser(parseType)
        .default('feature'),
    )
    .option(
      '--bug-context-path <file>',
      'Path to a JSON BugReport (required when --type bug, unless using submit-bug)',
    )
    .action(async (description: string, opts: Record<string, unknown>) => {
      // SPEC-018-3-02: bug-typed requests must carry a populated bug_context.
      // Either supply a pre-built JSON file via --bug-context-path or use
      // the dedicated `submit-bug` subcommand.
      let bugContext: BugReport | undefined;
      if (opts.type === 'bug') {
        if (opts.bugContextPath) {
          const result = loadBugContext(String(opts.bugContextPath));
          if (!result.ok) {
            process.stderr.write(`Error: ${result.error}\n`);
            throw new InvalidArgumentError(result.error);
          }
          bugContext = result.report;
        } else {
          const msg =
            "bug-typed requests require bug context. " +
            "Use 'autonomous-dev request submit-bug' or pass --bug-context-path <file>";
          process.stderr.write(`Error: ${msg}\n`);
          throw new InvalidArgumentError(msg);
        }
      }

      await dispatch('submit', {
        description,
        repo: opts.repo,
        priority: opts.priority,
        deadline: opts.deadline,
        type: opts.type,
        bug_context: bugContext ? JSON.stringify(bugContext) : undefined,
      });
    });

  // -- submit-bug ---------------------------------------------------------
  // SPEC-018-3-02: dedicated interactive (or scripted) bug-report intake.
  program
    .command('submit-bug')
    .description(
      'Submit a bug report (interactive when stdin is a TTY; flag-driven otherwise)',
    )
    .addOption(
      new Option('--repo <repo>', 'Target repository (org/repo or absolute path)').argParser(parseRepo),
    )
    .addOption(
      new Option('--priority <priority>', 'Priority: high|normal|low')
        .choices(['high', 'normal', 'low'])
        .default('normal'),
    )
    .option('--non-interactive', 'Force flag-only mode even on a TTY', false)
    .option(
      '--bug-context-path <file>',
      'Path to a pre-built JSON BugReport (skips prompts/flags)',
    )
    // Scalar flags
    .option('--title <s>', 'Bug title (1-200 chars)')
    .option('--description <s>', 'Bug description (1-4000 chars)')
    .option('--expected <s>', 'Expected behavior (1-2000 chars)')
    .option('--actual <s>', 'Actual behavior (1-2000 chars)')
    .option('--os <s>', 'environment.os override')
    .option('--runtime <s>', 'environment.runtime override')
    .option('--version <s>', 'environment.version override')
    .option(
      '--severity <s>',
      'Severity: low|medium|high|critical',
    )
    .option('--user-impact <s>', 'User impact (1-1000 chars)')
    // Repeatable array flags — commander's variadic via collector
    .option(
      '--repro-step <s>',
      'A reproduction step (repeatable; ≥1 required)',
      collectArray,
      [] as string[],
    )
    .option(
      '--error-message <s>',
      'Verbatim error message (repeatable)',
      collectArray,
      [] as string[],
    )
    .option(
      '--component <s>',
      'Affected component (repeatable)',
      collectArray,
      [] as string[],
    )
    .option(
      '--label <s>',
      'Free-form label (repeatable)',
      collectArray,
      [] as string[],
    )
    .action(async (opts: Record<string, unknown>) => {
      const report = await collectBugReport(opts);
      if (!report) return; // collector already wrote stderr + threw OR exited

      // Bash already sets the request type implicitly to 'bug' for this
      // subcommand; the daemon needs both fields present.
      await dispatch('submit', {
        description: report.title, // short summary doubles as description
        repo: opts.repo,
        priority: opts.priority,
        type: 'bug',
        bug_context: JSON.stringify(report),
      });
    });

  // -- edit ---------------------------------------------------------------
  // SPEC-018-3-03: reject mutations to immutable fields, audit every reject.
  program
    .command('edit <request-id>')
    .description('Edit mutable fields on an existing request')
    .option('--priority <s>', 'Priority: high|normal|low')
    .option('--description <s>', 'Updated description')
    .option('--label <s>', 'Replace labels (repeatable)', collectArray, [] as string[])
    .option('--user-impact <s>', 'Updated user impact')
    // Immutable fields — accepted by commander but rejected by the action.
    .option('--type <s>', 'IMMUTABLE — request type cannot be changed after submission')
    .option('--id <s>', 'IMMUTABLE — request id cannot be changed')
    .option('--created-at <s>', 'IMMUTABLE — created_at cannot be changed')
    .option('--source-channel <s>', 'IMMUTABLE — source_channel cannot be changed')
    .action(async (requestId: string, opts: Record<string, unknown>) => {
      // Map commander's camelCase opts back onto the snake_case field
      // names the audit log records.
      const presence: Array<[string, string]> = [
        ['type', 'request_type'],
        ['id', 'id'],
        ['createdAt', 'created_at'],
        ['sourceChannel', 'source_channel'],
      ];
      for (const [optKey, fieldName] of presence) {
        if (opts[optKey] !== undefined) {
          rejectImmutable(requestId, fieldName);
          return; // unreachable — rejectImmutable throws/exits
        }
      }
      // Mutable changes — pass through to the daemon. Empty change set is
      // an explicit no-op success.
      const changes: Record<string, unknown> = {};
      if (opts.priority !== undefined) changes.priority = opts.priority;
      if (opts.description !== undefined) changes.description = opts.description;
      if (opts.userImpact !== undefined) changes.user_impact = opts.userImpact;
      const labels = opts.label as string[] | undefined;
      if (labels && labels.length > 0) changes.labels = labels.join(',');
      await dispatch('edit', changes, requestId);
    });

  // -- status -------------------------------------------------------------
  program
    .command('status <request-id>')
    .description('Show current status of a request')
    .action(async (requestId: string) => {
      await dispatch('status', {}, requestId);
    });

  // -- list ---------------------------------------------------------------
  program
    .command('list')
    .description('List recent requests')
    .addOption(
      new Option('--state <state>', 'Filter: active|all')
        .argParser(parseListState)
        .default('active'),
    )
    .addOption(
      new Option('--limit <n>', 'Maximum number of results').argParser(parsePositiveInt),
    )
    .action(async (opts: Record<string, unknown>) => {
      await dispatch('list', { state: opts.state, limit: opts.limit });
    });

  // -- cancel -------------------------------------------------------------
  program
    .command('cancel <request-id>')
    .description('Cancel a request')
    .option('--reason <reason>', 'Optional cancellation reason')
    .action(async (requestId: string, opts: Record<string, unknown>) => {
      await dispatch('cancel', { reason: opts.reason }, requestId);
    });

  // -- pause --------------------------------------------------------------
  program
    .command('pause <request-id>')
    .description('Pause a request')
    .action(async (requestId: string) => {
      await dispatch('pause', {}, requestId);
    });

  // -- resume -------------------------------------------------------------
  program
    .command('resume <request-id>')
    .description('Resume a paused request')
    .action(async (requestId: string) => {
      await dispatch('resume', {}, requestId);
    });

  // -- priority -----------------------------------------------------------
  program
    .command('priority <request-id> <level>')
    .description('Change priority (high|normal|low)')
    .action(async (requestId: string, level: string) => {
      // Bash already validated `level`; we trust it here per SPEC-011-1-03 §Task 8.
      await dispatch('priority', { priority: level }, requestId);
    });

  // -- logs ---------------------------------------------------------------
  program
    .command('logs <request-id>')
    .description('Tail logs for a request')
    .option('--follow', 'Follow log output', false)
    .addOption(
      new Option('--lines <n>', 'Number of lines to show').argParser(parsePositiveInt),
    )
    .action(async (requestId: string, opts: Record<string, unknown>) => {
      await dispatch(
        'logs',
        { follow: opts.follow, lines: opts.lines },
        requestId,
      );
    });

  // -- feedback -----------------------------------------------------------
  program
    .command('feedback <request-id> <message>')
    .description('Submit clarifying feedback')
    .action(async (requestId: string, message: string) => {
      await dispatch('feedback', { message }, requestId);
    });

  // -- kill ---------------------------------------------------------------
  program
    .command('kill <request-id>')
    .description('Force-terminate a request')
    .action(async (requestId: string) => {
      await dispatch('kill', {}, requestId);
    });

  // SPEC-021-1-04: standards subcommand family.
  registerStandardsCommand(program);

  return program;
}

// ---------------------------------------------------------------------------
// Real router initialization (lazy; not invoked under unit tests)
// ---------------------------------------------------------------------------

/**
 * Default location of the sqlite database used by the intake layer.
 * Mirrors the convention used by the daemon and other adapters.
 */
/* istanbul ignore next — exercised only by the production entry point */
function defaultDbPath(): string {
  return path.join(
    process.env.HOME ?? os.homedir(),
    '.autonomous-dev',
    'intake.db',
  );
}

/**
 * Default location of the authz YAML config.
 */
/* istanbul ignore next — exercised only by the production entry point */
function defaultAuthConfigPath(): string {
  return path.join(
    process.env.HOME ?? os.homedir(),
    '.autonomous-dev',
    'intake-auth.yaml',
  );
}

/**
 * Construct a real {@link IntakeRouterLike} backed by the production
 * dependencies: sqlite Repository, AuthzEngine reading
 * `~/.autonomous-dev/intake-auth.yaml`, and RateLimiter.
 *
 * Optional deps (`claudeClient`, `duplicateDetector`, `injectionRules`)
 * are intentionally undefined.
 *
 * TODO(PLAN-011-1): wire claudeClient + duplicateDetector + injectionRules
 * for full submit support. Until then, `submit` will work for code paths
 * that do not require NLP/dedup/sanitization, and fail cleanly otherwise.
 */
/* istanbul ignore next — pulls in sqlite / yaml / authz; covered by integration tests */
export async function initRouter(): Promise<IntakeRouterLike> {
  // Dynamic imports keep these heavy modules out of the unit-test path.
  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const { Repository } = await import('../db/repository');
  const { initializeDatabase } = await import('../db/migrator');
  const { AuthzEngine } = await import('../authz/authz_engine');
  const { AuditLogger } = await import('../authz/audit_logger');
  const { RateLimiter } = await import('../rate_limit/rate_limiter');
  const { IntakeRouter } = await import('../core/intake_router');
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

  const dbPath = defaultDbPath();
  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
  const { db } = initializeDatabase(dbPath, migrationsDir);
  const repo = new Repository(db);

  const auditLogRepo = AuditLogger.fromDatabase(db);
  const auditLogger = new AuditLogger(auditLogRepo, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });

  const authConfigPath = defaultAuthConfigPath();
  const authz = new AuthzEngine(authConfigPath, auditLogger);
  const rateLimiter = new RateLimiter(repo);

  return new IntakeRouter({
    authz,
    rateLimiter,
    db: repo,
    // TODO(PLAN-011-1): wire claudeClient + duplicateDetector + injectionRules
    // for full submit support.
  });
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Parse `argv`, dispatch to the matching subcommand, and exit with the
 * appropriate code:
 *   - 0 on success
 *   - 1 on user error (validation, command failure)
 *   - 2 on system error (anything not classifiable as user error)
 *
 * Exposed for testing — production entrypoint at the bottom of this file
 * calls it with `process.argv` and a real router provider.
 */
export async function main(
  argv: string[],
  routerProvider: () => IntakeRouterLike | Promise<IntakeRouterLike>,
): Promise<number> {
  const program = buildProgram(routerProvider);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof InvalidArgumentError) {
      // commander already printed (for arg validators); for our explicit
      // throw on router failure, the message was already written to stderr.
      // Avoid duplicate output here.
      return 1;
    }
    if (err instanceof CommanderError) {
      // commander already printed help/error text.
      return err.exitCode || 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: ${msg}\n`);
    return 2;
  }
}

// Production invocation. Skipped under jest (which sets NODE_ENV=test by
// default and/or imports without executing the file as `__main__`).
// We use a require-style guard equivalent to Python's `if __name__ == '__main__':`.
// In ESM this is `import.meta.url === pathToFileURL(process.argv[1]).href`,
// but the package is configured as `"type": "module"` only by package.json —
// the actual tsconfig downstream may compile to CJS. We use the safest
// guard: only run when the file is the entry point.
/* istanbul ignore next */
if (
  typeof require !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  require.main === (module as any)
) {
  main(process.argv, initRouter).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`FATAL: ${err?.message ?? String(err)}\n`);
      process.exit(2);
    },
  );
}
