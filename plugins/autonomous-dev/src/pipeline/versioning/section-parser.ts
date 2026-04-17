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
 * Internal representation of a heading found during scanning.
 */
interface HeadingEntry {
  lineIndex: number;
  level: number;
  text: string;
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
  const lines = content.split('\n');

  // Phase 1: Separate frontmatter and body
  const { frontmatter, bodyLines } = separateFrontmatter(lines);

  // Phase 2: Find all headings (skip code blocks)
  const headings = findHeadings(bodyLines);

  // Phase 3: Extract title (first H1)
  let title: string | null = null;
  const nonTitleHeadings: HeadingEntry[] = [];

  for (const h of headings) {
    if (h.level === 1 && title === null) {
      title = h.text;
    } else {
      nonTitleHeadings.push(h);
    }
  }

  // Phase 4: Build flat sections with content ranges
  const flatSections = buildFlatSections(nonTitleHeadings, bodyLines);

  // Phase 5: Nest subsections into tree
  const nestedSections = nestSections(flatSections);

  return {
    frontmatter,
    title,
    sections: nestedSections,
  };
}

/**
 * Converts heading text to a kebab-case section ID.
 * "Functional Requirements" -> "functional-requirements"
 * "API Design (v2)" -> "api-design-v2"
 */
export function toSectionId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // remove non-alphanumeric (keep spaces and hyphens)
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Separates frontmatter from body lines.
 * Frontmatter is delimited by --- on the first line and a closing ---.
 */
function separateFrontmatter(
  lines: string[],
): { frontmatter: Record<string, unknown> | null; bodyLines: string[] } {
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatter: null, bodyLines: lines };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    // No closing delimiter -- treat entire document as body
    return { frontmatter: null, bodyLines: lines };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const bodyLines = lines.slice(closingIndex + 1);

  const frontmatter = parseSimpleYaml(frontmatterLines);

  return { frontmatter, bodyLines };
}

/**
 * Parses simple YAML key-value pairs from frontmatter lines.
 * Handles: string, number, boolean, null, and simple arrays.
 */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;

  for (const line of lines) {
    // Array item
    const arrayMatch = line.match(/^\s+-\s+(.*)$/);
    if (arrayMatch && currentKey !== null) {
      if (currentArray === null) {
        currentArray = [];
      }
      currentArray.push(parseYamlValue(arrayMatch[1].trim()));
      result[currentKey] = currentArray;
      continue;
    }

    // If we were building an array and hit a non-array line, flush it
    if (currentArray !== null) {
      currentArray = null;
    }

    // Key-value pair
    const kvMatch = line.match(/^([^:]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1].trim();
      const rawValue = kvMatch[2].trim();

      if (rawValue === '[]') {
        result[currentKey] = [];
      } else if (rawValue === '') {
        result[currentKey] = '';
      } else {
        result[currentKey] = parseYamlValue(rawValue);
      }
    }
  }

  return result;
}

/**
 * Parses a scalar YAML value.
 */
function parseYamlValue(raw: string): unknown {
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Remove surrounding quotes
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  // Number
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);

  return raw;
}

/**
 * Scans body lines for ATX headings, skipping those inside fenced code blocks.
 */
function findHeadings(bodyLines: string[]): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];

    // Check for fenced code block toggle (``` or ~~~)
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        lineIndex: i,
        level: match[1].length,
        text: match[2].trim(),
      });
    }
  }

  return headings;
}

/**
 * Intermediate flat section: heading + content slice between consecutive headings.
 */
interface FlatSection {
  id: string;
  heading: string;
  level: number;
  content: string;
  wordCount: number;
}

/**
 * Builds flat sections from headings and body lines by extracting content
 * between each heading and the next heading (at any level).
 *
 * Each section's content is the text between its heading line and the next
 * heading line (or end of document). This means a parent section's content
 * only includes text before its first child heading.
 */
function buildFlatSections(
  headings: HeadingEntry[],
  bodyLines: string[],
): FlatSection[] {
  const sections: FlatSection[] = [];

  for (let i = 0; i < headings.length; i++) {
    const startLine = headings[i].lineIndex + 1; // line after heading
    const endLine =
      i + 1 < headings.length ? headings[i + 1].lineIndex : bodyLines.length;

    const contentLines = bodyLines.slice(startLine, endLine);
    const content = contentLines.join('\n');

    sections.push({
      id: toSectionId(headings[i].text),
      heading: headings[i].text,
      level: headings[i].level,
      content,
      wordCount: countWords(content),
    });
  }

  return sections;
}

/**
 * Nests flat sections into a tree based on heading levels.
 *
 * A section at level N owns all immediately following sections at level > N
 * until a section at level <= N is encountered.
 *
 * Each section's content is its own text (between its heading and the next
 * heading of any level), already computed by buildFlatSections.
 */
function nestSections(flatSections: FlatSection[]): ParsedSection[] {
  const result: ParsedSection[] = [];

  let i = 0;
  while (i < flatSections.length) {
    const section = flatSections[i];
    i++;

    // Collect children: all following sections with level > section.level
    const children: FlatSection[] = [];
    while (i < flatSections.length && flatSections[i].level > section.level) {
      children.push(flatSections[i]);
      i++;
    }

    // Recursively nest children
    const nestedChildren = nestSections(children);

    result.push({
      id: section.id,
      heading: section.heading,
      level: section.level,
      content: section.content,
      wordCount: section.wordCount,
      subsections: nestedChildren,
    });
  }

  return result;
}
