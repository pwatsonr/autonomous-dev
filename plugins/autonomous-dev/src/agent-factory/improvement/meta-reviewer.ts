/**
 * Meta-Review Orchestration and Self-Review Bypass (SPEC-005-3-4, Tasks 8-9).
 *
 * Invokes the `agent-meta-reviewer` to evaluate proposals against the
 * 6-point security checklist. Handles the self-review bypass for
 * meta-reviewer self-modifications (which skip meta-review and go
 * directly to human review).
 *
 * The 6-point security checklist:
 *   1. Tool access escalation
 *   2. Role change
 *   3. Scope creep
 *   4. Prompt injection vectors
 *   5. Schema compliance
 *   6. Proportionality
 *
 * Any finding with severity `blocker` causes automatic rejection
 * regardless of the meta-reviewer's stated verdict.
 */

import * as crypto from 'crypto';

import type { IAgentRegistry, AgentRecord } from '../types';
import type { AuditLogger } from '../audit';
import type { AgentRuntime } from '../runtime';
import type {
  AgentProposal,
  MetaReviewResult,
  MetaReviewFinding,
  ChecklistResult,
  MetaReviewVerdict,
  FindingSeverity,
} from './types';

// Re-export for convenience
export type { MetaReviewResult, MetaReviewFinding, ChecklistResult };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the meta-reviewer agent in the registry. */
const META_REVIEWER_AGENT = 'agent-meta-reviewer';

/** The 6-point security checklist item names. */
const CHECKLIST_ITEMS: ReadonlyArray<{ item: number; name: string }> = [
  { item: 1, name: 'Tool access escalation' },
  { item: 2, name: 'Role change' },
  { item: 3, name: 'Scope creep' },
  { item: 4, name: 'Prompt injection vectors' },
  { item: 5, name: 'Schema compliance' },
  { item: 6, name: 'Proportionality' },
] as const;

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface MetaReviewLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: MetaReviewLogger = {
  info: (msg: string) => console.log(`[meta-reviewer] ${msg}`),
  warn: (msg: string) => console.warn(`[meta-reviewer] ${msg}`),
  error: (msg: string) => console.error(`[meta-reviewer] ${msg}`),
};

// ---------------------------------------------------------------------------
// MetaReviewOrchestrator
// ---------------------------------------------------------------------------

export interface MetaReviewOrchestratorOptions {
  registry: IAgentRegistry;
  auditLogger: AuditLogger;
  /** Optional logger for operational output. */
  logger?: MetaReviewLogger;
  /**
   * Factory for creating an AgentRuntime for the meta-reviewer agent.
   * Required for actual invocation; omit only in unit tests.
   */
  createRuntime?: (agent: AgentRecord) => AgentRuntime;
}

/**
 * Orchestrates the meta-review gate for agent modification proposals.
 *
 * Usage:
 * ```ts
 * const orchestrator = new MetaReviewOrchestrator({
 *   registry,
 *   auditLogger,
 *   createRuntime: (agent) => new AgentRuntime(agent, auditLogger, hooks),
 * });
 * const result = await orchestrator.review(proposal);
 * ```
 */
export class MetaReviewOrchestrator {
  private readonly registry: IAgentRegistry;
  private readonly auditLogger: AuditLogger;
  private readonly logger: MetaReviewLogger;
  private readonly createRuntime?: (agent: AgentRecord) => AgentRuntime;

  constructor(opts: MetaReviewOrchestratorOptions) {
    this.registry = opts.registry;
    this.auditLogger = opts.auditLogger;
    this.logger = opts.logger ?? defaultLogger;
    this.createRuntime = opts.createRuntime;
  }

  /**
   * Review a proposal through the meta-review gate.
   *
   * Steps:
   *   1. Check for self-review bypass (agent-meta-reviewer reviewing itself).
   *   2. Look up the meta-reviewer agent in the registry.
   *   3. Construct the review input prompt.
   *   4. Invoke the meta-reviewer agent.
   *   5. Parse the structured response.
   *   6. Apply hard override: any blocker finding forces rejection.
   *   7. Update proposal status.
   *   8. Log to audit.
   *
   * On parse failure the proposal remains in `pending_meta_review` and
   * an error is returned as part of the result.
   */
  async review(proposal: AgentProposal): Promise<MetaReviewResult> {
    // Step 1: Self-review bypass
    if (proposal.agent_name === META_REVIEWER_AGENT) {
      return this.handleSelfReviewBypass(proposal);
    }

    // Step 2: Look up the meta-reviewer agent
    const metaReviewerRecord = this.registry.get(META_REVIEWER_AGENT);
    if (!metaReviewerRecord) {
      const error = `Meta-reviewer agent '${META_REVIEWER_AGENT}' not found in registry`;
      this.logger.error(error);
      throw new Error(error);
    }
    // Note: meta-reviewer may be FROZEN; it must still be invocable for reviews.

    // Step 3: Construct review input
    const prompt = buildReviewPrompt(proposal);

    // Step 4: Invoke the meta-reviewer agent
    const agentOutput = await this.invokeMetaReviewer(metaReviewerRecord, prompt);
    if (agentOutput === null) {
      this.logger.error(
        `Meta-reviewer invocation failed for proposal ${proposal.proposal_id}`,
      );
      // Proposal stays at pending_meta_review; return an error result
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'agent_rejected' as const,
        agent_name: proposal.agent_name,
        details: {
          event: 'meta_review_invocation_failed',
          proposal_id: proposal.proposal_id,
        },
      });
      throw new Error('Meta-reviewer invocation failed');
    }

    // Step 5: Parse the response
    const parsed = parseMetaReviewOutput(agentOutput);
    if (!parsed) {
      this.logger.error(
        `Failed to parse meta-reviewer output for proposal ${proposal.proposal_id}`,
      );
      // Proposal stays at pending_meta_review
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'agent_rejected' as const,
        agent_name: proposal.agent_name,
        details: {
          event: 'meta_review_parse_failed',
          proposal_id: proposal.proposal_id,
        },
      });
      throw new Error('Failed to parse meta-reviewer output');
    }

    // Step 6: Build the MetaReviewResult
    const result: MetaReviewResult = {
      review_id: crypto.randomUUID(),
      proposal_id: proposal.proposal_id,
      verdict: parsed.verdict,
      findings: parsed.findings,
      checklist_results: parsed.checklist_results,
      reviewed_at: new Date().toISOString(),
      bypassed: false,
    };

    // Step 7: Hard override — any blocker finding forces rejection
    const hasBlocker = result.findings.some(f => f.severity === 'blocker');
    if (hasBlocker && result.verdict === 'approved') {
      result.verdict = 'rejected';
      this.logger.warn(
        `Verdict overridden to 'rejected' due to blocker finding(s) in proposal ${proposal.proposal_id}`,
      );
    }

    // Step 8: Update proposal status
    if (result.verdict === 'approved') {
      proposal.status = 'meta_approved';
    } else {
      proposal.status = 'meta_rejected';
    }
    proposal.meta_review_id = result.review_id;

    // Step 9: Audit log
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_rejected' as const, // closest existing audit event type
      agent_name: proposal.agent_name,
      details: {
        event: 'meta_review_completed',
        review_id: result.review_id,
        proposal_id: proposal.proposal_id,
        verdict: result.verdict,
        findings_count: result.findings.length,
        blocker_findings: result.findings
          .filter(f => f.severity === 'blocker')
          .map(f => ({
            checklist_item: f.checklist_item,
            description: f.description,
          })),
      },
    });

    this.logger.info(
      `Meta-review ${result.review_id} completed: verdict=${result.verdict}, ` +
      `findings=${result.findings.length} for proposal ${proposal.proposal_id}`,
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Self-review bypass (Task 9)
  // -------------------------------------------------------------------------

  /**
   * Handle self-review bypass when the proposal targets the meta-reviewer itself.
   *
   * The meta-reviewer cannot review its own modifications. Instead:
   * - The review is automatically bypassed with verdict 'approved'.
   * - The proposal status is set to 'pending_human_review' (not 'meta_approved').
   * - This ensures meta-reviewer modifications always require human approval.
   */
  private handleSelfReviewBypass(proposal: AgentProposal): MetaReviewResult {
    const result: MetaReviewResult = {
      review_id: crypto.randomUUID(),
      proposal_id: proposal.proposal_id,
      verdict: 'approved',
      findings: [],
      checklist_results: [],
      reviewed_at: new Date().toISOString(),
      bypassed: true,
      bypass_reason: 'Self-referential proposal: meta-reviewer cannot review its own modifications',
    };

    // Set status to pending_human_review, NOT meta_approved
    proposal.status = 'pending_human_review';
    proposal.meta_review_id = result.review_id;

    // Audit log
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_rejected' as const, // closest existing audit event type
      agent_name: proposal.agent_name,
      details: {
        event: 'meta_review_bypassed_self_referential',
        review_id: result.review_id,
        proposal_id: proposal.proposal_id,
        bypass_reason: result.bypass_reason,
      },
    });

    this.logger.info(
      `Self-review bypass for proposal ${proposal.proposal_id}: ` +
      `meta-reviewer cannot review its own modifications, ` +
      `status set to pending_human_review`,
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Meta-reviewer invocation
  // -------------------------------------------------------------------------

  /**
   * Invoke the meta-reviewer agent with the given prompt.
   *
   * Returns the agent's text output, or null on failure.
   */
  private async invokeMetaReviewer(
    metaReviewerRecord: AgentRecord,
    prompt: string,
  ): Promise<string | null> {
    try {
      if (this.createRuntime) {
        const runtime = this.createRuntime(metaReviewerRecord);
        const result = await runtime.invoke(prompt, {
          workingDirectory: process.cwd(),
        });

        if (!result.success) {
          this.logger.error(
            `Meta-reviewer invocation failed: ${result.output ?? 'unknown error'}`,
          );
          return null;
        }

        return result.output ?? null;
      }

      // Fallback: no runtime factory provided
      this.logger.warn(
        'No runtime factory provided; returning null from meta-reviewer invocation',
      );
      return null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Meta-reviewer invocation error: ${message}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Review prompt builder
// ---------------------------------------------------------------------------

/**
 * Construct the review prompt for the meta-reviewer agent.
 *
 * Includes the full proposal with diff, both definitions, and the
 * 6-point security checklist instructions.
 */
export function buildReviewPrompt(proposal: AgentProposal): string {
  return `You are the Agent Meta-Reviewer. Evaluate this agent modification proposal for safety.

## Proposal Summary
- Agent: ${proposal.agent_name} (${proposal.current_version} -> ${proposal.proposed_version})
- Version bump: ${proposal.version_bump}
- Proposal ID: ${proposal.proposal_id}
- Weakness report: ${proposal.weakness_report_id}

## Unified Diff
\`\`\`diff
${proposal.diff}
\`\`\`

## Current Definition (for reference)
\`\`\`markdown
${proposal.current_definition}
\`\`\`

## Proposed Definition
\`\`\`markdown
${proposal.proposed_definition}
\`\`\`

## 6-Point Security Checklist
Evaluate each item. For each, provide: PASS or FAIL, severity (info/warning/blocker), and evidence.

1. **Tool access escalation**: Does the proposal change the tools field or imply tool access changes in the prompt?
2. **Role change**: Does the proposal change the role field or imply role-level capability shifts?
3. **Scope creep**: Do changes go beyond addressing the identified weaknesses?
4. **Prompt injection vectors**: Could new prompt text be manipulated by adversarial input?
5. **Schema compliance**: Does the proposed definition maintain valid schema?
6. **Proportionality**: Are changes proportional to weakness severity?

Output a JSON object with: verdict ("approved"/"rejected"), findings array, and checklist_results array.

Expected JSON format:
\`\`\`json
{
  "verdict": "approved" | "rejected",
  "findings": [
    {
      "checklist_item": 1,
      "severity": "info" | "warning" | "blocker",
      "description": "...",
      "evidence": "..."
    }
  ],
  "checklist_results": [
    {
      "item": 1,
      "name": "Tool access escalation",
      "passed": true
    }
  ]
}
\`\`\``;
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

/**
 * Parsed meta-reviewer output before building the full MetaReviewResult.
 */
interface ParsedMetaReviewOutput {
  verdict: MetaReviewVerdict;
  findings: MetaReviewFinding[];
  checklist_results: ChecklistResult[];
}

/**
 * Parse the meta-reviewer agent's output into structured data.
 *
 * Handles:
 *   - Raw JSON string
 *   - JSON wrapped in ```json ... ``` code blocks
 *   - JSON wrapped in ``` ... ``` code blocks (no language tag)
 *
 * Returns null if parsing fails.
 */
export function parseMetaReviewOutput(output: string): ParsedMetaReviewOutput | null {
  const json = extractJson(output);
  if (!json) {
    return null;
  }

  try {
    const parsed = JSON.parse(json);

    // Validate verdict
    const verdict = parseVerdict(parsed.verdict);
    if (!verdict) {
      return null;
    }

    // Parse findings
    const findings = parseFindings(parsed.findings);

    // Parse checklist results
    const checklistResults = parseChecklistResults(parsed.checklist_results, findings);

    return {
      verdict,
      findings,
      checklist_results: checklistResults,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction (mirrors analyzer.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Extract JSON from agent output text.
 */
function extractJson(output: string): string | null {
  // Try to find JSON in a code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      return candidate;
    }
  }

  // Try raw JSON (first { to last })
  const trimmed = output.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseVerdict(value: unknown): MetaReviewVerdict | null {
  if (value === 'approved' || value === 'rejected') {
    return value;
  }
  return null;
}

function parseFindingSeverity(value: unknown): FindingSeverity {
  if (value === 'info' || value === 'warning' || value === 'blocker') {
    return value;
  }
  return 'info'; // default to info for unrecognized severity
}

function parseFindings(raw: unknown): MetaReviewFinding[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      checklist_item: typeof item.checklist_item === 'number' ? item.checklist_item : 0,
      severity: parseFindingSeverity(item.severity),
      description: typeof item.description === 'string' ? item.description : '',
      evidence: typeof item.evidence === 'string' ? item.evidence : '',
    }));
}

function parseChecklistResults(
  raw: unknown,
  findings: MetaReviewFinding[],
): ChecklistResult[] {
  if (!Array.isArray(raw)) {
    // Build default checklist results from CHECKLIST_ITEMS with any findings
    return CHECKLIST_ITEMS.map((ci) => {
      const finding = findings.find(f => f.checklist_item === ci.item);
      return {
        item: ci.item,
        name: ci.name,
        passed: !finding || finding.severity !== 'blocker',
        finding,
      };
    });
  }

  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const itemNum = typeof item.item === 'number' ? item.item : 0;
      const name = typeof item.name === 'string'
        ? item.name
        : (CHECKLIST_ITEMS.find(ci => ci.item === itemNum)?.name ?? `Item ${itemNum}`);
      const passed = typeof item.passed === 'boolean' ? item.passed : true;
      const finding = findings.find(f => f.checklist_item === itemNum);

      return {
        item: itemNum,
        name,
        passed,
        finding,
      };
    });
}
