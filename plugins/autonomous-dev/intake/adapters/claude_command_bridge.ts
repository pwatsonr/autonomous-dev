/**
 * Claude Command Bridge -- wires Claude App slash commands to the IntakeRouter.
 *
 * This module exposes two surfaces:
 *
 *   1. {@link ClaudeCommandBridge} class -- in-process bridge used by the
 *      ClaudeAdapter (SPEC-008-2-04, Task 8) and by integration tests
 *      (`claude_app_e2e.test.ts`).  It accepts already-parsed args/flags and
 *      routes through an injected IntakeRouter.
 *
 *   2. CLI entrypoint -- when this module is invoked as
 *      `node dist/intake/adapters/claude_command_bridge.js <subcommand> [args...]`
 *      from the bash proxy in `commands/_shared/bridge_proxy.sh`
 *      (SPEC-011-2-01), `main(argv)` is executed.  It parses env vars,
 *      validates the subcommand, builds an IncomingCommand, dispatches to a
 *      lazily-initialised IntakeRouter, and emits a JSON envelope on stdout.
 *
 * SPEC-011-2-02 IncomingCommand mapping note
 * -------------------------------------------
 * The spec (§"Type Definitions") proposes an IncomingCommand shape of
 * `{subcommand, args: Record<string, string|number|boolean>, source: CommandSource}`.
 * The canonical shape already in `adapter_interface.ts` (SPEC-008-1) is
 * `{commandName, args: string[], flags: Record<string, string|boolean>,
 *   rawText, source: { channelType, userId, timestamp, ... }}`.
 *
 * Per the implementation contract for PLAN-011-2 we mirror the existing
 * cli adapter mapping (PLAN-011-1) and reconcile as follows:
 *
 *   - spec `subcommand`           -> canonical `commandName`
 *   - spec `args.request_id`      -> canonical `args[0]` (when present)
 *   - spec `args` (Record)        -> canonical `flags`; numbers/strings
 *                                    coerced to string, booleans kept as
 *                                    booleans, undefined values omitted
 *   - canonical `source.channelType` is always `'claude_app'` (underscore)
 *     even though the SPEC's CommandSource type uses `'claude-app'` (hyphen)
 *     -- the canonical ChannelType union is the source of truth here
 *   - canonical `rawText` is reconstructed from process.argv so the router
 *     audit trail captures what the user actually typed
 *
 * Errors flow through {@link BridgeError} and are emitted on stdout as a
 * spec-shaped {@link CliErrorEnvelope} JSON object.  Exit codes follow the
 * mapping in SPEC-011-2-02 §"Error -> exit-code mapping".
 *
 * Implements SPEC-008-2-04, Task 8 (existing class) and SPEC-011-2-02
 * (CLI entrypoint).
 *
 * @module claude_command_bridge
 */

import * as path from 'path';

import type {
  IncomingCommand,
  CommandResult,
  ErrorResponse,
  ChannelType,
} from './adapter_interface';
import type { ClaudeIdentityResolver } from './claude_identity';
import { ValidationError, parseCommandArgs } from './claude_arg_parser';
import type { ValidationFn, IntakeRouter, CLIFormatter } from './claude_adapter';

// ---------------------------------------------------------------------------
// ClaudeCommandBridge (existing in-process surface, SPEC-008-2-04)
// ---------------------------------------------------------------------------

/**
 * Bridge between Claude Code slash command callbacks and the IntakeRouter.
 *
 * Pipeline per invocation:
 * 1. Parse raw argument string into structured args/flags.
 * 2. Run adapter-level validation for the command.
 * 3. Resolve user identity via {@link ClaudeIdentityResolver}.
 * 4. Construct a typed {@link IncomingCommand}.
 * 5. Route through {@link IntakeRouter}.
 * 6. Format the result for terminal output.
 *
 * All errors (validation, authz, rate limit, unexpected) are formatted
 * via the {@link CLIFormatter} and returned as plain strings.
 */
export class ClaudeCommandBridge {
  constructor(
    private router: IntakeRouter,
    private identityResolver: ClaudeIdentityResolver,
    private argParser: typeof parseCommandArgs,
    private formatter: CLIFormatter,
    private validators: Record<string, ValidationFn>,
  ) {}

  /**
   * Handle a command invocation from a slash command callback.
   *
   * @param commandName  The fully qualified command name (e.g., `autonomous-dev:submit`).
   * @param rawArgs      The raw argument string typed by the user.
   * @returns A formatted string for terminal output.
   */
  async handleCommand(commandName: string, rawArgs: string): Promise<string> {
    try {
      // 1. Parse arguments
      const { args, flags } = this.argParser(rawArgs);

      // 2. Validate at adapter level
      const shortName = commandName.replace('autonomous-dev:', '');
      const validator = this.validators[shortName];
      if (validator) {
        try {
          validator(args, flags);
        } catch (err) {
          if (err instanceof ValidationError) {
            return this.formatter.formatError({
              success: false,
              error: err.message,
              errorCode: 'VALIDATION_ERROR',
            }).fallbackText;
          }
          throw err;
        }
      }

      // 3. Resolve user identity
      const userId = await this.identityResolver.resolve();

      // 4. Construct IncomingCommand
      const command: IncomingCommand = {
        commandName: shortName,
        args,
        flags,
        rawText: rawArgs,
        source: {
          channelType: 'claude_app',
          userId,
          timestamp: new Date(),
        },
      };

      // 5. Route through IntakeRouter
      const result = await this.router.route(command);

      // 6. Format result
      if (result.success) {
        return this.formatSuccess(shortName, result);
      } else {
        return this.formatter.formatError(result as ErrorResponse).fallbackText;
      }
    } catch (error) {
      // Catch validation errors from arg parser (unclosed quotes, empty flag names)
      if (error instanceof ValidationError) {
        return this.formatter.formatError({
          success: false,
          error: (error as Error).message,
          errorCode: 'VALIDATION_ERROR',
        }).fallbackText;
      }

      // Unexpected errors -> generic message
      return this.formatter.formatError({
        success: false,
        error: 'An internal error occurred.',
        errorCode: 'INTERNAL_ERROR',
      }).fallbackText;
    }
  }

  /**
   * Format a successful command result for terminal output.
   *
   * Dispatches to the appropriate formatter method based on command name.
   *
   * @param commandName  The short command name (without `autonomous-dev:` prefix).
   * @param result       The successful command result.
   * @returns Formatted string for terminal output.
   */
  private formatSuccess(commandName: string, result: CommandResult): string {
    switch (commandName) {
      case 'submit':
        return this.formatter.formatSubmitSuccess(result.data).payload as string;
      case 'status':
        return this.formatter.formatStatusCard(result.data).payload as string;
      case 'list':
        return this.formatter.formatList(result.data).payload as string;
      default:
        return this.formatter.formatGenericSuccess(result).payload as string;
    }
  }
}

// ===========================================================================
// CLI entrypoint surface (SPEC-011-2-02)
// ===========================================================================

// ---------------------------------------------------------------------------
// Subcommand allowlist
// ---------------------------------------------------------------------------

/** The 10 subcommands accepted by the CLI entrypoint. */
export const ALLOWED_SUBCOMMANDS = [
  'submit',
  'status',
  'list',
  'cancel',
  'pause',
  'resume',
  'priority',
  'logs',
  'feedback',
  'kill',
] as const;

/** Union of allowed subcommand strings. */
export type AllowedSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

/**
 * Subcommands that take their first positional argument as the request_id.
 * Used to map argv[1] into canonical IncomingCommand.args[0].
 */
const FIRST_POSITIONAL_IS_REQUEST_ID = new Set<AllowedSubcommand>([
  'status',
  'cancel',
  'pause',
  'resume',
  'priority',
  'logs',
  'feedback',
  'kill',
]);

// ---------------------------------------------------------------------------
// CLI error envelope (spec-shaped JSON, written to stdout)
// ---------------------------------------------------------------------------

/** The 6 errorCode values surfaced by the CLI entrypoint (SPEC-011-2-02). */
export type CliErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_SUBCOMMAND'
  | 'MODULE_NOT_FOUND'
  | 'DATABASE_CONNECTION'
  | 'VERSION_MISMATCH'
  | 'INTERNAL_ERROR';

/** JSON envelope written to stdout on error. */
export interface CliErrorEnvelope {
  ok: false;
  errorCode: CliErrorCode;
  message: string;
  resolution?: string;
}

/** JSON envelope written to stdout on success. */
export interface CliSuccessEnvelope {
  ok: true;
  data: unknown;
}

/**
 * Strongly-typed bridge error.  Caught by {@link main} and serialised as a
 * {@link CliErrorEnvelope} on stdout, then mapped to an exit code via
 * {@link EXIT_CODE_BY_ERROR}.
 */
export class BridgeError extends Error {
  public readonly code: CliErrorCode;
  public readonly resolution?: string;

  constructor(code: CliErrorCode, message: string, resolution?: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.resolution = resolution;
  }
}

/** SPEC-011-2-02 §"Error -> exit-code mapping". */
export const EXIT_CODE_BY_ERROR: Record<CliErrorCode, number> = {
  INVALID_ARGUMENT: 1,
  UNKNOWN_SUBCOMMAND: 1,
  MODULE_NOT_FOUND: 2,
  DATABASE_CONNECTION: 2,
  VERSION_MISMATCH: 2,
  INTERNAL_ERROR: 2,
};

// ---------------------------------------------------------------------------
// Argument parsing for argv passed by bridge_proxy.sh
// ---------------------------------------------------------------------------

/** Result of parsing argv after the subcommand has been removed. */
export interface ParsedArgv {
  /** Positional values, in order. */
  positionals: string[];
  /** Flag map: --key=value -> string, --flag -> true. */
  flags: Record<string, string | boolean>;
}

/**
 * Parse the CLI args (after the subcommand has been shifted off).
 *
 * Recognises:
 *   - `--key=value`  -> flags[key] = value
 *   - `--key value`  -> flags[key] = value
 *   - `--flag`       -> flags[flag] = true
 *   - bare positionals -> appended to positionals[]
 *
 * Throws {@link BridgeError} (INVALID_ARGUMENT) on:
 *   - empty flag name (e.g. `--=value` or `--`)
 *   - flag name containing whitespace
 */
export function parseSubcommandArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.length === 0) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          `Empty flag name in argument: '${tok}'.`,
          'Use --key=value or --flag.',
        );
      }
      const eq = body.indexOf('=');
      if (eq === -1) {
        // --flag form: peek next token; if it exists and does not start with --,
        // treat it as the value.  Otherwise treat as boolean true.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          if (body.length === 0) {
            throw new BridgeError(
              'INVALID_ARGUMENT',
              `Empty flag name in argument: '${tok}'.`,
            );
          }
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = true;
        }
      } else {
        const key = body.slice(0, eq);
        const value = body.slice(eq + 1);
        if (key.length === 0) {
          throw new BridgeError(
            'INVALID_ARGUMENT',
            `Empty flag name in argument: '${tok}'.`,
          );
        }
        flags[key] = value;
      }
    } else {
      positionals.push(tok);
    }
  }

  return { positionals, flags };
}

// ---------------------------------------------------------------------------
// Per-subcommand argument validation (very thin -- leaves richer rules to
// the canonical VALIDATORS in claude_adapter.ts when the bridge is called
// in-process)
// ---------------------------------------------------------------------------

/**
 * Validate parsed argv against per-subcommand requirements.
 *
 * Checks only what the bash-proxy contract guarantees:
 *   - required positionals are present
 *   - no unknown flags slip through (flags are matched against
 *     `arg_schemas.yaml` keys)
 *   - enum-typed flags hold one of their allowed values
 *
 * Throws {@link BridgeError} (INVALID_ARGUMENT) on violation.
 */
export function validateSubcommandArgs(
  subcommand: AllowedSubcommand,
  parsed: ParsedArgv,
): void {
  const { positionals, flags } = parsed;
  const knownFlags = KNOWN_FLAGS_BY_SUBCOMMAND[subcommand];

  // Required positionals
  switch (subcommand) {
    case 'submit': {
      const hasDescription =
        flags.description !== undefined || positionals.length > 0;
      if (!hasDescription) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          "Missing required argument 'description' for subcommand 'submit'.",
          'Provide --description="..." or pass it as the first positional.',
        );
      }
      if (
        flags.priority !== undefined &&
        !['high', 'normal', 'low'].includes(String(flags.priority))
      ) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          `Invalid value '${flags.priority}' for --priority. ` +
            "Allowed: high, normal, low.",
        );
      }
      break;
    }
    case 'status':
    case 'cancel':
    case 'pause':
    case 'resume':
    case 'logs':
    case 'kill': {
      const hasRequestId =
        flags.request_id !== undefined || positionals.length > 0;
      if (!hasRequestId) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          `Missing required argument 'request_id' for subcommand '${subcommand}'.`,
          'Provide --request_id=REQ-NNNNNN or pass it as the first positional.',
        );
      }
      break;
    }
    case 'priority': {
      const hasRequestId =
        flags.request_id !== undefined || positionals.length > 0;
      if (!hasRequestId) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          "Missing required argument 'request_id' for subcommand 'priority'.",
        );
      }
      const priorityValue =
        flags.priority !== undefined
          ? String(flags.priority)
          : positionals[1];
      if (priorityValue === undefined) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          "Missing required argument 'priority' for subcommand 'priority'.",
        );
      }
      if (!['high', 'normal', 'low'].includes(priorityValue)) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          `Invalid priority value '${priorityValue}'. ` +
            "Allowed: high, normal, low.",
        );
      }
      break;
    }
    case 'feedback': {
      const hasRequestId =
        flags.request_id !== undefined || positionals.length > 0;
      const hasMessage =
        flags.message !== undefined || positionals.length > 1;
      if (!hasRequestId) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          "Missing required argument 'request_id' for subcommand 'feedback'.",
        );
      }
      if (!hasMessage) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          "Missing required argument 'message' for subcommand 'feedback'.",
        );
      }
      break;
    }
    case 'list': {
      if (
        flags.state !== undefined &&
        !['active', 'completed', 'all'].includes(String(flags.state))
      ) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          `Invalid value '${flags.state}' for --state. ` +
            "Allowed: active, completed, all.",
        );
      }
      break;
    }
  }

  // Unknown flags
  for (const k of Object.keys(flags)) {
    if (!knownFlags.has(k)) {
      throw new BridgeError(
        'INVALID_ARGUMENT',
        `Unknown flag '--${k}' for subcommand '${subcommand}'.`,
        `Allowed flags: ${[...knownFlags].map((f) => '--' + f).join(', ')}`,
      );
    }
  }
}

/** Allowed flag keys per subcommand (mirrors `arg_schemas.yaml`). */
const KNOWN_FLAGS_BY_SUBCOMMAND: Record<AllowedSubcommand, Set<string>> = {
  submit: new Set(['description', 'priority', 'repo', 'deadline']),
  status: new Set(['request_id']),
  list: new Set(['state', 'limit']),
  cancel: new Set(['request_id']),
  pause: new Set(['request_id']),
  resume: new Set(['request_id']),
  priority: new Set(['request_id', 'priority']),
  logs: new Set(['request_id', 'lines']),
  feedback: new Set(['request_id', 'message']),
  kill: new Set(['request_id']),
};

// ---------------------------------------------------------------------------
// Mapping spec args -> canonical IncomingCommand (args[]/flags{})
// ---------------------------------------------------------------------------

/**
 * Translate the spec's argv shape into the canonical IncomingCommand
 * args/flags pair used by the existing IntakeRouter.
 *
 * Rules (see header comment for the full mapping):
 *   - if the subcommand's first positional is a request_id, lift it (or
 *     `--request_id`) into args[0]
 *   - all other parsed values become flags; numbers are kept as-is by
 *     parseSubcommandArgv (we receive strings) and undefined is omitted
 *
 * Returns `{ args, flags }` ready to drop into IncomingCommand.
 */
export function mapToCanonicalArgs(
  subcommand: AllowedSubcommand,
  parsed: ParsedArgv,
): { args: string[]; flags: Record<string, string | boolean> } {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = { ...parsed.flags };

  if (FIRST_POSITIONAL_IS_REQUEST_ID.has(subcommand)) {
    const requestId =
      flags.request_id !== undefined
        ? String(flags.request_id)
        : parsed.positionals[0];
    if (requestId !== undefined) {
      args.push(requestId);
      delete flags.request_id;
    }
    if (subcommand === 'priority') {
      const priorityValue =
        flags.priority !== undefined
          ? String(flags.priority)
          : parsed.positionals[1];
      if (priorityValue !== undefined) {
        args.push(priorityValue);
        delete flags.priority;
      }
    }
    if (subcommand === 'feedback') {
      const message =
        flags.message !== undefined
          ? String(flags.message)
          : parsed.positionals[1];
      if (message !== undefined) {
        args.push(message);
        delete flags.message;
      }
    }
  } else if (subcommand === 'submit') {
    // For submit, the first positional is the description if --description
    // was not passed.  Mirrors VALIDATORS.submit which reads args[0].
    const description =
      flags.description !== undefined
        ? String(flags.description)
        : parsed.positionals[0];
    if (description !== undefined) {
      args.push(description);
      delete flags.description;
    }
  }
  // For 'list' and any other subcommand without positional mapping, we
  // simply leave args empty and pass everything through as flags.

  // Coerce non-boolean flag values to strings; booleans pass through.
  for (const k of Object.keys(flags)) {
    const v = flags[k];
    if (typeof v !== 'boolean') {
      flags[k] = String(v);
    }
  }

  return { args, flags };
}

// ---------------------------------------------------------------------------
// Router lazy initialisation (mirrors PLAN-011-1 cli_adapter pattern)
// ---------------------------------------------------------------------------

/**
 * Build an IntakeRouter wired with the minimum production-grade
 * dependencies.  Optional deps that need richer wiring (NLP client,
 * duplicate detector, injection rules) are left undefined and tagged
 * with TODOs so a future agent can complete the pipeline without
 * having to re-discover the seam.
 *
 * Throws by re-throwing -- the caller (main) wraps `MODULE_NOT_FOUND`
 * and `SQLITE_*` errors into typed BridgeErrors.
 */
/* istanbul ignore next -- production router init; covered by integration tests, not unit tests */
export async function initRouter(): Promise<IntakeRouter> {
  // Resolve plugin root from this module's compiled location:
  // dist/intake/adapters/claude_command_bridge.js -> ../../../
  const pluginDir = path.resolve(__dirname, '..', '..', '..');

  // Lazy require so MODULE_NOT_FOUND surfaces here at the call site.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { IntakeRouter: IntakeRouterCtor } = require(
    path.join(pluginDir, 'dist', 'intake', 'core', 'intake_router.js'),
  ) as typeof import('../core/intake_router');
  const { Repository } = require(
    path.join(pluginDir, 'dist', 'intake', 'db', 'repository.js'),
  ) as typeof import('../db/repository');
  const { initializeDatabase } = require(
    path.join(pluginDir, 'dist', 'intake', 'db', 'migrator.js'),
  ) as typeof import('../db/migrator');
  const { AuditLogger } = require(
    path.join(pluginDir, 'dist', 'intake', 'authz', 'audit_logger.js'),
  ) as typeof import('../authz/audit_logger');
  const { AuthzEngine } = require(
    path.join(pluginDir, 'dist', 'intake', 'authz', 'authz_engine.js'),
  ) as typeof import('../authz/authz_engine');
  const { RateLimiter } = require(
    path.join(pluginDir, 'dist', 'intake', 'rate_limit', 'rate_limiter.js'),
  ) as typeof import('../rate_limit/rate_limiter');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const dbPath =
    process.env.AUTONOMOUS_DEV_DB ??
    path.join(
      process.env.HOME ?? '/tmp',
      '.autonomous-dev',
      'intake.sqlite3',
    );
  const migrationsDir = path.join(pluginDir, 'intake', 'db', 'migrations');

  const { db } = initializeDatabase(dbPath, migrationsDir);
  const repo = new Repository(db);

  const auditLogRepo = AuditLogger.fromDatabase(db);
  const auditLogger = new AuditLogger(auditLogRepo, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const authConfigPath =
    process.env.AUTONOMOUS_DEV_AUTH_CONFIG ??
    path.join(pluginDir, 'config', 'intake-auth.yaml');
  const authz = new AuthzEngine(authConfigPath, auditLogger);
  const rateLimiter = new RateLimiter(repo);

  const router = new IntakeRouterCtor({
    authz,
    rateLimiter,
    db: repo,
    // TODO(PLAN-011-2): wire optional deps (claudeClient, duplicateDetector,
    //                   injectionRules) once the bridge is invoked end-to-end
    //                   from the bash proxy and SubmitHandler needs them.
  });

  return router as unknown as IntakeRouter;
}

// ---------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------

/**
 * Check that the runtime version matches `AUTONOMOUS_DEV_EXPECTED_VERSION`.
 *
 * If the env var is unset, the check is skipped.  Otherwise a mismatch
 * throws {@link BridgeError} (VERSION_MISMATCH).
 */
export function checkVersion(): void {
  const expected = process.env.AUTONOMOUS_DEV_EXPECTED_VERSION;
  if (expected === undefined || expected === '') {
    return;
  }

  let actual: string;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const pluginDir = path.resolve(__dirname, '..', '..', '..');
    const pkg = require(path.join(pluginDir, 'package.json'));
    /* eslint-enable @typescript-eslint/no-require-imports */
    actual = String(pkg.version ?? 'unknown');
  } catch {
    actual = 'unknown';
  }

  if (actual !== expected) {
    const pluginDir = path.resolve(__dirname, '..', '..', '..');
    throw new BridgeError(
      'VERSION_MISMATCH',
      `Bridge version ${actual} does not match expected ${expected}.`,
      `cd ${pluginDir} && npm run build`,
    );
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Wrap a thrown error into a typed BridgeError when its shape matches
 * one of the well-known failure modes (see TDD-011 §6.4).
 */
export function classifyError(err: unknown): BridgeError {
  if (err instanceof BridgeError) {
    return err;
  }

  const e = err as { code?: string; name?: string; message?: string };
  const message = e?.message ?? String(err);
  const pluginDir = path.resolve(__dirname, '..', '..', '..');

  // MODULE_NOT_FOUND: thrown by Node's require() when a dependency is missing.
  if (
    e?.code === 'MODULE_NOT_FOUND' ||
    /Cannot find module/i.test(message)
  ) {
    return new BridgeError(
      'MODULE_NOT_FOUND',
      `Required module not installed (${message}).`,
      `cd ${pluginDir} && npm install && npm run build`,
    );
  }

  // DATABASE_CONNECTION: better-sqlite3 emits SQLITE_* error codes.
  if (
    e?.name === 'DatabaseConnectionError' ||
    /SQLITE_/i.test(message)
  ) {
    const dbPath =
      process.env.AUTONOMOUS_DEV_DB ??
      `${process.env.HOME ?? '~'}/.autonomous-dev/intake.sqlite3`;
    return new BridgeError(
      'DATABASE_CONNECTION',
      `SQLite database connection failed: ${message}`,
      `Verify file exists and is writable: ${dbPath}. ` +
        'Check directory permissions; SQLite needs read+write on the file ' +
        'and its parent directory.',
    );
  }

  // Default: internal error (exit 2).
  return new BridgeError(
    'INTERNAL_ERROR',
    `Unexpected internal error: ${message}`,
  );
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Dependencies for {@link main}.  Allows tests to substitute a fake
 * router/identity resolver without spinning up the real DB.
 */
export interface MainDeps {
  /** Builds the IntakeRouter on demand.  Defaults to {@link initRouter}. */
  routerFactory?: () => Promise<IntakeRouter>;
  /** Resolves the userId for the IncomingCommand source. */
  resolveUserId?: () => string | Promise<string>;
}

/**
 * CLI entrypoint -- accepts argv, returns the process exit code.
 *
 * Side effects:
 *   - writes a single JSON envelope to stdout (success or error)
 *   - never writes to stderr (stderr is reserved for the bash proxy)
 *
 * Pipeline:
 *   1. Validate subcommand against ALLOWED_SUBCOMMANDS.
 *   2. Parse remaining argv into positionals/flags.
 *   3. Validate the parsed arguments.
 *   4. Verify version (if AUTONOMOUS_DEV_EXPECTED_VERSION is set).
 *   5. Map to canonical args/flags.
 *   6. Build the IncomingCommand.
 *   7. Initialise the IntakeRouter.
 *   8. Route and emit JSON.
 */
export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<number> {
  // (1) Subcommand validation
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === '') {
    return emitError(
      new BridgeError(
        'UNKNOWN_SUBCOMMAND',
        'No subcommand provided.',
        `Allowed subcommands: ${ALLOWED_SUBCOMMANDS.join(', ')}`,
      ),
    );
  }
  if (!ALLOWED_SUBCOMMANDS.includes(subcommand as AllowedSubcommand)) {
    return emitError(
      new BridgeError(
        'UNKNOWN_SUBCOMMAND',
        `Unknown subcommand '${subcommand}'.`,
        `Allowed subcommands: ${ALLOWED_SUBCOMMANDS.join(', ')}`,
      ),
    );
  }
  const sub = subcommand as AllowedSubcommand;

  try {
    // (2) Parse remaining argv
    const parsed = parseSubcommandArgv(argv.slice(1));

    // (3) Validate
    validateSubcommandArgs(sub, parsed);

    // (4) Version check (after argument validation so version errors do
    //     not mask trivial argv errors).
    checkVersion();

    // (5) Map to canonical args/flags
    const { args, flags } = mapToCanonicalArgs(sub, parsed);

    // (6) Build IncomingCommand
    const channelType: ChannelType = 'claude_app';
    const userId = deps.resolveUserId
      ? await deps.resolveUserId()
      : process.env.CLAUDE_SESSION_ID ?? 'unknown';
    // Reconstruct rawText from the original argv so the audit trail captures
    // exactly what the bash proxy forwarded.
    const rawText = argv.join(' ');
    const command: IncomingCommand = {
      commandName: sub,
      args,
      flags,
      rawText,
      source: {
        channelType,
        userId,
        timestamp: new Date(),
      },
    };

    // (7) Initialise router (lazy: skip if a fake is supplied)
    const router = deps.routerFactory
      ? await deps.routerFactory()
      : await initRouter();

    // (8) Route
    const result = await router.route(command);

    if (result.success) {
      const env: CliSuccessEnvelope = { ok: true, data: result.data };
      process.stdout.write(JSON.stringify(env) + '\n');
      return 0;
    }

    // Router-level errors are mapped onto the CLI envelope.  Spec error
    // codes are a smaller set than the canonical ErrorResponse codes, so
    // we collapse anything we cannot map to INTERNAL_ERROR.
    const env: CliErrorEnvelope = {
      ok: false,
      errorCode: 'INTERNAL_ERROR',
      message: result.error ?? 'Unknown router error.',
    };
    process.stdout.write(JSON.stringify(env) + '\n');
    return EXIT_CODE_BY_ERROR.INTERNAL_ERROR;
  } catch (err) {
    return emitError(classifyError(err));
  }
}

/** Serialise a BridgeError to stdout and return its exit code. */
function emitError(err: BridgeError): number {
  const env: CliErrorEnvelope = {
    ok: false,
    errorCode: err.code,
    message: err.message,
  };
  if (err.resolution !== undefined) {
    env.resolution = err.resolution;
  }
  process.stdout.write(JSON.stringify(env) + '\n');
  return EXIT_CODE_BY_ERROR[err.code];
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

// Only run main() when this file is executed directly (not when imported
// for tests).  This guard relies on Node's `require.main === module` idiom,
// which works with both CommonJS output and ts-jest.
/* istanbul ignore next -- direct-execution dispatch guard; covered by manual verification */
if (require.main === module) {
  // process.argv is [node, scriptPath, subcommand, ...args]; slice off the
  // first two entries before passing to main().
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      // Defensive: classifyError already runs inside main, but if main
      // itself throws synchronously, route through the same envelope so
      // the caller still gets JSON on stdout.
      const wrapped = err instanceof BridgeError
        ? err
        : new BridgeError(
            'INTERNAL_ERROR',
            `Unexpected error during dispatch: ${(err as Error).message}`,
          );
      process.stdout.write(
        JSON.stringify({
          ok: false,
          errorCode: wrapped.code,
          message: wrapped.message,
          ...(wrapped.resolution !== undefined
            ? { resolution: wrapped.resolution }
            : {}),
        }) + '\n',
      );
      process.exit(EXIT_CODE_BY_ERROR[wrapped.code]);
    });
}
