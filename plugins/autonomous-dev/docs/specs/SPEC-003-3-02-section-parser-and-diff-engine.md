# SPEC-003-3-02: Markdown Section Parser and Structured Diff Engine

## Metadata
- **Parent Plan**: PLAN-003-3
- **Tasks Covered**: Task 3, Task 4
- **Estimated effort**: 10 hours

## Description
Implement the Markdown section parser that splits a document into structured sections based on ATX-style headings (supporting nested subsections), and the structured diff engine that computes section-level diffs between two document versions, detecting added, removed, modified, and unchanged sections with word count deltas and frontmatter changes.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/versioning/section-parser.ts` | Create |
| `src/pipeline/versioning/diff-engine.ts` | Create |

## Implementation Details

### Task 3: `src/pipeline/versioning/section-parser.ts`

```typescript
export interface ParsedSection {
  /** Section ID derived from heading (kebab-case of heading text) */
  id: string;
  /** Raw heading text (without # prefix) */
  heading: string;
  /** Heading level (1 = H1, 2 = H2, etc.) */
  level: number;
  /** Raw content of this section (between this heading and the next heading of same or higher level) */
  content: string;
  /** Word count of content (excluding heading) */
  wordCount: number;
  /** Nested subsections (headings of deeper level within this section's range) */
  subsections: ParsedSection[];
}

export interface DocumentSections {
  /** Frontmatter as raw key-value pairs (parsed separately) */
  frontmatter: Record<string, unknown> | null;
  /** The H1 title (first heading) */
  title: string | null;
  /** All top-level sections (typically H2 level) */
  sections: ParsedSection[];
}

/**
 * Parses a Markdown document into structured sections.
 *
 * Algorithm:
 *   1. Separate frontmatter (between --- delimiters) from body.
 *   2. Scan body line-by-line for ATX headings (lines starting with #).
 *   3. Skip headings inside fenced code blocks (``` or ~~~).
 *   4. Build a flat list of (heading, level, startLine, endLine) ranges.
 *   5. Nest subsections: a section at level N includes all following
 *      sections at level > N until the next section at level <= N.
 *   6. Compute word count for each section's content (excluding child sections).
 *   7. Generate section IDs by converting heading text to kebab-case:
 *      "Functional Requirements" -> "functional-requirements"
 *
 * Edge cases:
 *   - Document with no headings: returns empty sections array.
 *   - Headings inside fenced code blocks: ignored.
 *   - Multiple H1 headings: first is title, rest are top-level sections.
 *   - Empty sections (heading followed immediately by next heading): wordCount = 0.
 *   - Setext headings (underline style): NOT supported (ATX only per risk mitigation).
 */
export function parseSections(content: string): DocumentSections {
  // Implementation outline:
  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatterDone = false;
  let inCodeBlock = false;
  let frontmatterLines: string[] = [];
  let bodyLines: string[] = [];

  // Phase 1: Separate frontmatter and body
  for (const line of lines) {
    if (!frontmatterDone && line.trim() === '---') {
      if (!inFrontmatter) { inFrontmatter = true; continue; }
      else { frontmatterDone = true; inFrontmatter = false; continue; }
    }
    if (inFrontmatter) { frontmatterLines.push(line); continue; }
    bodyLines.push(line);
  }

  // Phase 2: Find all headings (skip code blocks)
  const headings: Array<{ line: number; level: number; text: string }> = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({ line: i, level: match[1].length, text: match[2].trim() });
    }
  }

  // Phase 3: Extract content ranges and build flat sections
  // Phase 4: Nest subsections
  // Phase 5: Compute word counts and generate IDs

  return { frontmatter: null, title: null, sections: [] }; // placeholder
}

/**
 * Converts heading text to a kebab-case section ID.
 * "Functional Requirements" -> "functional-requirements"
 * "API Design (v2)" -> "api-design-v2"
 */
export function toSectionId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // remove non-alphanumeric
    .replace(/\s+/g, '-')           // spaces to hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '');          // trim leading/trailing hyphens
}

/**
 * Counts words in a string (splits on whitespace).
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
```

### Task 4: `src/pipeline/versioning/diff-engine.ts`

```typescript
import { ParsedSection, DocumentSections, parseSections, toSectionId } from './section-parser';

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
    sectionsAdded: sectionDiffs.filter(d => d.changeType === 'added').length,
    sectionsRemoved: sectionDiffs.filter(d => d.changeType === 'removed').length,
    sectionsModified: sectionDiffs.filter(d => d.changeType === 'modified').length,
    sectionsUnchanged: sectionDiffs.filter(d => d.changeType === 'unchanged').length,
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
 */
function computeFrontmatterChanges(
  oldFm: Record<string, unknown>,
  newFm: Record<string, unknown>,
): FrontmatterChange[] {
  const changes: FrontmatterChange[] = [];
  const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);
  for (const key of allKeys) {
    const oldVal = oldFm[key];
    const newVal = newFm[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes.push({ field: key, oldValue: oldVal ?? null, newValue: newVal ?? null });
    }
  }
  return changes;
}
```

## Acceptance Criteria
1. `parseSections` splits a Markdown document into structured sections based on ATX headings.
2. `parseSections` correctly handles nested headings (H2 contains H3 subsections).
3. `parseSections` ignores headings inside fenced code blocks.
4. `parseSections` produces correct word counts for each section.
5. `toSectionId` converts heading text to kebab-case ID.
6. `parseSections` handles documents with no headings (returns empty sections).
7. `parseSections` separates frontmatter from body.
8. `computeDiff` produces correct `SectionDiff` entries for added, removed, modified, and unchanged sections.
9. `computeDiff` computes correct word count deltas per section.
10. `computeDiff` detects frontmatter field-level changes.
11. `computeDiff` produces correct summary counts.
12. Identical documents produce all-unchanged diffs with zero deltas.
13. Completely rewritten documents produce all-removed + all-added diffs.

## Test Cases

### Unit Tests: `tests/pipeline/versioning/section-parser.test.ts`
- `parses document with 3 H2 sections`
- `parses document with H2 + H3 nested sections`
- `ignores headings inside fenced code blocks (triple backtick)`
- `ignores headings inside fenced code blocks (triple tilde)`
- `handles document with no headings`
- `handles document with only H1 title`
- `handles empty sections (heading with no content)`
- `separates frontmatter from body`
- `handles document without frontmatter`
- `computes correct word count for each section`
- `generates correct section IDs from headings`
- `toSectionId: "Functional Requirements" -> "functional-requirements"`
- `toSectionId: "API Design (v2)" -> "api-design-v2"`
- `toSectionId: handles special characters`
- `countWords: empty string returns 0`
- `countWords: "hello world" returns 2`
- `countWords: handles multiple spaces`

### Unit Tests: `tests/pipeline/versioning/diff-engine.test.ts`
- `identical documents: all sections unchanged, zero word count delta`
- `completely rewritten document: all sections removed + added`
- `single section modified: detects modification with word count delta`
- `section added: changeType is added, old content is null`
- `section removed: changeType is removed, new content is null`
- `frontmatter change detected: field old/new values captured`
- `frontmatter field added: oldValue is null`
- `frontmatter field removed: newValue is null`
- `summary counts correct: 1 added, 1 removed, 1 modified, 2 unchanged`
- `totalWordCountDelta computed correctly across all sections`
- `diff handles documents with nested subsections`
- `diff handles documents with no frontmatter`

### Snapshot Tests: `tests/pipeline/versioning/snapshots/`
- `diff output for PRD v1.0 to v1.1 matches snapshot`
- `diff output for TDD with added section matches snapshot`
