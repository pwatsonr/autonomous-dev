// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A document prepared for review, including metadata that may bias scoring.
 */
export interface DocumentForReview {
  id: string;
  content: string;
  frontmatter: Record<string, unknown>;
  version: string;
  created_at: string;
  updated_at?: string;
  change_history?: string[];
  sections: { id: string; title: string; content: string }[];
}

/**
 * A document after blind scoring filters have been applied.
 * Version is always normalized to "1.0", iteration metadata is stripped.
 */
export interface FilteredDocument {
  id: string;
  content: string;
  frontmatter: Record<string, unknown>;
  /** Always normalized to "1.0". */
  version: '1.0';
  /** Retained from original. */
  created_at: string;
  sections: { id: string; title: string; content: string }[];
  /** Audit list of fields/patterns that were removed. */
  fields_stripped: string[];
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Regex patterns for detecting author feedback references in content.
 * These sentences reveal that a prior review occurred, biasing scoring.
 */
const FEEDBACK_REFERENCE_PATTERNS = [
  /(?:Per|Based on|Following|In response to|Addressing)\s+(?:reviewer|review)\s+(?:feedback|comments?|suggestions?|recommendations?)[^.]*\./gi,
  /(?:As\s+(?:suggested|recommended|requested)\s+(?:by|in)\s+(?:the\s+)?review)[^.]*\./gi,
  /(?:Updated|Changed|Modified|Revised|Reworked)\s+(?:per|based on|following)\s+(?:review|feedback)[^.]*\./gi,
  /(?:This\s+(?:section|paragraph|content)\s+(?:was|has been)\s+(?:revised|updated|rewritten)\s+(?:to\s+address|in response to))[^.]*\./gi,
];

/**
 * Regex patterns for detecting revision note section headers.
 * When matched, everything from that header to the next same-level
 * or higher-level header (or end of document) is removed.
 */
const REVISION_SECTION_PATTERNS = [
  /^#{1,3}\s*(?:Revision\s+Notes?|Change\s*Log|Revision\s+History|Changes)\s*$/gim,
];

/**
 * Frontmatter keys that must be removed to prevent iteration bias.
 */
const PROHIBITED_FRONTMATTER_KEYS = [
  'iteration_count',
  'iteration',
  'previous_scores',
  'previous_findings',
];

// ---------------------------------------------------------------------------
// BlindScoringContextFilter
// ---------------------------------------------------------------------------

/**
 * Strips iteration metadata from documents to enforce blind scoring.
 *
 * Reviewers should evaluate each document on its own merits without
 * knowing whether it is a first draft or a revision. This filter removes
 * version numbers, change history, revision notes sections, and
 * author feedback references.
 */
export class BlindScoringContextFilter {
  /**
   * Filters a document for review, stripping all iteration-biasing metadata.
   */
  filterDocument(document: DocumentForReview): FilteredDocument {
    const fieldsStripped: string[] = [];

    // 1. Normalize version
    if (document.version !== '1.0') {
      fieldsStripped.push('version');
    }

    // 2. Strip updated_at
    const filteredFrontmatter = { ...document.frontmatter };
    if (document.updated_at !== undefined) {
      fieldsStripped.push('updated_at');
    }
    if ('updated_at' in filteredFrontmatter) {
      delete filteredFrontmatter['updated_at'];
    }

    // 3. Strip change_history
    if (document.change_history !== undefined && document.change_history.length > 0) {
      fieldsStripped.push('change_history');
    }

    // 4. Strip prohibited frontmatter keys
    for (const key of PROHIBITED_FRONTMATTER_KEYS) {
      if (key in filteredFrontmatter) {
        fieldsStripped.push(key);
        delete filteredFrontmatter[key];
      }
    }

    // 5. Filter content: strip revision sections and feedback references
    let filteredContent = this.stripRevisionSections(document.content);
    const feedbackStripped = this.stripFeedbackReferences(filteredContent);
    filteredContent = feedbackStripped.content;
    if (feedbackStripped.stripped) {
      fieldsStripped.push('feedback_references');
    }

    // 6. Filter sections: strip revision sections and feedback references
    const filteredSections = this.filterSections(document.sections);
    if (filteredSections.revisionSectionsRemoved) {
      fieldsStripped.push('revision_sections');
    }

    return {
      id: document.id,
      content: filteredContent,
      frontmatter: filteredFrontmatter,
      version: '1.0',
      created_at: document.created_at,
      sections: filteredSections.sections,
      fields_stripped: fieldsStripped,
    };
  }

  /**
   * Filters a parent document for review.
   * Same stripping rules as filterDocument; parent documents additionally
   * retain their full structure since reviewers need them for alignment scoring.
   */
  filterParentDocument(parentDocument: DocumentForReview): FilteredDocument {
    return this.filterDocument(parentDocument);
  }

  /**
   * Strips revision note sections from content.
   * Removes everything from a revision section header to the next
   * same-level or higher-level header (or end of document).
   */
  private stripRevisionSections(content: string): string {
    let result = content;

    for (const pattern of REVISION_SECTION_PATTERNS) {
      // Reset lastIndex since we reuse the pattern
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      // We need to work line-by-line for proper header level detection
      while ((match = pattern.exec(result)) !== null) {
        const headerStart = match.index;
        const headerLine = match[0];
        // Determine the level of the matched header (count leading #)
        const headerLevel = (headerLine.match(/^#+/) || [''])[0].length;

        // Find the end: next header of same or higher level, or end of document
        const afterHeader = result.substring(headerStart + headerLine.length);
        const nextHeaderPattern = new RegExp(`^#{1,${headerLevel}}\\s`, 'gm');
        const nextHeaderMatch = nextHeaderPattern.exec(afterHeader);

        let sectionEnd: number;
        if (nextHeaderMatch) {
          sectionEnd = headerStart + headerLine.length + nextHeaderMatch.index;
        } else {
          sectionEnd = result.length;
        }

        // Remove the section
        result = result.substring(0, headerStart) + result.substring(sectionEnd);

        // Reset pattern since content changed
        pattern.lastIndex = 0;
      }
    }

    return result;
  }

  /**
   * Strips author feedback reference sentences from content.
   * Returns the filtered content and whether any references were stripped.
   */
  private stripFeedbackReferences(content: string): { content: string; stripped: boolean } {
    let result = content;
    let stripped = false;

    for (const pattern of FEEDBACK_REFERENCE_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      const newContent = result.replace(pattern, '');
      if (newContent !== result) {
        stripped = true;
        result = newContent;
      }
    }

    // Clean up any double spaces or empty lines left by stripping
    result = result.replace(/  +/g, ' ');
    result = result.replace(/\n{3,}/g, '\n\n');

    return { content: result, stripped };
  }

  /**
   * Filters document sections: removes revision-titled sections and
   * strips feedback references from remaining sections' content.
   */
  private filterSections(
    sections: { id: string; title: string; content: string }[],
  ): { sections: { id: string; title: string; content: string }[]; revisionSectionsRemoved: boolean } {
    let revisionSectionsRemoved = false;
    const isRevisionSection = (title: string): boolean => {
      const normalized = title.trim().toLowerCase();
      return (
        normalized === 'revision notes' ||
        normalized === 'revision note' ||
        normalized === 'changelog' ||
        normalized === 'change log' ||
        normalized === 'revision history' ||
        normalized === 'changes'
      );
    };

    const filtered = sections
      .filter((section) => {
        if (isRevisionSection(section.title)) {
          revisionSectionsRemoved = true;
          return false;
        }
        return true;
      })
      .map((section) => {
        const feedbackResult = this.stripFeedbackReferences(section.content);
        return {
          id: section.id,
          title: section.title,
          content: feedbackResult.content,
        };
      });

    return { sections: filtered, revisionSectionsRemoved };
  }
}
