/**
 * Conflict resolution, auto-resolve, AI-resolve, and human escalation
 * for the parallel merge engine.
 *
 * SPEC-006-4-2: Conflict Classification and Auto-Resolution
 *   - Auto-resolve for non-overlapping hunks (3-way merge)
 *   - AI conflict resolution with confidence threshold (0.85)
 *   - Human escalation with structured reports
 *
 * SPEC-006-4-3: Human Escalation, Merge Circuit Breaker, and Rollback
 *   - Escalation report generation
 *   - Merge abort on escalation
 */

import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';

import { ParallelConfig } from './config';
import type { ClassificationResult } from './conflict-classifier';
import {
  ConflictType,
  ConflictResolutionResult,
  ConflictResolutionRequest,
} from './types';

// Re-export for convenience
export { ConflictType } from './types';
export type { ConflictResolutionResult, ConflictResolutionRequest } from './types';
export type { ClassificationResult } from './conflict-classifier';

// ============================================================================
// Escalation report (SPEC-006-4-3)
// ============================================================================

/**
 * Structured report generated when a conflict is escalated to a human.
 * Written to `.autonomous-dev/conflicts/req-{requestId}/` as JSON.
 */
export interface EscalationReport {
  id: string;
  requestId: string;
  file: string;
  trackA: string;
  trackB: string;
  conflictType: ConflictType;
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  specAIntent: string;
  specBIntent: string;
  aiSuggestion: string | null;
  aiConfidence: number | null;
  aiReasoning: string | null;
  timestamp: string;
}

// ============================================================================
// AI agent types (SPEC-006-4-2)
// ============================================================================

/** Response from the conflict resolution subagent. */
export interface ConflictAgentResponse {
  content: string;
  confidence: number;
  reasoning: string;
}

/**
 * Factory function type for spawning a conflict resolution subagent.
 * The prompt is the full resolution prompt; maxTurns bounds the agent.
 * Returns the parsed agent response.
 */
export type SpawnConflictAgentFn = (
  prompt: string,
  maxTurns: number,
) => Promise<ConflictAgentResponse>;

// ============================================================================
// Errors (SPEC-006-4-2)
// ============================================================================

/**
 * Thrown when the AI conflict resolution agent returns a confidence score
 * below the configured threshold.
 */
export class ConflictResolutionBelowThresholdError extends Error {
  constructor(
    public readonly file: string,
    public readonly confidence: number,
    public readonly threshold: number,
    public readonly result: ConflictResolutionResult,
  ) {
    super(
      `AI conflict resolution for "${file}" returned confidence ${confidence.toFixed(2)}, ` +
        `below threshold ${threshold.toFixed(2)}. Human review required.`,
    );
    this.name = 'ConflictResolutionBelowThresholdError';
  }
}

// ============================================================================
// 3-Way Merge Algorithm (SPEC-006-4-2)
// ============================================================================

/** Result of a 3-way merge attempt. */
export interface ThreeWayMergeResult {
  success: boolean;
  result: string[];
  /** If success is false, describes the conflict. */
  conflictDescription?: string;
}

/**
 * Perform a line-based 3-way merge.
 *
 * For each line range in base:
 *   - If unchanged in both: keep base
 *   - If changed in ours only: take ours
 *   - If changed in theirs only: take theirs
 *   - If changed in both (should not happen for non-overlapping): fail
 *
 * Uses LCS-based alignment to map lines between versions.
 */
export function threeWayMerge(
  baseLines: string[],
  oursLines: string[],
  theirsLines: string[],
): ThreeWayMergeResult {
  const oursAlignment = buildAlignment(baseLines, oursLines);
  const theirsAlignment = buildAlignment(baseLines, theirsLines);

  const result: string[] = [];
  let oursIdx = 0;
  let theirsIdx = 0;

  for (let baseIdx = 0; baseIdx <= baseLines.length; baseIdx++) {
    // Collect insertions before this base line from ours
    const oursInsertions: string[] = [];
    while (
      oursIdx < oursAlignment.length &&
      oursAlignment[oursIdx].baseIdx === -1 &&
      oursAlignment[oursIdx].insertBeforeBase === baseIdx
    ) {
      oursInsertions.push(oursAlignment[oursIdx].modLine);
      oursIdx++;
    }

    // Collect insertions before this base line from theirs
    const theirsInsertions: string[] = [];
    while (
      theirsIdx < theirsAlignment.length &&
      theirsAlignment[theirsIdx].baseIdx === -1 &&
      theirsAlignment[theirsIdx].insertBeforeBase === baseIdx
    ) {
      theirsInsertions.push(theirsAlignment[theirsIdx].modLine);
      theirsIdx++;
    }

    // If both have insertions at the same point, check if they're identical
    if (oursInsertions.length > 0 && theirsInsertions.length > 0) {
      if (oursInsertions.join('\n') === theirsInsertions.join('\n')) {
        // Compatible: same insertions
        result.push(...oursInsertions);
      } else {
        return {
          success: false,
          result: [],
          conflictDescription: `Both sides insert different content before base line ${baseIdx}`,
        };
      }
    } else {
      result.push(...oursInsertions);
      result.push(...theirsInsertions);
    }

    // Handle the base line itself
    if (baseIdx < baseLines.length) {
      const oursEntry = oursAlignment.find(
        (a) => a.baseIdx === baseIdx && a.baseIdx !== -1,
      );
      const theirsEntry = theirsAlignment.find(
        (a) => a.baseIdx === baseIdx && a.baseIdx !== -1,
      );

      const oursChanged = oursEntry
        ? oursEntry.deleted || oursEntry.modLine !== baseLines[baseIdx]
        : false;
      const theirsChanged = theirsEntry
        ? theirsEntry.deleted || theirsEntry.modLine !== baseLines[baseIdx]
        : false;

      if (!oursChanged && !theirsChanged) {
        // Neither changed: keep base
        result.push(baseLines[baseIdx]);
      } else if (oursChanged && !theirsChanged) {
        // Only ours changed: take ours
        if (oursEntry && !oursEntry.deleted) {
          result.push(oursEntry.modLine);
        }
        // If deleted, skip the line
      } else if (!oursChanged && theirsChanged) {
        // Only theirs changed: take theirs
        if (theirsEntry && !theirsEntry.deleted) {
          result.push(theirsEntry.modLine);
        }
      } else {
        // Both changed
        const oursContent = oursEntry?.deleted ? null : oursEntry?.modLine;
        const theirsContent = theirsEntry?.deleted
          ? null
          : theirsEntry?.modLine;

        if (oursContent === theirsContent) {
          // Compatible: same change (including both deleted)
          if (oursContent !== null) {
            result.push(oursContent);
          }
        } else {
          return {
            success: false,
            result: [],
            conflictDescription: `Both sides modified base line ${baseIdx} differently`,
          };
        }
      }

      // Advance alignment pointers past this base line
      if (oursEntry) {
        oursIdx = oursAlignment.indexOf(oursEntry) + 1;
      }
      if (theirsEntry) {
        theirsIdx = theirsAlignment.indexOf(theirsEntry) + 1;
      }
    }
  }

  // Collect any trailing entries
  while (oursIdx < oursAlignment.length) {
    if (!oursAlignment[oursIdx].deleted) {
      result.push(oursAlignment[oursIdx].modLine);
    }
    oursIdx++;
  }
  while (theirsIdx < theirsAlignment.length) {
    if (!theirsAlignment[theirsIdx].deleted) {
      result.push(theirsAlignment[theirsIdx].modLine);
    }
    theirsIdx++;
  }

  return { success: true, result };
}

/** An alignment entry mapping a base line to its modified counterpart. */
interface AlignmentEntry {
  baseIdx: number; // -1 for insertions
  modLine: string;
  deleted: boolean;
  insertBeforeBase: number; // for insertions, which base line they precede
}

/**
 * Build a line-by-line alignment between base and modified arrays
 * using LCS to determine which lines match.
 */
function buildAlignment(
  baseLines: string[],
  modLines: string[],
): AlignmentEntry[] {
  const m = baseLines.length;
  const n = modLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (baseLines[i - 1] === modLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matches
  const matches: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (baseLines[i - 1] === modLines[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();

  // Build alignment entries
  const alignment: AlignmentEntry[] = [];
  let modIdx = 0;
  let matchIdx = 0;
  let baseIdx = 0;

  while (baseIdx < m || modIdx < n) {
    if (matchIdx < matches.length) {
      const [matchBase, matchMod] = matches[matchIdx];

      // Add insertions from mod before the next match
      while (modIdx < matchMod) {
        alignment.push({
          baseIdx: -1,
          modLine: modLines[modIdx],
          deleted: false,
          insertBeforeBase: matchBase,
        });
        modIdx++;
      }

      // Add deletions from base before the next match
      while (baseIdx < matchBase) {
        alignment.push({
          baseIdx,
          modLine: baseLines[baseIdx],
          deleted: true,
          insertBeforeBase: -1,
        });
        baseIdx++;
      }

      // Add the matched line
      alignment.push({
        baseIdx: matchBase,
        modLine: modLines[matchMod],
        deleted: false,
        insertBeforeBase: -1,
      });
      baseIdx++;
      modIdx++;
      matchIdx++;
    } else {
      // No more matches: remaining mod lines are insertions
      while (modIdx < n) {
        alignment.push({
          baseIdx: -1,
          modLine: modLines[modIdx],
          deleted: false,
          insertBeforeBase: baseIdx,
        });
        modIdx++;
      }
      // Remaining base lines are deletions
      while (baseIdx < m) {
        alignment.push({
          baseIdx,
          modLine: baseLines[baseIdx],
          deleted: true,
          insertBeforeBase: -1,
        });
        baseIdx++;
      }
    }
  }

  return alignment;
}

// ============================================================================
// ConflictResolver
// ============================================================================

/**
 * Resolves merge conflicts using auto-resolution (non-overlapping),
 * AI-assisted resolution (overlapping) with confidence gating,
 * and human escalation when resolution is not possible.
 */
export class ConflictResolver {
  private spawnConflictAgent: SpawnConflictAgentFn;

  constructor(
    private readonly repoRoot: string,
    private readonly config: ParallelConfig,
    private readonly eventEmitter: EventEmitter,
    spawnAgent?: SpawnConflictAgentFn,
  ) {
    this.spawnConflictAgent =
      spawnAgent ?? ConflictResolver.defaultSpawnConflictAgent;
  }

  /**
   * Default subagent factory stub.
   * In production, this would be replaced with a real Claude Code SDK call.
   */
  private static async defaultSpawnConflictAgent(
    _prompt: string,
    _maxTurns: number,
  ): Promise<ConflictAgentResponse> {
    return {
      content: '',
      confidence: 0,
      reasoning: 'No conflict agent configured',
    };
  }

  // --------------------------------------------------------------------------
  // Stage content retrieval
  // --------------------------------------------------------------------------

  /**
   * Read content from a specific merge stage using `git show`.
   *
   * Stage numbers:
   *   1 = base (common ancestor)
   *   2 = ours (current branch)
   *   3 = theirs (branch being merged)
   *
   * Returns null if the stage content is unavailable.
   */
  async getStageContent(file: string, stage: 1 | 2 | 3): Promise<string | null> {
    try {
      const output = execSync(
        `git -C "${this.repoRoot}" show :${stage}:${file}`,
        { encoding: 'utf-8' },
      );
      return output;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Conflict classification (simple, from SPEC-006-4-3)
  // --------------------------------------------------------------------------

  /**
   * Classify a conflict based on the diff between ours and theirs
   * relative to base. Returns the appropriate ConflictType.
   *
   * Note: for full 5-tier classification with hunk analysis, use
   * ConflictClassifier from `./conflict-classifier.ts`.
   */
  classifyConflict(
    baseContent: string | null,
    oursContent: string | null,
    theirsContent: string | null,
  ): ConflictType {
    if (!oursContent || !theirsContent) {
      return ConflictType.NonOverlapping;
    }
    if (!baseContent) {
      // Both tracks added the file independently
      return ConflictType.OverlappingConflicting;
    }

    const baseLines = baseContent.split('\n');
    const oursLines = oursContent.split('\n');
    const theirsLines = theirsContent.split('\n');

    // Find which lines differ from base in each branch
    const oursChanged = new Set<number>();
    const theirsChanged = new Set<number>();

    const maxLen = Math.max(baseLines.length, oursLines.length, theirsLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= baseLines.length || i >= oursLines.length || baseLines[i] !== oursLines[i]) {
        oursChanged.add(i);
      }
      if (i >= baseLines.length || i >= theirsLines.length || baseLines[i] !== theirsLines[i]) {
        theirsChanged.add(i);
      }
    }

    // Check for overlap
    let hasOverlap = false;
    for (const line of oursChanged) {
      if (theirsChanged.has(line)) {
        hasOverlap = true;
        break;
      }
    }

    if (!hasOverlap) {
      return ConflictType.NonOverlapping;
    }

    return ConflictType.OverlappingConflicting;
  }

  // --------------------------------------------------------------------------
  // Auto-resolve for non-overlapping conflicts (SPEC-006-4-2)
  // --------------------------------------------------------------------------

  /**
   * Attempt to auto-resolve a non-overlapping conflict.
   * Applies both change sets to the base independently using 3-way merge.
   *
   * @returns Resolution result, or null if the conflict type is not non-overlapping.
   */
  async autoResolve(
    classification: ClassificationResult,
    requestId: string,
  ): Promise<ConflictResolutionResult | null> {
    if (classification.conflictType !== ConflictType.NonOverlapping) {
      return null; // cannot auto-resolve overlapping conflicts
    }

    const { baseContent, oursContent, theirsContent, file } = classification;

    const baseLines = baseContent.split('\n');
    const oursLines = oursContent.split('\n');
    const theirsLines = theirsContent.split('\n');

    const merged = threeWayMerge(baseLines, oursLines, theirsLines);

    if (!merged.success) {
      return null; // unexpected overlap detected during merge
    }

    const resolvedContent = merged.result.join('\n');

    // Stage the resolved file
    const filePath = path.join(this.repoRoot, file);
    await fs.writeFile(filePath, resolvedContent, 'utf-8');
    execSync(`git -C "${this.repoRoot}" add "${file}"`);

    this.eventEmitter.emit('merge.conflict_resolved', {
      type: 'merge.conflict_resolved',
      requestId,
      file,
      strategy: 'auto',
      confidence: 0.95,
      timestamp: new Date().toISOString(),
    });

    return {
      resolvedContent,
      confidence: 0.95,
      reasoning:
        'Non-overlapping hunks: both change sets applied independently to base',
      strategy: 'auto',
    };
  }

  // --------------------------------------------------------------------------
  // AI conflict resolution (SPEC-006-4-2)
  // --------------------------------------------------------------------------

  /**
   * Spawn a specialised conflict resolution subagent.
   * Provides base/ours/theirs and both specs; expects resolved content + confidence.
   *
   * If the agent's confidence is at or above the threshold, the resolution is
   * accepted, the file is written and staged.
   *
   * If below threshold, throws ConflictResolutionBelowThresholdError for
   * human escalation.
   */
  async aiResolve(
    request: ConflictResolutionRequest,
  ): Promise<ConflictResolutionResult> {
    this.eventEmitter.emit('merge.conflict_detected', {
      type: 'merge.conflict_detected',
      requestId: request.requestId,
      file: request.file,
      trackA: request.trackA,
      trackB: request.trackB,
      timestamp: new Date().toISOString(),
    });

    const prompt = this.buildConflictResolutionPrompt(request);

    // Spawn a subagent with bounded turn budget (10 turns max)
    const resolution = await this.spawnConflictAgent(prompt, 10);

    const result: ConflictResolutionResult = {
      resolvedContent: resolution.content,
      confidence: resolution.confidence,
      reasoning: resolution.reasoning,
      strategy: 'ai',
    };

    // Enforce confidence threshold
    if (result.confidence >= this.config.conflict_ai_confidence_threshold) {
      // Accept resolution: write file and stage
      const filePath = path.join(this.repoRoot, request.file);
      await fs.writeFile(filePath, result.resolvedContent, 'utf-8');
      execSync(`git -C "${this.repoRoot}" add "${request.file}"`);

      this.eventEmitter.emit('merge.conflict_resolved', {
        type: 'merge.conflict_resolved',
        requestId: request.requestId,
        file: request.file,
        strategy: 'ai',
        confidence: result.confidence,
        timestamp: new Date().toISOString(),
      });

      return result;
    }

    // Below threshold: escalate to human
    throw new ConflictResolutionBelowThresholdError(
      request.file,
      result.confidence,
      this.config.conflict_ai_confidence_threshold,
      result,
    );
  }

  // --------------------------------------------------------------------------
  // Prompt builder
  // --------------------------------------------------------------------------

  /**
   * Build the structured prompt for the conflict resolution subagent.
   * Includes base/ours/theirs content, both specs, and interface contracts.
   */
  buildConflictResolutionPrompt(request: ConflictResolutionRequest): string {
    return `You are a merge conflict resolution specialist.

## Conflict in file: ${request.file}

### Base version (common ancestor):
\`\`\`
${request.baseContent}
\`\`\`

### "Ours" version (integration branch, ${request.trackA}):
\`\`\`
${request.oursContent}
\`\`\`

### "Theirs" version (track branch, ${request.trackB}):
\`\`\`
${request.theirsContent}
\`\`\`

### Spec for ${request.trackA}:
${request.specA}

### Spec for ${request.trackB}:
${request.specB}

### Interface contracts:
${request.interfaceContracts.map((c) => `- ${c.producer} -> ${c.consumer}: ${c.contractType}`).join('\n')}

## Instructions
1. Merge both sets of changes into a coherent result that satisfies BOTH specs.
2. Resolve any contradictions in favor of maintaining type safety and interface contracts.
3. Return your response in this exact format:

RESOLVED_CONTENT:
<the merged file content>

CONFIDENCE: <0.0-1.0>
REASONING: <explanation of merge decisions>`;
  }

  // --------------------------------------------------------------------------
  // Escalation (SPEC-006-4-3)
  // --------------------------------------------------------------------------

  /**
   * Generate a structured escalation report for a conflict that cannot
   * be resolved automatically.
   *
   * Steps:
   *   1. Read base/ours/theirs content from git merge stages
   *   2. Classify the conflict
   *   3. Build the report with spec intents and optional AI suggestion
   *   4. Write report JSON to `.autonomous-dev/conflicts/req-{requestId}/`
   *   5. Abort the in-progress merge
   *   6. Emit `merge.escalated` event
   *
   * @param file       Path of the conflicting file
   * @param requestId  Request identifier
   * @param trackA     Name of the first track
   * @param trackB     Name of the second track
   * @param aiResult   Optional AI resolution result (included in report)
   * @returns The generated escalation report
   */
  async escalateConflict(
    file: string,
    requestId: string,
    trackA: string,
    trackB: string,
    aiResult?: ConflictResolutionResult,
  ): Promise<EscalationReport> {
    // 1. Read stage content
    const baseContent = await this.getStageContent(file, 1) ?? '';
    const oursContent = await this.getStageContent(file, 2) ?? '';
    const theirsContent = await this.getStageContent(file, 3) ?? '';

    // 2. Classify
    const conflictType = this.classifyConflict(
      baseContent || null,
      oursContent || null,
      theirsContent || null,
    );

    // 3. Build report
    const report: EscalationReport = {
      id: `conflict-${requestId}-${Date.now()}`,
      requestId,
      file,
      trackA,
      trackB,
      conflictType,
      baseContent,
      oursContent,
      theirsContent,
      specAIntent: 'extracted from spec',
      specBIntent: 'extracted from spec',
      aiSuggestion: aiResult?.resolvedContent ?? null,
      aiConfidence: aiResult?.confidence ?? null,
      aiReasoning: aiResult?.reasoning ?? null,
      timestamp: new Date().toISOString(),
    };

    // 4. Write report to structured location
    const reportDir = path.join(
      this.repoRoot,
      '.autonomous-dev',
      'conflicts',
      `req-${requestId}`,
    );
    await fs.mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${report.id}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    // 5. Abort the in-progress merge
    try {
      execSync(`git -C "${this.repoRoot}" merge --abort`, { stdio: 'pipe' });
    } catch {
      // merge --abort may fail if no merge in progress; that's fine
    }

    // 6. Emit event
    this.eventEmitter.emit('merge.escalated', {
      type: 'merge.escalated',
      requestId,
      file,
      trackA,
      trackB,
      reportPath,
      timestamp: new Date().toISOString(),
    });

    return report;
  }
}
