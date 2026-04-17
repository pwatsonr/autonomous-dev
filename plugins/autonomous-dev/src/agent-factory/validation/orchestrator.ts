/**
 * A/B Validation Orchestrator (SPEC-005-4-3, Task 7).
 *
 * Coordinates the full 7-step A/B evaluation protocol end-to-end:
 *   1. Input selection (historical inputs from weakness report)
 *   2. Run current agent (version_a) on each input
 *   3. Run proposed agent (version_b) on each input
 *   4. Randomize labels (blind the scorer)
 *   5. Blind scoring (median-of-3 rounds)
 *   6. De-randomize (map scores back to versions)
 *   7. Aggregate decision (positive / negative / inconclusive)
 *
 * Integrates the TokenTracker for budget enforcement (Task 8).
 * When the token budget is exceeded mid-validation, the run is
 * aborted and marked inconclusive with reason `token_budget_exceeded`.
 *
 * Evaluation results are persisted to `data/evaluations/<id>.json`.
 *
 * Exports: `ABValidationOrchestrator`, `TokenTracker`
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

import type { IAgentRegistry } from '../types';
import type {
  AgentProposal,
  WeaknessReport,
  ABEvaluationResult,
  ABAggregate,
  ABInput,
  ComparisonResult,
  TokenConsumption,
  ProposalStatus,
} from '../improvement/types';

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Interface for the weakness report store.
 * The orchestrator needs to look up weakness reports by ID.
 */
export interface IWeaknessReportStore {
  getById(reportId: string): WeaknessReport | null;
}

/**
 * Interface for the proposal store.
 * The orchestrator needs to update proposal status and evaluation ID.
 */
export interface IProposalStore {
  updateStatus(proposalId: string, newStatus: ProposalStatus): void;
  setEvaluationId(proposalId: string, evaluationId: string): void;
}

import { InputSelector } from './input-selector';
import { BlindRunner } from './blind-runner';
import type { AgentInvoker } from './blind-runner';
import { LabelRandomizer, InMemoryMappingStore } from './randomizer';
import { BlindScorer } from './blind-scorer';
import type { ReviewerInvoker } from './blind-scorer';
import { Comparator } from './comparator';
import { DecisionEngine } from './decision-engine';

// ---------------------------------------------------------------------------
// TokenTracker (SPEC-005-4-3, Task 8)
// ---------------------------------------------------------------------------

/**
 * Tracks cumulative token consumption across all agent runs and scoring
 * rounds within a validation cycle.
 *
 * The orchestrator checks `exceeded` after each operation and aborts
 * if the budget has been surpassed.
 */
export class TokenTracker {
  private cumulative: number = 0;
  private inputSelectionTokens: number = 0;
  private versionARunTokens: number = 0;
  private versionBRunTokens: number = 0;
  private scoringTokens: number = 0;

  constructor(private readonly budget: number) {}

  /**
   * Add tokens to the cumulative total, categorized by source.
   */
  add(tokens: number, category?: 'input_selection' | 'version_a' | 'version_b' | 'scoring'): void {
    this.cumulative += tokens;
    switch (category) {
      case 'input_selection':
        this.inputSelectionTokens += tokens;
        break;
      case 'version_a':
        this.versionARunTokens += tokens;
        break;
      case 'version_b':
        this.versionBRunTokens += tokens;
        break;
      case 'scoring':
        this.scoringTokens += tokens;
        break;
      default:
        // Uncategorized -- still counted in cumulative
        break;
    }
  }

  /** Whether the cumulative tokens exceed the budget. */
  get exceeded(): boolean {
    return this.cumulative > this.budget;
  }

  /** Remaining tokens before budget exhaustion (clamped to 0). */
  get remaining(): number {
    return Math.max(0, this.budget - this.cumulative);
  }

  /** Build the TokenConsumption record for the evaluation result. */
  get consumption(): TokenConsumption {
    return {
      input_selection_tokens: this.inputSelectionTokens,
      version_a_run_tokens: this.versionARunTokens,
      version_b_run_tokens: this.versionBRunTokens,
      scoring_tokens: this.scoringTokens,
      total_tokens: this.cumulative,
      budget: this.budget,
      utilization_percent: this.budget > 0
        ? (this.cumulative / this.budget) * 100
        : 0,
    };
  }

  /** Get the current cumulative total. */
  get total(): number {
    return this.cumulative;
  }

  /** Get the configured budget. */
  get budgetLimit(): number {
    return this.budget;
  }
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface OrchestratorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: OrchestratorLogger = {
  info: (msg: string) => console.log(`[ab-orchestrator] ${msg}`),
  warn: (msg: string) => console.warn(`[ab-orchestrator] ${msg}`),
  error: (msg: string) => console.error(`[ab-orchestrator] ${msg}`),
};

// ---------------------------------------------------------------------------
// Default token budget
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 100_000;

// ---------------------------------------------------------------------------
// Orchestrator options
// ---------------------------------------------------------------------------

export interface ABValidationOrchestratorOptions {
  /** Registry for looking up agent records. */
  registry: IAgentRegistry;
  /** Invoker for running agents (current and proposed versions). */
  agentInvoker: AgentInvoker;
  /** Invoker for running reviewer agents during blind scoring. */
  reviewerInvoker: ReviewerInvoker;
  /** Store for looking up weakness reports by ID. */
  weaknessReportStore: IWeaknessReportStore;
  /** Store for updating proposal status and evaluation_id. */
  proposalStore: IProposalStore;
  /** Directory where evaluation JSON files are written. */
  evaluationsDir?: string;
  /** Maximum token budget for the entire validation run. */
  validationTokenBudget?: number;
  /** Optional logger. */
  logger?: OrchestratorLogger;
  /**
   * Optional input resolver that retrieves the original input text
   * for a historical invocation. Passed through to InputSelector.
   */
  inputResolver?: (invocation: import('../metrics/types').InvocationMetric) => string;
  /** Metrics engine for the input selector. */
  metricsEngine: import('../metrics/types').IMetricsEngine;
}

// ---------------------------------------------------------------------------
// ABValidationOrchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrates the complete 7-step A/B evaluation protocol.
 *
 * Usage:
 * ```ts
 * const orchestrator = new ABValidationOrchestrator({ ... });
 * const result = await orchestrator.runValidation(proposal);
 * // result.aggregate.verdict: 'positive' | 'negative' | 'inconclusive'
 * ```
 */
export class ABValidationOrchestrator {
  private readonly registry: IAgentRegistry;
  private readonly agentInvoker: AgentInvoker;
  private readonly reviewerInvoker: ReviewerInvoker;
  private readonly weaknessReportStore: IWeaknessReportStore;
  private readonly proposalStore: IProposalStore;
  private readonly evaluationsDir: string;
  private readonly tokenBudget: number;
  private readonly logger: OrchestratorLogger;
  private readonly inputResolver?: (invocation: import('../metrics/types').InvocationMetric) => string;
  private readonly metricsEngine: import('../metrics/types').IMetricsEngine;

  constructor(opts: ABValidationOrchestratorOptions) {
    this.registry = opts.registry;
    this.agentInvoker = opts.agentInvoker;
    this.reviewerInvoker = opts.reviewerInvoker;
    this.weaknessReportStore = opts.weaknessReportStore;
    this.proposalStore = opts.proposalStore;
    this.evaluationsDir = opts.evaluationsDir
      ? path.resolve(opts.evaluationsDir)
      : path.resolve('data/evaluations');
    this.tokenBudget = opts.validationTokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.logger = opts.logger ?? defaultLogger;
    this.inputResolver = opts.inputResolver;
    this.metricsEngine = opts.metricsEngine;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute the full 7-step A/B validation protocol for a proposal.
   *
   * On budget exhaustion the run is aborted and marked inconclusive
   * with `abort_reason: 'token_budget_exceeded'`.  Partial results
   * (inputs scored before abort) are included in the evaluation.
   *
   * @param proposal  The agent modification proposal to validate.
   * @returns         ABEvaluationResult with aggregate verdict and details.
   */
  async runValidation(proposal: AgentProposal): Promise<ABEvaluationResult> {
    const evaluationId = randomUUID();
    const startedAt = new Date().toISOString();
    const tokenTracker = new TokenTracker(this.tokenBudget);

    this.logger.info(
      `Starting A/B validation ${evaluationId} for proposal ${proposal.proposal_id} ` +
      `(agent: ${proposal.agent_name}, budget: ${this.tokenBudget} tokens)`,
    );

    try {
      // --- Resolve dependencies ---

      const agentRecord = this.registry.get(proposal.agent_name);
      if (!agentRecord) {
        return this.abortResult(
          evaluationId, proposal, startedAt, [],
          `Agent '${proposal.agent_name}' not found in registry`,
          tokenTracker,
        );
      }

      const weaknessReport = this.weaknessReportStore.getById(
        proposal.weakness_report_id,
      );
      if (!weaknessReport) {
        return this.abortResult(
          evaluationId, proposal, startedAt, [],
          `Weakness report '${proposal.weakness_report_id}' not found`,
          tokenTracker,
        );
      }

      // --- Step 1: Input selection ---

      this.logger.info('Step 1: Selecting historical inputs');
      const inputSelector = new InputSelector(
        this.metricsEngine,
        this.inputResolver,
      );
      const selectionResult = inputSelector.selectInputs(
        proposal.agent_name,
        weaknessReport,
      );

      if (!selectionResult.success) {
        return this.abortResult(
          evaluationId, proposal, startedAt, [],
          selectionResult.error ?? 'Input selection failed',
          tokenTracker,
        );
      }

      const selectedInputs = selectionResult.inputs;
      this.logger.info(`Selected ${selectedInputs.length} inputs for validation`);

      // --- Set up components ---

      const blindRunner = new BlindRunner(this.agentInvoker, this.tokenBudget);
      const mappingStore = new InMemoryMappingStore();
      const randomizer = new LabelRandomizer(mappingStore);
      const blindScorer = new BlindScorer({
        reviewerInvoker: this.reviewerInvoker,
      });
      const comparator = new Comparator();
      const decisionEngine = new DecisionEngine();

      // --- Process each input through steps 2-6 ---

      const abInputs: ABInput[] = [];
      const comparisons: ComparisonResult[] = [];

      for (const input of selectedInputs) {
        this.logger.info(
          `Processing input ${input.input_id} (reason: ${input.selection_reason})`,
        );

        // Step 2: Run current agent (version_a)
        this.logger.info('Step 2: Running current agent version');
        const runPair = await blindRunner.runBothVersions(
          input,
          agentRecord,
          proposal.proposed_definition,
        );

        // Track tokens from both runs
        const aTokens = runPair.version_a.input_tokens + runPair.version_a.output_tokens;
        const bTokens = runPair.version_b.input_tokens + runPair.version_b.output_tokens;
        tokenTracker.add(aTokens, 'version_a');
        tokenTracker.add(bTokens, 'version_b');

        // Check budget after runs
        if (tokenTracker.exceeded) {
          this.logger.warn(
            `Token budget exceeded after running input ${input.input_id} ` +
            `(${tokenTracker.total}/${this.tokenBudget})`,
          );
          return this.abortResult(
            evaluationId, proposal, startedAt, abInputs,
            'token_budget_exceeded',
            tokenTracker,
          );
        }

        // Step 4: Randomize labels
        this.logger.info('Step 4: Randomizing labels');
        const randomized = randomizer.randomize(runPair);

        // Step 5: Blind scoring (median-of-3 rounds)
        this.logger.info('Step 5: Blind scoring');
        const rubric = agentRecord.agent.evaluation_rubric;
        const targetRole = agentRecord.agent.role;
        const scoringResult = await blindScorer.score(
          randomized,
          rubric,
          targetRole,
        );

        // Estimate scoring tokens (from scoring rounds)
        const scoringTokenEstimate = estimateScoringTokens(scoringResult);
        tokenTracker.add(scoringTokenEstimate, 'scoring');

        // Check budget after scoring
        if (tokenTracker.exceeded) {
          this.logger.warn(
            `Token budget exceeded after scoring input ${input.input_id} ` +
            `(${tokenTracker.total}/${this.tokenBudget})`,
          );
          return this.abortResult(
            evaluationId, proposal, startedAt, abInputs,
            'token_budget_exceeded',
            tokenTracker,
          );
        }

        // Step 6: De-randomize and compare
        this.logger.info('Step 6: De-randomizing and comparing');
        const mapping = mappingStore.retrieve(randomized.mapping_id);
        const comparison = comparator.compare(scoringResult, mapping);

        // Convert to ABInput and store
        const abInput = toABInput(input, comparison);
        abInputs.push(abInput);
        comparisons.push(comparison);
      }

      // --- Step 7: Aggregate decision ---

      this.logger.info('Step 7: Computing aggregate decision');
      const aggregate = decisionEngine.decide(comparisons);

      // --- Update proposal status ---

      this.updateProposalStatus(proposal, aggregate, evaluationId);

      // --- Build and store evaluation result ---

      const result = this.buildEvaluationResult(
        evaluationId,
        proposal,
        startedAt,
        abInputs,
        aggregate,
        tokenTracker,
        false,
      );

      await this.storeEvaluation(result);

      this.logger.info(
        `A/B validation ${evaluationId} complete: verdict=${aggregate.verdict}, ` +
        `wins=${aggregate.proposed_wins}, losses=${aggregate.current_wins}, ` +
        `ties=${aggregate.ties}, tokens=${tokenTracker.total}/${this.tokenBudget}`,
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Validation failed: ${message}`);
      return this.abortResult(
        evaluationId, proposal, startedAt, [],
        message,
        tokenTracker,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Status update
  // -----------------------------------------------------------------------

  /**
   * Update proposal status based on the aggregate verdict.
   *
   * - positive -> validated_positive
   * - negative -> validated_negative
   * - inconclusive -> validated_negative (conservative: do not promote)
   */
  private updateProposalStatus(
    proposal: AgentProposal,
    aggregate: ABAggregate,
    evaluationId: string,
  ): void {
    try {
      const newStatus =
        aggregate.verdict === 'positive'
          ? 'validated_positive' as const
          : 'validated_negative' as const;

      this.proposalStore.updateStatus(proposal.proposal_id, newStatus);
      this.proposalStore.setEvaluationId(proposal.proposal_id, evaluationId);

      this.logger.info(
        `Proposal ${proposal.proposal_id} status updated to ${newStatus}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to update proposal status: ${message}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Result builders
  // -----------------------------------------------------------------------

  /**
   * Build a complete ABEvaluationResult.
   */
  private buildEvaluationResult(
    evaluationId: string,
    proposal: AgentProposal,
    startedAt: string,
    inputs: ABInput[],
    aggregate: ABAggregate,
    tokenTracker: TokenTracker,
    aborted: boolean,
    abortReason?: string,
  ): ABEvaluationResult {
    return {
      evaluation_id: evaluationId,
      proposal_id: proposal.proposal_id,
      agent_name: proposal.agent_name,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      inputs,
      aggregate,
      token_consumption: tokenTracker.consumption,
      aborted,
      abort_reason: abortReason,
    };
  }

  /**
   * Build an aborted evaluation result.
   *
   * When aborted, the verdict is always inconclusive. Partial results
   * (inputs scored so far) are included.
   */
  private abortResult(
    evaluationId: string,
    proposal: AgentProposal,
    startedAt: string,
    partialInputs: ABInput[],
    reason: string,
    tokenTracker: TokenTracker,
  ): ABEvaluationResult {
    this.logger.warn(
      `Validation ${evaluationId} aborted: ${reason}`,
    );

    // Build an inconclusive aggregate from partial results
    const aggregate: ABAggregate = {
      verdict: 'inconclusive',
      proposed_wins: partialInputs.filter((i) => i.outcome === 'proposed_wins').length,
      current_wins: partialInputs.filter((i) => i.outcome === 'current_wins').length,
      ties: partialInputs.filter((i) => i.outcome === 'tie').length,
      total_inputs: partialInputs.length,
      mean_delta: partialInputs.length > 0
        ? partialInputs.reduce((sum, i) => sum + i.overall_delta, 0) / partialInputs.length
        : 0,
      per_dimension_summary: {},
      recommendation: `Validation aborted: ${reason}`,
    };

    const result = this.buildEvaluationResult(
      evaluationId,
      proposal,
      startedAt,
      partialInputs,
      aggregate,
      tokenTracker,
      true,
      reason,
    );

    // Store the aborted evaluation for audit
    this.storeEvaluation(result).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to store aborted evaluation: ${message}`);
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Evaluation persistence
  // -----------------------------------------------------------------------

  /**
   * Write the complete ABEvaluationResult as JSON to
   * `data/evaluations/<evaluation_id>.json`.
   */
  private async storeEvaluation(result: ABEvaluationResult): Promise<void> {
    try {
      if (!fs.existsSync(this.evaluationsDir)) {
        fs.mkdirSync(this.evaluationsDir, { recursive: true });
      }

      const filePath = path.join(
        this.evaluationsDir,
        `${result.evaluation_id}.json`,
      );
      const content = JSON.stringify(result, null, 2);
      fs.writeFileSync(filePath, content, { encoding: 'utf-8' });

      this.logger.info(`Evaluation stored at ${filePath}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to store evaluation: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Convert a ComparisonResult and its SelectedInput into an ABInput record.
 */
function toABInput(
  input: import('./types').SelectedInput,
  comparison: ComparisonResult,
): ABInput {
  return {
    input_id: input.input_id,
    selection_reason: input.selection_reason,
    version_a_scores: comparison.version_a_scores,
    version_b_scores: comparison.version_b_scores,
    per_dimension_delta: comparison.per_dimension_delta,
    overall_delta: comparison.overall_delta,
    outcome: comparison.outcome,
  };
}

/**
 * Estimate total tokens consumed by scoring rounds.
 *
 * Since the BlindScorer does not directly report token counts,
 * we estimate based on scoring round count. Each reviewer invocation
 * typically consumes tokens proportional to prompt + response size.
 * For now, return 0 (the actual token tracking is done through the
 * BlindRunner's TokenTracker for runs; scoring tokens would need
 * to be integrated into the ReviewerInvoker contract).
 */
function estimateScoringTokens(
  scoringResult: import('../improvement/types').ScoringResult,
): number {
  // The scorer's token consumption would ideally be tracked by the
  // ReviewerInvoker. Since the current interface does not return
  // token counts, we return 0. The orchestrator's token budget
  // primarily covers agent runs; scoring is lightweight by comparison.
  // This is a known limitation to be addressed when the ReviewerInvoker
  // interface is extended to report token consumption.
  return 0;
}
