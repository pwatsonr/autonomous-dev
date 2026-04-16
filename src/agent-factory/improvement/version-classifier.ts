/**
 * Version bump classifier (SPEC-005-3-3, Task 7).
 *
 * Determines whether a proposed agent modification constitutes a major,
 * minor, or patch semver increment based on diff analysis.
 *
 * Classification rules (TDD 3.6.1):
 *   MAJOR: role or expertise (new tags) changed, or >50% body changed
 *   MINOR: rubric dimensions changed, new instructions added, or 10-50% body
 *   PATCH: <10% body, no frontmatter changes (except version/version_history)
 */

import { ParsedAgent } from '../types';
import { VersionBump, VersionClassification } from './types';

// Re-export for convenience
export type { VersionBump, VersionClassification };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the version bump required for a proposed agent modification.
 *
 * Compares the current and proposed `ParsedAgent` definitions plus the
 * unified diff string, and returns a classification with the bump type,
 * reason, body change percentage, and list of changed frontmatter fields.
 *
 * @param current   The currently-active agent definition.
 * @param proposed  The proposed modified agent definition.
 * @param _diff     The unified diff between current and proposed `.md` content.
 *                  Reserved for future use; classification uses parsed fields.
 * @returns         The version bump classification.
 */
export function classifyVersionBump(
  current: ParsedAgent,
  proposed: ParsedAgent,
  _diff: string,
): VersionClassification {
  const bodyChangePercent = computeBodyChangePercent(
    current.system_prompt,
    proposed.system_prompt,
  );

  const frontmatterChanges = detectFrontmatterChanges(current, proposed);

  // MAJOR: role or expertise (new tags) changed, or >50% body changed
  if (
    frontmatterChanges.includes('role') ||
    frontmatterChanges.includes('expertise_new_tags') ||
    bodyChangePercent > 50
  ) {
    const reasons: string[] = [];
    if (frontmatterChanges.includes('role')) reasons.push('role changed');
    if (frontmatterChanges.includes('expertise_new_tags')) reasons.push('new expertise tags added');
    if (bodyChangePercent > 50) reasons.push(`>50% body changed (${bodyChangePercent.toFixed(1)}%)`);
    return {
      bump: 'major',
      reason: reasons.join('; '),
      bodyChangePercent,
      frontmatterChanges,
    };
  }

  // MINOR: rubric dimensions changed, or 10-50% body
  if (
    frontmatterChanges.includes('evaluation_rubric') ||
    bodyChangePercent >= 10
  ) {
    const reasons: string[] = [];
    if (frontmatterChanges.includes('evaluation_rubric')) reasons.push('evaluation rubric changed');
    if (bodyChangePercent >= 10) reasons.push(`10-50% body changed (${bodyChangePercent.toFixed(1)}%)`);
    return {
      bump: 'minor',
      reason: reasons.join('; '),
      bodyChangePercent,
      frontmatterChanges,
    };
  }

  // PATCH: <10% body, no frontmatter changes (except version/version_history)
  return {
    bump: 'patch',
    reason: `<10% body changed (${bodyChangePercent.toFixed(1)}%), no significant frontmatter changes`,
    bodyChangePercent,
    frontmatterChanges,
  };
}

// ---------------------------------------------------------------------------
// Body change percentage computation
// ---------------------------------------------------------------------------

/**
 * Compute the percentage of lines changed between two system prompts.
 *
 * Uses a simple LCS-based line diff:
 *   1. Split current and proposed into lines.
 *   2. Compute longest common subsequence (LCS) length.
 *   3. addedLines = proposedLines.length - lcsLength
 *   4. removedLines = currentLines.length - lcsLength
 *   5. changePercent = (addedLines + removedLines) / max(currentLines.length, 1) * 100
 */
export function computeBodyChangePercent(
  currentBody: string,
  proposedBody: string,
): number {
  const currentLines = splitLines(currentBody);
  const proposedLines = splitLines(proposedBody);

  const lcsLength = computeLcsLength(currentLines, proposedLines);
  const removedLines = currentLines.length - lcsLength;
  const addedLines = proposedLines.length - lcsLength;

  const totalCurrentLines = Math.max(currentLines.length, 1);
  return ((addedLines + removedLines) / totalCurrentLines) * 100;
}

// ---------------------------------------------------------------------------
// Frontmatter change detection
// ---------------------------------------------------------------------------

/**
 * Detect which frontmatter fields changed between current and proposed,
 * excluding `version` and `version_history` (which are expected to change).
 *
 * Returns a list of change identifiers:
 *   - 'role'               : role field changed
 *   - 'expertise_new_tags' : new expertise tags added
 *   - 'evaluation_rubric'  : rubric dimensions changed (added, removed, or weight delta > 0.1)
 *   - 'temperature'        : temperature field changed
 *   - 'turn_limit'         : turn_limit field changed
 *   - 'model'              : model field changed
 */
export function detectFrontmatterChanges(
  current: ParsedAgent,
  proposed: ParsedAgent,
): string[] {
  const changes: string[] = [];

  // Role
  if (current.role !== proposed.role) {
    changes.push('role');
  }

  // Expertise: check for new tags (case-insensitive)
  const currentExpertiseLower = new Set(current.expertise.map(t => t.toLowerCase()));
  const newTags = proposed.expertise.filter(
    t => !currentExpertiseLower.has(t.toLowerCase()),
  );
  if (newTags.length > 0) {
    changes.push('expertise_new_tags');
  }

  // Evaluation rubric: check for added, removed, or weight change > 0.1
  if (hasRubricChanges(current.evaluation_rubric, proposed.evaluation_rubric)) {
    changes.push('evaluation_rubric');
  }

  // Temperature
  if (current.temperature !== proposed.temperature) {
    changes.push('temperature');
  }

  // Turn limit
  if (current.turn_limit !== proposed.turn_limit) {
    changes.push('turn_limit');
  }

  // Model
  if (current.model !== proposed.model) {
    changes.push('model');
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

/**
 * Increment a semver version string by the specified bump type.
 *
 * @param version  Current version string (e.g., "1.2.3").
 * @param bump     The bump type: 'major', 'minor', or 'patch'.
 * @returns        The incremented version string.
 */
export function incrementVersion(version: string, bump: VersionBump): string {
  const parts = version.split('.').map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;

  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if evaluation rubric has meaningful changes:
 *   - Dimensions added or removed
 *   - Weight changed by more than 0.1 for any dimension
 */
function hasRubricChanges(
  current: Array<{ name: string; weight: number; description: string }>,
  proposed: Array<{ name: string; weight: number; description: string }>,
): boolean {
  const currentMap = new Map(current.map(d => [d.name, d]));
  const proposedMap = new Map(proposed.map(d => [d.name, d]));

  // Check for removed dimensions
  for (const name of currentMap.keys()) {
    if (!proposedMap.has(name)) return true;
  }

  // Check for added dimensions
  for (const name of proposedMap.keys()) {
    if (!currentMap.has(name)) return true;
  }

  // Check for weight changes > 0.1
  for (const [name, currentDim] of currentMap) {
    const proposedDim = proposedMap.get(name);
    if (proposedDim && Math.abs(currentDim.weight - proposedDim.weight) > 0.1) {
      return true;
    }
  }

  return false;
}

/**
 * Split a string into lines, handling empty strings gracefully.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/**
 * Compute the length of the longest common subsequence of two string arrays.
 *
 * Uses standard DP; O(n*m) time and space. For agent system prompts this
 * is bounded by a few hundred lines at most.
 */
function computeLcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;

  // Use a 2-row DP table to save memory
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    // Swap rows
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return prev[m];
}
