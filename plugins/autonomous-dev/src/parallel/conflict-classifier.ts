/**
 * Conflict type classification using git stage extraction.
 *
 * SPEC-006-4-2: Conflict Classification and Auto-Resolution
 *
 * Categorizes merge conflicts into five types based on the relationship
 * between base, ours, and theirs versions:
 *   - Disjoint: files modified in only one branch (no actual conflict)
 *   - NonOverlapping: both branches modify the file, but in different line ranges
 *   - OverlappingCompatible: both branches make the same change in overlapping regions
 *   - OverlappingConflicting: both branches make different changes in overlapping regions
 *   - Structural: add/delete conflicts (missing git merge stages)
 */

import { execSync } from 'child_process';

import { ConflictType } from './types';

// Re-export for consumer convenience
export { ConflictType } from './types';

// ============================================================================
// Interfaces
// ============================================================================

/** A line range within a file (0-based, end-exclusive). */
export interface LineRange {
  start: number;
  end: number;
}

/** Analysis of a single hunk pair (ours vs theirs) relative to base. */
export interface HunkAnalysis {
  baseRange: LineRange;
  oursRange: LineRange;
  theirsRange: LineRange;
  overlaps: boolean;
}

/** Internal representation of a single diff hunk. */
export interface HunkInfo {
  baseStart: number;
  baseEnd: number;
  modStart: number;
  modEnd: number;
}

/** Result of classifying a single conflicted file. */
export interface ClassificationResult {
  file: string;
  conflictType: ConflictType;
  confidence: number;
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  hunks: HunkAnalysis[];
}

// ============================================================================
// Diff utilities
// ============================================================================

/** A single change entry from a line-based diff. */
interface DiffChange {
  added?: boolean;
  removed?: boolean;
  count: number;
}

/**
 * Compute a line-level diff between two strings.
 *
 * Uses a simple LCS-based approach: for each line in `base` and `modified`,
 * tracks insertions, deletions, and unchanged regions.
 *
 * This is a lightweight implementation to avoid external dependencies.
 * For production usage with large files, consider using the `diff` npm package.
 */
export function diffLines(base: string, modified: string): DiffChange[] {
  const baseLines = base.split('\n');
  const modLines = modified.split('\n');

  // Build LCS table
  const m = baseLines.length;
  const n = modLines.length;

  // Optimisation: if both are identical, return single unchanged block
  if (base === modified) {
    return [{ count: m }];
  }

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

  // Backtrack to produce change list
  const changes: DiffChange[] = [];
  let i = m;
  let j = n;

  // We'll build in reverse then flip
  const reversed: DiffChange[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && baseLines[i - 1] === modLines[j - 1]) {
      reversed.push({ count: 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({ added: true, count: 1 });
      j--;
    } else {
      reversed.push({ removed: true, count: 1 });
      i--;
    }
  }

  reversed.reverse();

  // Merge consecutive same-type changes
  for (const change of reversed) {
    const last = changes[changes.length - 1];
    if (last) {
      const sameType =
        (change.added && last.added) ||
        (change.removed && last.removed) ||
        (!change.added && !change.removed && !last.added && !last.removed);
      if (sameType) {
        last.count += change.count;
        continue;
      }
    }
    changes.push({ ...change });
  }

  return changes;
}

// ============================================================================
// ConflictClassifier
// ============================================================================

/**
 * Classifies merge conflicts by extracting the three git merge stages
 * and analyzing hunk overlaps between ours and theirs relative to base.
 */
export class ConflictClassifier {
  constructor(private repoRoot: string) {}

  /**
   * Classify a single conflicted file.
   *
   * Extracts base (stage 1), ours (stage 2), theirs (stage 3) via
   * `git show :N:<file>`, then computes hunks and overlap analysis.
   */
  async classifyConflict(
    file: string,
    _requestId: string,
  ): Promise<ClassificationResult> {
    // Extract the three stages from git's index
    const baseContent = await this.getStageContent(file, 1); // common ancestor
    const oursContent = await this.getStageContent(file, 2); // integration branch (ours)
    const theirsContent = await this.getStageContent(file, 3); // track branch (theirs)

    // If any stage is missing, it's a structural conflict (add/delete)
    if (baseContent === null || oursContent === null || theirsContent === null) {
      return {
        file,
        conflictType: ConflictType.Structural,
        confidence: 1.0,
        baseContent: baseContent ?? '',
        oursContent: oursContent ?? '',
        theirsContent: theirsContent ?? '',
        hunks: [],
      };
    }

    // Compute hunks: diff base->ours and base->theirs
    const oursHunks = this.computeHunks(baseContent, oursContent);
    const theirsHunks = this.computeHunks(baseContent, theirsContent);

    // If one side has no changes, it's disjoint (only one branch modified the file)
    if (oursHunks.length === 0 || theirsHunks.length === 0) {
      return {
        file,
        conflictType: ConflictType.Disjoint,
        confidence: 1.0,
        baseContent,
        oursContent,
        theirsContent,
        hunks: [],
      };
    }

    // Check for overlap between hunk ranges
    const hunkAnalysis = this.analyzeHunkOverlaps(oursHunks, theirsHunks);
    const hasOverlap = hunkAnalysis.some((h) => h.overlaps);

    if (!hasOverlap) {
      return {
        file,
        conflictType: ConflictType.NonOverlapping,
        confidence: 0.95,
        baseContent,
        oursContent,
        theirsContent,
        hunks: hunkAnalysis,
      };
    }

    // Overlapping changes -- determine compatible vs conflicting
    const isCompatible = this.checkOverlapCompatibility(
      baseContent,
      oursContent,
      theirsContent,
      hunkAnalysis,
    );

    return {
      file,
      conflictType: isCompatible
        ? ConflictType.OverlappingCompatible
        : ConflictType.OverlappingConflicting,
      confidence: isCompatible ? 0.7 : 0.9,
      baseContent,
      oursContent,
      theirsContent,
      hunks: hunkAnalysis,
    };
  }

  /**
   * Extract content from a specific git merge stage.
   * Stage 1 = base (common ancestor)
   * Stage 2 = ours (integration branch)
   * Stage 3 = theirs (track branch)
   */
  async getStageContent(
    file: string,
    stage: 1 | 2 | 3,
  ): Promise<string | null> {
    try {
      return execSync(`git -C "${this.repoRoot}" show :${stage}:${file}`, {
        encoding: 'utf-8',
      });
    } catch {
      return null; // stage does not exist (file added/deleted)
    }
  }

  /**
   * Compute changed hunks between two file versions.
   * Uses a line-based diff algorithm.
   */
  computeHunks(base: string, modified: string): HunkInfo[] {
    const changes = diffLines(base, modified);
    const hunks: HunkInfo[] = [];
    let baseLine = 0;
    let modLine = 0;

    for (const change of changes) {
      if (change.added) {
        hunks.push({
          baseStart: baseLine,
          baseEnd: baseLine,
          modStart: modLine,
          modEnd: modLine + change.count,
        });
        modLine += change.count;
      } else if (change.removed) {
        hunks.push({
          baseStart: baseLine,
          baseEnd: baseLine + change.count,
          modStart: modLine,
          modEnd: modLine,
        });
        baseLine += change.count;
      } else {
        baseLine += change.count;
        modLine += change.count;
      }
    }

    return hunks;
  }

  /**
   * Compare ours-hunks and theirs-hunks for range overlap in base coordinates.
   *
   * Returns HunkAnalysis entries for overlapping pairs, plus non-overlapping
   * hunks for completeness (these can be auto-resolved independently).
   */
  analyzeHunkOverlaps(
    oursHunks: HunkInfo[],
    theirsHunks: HunkInfo[],
  ): HunkAnalysis[] {
    const analysis: HunkAnalysis[] = [];
    const matchedOurs = new Set<number>();
    const matchedTheirs = new Set<number>();

    // Find overlapping pairs
    for (let oi = 0; oi < oursHunks.length; oi++) {
      const ours = oursHunks[oi];
      for (let ti = 0; ti < theirsHunks.length; ti++) {
        const theirs = theirsHunks[ti];
        const overlaps =
          ours.baseStart < theirs.baseEnd && theirs.baseStart < ours.baseEnd;

        if (overlaps) {
          matchedOurs.add(oi);
          matchedTheirs.add(ti);
          analysis.push({
            baseRange: {
              start: Math.min(ours.baseStart, theirs.baseStart),
              end: Math.max(ours.baseEnd, theirs.baseEnd),
            },
            oursRange: { start: ours.modStart, end: ours.modEnd },
            theirsRange: { start: theirs.modStart, end: theirs.modEnd },
            overlaps: true,
          });
        }
      }
    }

    // Add non-overlapping hunks for completeness
    for (let oi = 0; oi < oursHunks.length; oi++) {
      if (!matchedOurs.has(oi)) {
        const ours = oursHunks[oi];
        analysis.push({
          baseRange: { start: ours.baseStart, end: ours.baseEnd },
          oursRange: { start: ours.modStart, end: ours.modEnd },
          theirsRange: { start: -1, end: -1 },
          overlaps: false,
        });
      }
    }

    for (let ti = 0; ti < theirsHunks.length; ti++) {
      if (!matchedTheirs.has(ti)) {
        const theirs = theirsHunks[ti];
        analysis.push({
          baseRange: { start: theirs.baseStart, end: theirs.baseEnd },
          oursRange: { start: -1, end: -1 },
          theirsRange: { start: theirs.modStart, end: theirs.modEnd },
          overlaps: false,
        });
      }
    }

    return analysis;
  }

  /**
   * Check if overlapping hunks are making compatible changes
   * (i.e., both sides made the exact same modification).
   */
  checkOverlapCompatibility(
    _base: string,
    ours: string,
    theirs: string,
    hunks: HunkAnalysis[],
  ): boolean {
    const oursLines = ours.split('\n');
    const theirsLines = theirs.split('\n');

    for (const hunk of hunks.filter((h) => h.overlaps)) {
      const oursSlice = oursLines
        .slice(hunk.oursRange.start, hunk.oursRange.end)
        .join('\n');
      const theirsSlice = theirsLines
        .slice(hunk.theirsRange.start, hunk.theirsRange.end)
        .join('\n');
      if (oursSlice !== theirsSlice) return false;
    }
    return true;
  }
}
