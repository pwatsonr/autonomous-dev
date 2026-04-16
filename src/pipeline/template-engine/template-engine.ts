import { DocumentTemplate, TemplateSection } from '../types/template';
import { DocumentType } from '../types/document-type';
import { QualityRubric } from '../types/quality-rubric';
import { DocumentFrontmatter } from '../types/frontmatter';
import { PRD_TEMPLATE } from '../templates/prd-template';
import { TDD_TEMPLATE } from '../templates/tdd-template';
import { PLAN_TEMPLATE } from '../templates/plan-template';
import { SPEC_TEMPLATE } from '../templates/spec-template';
import { CODE_TEMPLATE } from '../templates/code-template';

export interface RenderOptions {
  /** Document title */
  title: string;
  /** Frontmatter field overrides */
  frontmatterOverrides?: Partial<DocumentFrontmatter>;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateValidationError[];
  warnings: TemplateValidationError[];
}

export interface TemplateValidationError {
  /** Which section or aspect failed */
  sectionId: string | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Validation codes:
 *   MISSING_SECTION          - required section not found in document
 *   EMPTY_SECTION            - required section is present but has no content
 *   BELOW_WORD_COUNT         - section word count below minimum
 *   GUIDANCE_COMMENT_PRESENT - template guidance comment not removed
 *   FRONTMATTER_INCOMPLETE   - frontmatter missing required fields
 *   UNKNOWN_SECTION          - section not in template (when customSectionsAllowed=false)
 */

/** Map of document types to their rubrics, set externally via setRubrics */
let rubricMap: Map<string, QualityRubric> | null = null;

export class TemplateEngine {
  private templates: Map<string, DocumentTemplate>;

  constructor() {
    this.templates = new Map();
    this.templates.set(DocumentType.PRD, PRD_TEMPLATE);
    this.templates.set(DocumentType.TDD, TDD_TEMPLATE);
    this.templates.set(DocumentType.PLAN, PLAN_TEMPLATE);
    this.templates.set(DocumentType.SPEC, SPEC_TEMPLATE);
    this.templates.set(DocumentType.CODE, CODE_TEMPLATE);
  }

  /**
   * Returns the template for the given document type.
   * @throws Error if type has no registered template.
   */
  getTemplate(type: DocumentType): DocumentTemplate {
    const template = this.templates.get(type);
    if (!template) {
      throw new Error(`No template registered for document type: ${type}`);
    }
    return template;
  }

  /**
   * Renders a blank document from the template with initial values.
   *
   * Output format:
   * ---
   * {frontmatter YAML}
   * ---
   * # {title}
   *
   * ## {section.heading}
   * <!-- Guidance: {section.description} -->
   *
   * (repeat for all sections and subsections)
   *
   * @returns Rendered Markdown string with frontmatter
   */
  renderTemplate(type: DocumentType, options: RenderOptions): string {
    const template = this.getTemplate(type);
    const now = new Date().toISOString();

    const frontmatter: Record<string, unknown> = {
      ...template.frontmatterDefaults,
      ...(options.frontmatterOverrides ?? {}),
      title: options.title,
      type: type,
      created_at: now,
      updated_at: now,
    };

    let output = '---\n';
    output += dumpYaml(frontmatter);
    output += '---\n\n';
    output += `# ${options.title}\n\n`;

    for (const section of template.sections) {
      output += renderSection(section);
    }

    return output;
  }

  /**
   * Validates an authored document against its template structure.
   *
   * Checks (per TDD Section 3.3.7):
   * 1. Frontmatter completeness (checks for --- delimiters)
   * 2. All required sections present (by heading match)
   * 3. Required sections are non-empty (have content beyond guidance comments)
   * 4. Sections meet minimum word counts
   * 5. Guidance comments removed (no <!-- Guidance: ... --> markers)
   * 6. No unknown sections when customSectionsAllowed=false
   *
   * @param content Full Markdown document content
   * @param type Document type (determines which template to validate against)
   * @returns TemplateValidationResult with errors and warnings
   */
  validateDocument(content: string, type: DocumentType): TemplateValidationResult {
    const template = this.getTemplate(type);
    const errors: TemplateValidationError[] = [];
    const warnings: TemplateValidationError[] = [];

    // 1. Parse frontmatter
    const frontmatterResult = extractFrontmatter(content);
    if (!frontmatterResult.valid) {
      errors.push({
        sectionId: null,
        code: 'FRONTMATTER_INCOMPLETE',
        message: frontmatterResult.error ?? 'Frontmatter is missing or incomplete',
        severity: 'error',
      });
    }

    // 2. Parse sections from body
    const body = frontmatterResult.body;
    const documentSections = parseSections(body);
    const templateSectionIds = new Set(
      collectAllSectionIds(template.sections),
    );
    const documentSectionMap = new Map<string, ParsedSection>();
    for (const ds of documentSections) {
      documentSectionMap.set(ds.id, ds);
    }

    // 3. Check required sections present
    for (const section of template.sections) {
      if (section.required && !documentSectionMap.has(section.id)) {
        errors.push({
          sectionId: section.id,
          code: 'MISSING_SECTION',
          message: `Required section "${section.heading}" is missing`,
          severity: 'error',
        });
      }
    }

    // 4. Check non-empty and word counts for template sections
    for (const section of template.sections) {
      const docSection = documentSectionMap.get(section.id);
      if (!docSection) continue;

      const contentText = stripGuidanceComments(docSection.content).trim();
      if (section.required && contentText.length === 0) {
        errors.push({
          sectionId: section.id,
          code: 'EMPTY_SECTION',
          message: `Required section "${section.heading}" is empty`,
          severity: 'error',
        });
      }

      if (section.minWordCount > 0) {
        const wc = wordCount(contentText);
        if (wc < section.minWordCount) {
          errors.push({
            sectionId: section.id,
            code: 'BELOW_WORD_COUNT',
            message: `Section "${section.heading}" has ${wc} words, minimum is ${section.minWordCount}`,
            severity: 'error',
          });
        }
      }

      // Check subsections recursively
      for (const sub of section.subsections) {
        checkSubsection(sub, documentSections, errors);
      }
    }

    // 5. Check guidance comments removed
    if (content.includes('<!-- Guidance:')) {
      errors.push({
        sectionId: null,
        code: 'GUIDANCE_COMMENT_PRESENT',
        message: 'Template guidance comments have not been removed',
        severity: 'error',
      });
    }

    // 6. Unknown sections
    if (!template.customSectionsAllowed) {
      for (const docSection of documentSections) {
        if (!templateSectionIds.has(docSection.id)) {
          warnings.push({
            sectionId: docSection.id,
            code: 'UNKNOWN_SECTION',
            message: `Section "${docSection.heading}" is not defined in the template`,
            severity: 'warning',
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Returns the quality rubric for the given document type.
   * Rubrics are loaded from the registry/rubrics modules.
   */
  getRubric(type: DocumentType): QualityRubric {
    if (rubricMap && rubricMap.has(type)) {
      return rubricMap.get(type)!;
    }
    // Lazy-load rubrics from the document-type-registry
    const rubrics = loadRubrics();
    const rubric = rubrics.get(type);
    if (!rubric) {
      throw new Error(`No rubric registered for document type: ${type}`);
    }
    return rubric;
  }

  /**
   * Allows external injection of rubrics (useful for testing and decoupling
   * from the registry module).
   */
  static setRubrics(map: Map<string, QualityRubric>): void {
    rubricMap = map;
  }

  /**
   * Clears injected rubrics, reverting to lazy-loaded defaults.
   */
  static clearRubrics(): void {
    rubricMap = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ParsedSection {
  id: string;
  heading: string;
  level: number;
  content: string;
}

/**
 * Renders a single section (and its subsections) as Markdown.
 */
function renderSection(section: TemplateSection): string {
  let output = '';
  output += '#'.repeat(section.level) + ' ' + section.heading + '\n';
  output += `<!-- Guidance: ${section.description} -->\n\n`;
  for (const sub of section.subsections) {
    output += renderSection(sub);
  }
  return output;
}

/**
 * Converts a YAML-like frontmatter object to a simple YAML string.
 * Handles primitives, arrays, and nested objects.
 */
function dumpYaml(obj: Record<string, unknown>, indent: number = 0): string {
  let output = '';
  const prefix = ' '.repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      output += `${prefix}${key}: null\n`;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        output += `${prefix}${key}: []\n`;
      } else {
        output += `${prefix}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            output += `${prefix}  -\n`;
            output += dumpYaml(item as Record<string, unknown>, indent + 4);
          } else {
            output += `${prefix}  - ${formatYamlValue(item)}\n`;
          }
        }
      }
    } else if (typeof value === 'object') {
      output += `${prefix}${key}:\n`;
      output += dumpYaml(value as Record<string, unknown>, indent + 2);
    } else {
      output += `${prefix}${key}: ${formatYamlValue(value)}\n`;
    }
  }

  return output;
}

/**
 * Formats a scalar value for YAML output.
 */
function formatYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quote strings that contain special characters or look like non-strings
    if (
      value.includes(':') ||
      value.includes('#') ||
      value.includes('\n') ||
      value.includes('"') ||
      value.includes("'") ||
      value === '' ||
      value === 'true' ||
      value === 'false' ||
      value === 'null' ||
      /^\d+$/.test(value) ||
      /^\d+\.\d+$/.test(value)
    ) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return String(value);
}

/**
 * Extracts the frontmatter block and body from a Markdown document.
 */
function extractFrontmatter(content: string): {
  valid: boolean;
  yaml: string;
  body: string;
  error?: string;
} {
  const lines = content.split('\n');

  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { valid: false, yaml: '', body: content, error: 'No frontmatter delimiter found' };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { valid: false, yaml: '', body: content, error: 'No closing frontmatter delimiter found' };
  }

  if (closingIndex === 1) {
    return { valid: false, yaml: '', body: lines.slice(2).join('\n'), error: 'Frontmatter is empty' };
  }

  const yaml = lines.slice(1, closingIndex).join('\n');
  const body = lines.slice(closingIndex + 1).join('\n');

  return { valid: true, yaml, body };
}

/**
 * Parses sections from a Markdown body based on heading regex.
 */
function parseSections(body: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/;
  const lines = body.split('\n');

  let currentSection: ParsedSection | null = null;
  const contentLines: string[] = [];

  for (const line of lines) {
    const match = headingRegex.exec(line);
    if (match) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join('\n');
        sections.push(currentSection);
        contentLines.length = 0;
      }

      const level = match[1].length;
      const heading = match[2].trim();

      // Skip H1 (document title)
      if (level === 1) {
        currentSection = null;
        continue;
      }

      currentSection = {
        id: deriveSectionId(heading),
        heading,
        level,
        content: '',
      };
    } else if (currentSection) {
      contentLines.push(line);
    }
  }

  // Push last section
  if (currentSection) {
    currentSection.content = contentLines.join('\n');
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Derives a section ID from a heading string.
 * Converts to lowercase, replaces non-alphanumeric with hyphens,
 * collapses multiple hyphens, and trims leading/trailing hyphens.
 */
function deriveSectionId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Strips guidance comments from content.
 */
function stripGuidanceComments(content: string): string {
  return content.replace(/<!--\s*Guidance:.*?-->/gs, '');
}

/**
 * Counts words in a string.
 */
function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Collects all section IDs from a template section tree.
 */
function collectAllSectionIds(sections: TemplateSection[]): string[] {
  const ids: string[] = [];
  for (const section of sections) {
    ids.push(section.id);
    if (section.subsections.length > 0) {
      ids.push(...collectAllSectionIds(section.subsections));
    }
  }
  return ids;
}

/**
 * Checks a subsection recursively against parsed document sections.
 */
function checkSubsection(
  sub: TemplateSection,
  documentSections: ParsedSection[],
  errors: TemplateValidationError[],
): void {
  const docSection = documentSections.find((ds) => ds.id === sub.id);
  if (sub.required && !docSection) {
    errors.push({
      sectionId: sub.id,
      code: 'MISSING_SECTION',
      message: `Required subsection "${sub.heading}" is missing`,
      severity: 'error',
    });
    return;
  }

  if (docSection) {
    const contentText = stripGuidanceComments(docSection.content).trim();
    if (sub.required && contentText.length === 0) {
      errors.push({
        sectionId: sub.id,
        code: 'EMPTY_SECTION',
        message: `Required subsection "${sub.heading}" is empty`,
        severity: 'error',
      });
    }
    if (sub.minWordCount > 0) {
      const wc = wordCount(contentText);
      if (wc < sub.minWordCount) {
        errors.push({
          sectionId: sub.id,
          code: 'BELOW_WORD_COUNT',
          message: `Subsection "${sub.heading}" has ${wc} words, minimum is ${sub.minWordCount}`,
          severity: 'error',
        });
      }
    }
  }

  for (const nested of sub.subsections) {
    checkSubsection(nested, documentSections, errors);
  }
}

/**
 * Lazy-loads rubrics from the document-type-registry.
 * Returns a Map keyed by DocumentType string.
 */
function loadRubrics(): Map<string, QualityRubric> {
  // Import inline to avoid circular dependency at module load time
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { documentTypeRegistry } = require('../registry/document-type-registry');
  const map = new Map<string, QualityRubric>();
  for (const def of documentTypeRegistry.getAllDefinitions()) {
    map.set(def.type, def.rubric);
  }
  rubricMap = map;
  return map;
}

// Re-export helpers for testing
export { deriveSectionId, parseSections, wordCount, extractFrontmatter, stripGuidanceComments };
