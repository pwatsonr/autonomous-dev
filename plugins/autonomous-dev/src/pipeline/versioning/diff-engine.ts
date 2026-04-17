import { ParsedSection, DocumentSections, parseSections } from './section-parser';

export type SectionChangeType = 'added' | 'removed' | 'modified' | 'unchanged';

export interface SectionDiff {
  /** Section ID */
  sectionId: string;
  /** What changed */
  changeType: SectionChangeType;
  /** Previous content (null if added) */
  oldContent: string | null;
  /** New content (null if removed) */
  newContent: string | null;
  /** Word count delta (positive = added words, negative = removed words) */
  wordCountDelta: number;
  /** Old word count */
  oldWordCount: number;
  /** New word count */
  newWordCount: number;
}

export interface FrontmatterChange {
  /** Field name that changed */
  field: string;
  /** Old value (null if new field) */
  oldValue: unknown;
  /** New value (null if removed field) */
  newValue: unknown;
}

export interface DiffSummary {
  sectionsAdded: number;
  sectionsRemoved: number;
  sectionsModified: number;
  sectionsUnchanged: number;
  totalWordCountDelta: number;
}

export interface VersionDiff {
  /** Version this diff is from */
  fromVersion: string;
  /** Version this diff is to */
  toVersion: string;
  /** Per-section diffs */
  sectionDiffs: SectionDiff[];
  /** Frontmatter field-level changes */
  frontmatterChanges: FrontmatterChange[];
  /** Summary statistics */
  summary: DiffSummary;
  /** ISO 8601 timestamp of when diff was computed */
  computedAt: string;
}

/**
 * Computes a section-level diff between two versions of a document.
 *
 * Algorithm:
 *   1. Parse both documents into DocumentSections.
 *   2. Flatten both section trees into maps: sectionId -> ParsedSection.
 *   3. Compute section diffs:
 *      a. For each section in oldMap but not in newMap: changeType = 'removed'
 *      b. For each section in newMap but not in oldMap: changeType = 'added'
 *      c. For each section in both:
 *         - If content identical: changeType = 'unchanged'
 *         - If content differs: changeType = 'modified'
 *   4. Compute frontmatter changes by comparing all keys.
 *   5. Build summary.
 *
 * @param oldContent Raw Markdown of the old version
 * @param newContent Raw Markdown of the new version
 * @param fromVersion Version string of the old version
 * @param toVersion Version string of the new version
 * @returns VersionDiff with section-level changes
 */
export function computeDiff(
  oldContent: string,
  newContent: string,
  fromVersion: string,
  toVersion: string,
): VersionDiff {
  const oldDoc = parseSections(oldContent);
  const newDoc = parseSections(newContent);

  // Flatten section trees into maps
  const oldMap = flattenSections(oldDoc.sections);
  const newMap = flattenSections(newDoc.sections);

  const sectionDiffs: SectionDiff[] = [];
  const allIds = new Set([...oldMap.keys(), ...newMap.keys()]);

  for (const id of allIds) {
    const oldSection = oldMap.get(id);
    const newSection = newMap.get(id);

    if (!oldSection && newSection) {
      sectionDiffs.push({
        sectionId: id,
        changeType: 'added',
        oldContent: null,
        newContent: newSection.content,
        wordCountDelta: newSection.wordCount,
        oldWordCount: 0,
        newWordCount: newSection.wordCount,
      });
    } else if (oldSection && !newSection) {
      sectionDiffs.push({
        sectionId: id,
        changeType: 'removed',
        oldContent: oldSection.content,
        newContent: null,
        wordCountDelta: -oldSection.wordCount,
        oldWordCount: oldSection.wordCount,
        newWordCount: 0,
      });
    } else if (oldSection && newSection) {
      const isModified = oldSection.content.trim() !== newSection.content.trim();
      sectionDiffs.push({
        sectionId: id,
        changeType: isModified ? 'modified' : 'unchanged',
        oldContent: oldSection.content,
        newContent: newSection.content,
        wordCountDelta: newSection.wordCount - oldSection.wordCount,
        oldWordCount: oldSection.wordCount,
        newWordCount: newSection.wordCount,
      });
    }
  }

  // Frontmatter changes
  const frontmatterChanges = computeFrontmatterChanges(
    oldDoc.frontmatter ?? {},
    newDoc.frontmatter ?? {},
  );

  // Summary
  const summary: DiffSummary = {
    sectionsAdded: sectionDiffs.filter((d) => d.changeType === 'added').length,
    sectionsRemoved: sectionDiffs.filter((d) => d.changeType === 'removed').length,
    sectionsModified: sectionDiffs.filter((d) => d.changeType === 'modified').length,
    sectionsUnchanged: sectionDiffs.filter((d) => d.changeType === 'unchanged').length,
    totalWordCountDelta: sectionDiffs.reduce((sum, d) => sum + d.wordCountDelta, 0),
  };

  return {
    fromVersion,
    toVersion,
    sectionDiffs,
    frontmatterChanges,
    summary,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Flattens a nested section tree into a flat Map<sectionId, ParsedSection>.
 * Traverses depth-first, collecting all sections at all levels.
 */
function flattenSections(sections: ParsedSection[]): Map<string, ParsedSection> {
  const map = new Map<string, ParsedSection>();

  function walk(secs: ParsedSection[]): void {
    for (const sec of secs) {
      map.set(sec.id, sec);
      walk(sec.subsections);
    }
  }

  walk(sections);
  return map;
}

/**
 * Computes field-level changes between two frontmatter objects.
 * Detects added fields, removed fields, and modified values.
 */
function computeFrontmatterChanges(
  oldFm: Record<string, unknown>,
  newFm: Record<string, unknown>,
): FrontmatterChange[] {
  const changes: FrontmatterChange[] = [];
  const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);

  for (const key of allKeys) {
    const oldVal = key in oldFm ? oldFm[key] : undefined;
    const newVal = key in newFm ? newFm[key] : undefined;

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({
        field: key,
        oldValue: oldVal ?? null,
        newValue: newVal ?? null,
      });
    }
  }

  return changes;
}
