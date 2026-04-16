/**
 * Agent Runtime (SPEC-005-1-3, Tasks 6 and 7).
 *
 * Wraps agent invocation with pre/post hooks that enforce tool access
 * and path restrictions. Two built-in hooks:
 *
 *   - ToolAccessEnforcer: blocks tool calls not in the agent's `tools` array.
 *   - PathFilter: blocks file operations targeting protected directories.
 *
 * All blocked operations are logged to the audit log.
 */

import * as path from 'path';
import {
  AgentRecord,
  RuntimeHook,
  HookContext,
  HookResult,
  RuntimeContext,
  RuntimeResult,
  ToolCallInterception,
} from './types';
import { AuditLogger } from './audit';

// ---------------------------------------------------------------------------
// Protected path patterns
// ---------------------------------------------------------------------------

/**
 * Path patterns that are protected from agent write operations.
 * These are relative to the working directory.
 */
const PROTECTED_PATTERNS: string[] = [
  'agents',
  'data/agent-',
  'data/metrics',
];

// ---------------------------------------------------------------------------
// ToolAccessEnforcer
// ---------------------------------------------------------------------------

/**
 * Pre-tool-call hook that enforces tool access based on the agent's `tools` list.
 *
 * Before every tool call, checks if the tool name is in the agent's `tools` array.
 * Blocked calls are logged to the audit log.
 */
export class ToolAccessEnforcer implements RuntimeHook {
  readonly name = 'ToolAccessEnforcer';
  readonly phase = 'pre_tool_call' as const;

  private auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this.auditLogger = auditLogger;
  }

  execute(context: HookContext): HookResult {
    const { agent, toolName } = context;

    if (!agent.tools.includes(toolName)) {
      const reason = `Tool '${toolName}' is not authorized for agent '${agent.name}' (role: ${agent.role})`;

      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'tool_call_blocked',
        agent_name: agent.name,
        details: {
          tool: toolName,
          reason,
        },
      });

      return { allowed: false, reason: 'Tool not authorized' };
    }

    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// PathFilter
// ---------------------------------------------------------------------------

/**
 * Pre-tool-call hook that blocks file operations targeting protected directories.
 *
 * Only applies to file-operation tools: Bash, Edit, Write.
 * Extracts the target path, resolves it against the working directory,
 * and checks against protected path patterns.
 */
export class PathFilter implements RuntimeHook {
  readonly name = 'PathFilter';
  readonly phase = 'pre_tool_call' as const;

  private auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this.auditLogger = auditLogger;
  }

  execute(context: HookContext): HookResult {
    const { toolName } = context;

    // Only filter file-operation tools
    if (!['Bash', 'Edit', 'Write'].includes(toolName)) {
      return { allowed: true };
    }

    const targetPaths = extractTargetPaths(toolName, context.toolArgs, context.workingDirectory);

    for (const targetPath of targetPaths) {
      // Resolve to absolute path, then make relative to working directory
      const absolutePath = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(context.workingDirectory, targetPath);

      const relativePath = path.relative(context.workingDirectory, absolutePath);

      // Normalize: remove leading ./ and trailing /
      const normalized = relativePath.replace(/^\.\//, '').replace(/\/$/, '');

      for (const pattern of PROTECTED_PATTERNS) {
        if (matchesProtectedPattern(normalized, pattern)) {
          const reason = `Access to '${targetPath}' is blocked (protected path)`;

          this.auditLogger.log({
            timestamp: new Date().toISOString(),
            event_type: 'path_access_blocked',
            agent_name: context.agent.name,
            details: {
              tool: toolName,
              targetPath,
              normalizedPath: normalized,
              pattern,
            },
          });

          return { allowed: false, reason };
        }
      }
    }

    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// AgentRuntime
// ---------------------------------------------------------------------------

/**
 * Wraps agent execution with pre/post hooks for tool call interception.
 *
 * The runtime does not execute the agent model itself; it provides the
 * interception layer that must be integrated with the actual invocation
 * mechanism. Use `checkToolCall()` before each tool execution.
 *
 * Usage:
 * ```ts
 * const runtime = new AgentRuntime(agentRecord, auditLogger, [
 *   new ToolAccessEnforcer(auditLogger),
 *   new PathFilter(auditLogger),
 * ]);
 *
 * const result = runtime.checkToolCall('Edit', { file_path: 'agents/foo.md' }, '/project');
 * if (!result.allowed) {
 *   // Block the tool call
 * }
 * ```
 */
export class AgentRuntime {
  private agent: AgentRecord;
  private auditLogger: AuditLogger;
  private hooks: RuntimeHook[];
  private interceptLog: ToolCallInterception[] = [];
  private toolCallsBlocked = 0;
  private toolCallsAllowed = 0;

  constructor(
    agent: AgentRecord,
    auditLogger: AuditLogger,
    hooks: RuntimeHook[],
  ) {
    this.agent = agent;
    this.auditLogger = auditLogger;
    this.hooks = hooks;
  }

  /**
   * Check whether a tool call should be allowed or blocked.
   *
   * Runs all pre_tool_call hooks in order. The first hook that returns
   * `allowed: false` blocks the call (short-circuit).
   *
   * @param toolName         The name of the tool being called.
   * @param toolArgs         The arguments to the tool call.
   * @param workingDirectory The current working directory for path resolution.
   * @returns                HookResult indicating whether the call is allowed.
   */
  checkToolCall(
    toolName: string,
    toolArgs: Record<string, unknown>,
    workingDirectory: string,
  ): HookResult {
    const context: HookContext = {
      agent: this.agent.agent,
      toolName,
      toolArgs,
      workingDirectory,
    };

    for (const hook of this.hooks) {
      if (hook.phase !== 'pre_tool_call') continue;

      const result = hook.execute(context);

      const interception: ToolCallInterception = {
        toolName,
        allowed: result.allowed,
        reason: result.reason,
        hookName: hook.name,
        timestamp: new Date().toISOString(),
      };
      this.interceptLog.push(interception);

      if (!result.allowed) {
        this.toolCallsBlocked++;
        return result;
      }
    }

    this.toolCallsAllowed++;
    return { allowed: true };
  }

  /**
   * Invoke the agent with the given input and context.
   *
   * This is the high-level invocation method. In this implementation it
   * validates pre-invoke hooks and returns a RuntimeResult with metrics.
   * Actual model invocation would be plugged in by the orchestrator.
   *
   * @param input    The input text/prompt for the agent.
   * @param context  Runtime context (working directory, session info).
   * @returns        RuntimeResult with execution metrics.
   */
  async invoke(input: string, context: RuntimeContext): Promise<RuntimeResult> {
    const startTime = Date.now();

    // Run pre_invoke hooks
    const hookContext: HookContext = {
      agent: this.agent.agent,
      toolName: '',
      toolArgs: {},
      workingDirectory: context.workingDirectory,
    };

    for (const hook of this.hooks) {
      if (hook.phase !== 'pre_invoke') continue;
      const result = hook.execute(hookContext);
      if (!result.allowed) {
        return {
          success: false,
          output: `Invocation blocked by ${hook.name}: ${result.reason}`,
          toolCallsBlocked: this.toolCallsBlocked,
          toolCallsAllowed: this.toolCallsAllowed,
          duration_ms: Date.now() - startTime,
        };
      }
    }

    // Agent execution would happen here in the full system.
    // For now, return a success result with the metrics gathered so far.
    return {
      success: true,
      output: undefined,
      toolCallsBlocked: this.toolCallsBlocked,
      toolCallsAllowed: this.toolCallsAllowed,
      duration_ms: Date.now() - startTime,
    };
  }

  /**
   * Return the full interception log for this runtime instance.
   */
  getInterceptLog(): ToolCallInterception[] {
    return [...this.interceptLog];
  }

  /**
   * Return the underlying agent record.
   */
  getAgent(): AgentRecord {
    return this.agent;
  }
}

// ---------------------------------------------------------------------------
// Path extraction utilities
// ---------------------------------------------------------------------------

/**
 * Extract target file paths from tool arguments based on the tool type.
 *
 * - Edit: extracts `file_path` parameter
 * - Write: extracts `file_path` parameter
 * - Bash: extracts file paths from command string using regex
 *
 * @param toolName         The tool name.
 * @param toolArgs         The tool arguments.
 * @param workingDirectory The current working directory.
 * @returns                Array of extracted file paths (may be empty).
 */
function extractTargetPaths(
  toolName: string,
  toolArgs: Record<string, unknown>,
  workingDirectory: string,
): string[] {
  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolArgs['file_path'];
    if (typeof filePath === 'string' && filePath.length > 0) {
      return [filePath];
    }
    return [];
  }

  if (toolName === 'Bash') {
    const command = toolArgs['command'];
    if (typeof command === 'string') {
      return extractPathsFromBashCommand(command);
    }
    return [];
  }

  return [];
}

/**
 * Extract file paths from a Bash command string.
 *
 * Matches common file operation patterns:
 *   - cd <path>
 *   - cat/head/tail <path>
 *   - echo ... > <path> / echo ... >> <path>
 *   - rm/rm -rf <path>
 *   - mv <src> <dst>
 *   - cp <src> <dst>
 *   - touch <path>
 *   - ls <path>
 *
 * For ambiguous commands, extracts any tokens that look like file paths.
 */
function extractPathsFromBashCommand(command: string): string[] {
  const paths: string[] = [];

  // Pattern: cd <path>
  const cdMatch = command.match(/\bcd\s+([^\s;&|]+)/);
  if (cdMatch) {
    paths.push(cdMatch[1]);
  }

  // Pattern: cat/head/tail/less/more <path>
  const readCmdMatch = command.match(/\b(?:cat|head|tail|less|more)\s+([^\s;&|]+)/g);
  if (readCmdMatch) {
    for (const match of readCmdMatch) {
      const parts = match.split(/\s+/);
      if (parts.length >= 2) {
        paths.push(parts[parts.length - 1]);
      }
    }
  }

  // Pattern: echo ... > <path> or echo ... >> <path>
  const redirectMatch = command.match(/>{1,2}\s*([^\s;&|]+)/g);
  if (redirectMatch) {
    for (const match of redirectMatch) {
      const target = match.replace(/^>{1,2}\s*/, '').trim();
      if (target) paths.push(target);
    }
  }

  // Pattern: rm/rm -rf <path>
  const rmMatch = command.match(/\brm\s+(?:-[a-zA-Z]*\s+)?([^\s;&|]+)/g);
  if (rmMatch) {
    for (const match of rmMatch) {
      const parts = match.split(/\s+/).filter((p) => !p.startsWith('-') && p !== 'rm');
      if (parts.length > 0) {
        paths.push(parts[parts.length - 1]);
      }
    }
  }

  // Pattern: mv <src> <dst>
  const mvMatch = command.match(/\bmv\s+(?:-[a-zA-Z]*\s+)?([^\s;&|]+)\s+([^\s;&|]+)/);
  if (mvMatch) {
    paths.push(mvMatch[1], mvMatch[2]);
  }

  // Pattern: cp <src> <dst>
  const cpMatch = command.match(/\bcp\s+(?:-[a-zA-Z]*\s+)?([^\s;&|]+)\s+([^\s;&|]+)/);
  if (cpMatch) {
    paths.push(cpMatch[1], cpMatch[2]);
  }

  // Pattern: touch <path>
  const touchMatch = command.match(/\btouch\s+([^\s;&|]+)/);
  if (touchMatch) {
    paths.push(touchMatch[1]);
  }

  return paths;
}

/**
 * Check if a normalized relative path matches a protected pattern.
 *
 * Matching rules:
 *   - 'agents': matches 'agents' exactly or any path starting with 'agents/'
 *   - 'data/agent-': matches any path starting with 'data/agent-'
 *   - 'data/metrics': matches 'data/metrics' exactly or any path starting with 'data/metrics/'
 */
function matchesProtectedPattern(normalizedPath: string, pattern: string): boolean {
  // Exact match
  if (normalizedPath === pattern) return true;

  // Pattern for prefix-style matching (like 'data/agent-')
  if (pattern.endsWith('-')) {
    return normalizedPath.startsWith(pattern);
  }

  // Pattern for directory-style matching (like 'agents' or 'data/metrics')
  if (normalizedPath.startsWith(pattern + '/')) return true;

  return false;
}
