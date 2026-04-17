/**
 * Claude App Adapter — Native adapter and input validation layer.
 *
 * Contains:
 * - {@link ClaudeAdapter} class implementing the {@link IntakeAdapter}
 *   interface for the Claude Code CLI channel (SPEC-008-2-01, Tasks 1 & 2).
 * - All 10 slash command definitions under the `autonomous-dev:` namespace.
 * - Adapter-level input validators that run BEFORE a command reaches the
 *   IntakeRouter (SPEC-008-2-02, Task 9).
 *
 * @module claude_adapter
 */

import * as readline from 'readline';

import type {
  IntakeAdapter,
  AdapterHandle,
  ChannelType,
  MessageTarget,
  FormattedMessage,
  StructuredPrompt,
  UserResponse,
  TimeoutExpired,
  DeliveryReceipt,
  IncomingCommand,
  CommandResult,
  ErrorResponse,
} from './adapter_interface';
import { ValidationError, parseCommandArgs } from './claude_arg_parser';
import type { ClaudeIdentityResolver } from './claude_identity';

// Re-export ValidationError so consumers can catch it from this module.
export { ValidationError };

// ---------------------------------------------------------------------------
// Validation function type
// ---------------------------------------------------------------------------

/**
 * A per-command validation function.
 *
 * @param args  - Positional arguments parsed from the raw command string.
 * @param flags - Named flags parsed from the raw command string.
 * @throws {ValidationError} When validation fails.
 */
export type ValidationFn = (
  args: string[],
  flags: Record<string, string | boolean>,
) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a request ID.
 *
 * A valid request ID matches `REQ-NNNNNN` where `N` is a digit, exactly
 * six digits after the hyphen (e.g. `REQ-000042`).
 *
 * @param id - The request ID string to validate.
 * @throws {ValidationError} When the ID is missing or malformed.
 */
export function validateRequestId(id: string | undefined): void {
  if (!id) {
    throw new ValidationError('Request ID is required.');
  }
  if (!/^REQ-\d{6}$/.test(id)) {
    throw new ValidationError(
      `Invalid request ID format: ${id}. Expected REQ-NNNNNN (e.g., REQ-000042).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-command validators
// ---------------------------------------------------------------------------

/**
 * Map of command name -> validation function.
 *
 * Validators run at the adapter level before the command reaches the router.
 * If a command has no validation requirements, its entry is a no-op.
 */
export const VALIDATORS: Record<string, ValidationFn> = {
  submit: (args, flags) => {
    if (args[0] && args[0].length > 10_000) {
      throw new ValidationError(
        `Description exceeds maximum length of 10,000 characters (received ${args[0].length}).`,
      );
    }
    if (
      flags.priority &&
      !['high', 'normal', 'low'].includes(flags.priority as string)
    ) {
      throw new ValidationError(
        `Invalid priority: ${flags.priority}. Must be high, normal, or low.`,
      );
    }
    if (flags.repo && !/^[\w.-]+\/[\w.-]+$/.test(flags.repo as string)) {
      throw new ValidationError(
        `Invalid repo format: ${flags.repo}. Expected owner/name format.`,
      );
    }
    if (flags.deadline) {
      const d = new Date(flags.deadline as string);
      if (isNaN(d.getTime())) {
        throw new ValidationError(
          `Invalid deadline format: ${flags.deadline}. Expected ISO-8601 date.`,
        );
      }
      if (d.getTime() <= Date.now()) {
        throw new ValidationError('Deadline must be in the future.');
      }
    }
  },

  status: (args) => validateRequestId(args[0]),

  cancel: (args) => validateRequestId(args[0]),

  pause: (args) => validateRequestId(args[0]),

  resume: (args) => validateRequestId(args[0]),

  priority: (args) => {
    validateRequestId(args[0]);
    if (!['high', 'normal', 'low'].includes(args[1])) {
      throw new ValidationError(
        `Invalid priority: ${args[1]}. Must be high, normal, or low.`,
      );
    }
  },

  logs: (args) => validateRequestId(args[0]),

  feedback: (args) => {
    validateRequestId(args[0]);
    if (!args[1] || args[1].length === 0) {
      throw new ValidationError('Feedback message is required.');
    }
  },

  list: () => {
    // No validation needed
  },

  kill: () => {
    // No validation needed
  },
};

// ---------------------------------------------------------------------------
// Forward-declared dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Router interface consumed by the adapter.
 *
 * The concrete implementation is in `intake/core/intake_router.ts`
 * (SPEC-008-1-06). This interface decouples the adapter from the
 * router's concrete class.
 */
export interface IntakeRouter {
  route(command: IncomingCommand): Promise<CommandResult>;
}

/**
 * CLI notification formatter.
 *
 * Renders structured data into ANSI-formatted terminal output. The
 * concrete implementation is in
 * `intake/notifications/formatters/cli_formatter.ts`
 * (SPEC-008-2-03, Task 5).
 */
export interface CLIFormatter {
  formatError(error: ErrorResponse): FormattedMessage;
  formatSubmitSuccess(data: unknown): FormattedMessage;
  formatStatusCard(data: unknown): FormattedMessage;
  formatList(data: unknown): FormattedMessage;
  formatGenericSuccess(result: CommandResult): FormattedMessage;
}

// ---------------------------------------------------------------------------
// Command definition types
// ---------------------------------------------------------------------------

/** Describes a single argument for a command definition. */
export interface ArgDefinition {
  /** Argument name. */
  name: string;
  /** Data type for the argument. */
  type: 'string';
  /** Whether this argument is required. */
  required?: boolean;
  /** Human-readable description shown in help. */
  description?: string;
}

/** Describes a single flag for a command definition. */
export interface FlagDefinition {
  /** Flag name (without the `--` prefix). */
  name: string;
  /** Data type for the flag value. */
  type: 'string' | 'boolean';
  /** Default value when the flag is omitted. */
  default?: string | boolean;
  /** Human-readable description shown in help. */
  description?: string;
}

/** Full definition of a slash command to register. */
export interface CommandDefinition {
  /** Fully qualified command name (e.g., `autonomous-dev:submit`). */
  name: string;
  /** Short description shown in the command palette. */
  description: string;
  /** Positional argument definitions. */
  args?: ArgDefinition[];
  /** Named flag definitions. */
  flags?: FlagDefinition[];
}

// ---------------------------------------------------------------------------
// Command definitions (TDD section 3.2)
// ---------------------------------------------------------------------------

/** All 10 slash commands registered by the Claude App adapter. */
export const COMMANDS: CommandDefinition[] = [
  {
    name: 'autonomous-dev:submit',
    description: 'Submit a new request to the autonomous development pipeline',
    args: [
      {
        name: 'description',
        type: 'string',
        required: true,
        description: 'Natural-language description of the feature or task',
      },
    ],
    flags: [
      {
        name: 'priority',
        type: 'string',
        default: 'normal',
        description: 'Priority level: high, normal, or low',
      },
      {
        name: 'repo',
        type: 'string',
        description:
          'Target repository (defaults to current working directory repo)',
      },
      {
        name: 'deadline',
        type: 'string',
        description: 'ISO-8601 date deadline',
      },
      {
        name: 'force',
        type: 'boolean',
        default: false,
        description: 'Skip duplicate detection confirmation',
      },
    ],
  },
  {
    name: 'autonomous-dev:status',
    description: 'View the current state and progress of a request',
    args: [{ name: 'request-id', type: 'string', required: true }],
  },
  {
    name: 'autonomous-dev:list',
    description: 'List all active requests with their states and priorities',
    flags: [
      { name: 'priority', type: 'string', description: 'Filter by priority' },
      { name: 'status', type: 'string', description: 'Filter by status' },
    ],
  },
  {
    name: 'autonomous-dev:cancel',
    description: 'Cancel a request and clean up all associated artifacts',
    args: [{ name: 'request-id', type: 'string', required: true }],
  },
  {
    name: 'autonomous-dev:pause',
    description: 'Pause a request at the next phase boundary',
    args: [{ name: 'request-id', type: 'string', required: true }],
  },
  {
    name: 'autonomous-dev:resume',
    description: 'Resume a paused request',
    args: [{ name: 'request-id', type: 'string', required: true }],
  },
  {
    name: 'autonomous-dev:priority',
    description: 'Change a request priority',
    args: [
      { name: 'request-id', type: 'string', required: true },
      {
        name: 'level',
        type: 'string',
        required: true,
        description: 'high, normal, or low',
      },
    ],
  },
  {
    name: 'autonomous-dev:logs',
    description: 'View activity log for a request',
    args: [{ name: 'request-id', type: 'string', required: true }],
    flags: [{ name: 'all', type: 'boolean', default: false }],
  },
  {
    name: 'autonomous-dev:feedback',
    description: 'Send feedback or context to an active request',
    args: [
      { name: 'request-id', type: 'string', required: true },
      { name: 'message', type: 'string', required: true },
    ],
  },
  {
    name: 'autonomous-dev:kill',
    description: 'Emergency stop all running requests (admin only)',
    flags: [],
  },
];

// ---------------------------------------------------------------------------
// Plugin command registration interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the Claude Code plugin's command registration API.
 *
 * Injected into the adapter so that tests can supply a mock without
 * depending on the real Claude Code runtime.
 */
export interface PluginCommandRegistry {
  /**
   * Register a slash command with the Claude Code plugin system.
   *
   * @param definition  The command definition (name, description, args, flags).
   * @param callback    The callback invoked when the command is executed.
   *                    Receives the raw argument string typed by the user.
   * @returns A disposable that un-registers the command.
   */
  registerCommand(
    definition: CommandDefinition,
    callback: (rawArgs: string) => Promise<string>,
  ): { dispose(): void };
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

/**
 * Claude App native adapter implementing the {@link IntakeAdapter} interface.
 *
 * Lifecycle:
 * - {@link start} registers all 10 slash commands and returns an
 *   {@link AdapterHandle} for disposal.
 * - While running, each command invocation increments {@link inFlightCount},
 *   runs adapter-level validation, resolves identity, routes through the
 *   {@link IntakeRouter}, formats the result, and decrements in a `finally`
 *   block.
 * - {@link shutdown} sets the {@link shuttingDown} flag and waits up to
 *   10 seconds for in-flight commands to drain before disposing resources.
 * - Any command invoked while {@link shuttingDown} is `true` immediately
 *   returns an error: "System is shutting down."
 *
 * Implements SPEC-008-2-01, Tasks 1 & 2.
 */
export class ClaudeAdapter implements IntakeAdapter {
  readonly channelType: ChannelType = 'claude_app';

  /** Adapter handle returned by {@link start}; `null` before start. */
  private handle: AdapterHandle | null = null;

  /** Set to `true` by {@link shutdown}; new commands are rejected. */
  private shuttingDown = false;

  /** Count of commands currently executing. */
  private inFlightCount = 0;

  /** Disposables for registered commands (used during shutdown). */
  private commandDisposables: Array<{ dispose(): void }> = [];

  constructor(
    private readonly router: IntakeRouter,
    private readonly identityResolver: ClaudeIdentityResolver,
    private readonly formatter: CLIFormatter,
    private readonly registry: PluginCommandRegistry,
  ) {}

  // -----------------------------------------------------------------------
  // IntakeAdapter: start
  // -----------------------------------------------------------------------

  /**
   * Register all 10 slash commands and return a disposable handle.
   *
   * Calling `start()` more than once without an intervening `shutdown()`
   * is idempotent -- the existing handle is returned.
   */
  async start(): Promise<AdapterHandle> {
    if (this.handle) {
      return this.handle;
    }

    this.registerCommands();

    this.handle = {
      dispose: () => this.shutdown(),
    };

    return this.handle;
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: sendMessage (SPEC-008-2-03, Task 6)
  // -----------------------------------------------------------------------

  /**
   * Send a formatted message to the terminal.
   *
   * If `process.stdout.isTTY` is true, writes the ANSI-formatted payload.
   * If false (piped, CI, redirected), writes `fallbackText`.
   * Always appends a newline.
   * Returns `DeliveryReceipt` with `success: true` on success.
   */
  async sendMessage(
    _target: MessageTarget,
    payload: FormattedMessage,
  ): Promise<DeliveryReceipt> {
    try {
      const output = process.stdout.isTTY
        ? (payload.payload as string)
        : payload.fallbackText;
      process.stdout.write(output + '\n');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        retryable: false,
      };
    }
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: promptUser (SPEC-008-2-03, Task 7)
  // -----------------------------------------------------------------------

  /**
   * Prompt the user with a structured question and await a response.
   *
   * - Renders prompt content to stdout.
   * - Renders options as a numbered list when provided.
   * - Waits for stdin input with a timeout.
   * - In non-interactive mode (stdin is not a TTY), immediately returns
   *   `TimeoutExpired` with a logged warning.
   * - Resolves numbered option selections to their corresponding values.
   */
  async promptUser(
    target: MessageTarget,
    prompt: StructuredPrompt,
  ): Promise<UserResponse | TimeoutExpired> {
    const promptedAt = new Date();

    // Non-interactive mode: return timeout immediately
    if (!process.stdin.isTTY) {
      process.stderr.write(
        '[autonomous-dev] Warning: non-interactive mode, prompt timed out immediately.\n',
      );
      return {
        kind: 'timeout',
        requestId: prompt.requestId,
        promptedAt,
        expiredAt: new Date(),
      };
    }

    // Render prompt content
    process.stdout.write(`\n${prompt.content}\n`);

    // Render options as numbered list
    if (prompt.options && prompt.options.length > 0) {
      prompt.options.forEach((opt, i) => {
        process.stdout.write(`  ${i + 1}. ${opt.label}\n`);
      });
      process.stdout.write('\nEnter selection (number or text): ');
    } else {
      process.stdout.write('\nYour response: ');
    }

    // Wait for stdin with timeout
    const response = await readLineWithTimeout(prompt.timeoutSeconds * 1000);

    if (response === null) {
      return {
        kind: 'timeout',
        requestId: prompt.requestId,
        promptedAt,
        expiredAt: new Date(),
      };
    }

    // Resolve option selection
    let selectedOption: string | undefined;
    if (prompt.options) {
      const num = parseInt(response, 10);
      if (!isNaN(num) && num >= 1 && num <= prompt.options.length) {
        selectedOption = prompt.options[num - 1].value;
      }
    }

    return {
      responderId: target.userId ?? 'unknown',
      content: response,
      selectedOption,
      timestamp: new Date(),
    };
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: shutdown
  // -----------------------------------------------------------------------

  /**
   * Gracefully shut down the adapter.
   *
   * 1. Sets {@link shuttingDown} to `true` so new commands are rejected.
   * 2. Waits up to 10 seconds for in-flight commands to complete.
   * 3. Disposes all registered command handlers.
   * 4. Clears the adapter handle.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Wait for in-flight commands to complete (max 10s)
    const deadline = Date.now() + 10_000;
    while (this.inFlightCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Dispose registered commands
    for (const disposable of this.commandDisposables) {
      disposable.dispose();
    }
    this.commandDisposables = [];
    this.handle = null;
  }

  // -----------------------------------------------------------------------
  // Accessors for testing
  // -----------------------------------------------------------------------

  /** Whether the adapter is in the process of shutting down. */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Number of commands currently executing. */
  get currentInFlightCount(): number {
    return this.inFlightCount;
  }

  // -----------------------------------------------------------------------
  // Private: command registration
  // -----------------------------------------------------------------------

  /**
   * Register all 10 commands from the {@link COMMANDS} definitions array.
   *
   * Each command callback follows the pipeline:
   * (a) Check `shuttingDown` -> reject if true.
   * (b) Increment `inFlightCount`.
   * (c) Parse raw args into structured args/flags.
   * (d) Run adapter-level validation.
   * (e) Resolve user identity.
   * (f) Construct `IncomingCommand`.
   * (g) Route through `IntakeRouter`.
   * (h) Format the result.
   * (i) Decrement `inFlightCount` in `finally`.
   */
  private registerCommands(): void {
    for (const definition of COMMANDS) {
      const disposable = this.registry.registerCommand(
        definition,
        (rawArgs: string) => this.handleCommand(definition.name, rawArgs),
      );
      this.commandDisposables.push(disposable);
    }
  }

  /**
   * Handle a single command invocation.
   *
   * This is the callback passed to each registered command. It implements
   * the full pipeline described in the spec's registration pattern.
   *
   * @param fullName  The fully qualified command name (e.g., `autonomous-dev:submit`).
   * @param rawArgs   The raw argument string from the user.
   * @returns The formatted output string for the terminal.
   */
  private async handleCommand(
    fullName: string,
    rawArgs: string,
  ): Promise<string> {
    // (a) Reject if shutting down
    if (this.shuttingDown) {
      return this.formatter.formatError({
        success: false,
        error: 'System is shutting down.',
        errorCode: 'INVALID_STATE',
      }).fallbackText;
    }

    // (b) Track in-flight
    this.inFlightCount++;
    try {
      // (c) Parse args
      const { args, flags } = parseCommandArgs(rawArgs);

      // (d) Adapter-level validation
      const shortName = fullName.replace('autonomous-dev:', '');
      const validator = VALIDATORS[shortName];
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

      // (e) Resolve user identity
      const userId = await this.identityResolver.resolve();

      // (f) Construct IncomingCommand
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

      // (g) Route through IntakeRouter
      const result = await this.router.route(command);

      // (h) Format the result
      if (result.success) {
        return this.formatSuccess(shortName, result);
      } else {
        return this.formatter.formatError({
          success: false,
          error: result.error ?? 'An unknown error occurred.',
          errorCode: result.errorCode ?? 'INTERNAL_ERROR',
          retryAfterMs: result.retryAfterMs,
        }).fallbackText;
      }
    } catch (error) {
      // Catch any unclosed-quote or empty-flag-name parse errors
      if (error instanceof ValidationError) {
        return this.formatter.formatError({
          success: false,
          error: (error as Error).message,
          errorCode: 'VALIDATION_ERROR',
        }).fallbackText;
      }
      // Unexpected errors
      return this.formatter.formatError({
        success: false,
        error: 'An internal error occurred.',
        errorCode: 'INTERNAL_ERROR',
      }).fallbackText;
    } finally {
      // (i) Decrement in-flight count
      this.inFlightCount--;
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
        return this.formatter.formatSubmitSuccess(result.data)
          .payload as string;
      case 'status':
        return this.formatter.formatStatusCard(result.data)
          .payload as string;
      case 'list':
        return this.formatter.formatList(result.data).payload as string;
      default:
        return this.formatter.formatGenericSuccess(result)
          .payload as string;
    }
  }
}

// ---------------------------------------------------------------------------
// readLineWithTimeout (SPEC-008-2-03, Task 7 helper)
// ---------------------------------------------------------------------------

/**
 * Read a single line from stdin with a timeout.
 *
 * Creates a `readline.Interface` on `process.stdin`, uses `Promise.race`
 * between the readline promise and a `setTimeout` promise. Cleans up the
 * readline interface in all cases.
 *
 * @param timeoutMs - Maximum time to wait for input in milliseconds.
 * @returns The line read from stdin, or `null` if the timeout elapsed.
 */
export function readLineWithTimeout(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(null);
      }
    }, timeoutMs);

    rl.once('line', (line: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rl.close();
        resolve(line.trim());
      }
    });

    rl.once('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}
