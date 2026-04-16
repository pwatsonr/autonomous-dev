/**
 * Claude Command Bridge -- wires slash commands to the IntakeRouter.
 *
 * Translates raw command invocations into typed {@link IncomingCommand}
 * objects, runs adapter-level validation, resolves user identity, routes
 * through the {@link IntakeRouter}, and formats the results for terminal
 * output.
 *
 * Implements SPEC-008-2-04, Task 8.
 *
 * @module claude_command_bridge
 */

import type {
  IncomingCommand,
  CommandResult,
  ErrorResponse,
} from './adapter_interface';
import type { ClaudeIdentityResolver } from './claude_identity';
import { ValidationError, parseCommandArgs } from './claude_arg_parser';
import type { ValidationFn, IntakeRouter, CLIFormatter } from './claude_adapter';

// ---------------------------------------------------------------------------
// ClaudeCommandBridge
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
