/**
 * ReviewerExecutor: parallel reviewer invocation and result collection.
 *
 * Executes all reviewer agents concurrently via Promise.allSettled(), handles
 * per-reviewer timeout/retry with fresh-instance escalation for sole reviewers,
 * and collects validated ReviewOutput results.
 *
 * Based on SPEC-004-2-3 section 1.
 */

import type { ReviewOutput } from './types';
import type { ReviewerAssignment } from './panel-assembly-service';
import type { ReviewerOutputValidator, ValidationParseResult } from './reviewer-output-validator';

// ---------------------------------------------------------------------------
// LLM Adapter interface
// ---------------------------------------------------------------------------

/**
 * Prompt structure passed to the LLM adapter.
 * Intentionally open -- the concrete shape is defined upstream by the prompt
 * assembly layer. The executor only passes it through.
 */
export interface AssembledPrompt {
  [key: string]: unknown;
}

/**
 * Abstraction over the LLM invocation layer.
 *
 * Implementations may call the Claude API, a local model, or a test stub.
 * The adapter returns a raw string response that the output validator will parse.
 */
export interface LLMAdapter {
  invoke(prompt: AssembledPrompt, agentSeed: number, timeoutMs: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Reviewer Agent Pool interface
// ---------------------------------------------------------------------------

/** Status of a reviewer agent instance within the pool. */
export type AgentStatus = 'active' | 'completed' | 'failed';

/** A minimal agent instance handle returned by the pool. */
export interface AgentInstance {
  instance_id: string;
  reviewer_id: string;
  agent_seed: number;
  status: AgentStatus;
}

/**
 * Pool managing reviewer agent instances.
 *
 * The executor creates instances at invocation time and updates their status
 * on completion or failure.
 */
export interface ReviewerAgentPool {
  createInstance(assignment: ReviewerAssignment): AgentInstance;
  markCompleted(instanceId: string): void;
  markFailed(instanceId: string): void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the reviewer executor. */
export interface ReviewerExecutorConfig {
  /** Per-reviewer timeout in milliseconds. Default: 120000 (120s per NFR-005). */
  timeout_ms: number;
  /** Maximum retries per reviewer before giving up. Default: 1. */
  max_retries_per_reviewer: number;
  /** Whether to proceed with a partial panel when some reviewers fail. Default: true. */
  proceed_with_partial_panel: boolean;
  /** Number of total failures before escalation is triggered. Default: 2. */
  max_total_failures_before_escalation: number;
}

export const DEFAULT_EXECUTOR_CONFIG: ReviewerExecutorConfig = {
  timeout_ms: 120_000,
  max_retries_per_reviewer: 1,
  proceed_with_partial_panel: true,
  max_total_failures_before_escalation: 2,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Describes a single reviewer failure. */
export interface ReviewerFailure {
  reviewer_id: string;
  error_type: 'timeout' | 'malformed_output' | 'crash' | 'validation_error';
  error_message: string;
  retries_attempted: number;
}

/** Result of executing an entire review panel. */
export interface ExecutionResult {
  review_outputs: ReviewOutput[];
  failures: ReviewerFailure[];
  /** True if some reviewers failed and were excluded but at least one succeeded. */
  partial_panel: boolean;
  /** True if total failures >= max_total_failures_before_escalation AND no outputs. */
  escalation_required: boolean;
  execution_time_ms: number;
}

// ---------------------------------------------------------------------------
// Rubric type re-export for the executePanel signature
// ---------------------------------------------------------------------------

import type { Rubric } from './types';

// ---------------------------------------------------------------------------
// ReviewerExecutor
// ---------------------------------------------------------------------------

export class ReviewerExecutor {
  constructor(
    private llmAdapter: LLMAdapter,
    private outputValidator: ReviewerOutputValidator,
    private agentPool: ReviewerAgentPool,
    private config: ReviewerExecutorConfig = DEFAULT_EXECUTOR_CONFIG,
  ) {}

  /**
   * Execute all reviewers in the panel concurrently and collect results.
   *
   * @param assignments - The reviewer assignments for this panel
   * @param prompts - Map of reviewer_id -> assembled prompt
   * @param rubric - The rubric used for output validation
   * @returns ExecutionResult with outputs, failures, and status flags
   */
  async executePanel(
    assignments: ReviewerAssignment[],
    prompts: Map<string, AssembledPrompt>,
    rubric: Rubric,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const panelSize = assignments.length;
    const reviewOutputs: ReviewOutput[] = [];
    const failures: ReviewerFailure[] = [];

    // Execute all reviewers concurrently
    const results = await Promise.allSettled(
      assignments.map(assignment =>
        this.executeReviewer(assignment, prompts.get(assignment.reviewer_id)!, rubric, panelSize),
      ),
    );

    // Collect results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const outcome = result.value;
        if (outcome.success && outcome.reviewOutput) {
          reviewOutputs.push(outcome.reviewOutput);
        } else if (outcome.failure) {
          failures.push(outcome.failure);
        }
      } else {
        // Promise rejection (unexpected)
        failures.push({
          reviewer_id: 'unknown',
          error_type: 'crash',
          error_message: result.reason?.message ?? String(result.reason),
          retries_attempted: 0,
        });
      }
    }

    const executionTimeMs = Date.now() - startTime;

    const partialPanel = failures.length > 0 && reviewOutputs.length > 0;
    const escalationRequired =
      failures.length >= this.config.max_total_failures_before_escalation &&
      reviewOutputs.length === 0;

    return {
      review_outputs: reviewOutputs,
      failures,
      partial_panel: partialPanel,
      escalation_required: escalationRequired,
      execution_time_ms: executionTimeMs,
    };
  }

  /**
   * Execute a single reviewer with retry logic.
   *
   * For each reviewer:
   * 1. Create agent instance and invoke LLM
   * 2. On success, validate output
   * 3. On failure (timeout, crash, malformed), retry up to max_retries
   * 4. For sole reviewers, create a fresh instance (new seed) for one final attempt
   */
  private async executeReviewer(
    assignment: ReviewerAssignment,
    prompt: AssembledPrompt,
    rubric: Rubric,
    panelSize: number,
  ): Promise<ReviewerOutcome> {
    const agentInstance = this.agentPool.createInstance(assignment);
    let retriesAttempted = 0;
    let lastErrorType: ReviewerFailure['error_type'] = 'crash';
    let lastErrorMessage = '';

    // Initial attempt + retries
    const maxAttempts = 1 + this.config.max_retries_per_reviewer;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        retriesAttempted++;
      }

      const result = await this.invokeAndValidate(
        prompt,
        assignment.agent_seed,
        rubric,
        assignment.reviewer_id,
      );

      if (result.success && result.reviewOutput) {
        this.agentPool.markCompleted(agentInstance.instance_id);
        return { success: true, reviewOutput: result.reviewOutput };
      }

      lastErrorType = result.errorType ?? 'crash';
      lastErrorMessage = result.errorMessage ?? 'Unknown error';
    }

    // All regular attempts failed.
    // For sole reviewer: create a fresh instance with seed + 1 and try once more.
    if (panelSize === 1) {
      this.agentPool.markFailed(agentInstance.instance_id);
      const freshSeed = assignment.agent_seed + 1;
      const freshAssignment: ReviewerAssignment = {
        ...assignment,
        agent_seed: freshSeed,
        reviewer_id: `${assignment.role_id}-${freshSeed}`,
      };
      const freshInstance = this.agentPool.createInstance(freshAssignment);
      retriesAttempted++;

      const result = await this.invokeAndValidate(
        prompt,
        freshSeed,
        rubric,
        assignment.reviewer_id, // Keep original reviewer_id for output
      );

      if (result.success && result.reviewOutput) {
        this.agentPool.markCompleted(freshInstance.instance_id);
        return { success: true, reviewOutput: result.reviewOutput };
      }

      this.agentPool.markFailed(freshInstance.instance_id);
      lastErrorType = result.errorType ?? 'crash';
      lastErrorMessage = result.errorMessage ?? 'Unknown error';
    } else {
      this.agentPool.markFailed(agentInstance.instance_id);
    }

    return {
      success: false,
      failure: {
        reviewer_id: assignment.reviewer_id,
        error_type: lastErrorType,
        error_message: lastErrorMessage,
        retries_attempted: retriesAttempted,
      },
    };
  }

  /**
   * Invoke the LLM and validate the output. Returns a normalized result.
   */
  private async invokeAndValidate(
    prompt: AssembledPrompt,
    agentSeed: number,
    rubric: Rubric,
    reviewerId: string,
  ): Promise<InvokeResult> {
    let rawOutput: string;

    try {
      rawOutput = await this.llmAdapter.invoke(prompt, agentSeed, this.config.timeout_ms);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const isTimeout =
        message.toLowerCase().includes('timeout') ||
        message.toLowerCase().includes('timed out') ||
        message.toLowerCase().includes('aborted');
      return {
        success: false,
        errorType: isTimeout ? 'timeout' : 'crash',
        errorMessage: message,
      };
    }

    // Validate and parse the output
    let parseResult: ValidationParseResult;
    try {
      parseResult = this.outputValidator.validateAndParse(rawOutput, rubric, reviewerId);
    } catch (error) {
      return {
        success: false,
        errorType: 'validation_error',
        errorMessage: (error as Error).message ?? String(error),
      };
    }

    if (parseResult.success && parseResult.review_output) {
      return {
        success: true,
        reviewOutput: parseResult.review_output,
      };
    }

    return {
      success: false,
      errorType: 'malformed_output',
      errorMessage: parseResult.errors.join('; '),
    };
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReviewerOutcome {
  success: boolean;
  reviewOutput?: ReviewOutput;
  failure?: ReviewerFailure;
}

interface InvokeResult {
  success: boolean;
  reviewOutput?: ReviewOutput;
  errorType?: ReviewerFailure['error_type'];
  errorMessage?: string;
}
