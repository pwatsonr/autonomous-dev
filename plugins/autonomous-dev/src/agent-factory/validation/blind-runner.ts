/**
 * Blind Runner (SPEC-005-4-1, Task 2).
 *
 * Executes both the current and proposed agent versions against a
 * selected historical input, producing a RunPair for subsequent
 * randomization and blind scoring.
 *
 * Key invariants:
 *   - Both versions are re-run fresh; historical outputs are never reused.
 *   - All invocations are tagged with `environment: 'validation'`.
 *   - Token consumption is tracked cumulatively across all run pairs.
 *   - Failed runs are recorded with an error (never silently dropped).
 *
 * Exports: `BlindRunner`
 */

import * as crypto from 'crypto';
import type { AgentRecord, ParsedAgent } from '../types';
import type { ToolCallRecord } from '../metrics/types';
import type { SelectedInput, RunResult, RunPair, TokenTracker } from './types';

// ---------------------------------------------------------------------------
// Agent invoker interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the actual agent invocation mechanism.
 *
 * The BlindRunner does not invoke agents directly -- it delegates to an
 * AgentInvoker provided at construction time.  This enables testing with
 * mock invokers and decouples from the concrete runtime.
 */
export interface AgentInvoker {
  invoke(agent: AgentRecord, input: string): Promise<InvokeResult>;
}

/** Raw result returned by the agent invoker. */
export interface InvokeResult {
  success: boolean;
  output: string;
  input_tokens: number;
  output_tokens: number;
  wall_clock_ms: number;
  turn_count: number;
  tool_calls: ToolCallRecord[];
  error?: string;
}

// ---------------------------------------------------------------------------
// BlindRunner
// ---------------------------------------------------------------------------

export class BlindRunner {
  private readonly invoker: AgentInvoker;
  private readonly tokenTracker: TokenTracker;

  /**
   * @param invoker      The agent invoker used to execute agent runs.
   * @param tokenBudget  Maximum cumulative tokens allowed across all runs.
   */
  constructor(invoker: AgentInvoker, tokenBudget: number) {
    this.invoker = invoker;
    this.tokenTracker = {
      cumulative_tokens: 0,
      budget: tokenBudget,
      remaining: tokenBudget,
      exceeded: false,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run both the current and proposed agent versions against a selected input.
   *
   * Steps:
   *   1. Run the current agent (version_a) fresh on the input.
   *   2. Run the proposed agent (version_b) fresh on the same input.
   *   3. Update cumulative token tracking after each run.
   *   4. Return the paired results.
   *
   * If the token budget is exceeded after either run, the tracker's
   * `exceeded` flag is set.  The orchestrator should check
   * `getTokenTracker().exceeded` after each call.
   *
   * @param input         The historical input to run against both versions.
   * @param currentAgent  The current (baseline) agent record.
   * @param proposedDef   The proposed agent definition text (markdown).
   * @returns             A RunPair with results from both versions.
   */
  async runBothVersions(
    input: SelectedInput,
    currentAgent: AgentRecord,
    proposedDef: string,
  ): Promise<RunPair> {
    // Step 1: Run current agent (version_a)
    const versionA = await this.executeVersion(currentAgent, input.input_content);
    this.updateTokenTracker(versionA);

    // Step 2: Build temporary AgentRecord for proposed definition and run (version_b)
    const proposedAgent = buildProposedAgentRecord(currentAgent, proposedDef);
    const versionB = await this.executeVersion(proposedAgent, input.input_content);
    this.updateTokenTracker(versionB);

    return {
      input,
      version_a: versionA,
      version_b: versionB,
    };
  }

  /**
   * Return the current token tracker state.
   */
  getTokenTracker(): Readonly<TokenTracker> {
    return { ...this.tokenTracker };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Execute a single agent version and convert the result.
   * On failure, the error is captured in the RunResult.
   */
  private async executeVersion(
    agent: AgentRecord,
    inputContent: string,
  ): Promise<RunResult> {
    try {
      const result = await this.invoker.invoke(agent, inputContent);

      if (!result.success) {
        return {
          output: result.output ?? '',
          output_hash: hashOutput(result.output ?? ''),
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          wall_clock_ms: result.wall_clock_ms,
          turn_count: result.turn_count,
          tool_calls: result.tool_calls,
          error: result.error ?? 'Agent invocation failed',
        };
      }

      return {
        output: result.output,
        output_hash: hashOutput(result.output),
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        wall_clock_ms: result.wall_clock_ms,
        turn_count: result.turn_count,
        tool_calls: result.tool_calls,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        output: '',
        output_hash: hashOutput(''),
        input_tokens: 0,
        output_tokens: 0,
        wall_clock_ms: 0,
        turn_count: 0,
        tool_calls: [],
        error: message,
      };
    }
  }

  /**
   * Update the cumulative token tracker with the token consumption from a run.
   */
  private updateTokenTracker(result: RunResult): void {
    const consumed = result.input_tokens + result.output_tokens;
    this.tokenTracker.cumulative_tokens += consumed;
    this.tokenTracker.remaining = Math.max(
      0,
      this.tokenTracker.budget - this.tokenTracker.cumulative_tokens,
    );
    if (this.tokenTracker.cumulative_tokens > this.tokenTracker.budget) {
      this.tokenTracker.exceeded = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Build a temporary AgentRecord from the current agent record and a proposed
 * definition string.  The proposed definition replaces the system prompt and
 * increments the version indicator.
 */
function buildProposedAgentRecord(
  currentAgent: AgentRecord,
  proposedDef: string,
): AgentRecord {
  const proposedParsed: ParsedAgent = {
    ...currentAgent.agent,
    system_prompt: proposedDef,
    // Mark version as proposed to distinguish in logs
    version: currentAgent.agent.version + '-proposed',
  };

  return {
    agent: proposedParsed,
    state: 'VALIDATING',
    loadedAt: new Date(),
    diskHash: hashOutput(proposedDef),
    filePath: currentAgent.filePath,
  };
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function hashOutput(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}
