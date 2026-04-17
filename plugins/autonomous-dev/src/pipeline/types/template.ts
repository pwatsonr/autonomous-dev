export interface TemplateSection {
  /** Unique section identifier, e.g. 'executive-summary' */
  id: string;
  /** The Markdown heading text */
  heading: string;
  /** Heading level (1=H1, 2=H2, 3=H3, etc.) */
  level: number;
  /** Whether this section must be present */
  required: boolean;
  /** Description/guidance for what should be in this section */
  description: string;
  /** Minimum word count for this section (0 = no minimum) */
  minWordCount: number;
  /** Nested subsections */
  subsections: TemplateSection[];
  /** ID of the rubric category this section maps to for scoring */
  rubricCategoryId: string | null;
}

export interface DocumentTemplate {
  /** Template identifier, e.g. 'prd-v1' */
  id: string;
  /** Document type this template is for */
  documentType: string;
  /** Template version for evolution tracking */
  version: string;
  /** Top-level sections */
  sections: TemplateSection[];
  /** Whether custom (non-template) sections are allowed */
  customSectionsAllowed: boolean;
  /** Default frontmatter values for documents created from this template */
  frontmatterDefaults: Record<string, unknown>;
}
