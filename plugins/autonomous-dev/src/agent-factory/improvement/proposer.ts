/**
 * Proposal generator with constraint enforcement (SPEC-005-3-3, Tasks 5-6).
 *
 * Generates modification proposals from weakness reports by:
 *   1. Loading the current agent definition.
 *   2. Constructing an improvement prompt with constraints.
 *   3. Invoking an LLM to produce the modified definition.
 *   4. Enforcing hard-coded constraints BEFORE meta-review.
 *   5. Computing the unified diff and version bump.
 *   6. Assembling the proposal record with status `pending_meta_review`.
 *
 * Constraint enforcement is entirely code-based (no LLM involved) and
 * rejects proposals that violate immutable field rules immediately.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { ParsedAgent, IAgentRegistry } from '../types';
import { parseAgentString } from '../parser';
import { AuditLogger } from '../audit';
import {
  WeaknessReport,
  AgentProposal,
  ProposalResult,
  ConstraintViolation,
} from './types';
import {
  classifyVersionBump,
  incrementVersion,
} from './version-classifier';

// Re-export for convenience
export type { ProposalResult, ConstraintViolation };

// ---------------------------------------------------------------------------
// LLM invoker interface
// ---------------------------------------------------------------------------

/**
 * Interface for LLM invocation. The caller supplies an implementation
 * that routes to the appropriate model. This keeps the proposer
 * testable without real LLM calls.
 */
export interface LLMInvoker {
  invoke(prompt: string, model: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// ProposalGenerator
// ---------------------------------------------------------------------------

export interface ProposalGeneratorOptions {
  /** Default model to use when the agent's own model is unavailable. */
  defaultModel?: string;
  /** Directory where agent `.md` files live. */
  agentsDir: string;
}

/**
 * Generates constrained modification proposals from weakness reports.
 *
 * Usage:
 * ```ts
 * const generator = new ProposalGenerator(registry, llm, auditLogger, {
 *   agentsDir: 'agents/',
 * });
 * const result = await generator.generateProposal('code-executor', weaknessReport);
 * ```
 */
export class ProposalGenerator {
  private readonly registry: IAgentRegistry;
  private readonly llm: LLMInvoker;
  private readonly auditLogger: AuditLogger;
  private readonly options: ProposalGeneratorOptions;

  constructor(
    registry: IAgentRegistry,
    llm: LLMInvoker,
    auditLogger: AuditLogger,
    options: ProposalGeneratorOptions,
  ) {
    this.registry = registry;
    this.llm = llm;
    this.auditLogger = auditLogger;
    this.options = options;
  }

  /**
   * Generate a modification proposal for the named agent based on a
   * weakness report.
   *
   * Steps:
   *   1. Load current agent definition from disk.
   *   2. Construct improvement prompt with weakness report and constraints.
   *   3. Invoke LLM and extract proposed definition from response.
   *   4. Hard-coded constraint enforcement (rejects before meta-review).
   *   5. Compute diff and version bump.
   *   6. Create proposal record with status `pending_meta_review`.
   */
  async generateProposal(
    agentName: string,
    report: WeaknessReport,
  ): Promise<ProposalResult> {
    // Step 1: Load current agent definition
    const loadResult = this.loadCurrentDefinition(agentName);
    if (!loadResult.success) {
      return { success: false, error: loadResult.error };
    }
    const { content: currentContent, agent: currentAgent } = loadResult;

    // Step 2: Construct improvement prompt
    const prompt = buildImprovementPrompt(currentAgent, currentContent, report);

    // Step 3: Invoke LLM and extract proposed definition
    const model = this.options.defaultModel || currentAgent.model;
    let llmResponse: string;
    try {
      llmResponse = await this.llm.invoke(prompt, model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `LLM invocation failed: ${message}` };
    }

    const proposedContent = extractDefinitionFromResponse(llmResponse);
    if (proposedContent === null) {
      return {
        success: false,
        error: 'Failed to extract agent definition from LLM response: no code block found',
      };
    }

    // Parse the proposed definition
    const parseResult = parseAgentString(proposedContent);
    if (!parseResult.success || !parseResult.agent) {
      const parseErrors = parseResult.errors.map(e => e.message).join('; ');
      return {
        success: false,
        error: `Failed to parse proposed definition: ${parseErrors}`,
      };
    }
    const proposedAgent = parseResult.agent;

    // Step 4: Hard-coded constraint enforcement (BEFORE meta-review)
    const violations = enforceConstraints(currentAgent, proposedAgent);
    if (violations.length > 0) {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'agent_rejected',
        agent_name: agentName,
        details: {
          reason: 'proposal_rejected_constraint_violation',
          violations: violations.map(v => ({
            field: v.field,
            rule: v.rule,
            current_value: v.current_value,
            proposed_value: v.proposed_value,
          })),
          weakness_report_id: report.report_id,
        },
      });
      return { success: false, constraintViolations: violations };
    }

    // Step 5: Compute diff and version bump
    const diff = computeUnifiedDiff(currentContent, proposedContent, agentName);
    const classification = classifyVersionBump(currentAgent, proposedAgent, diff);
    const proposedVersion = incrementVersion(currentAgent.version, classification.bump);

    // Step 6: Create proposal record
    const proposal: AgentProposal = {
      proposal_id: generateUUID(),
      agent_name: agentName,
      current_version: currentAgent.version,
      proposed_version: proposedVersion,
      version_bump: classification.bump,
      weakness_report_id: report.report_id,
      current_definition: currentContent,
      proposed_definition: proposedContent,
      diff,
      rationale: classification.reason,
      status: 'pending_meta_review',
      created_at: new Date().toISOString(),
    };

    return { success: true, proposal };
  }

  // -------------------------------------------------------------------------
  // Internal: load current definition
  // -------------------------------------------------------------------------

  private loadCurrentDefinition(agentName: string): {
    success: true;
    content: string;
    agent: ParsedAgent;
  } | {
    success: false;
    error: string;
  } {
    // Check the registry first
    const record = this.registry.get(agentName);
    if (!record) {
      return { success: false, error: `Agent '${agentName}' not found in registry` };
    }

    // Read the .md file from disk
    const filePath = path.resolve(this.options.agentsDir, `${agentName}.md`);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to read agent file: ${message}` };
    }

    // Parse to get the typed representation
    const parseResult = parseAgentString(content);
    if (!parseResult.success || !parseResult.agent) {
      return { success: false, error: 'Failed to parse current agent definition' };
    }

    return { success: true, content, agent: parseResult.agent };
  }
}

// ---------------------------------------------------------------------------
// Improvement prompt builder
// ---------------------------------------------------------------------------

/**
 * Construct the improvement prompt sent to the LLM.
 *
 * Includes the weakness report, current definition, and explicit
 * constraint instructions that the LLM must not violate.
 */
export function buildImprovementPrompt(
  agent: ParsedAgent,
  currentContent: string,
  report: WeaknessReport,
): string {
  const weaknessLines = report.weaknesses.map(w =>
    `  - Dimension: ${w.dimension} (severity: ${w.severity})\n` +
    `    Evidence: ${w.evidence}\n` +
    `    Affected domains: ${w.affected_domains.join(', ')}\n` +
    `    Suggested focus: ${w.suggested_focus}`,
  ).join('\n');

  return `You are improving the agent definition for '${agent.name}' (v${agent.version}, role: ${agent.role}).

## Weakness Report
Overall Assessment: ${report.overall_assessment}
Weaknesses:
${weaknessLines}

## Current Agent Definition
\`\`\`
${currentContent}
\`\`\`

## Constraints (MUST NOT VIOLATE)
1. Do NOT change the \`tools\` field. Keep it exactly as-is.
2. Do NOT change the \`role\` field.
3. Do NOT add new expertise tags. You may refine existing tags (e.g., clarify wording) but not expand scope.
4. Do NOT remove any \`evaluation_rubric\` dimensions. You may adjust weights or descriptions.
5. Update the \`version\` field appropriately.
6. Add a new entry to \`version_history\`.

## Task
Produce a complete, modified agent \`.md\` file that addresses the identified weaknesses.
Focus your changes on the system prompt (Markdown body) to improve the agent's behavior
in the weak dimensions. You may also adjust rubric dimension weights if the weakness
analysis suggests rebalancing.

Output the complete modified \`.md\` file in a code block.`;
}

// ---------------------------------------------------------------------------
// Constraint enforcement (hard-coded, BEFORE meta-review)
// ---------------------------------------------------------------------------

/**
 * Enforce hard-coded constraints by comparing the current and proposed
 * `ParsedAgent` definitions.
 *
 * This function runs WITHOUT any LLM invocation. It is purely code-based
 * comparison that catches violations deterministically.
 *
 * Constraints:
 *   1. tools field must be identical
 *   2. role field must be identical
 *   3. no new expertise tags (subset check, case-insensitive)
 *   4. no rubric dimensions removed (additions allowed)
 */
export function enforceConstraints(
  current: ParsedAgent,
  proposed: ParsedAgent,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  // CONSTRAINT 1: tools field must be identical
  if (!arraysEqual(current.tools, proposed.tools)) {
    violations.push({
      field: 'tools',
      rule: 'IMMUTABLE_TOOLS',
      current_value: JSON.stringify(current.tools),
      proposed_value: JSON.stringify(proposed.tools),
    });
  }

  // CONSTRAINT 2: role field must be identical
  if (current.role !== proposed.role) {
    violations.push({
      field: 'role',
      rule: 'IMMUTABLE_ROLE',
      current_value: current.role,
      proposed_value: proposed.role,
    });
  }

  // CONSTRAINT 3: no new expertise tags (subset check, case-insensitive)
  const currentExpertiseLower = new Set(
    current.expertise.map(t => t.toLowerCase()),
  );
  const newTags = proposed.expertise.filter(
    t => !currentExpertiseLower.has(t.toLowerCase()),
  );
  if (newTags.length > 0) {
    violations.push({
      field: 'expertise',
      rule: 'NO_NEW_EXPERTISE',
      current_value: JSON.stringify(current.expertise),
      proposed_value: JSON.stringify(proposed.expertise),
    });
  }

  // CONSTRAINT 4: no rubric dimensions removed
  const currentDimensions = new Set(
    current.evaluation_rubric.map(d => d.name),
  );
  const proposedDimensions = new Set(
    proposed.evaluation_rubric.map(d => d.name),
  );
  const removedDimensions = [...currentDimensions].filter(
    d => !proposedDimensions.has(d),
  );
  if (removedDimensions.length > 0) {
    violations.push({
      field: 'evaluation_rubric',
      rule: 'NO_RUBRIC_REMOVAL',
      current_value: JSON.stringify([...currentDimensions]),
      proposed_value: JSON.stringify([...proposedDimensions]),
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/**
 * Extract the agent definition content from an LLM response.
 *
 * Looks for a fenced code block (```markdown, ```, or ```md) and returns
 * its contents. Returns `null` if no code block is found.
 */
export function extractDefinitionFromResponse(response: string): string | null {
  // Match fenced code blocks: ```markdown, ```md, or plain ```
  // Use a regex that captures the content between the fences
  const codeBlockRegex = /```(?:markdown|md)?\s*\n([\s\S]*?)```/;
  const match = response.match(codeBlockRegex);

  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Unified diff computation
// ---------------------------------------------------------------------------

/**
 * Compute a unified diff between two file contents.
 *
 * Produces a minimal unified diff format with context lines. This is a
 * simplified implementation that produces readable output without
 * requiring external dependencies.
 */
export function computeUnifiedDiff(
  currentContent: string,
  proposedContent: string,
  filename: string,
): string {
  const currentLines = currentContent.split('\n');
  const proposedLines = proposedContent.split('\n');

  // Use LCS to find matching lines
  const lcs = computeLcsLines(currentLines, proposedLines);

  const hunks: string[] = [];
  hunks.push(`--- a/${filename}.md`);
  hunks.push(`+++ b/${filename}.md`);

  let ci = 0; // current index
  let pi = 0; // proposed index
  let li = 0; // lcs index

  const diffLines: Array<{ type: '-' | '+' | ' '; text: string; oldLine: number; newLine: number }> = [];

  while (ci < currentLines.length || pi < proposedLines.length) {
    if (li < lcs.length && ci < currentLines.length && pi < proposedLines.length && currentLines[ci] === lcs[li] && proposedLines[pi] === lcs[li]) {
      // Common line
      diffLines.push({ type: ' ', text: currentLines[ci], oldLine: ci + 1, newLine: pi + 1 });
      ci++;
      pi++;
      li++;
    } else if (ci < currentLines.length && (li >= lcs.length || currentLines[ci] !== lcs[li])) {
      // Removed line
      diffLines.push({ type: '-', text: currentLines[ci], oldLine: ci + 1, newLine: pi + 1 });
      ci++;
    } else if (pi < proposedLines.length) {
      // Added line
      diffLines.push({ type: '+', text: proposedLines[pi], oldLine: ci + 1, newLine: pi + 1 });
      pi++;
    }
  }

  // Group into hunks (3 lines of context)
  const CONTEXT = 3;
  let hunkStart = -1;
  let hunkEnd = -1;

  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== ' ') {
      const start = Math.max(0, i - CONTEXT);
      const end = Math.min(diffLines.length - 1, i + CONTEXT);
      if (hunkStart === -1) {
        hunkStart = start;
        hunkEnd = end;
      } else if (start <= hunkEnd + 1) {
        hunkEnd = end;
      } else {
        // Emit previous hunk
        hunks.push(formatHunk(diffLines, hunkStart, hunkEnd));
        hunkStart = start;
        hunkEnd = end;
      }
    }
  }

  if (hunkStart !== -1) {
    hunks.push(formatHunk(diffLines, hunkStart, hunkEnd));
  }

  return hunks.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compare two string arrays for exact equality.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Generate a UUID v4.
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Compute the actual LCS lines (not just the length) between two arrays.
 */
function computeLcsLines(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  // Build DP table
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) {
    dp[i] = new Array<number>(m + 1).fill(0);
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get the actual subsequence
  const result: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

/**
 * Format a unified diff hunk from a range of diff lines.
 */
function formatHunk(
  diffLines: Array<{ type: '-' | '+' | ' '; text: string; oldLine: number; newLine: number }>,
  start: number,
  end: number,
): string {
  // Calculate old/new line ranges
  let oldStart = 0;
  let oldCount = 0;
  let newStart = 0;
  let newCount = 0;
  let oldStartSet = false;
  let newStartSet = false;

  for (let i = start; i <= end; i++) {
    const line = diffLines[i];
    if (line.type === ' ' || line.type === '-') {
      if (!oldStartSet) {
        oldStart = line.oldLine;
        oldStartSet = true;
      }
      oldCount++;
    }
    if (line.type === ' ' || line.type === '+') {
      if (!newStartSet) {
        newStart = line.newLine;
        newStartSet = true;
      }
      newCount++;
    }
  }

  if (!oldStartSet) oldStart = 1;
  if (!newStartSet) newStart = 1;

  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  const lines = [header];

  for (let i = start; i <= end; i++) {
    const line = diffLines[i];
    lines.push(`${line.type}${line.text}`);
  }

  return lines.join('\n');
}
