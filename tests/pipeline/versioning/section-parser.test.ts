import {
  parseSections,
  toSectionId,
  countWords,
  ParsedSection,
  DocumentSections,
} from '../../../src/pipeline/versioning/section-parser';

/**
 * Unit tests for section-parser (SPEC-003-3-02, Task 3).
 */

// ---------------------------------------------------------------------------
// Helper: build a simple Markdown document
// ---------------------------------------------------------------------------
function makeDoc(opts: {
  frontmatter?: Record<string, string>;
  title?: string;
  sections?: Array<{ level: number; heading: string; content: string }>;
}): string {
  let doc = '';

  if (opts.frontmatter) {
    doc += '---\n';
    for (const [k, v] of Object.entries(opts.frontmatter)) {
      doc += `${k}: ${v}\n`;
    }
    doc += '---\n';
  }

  if (opts.title) {
    doc += `\n# ${opts.title}\n\n`;
  }

  if (opts.sections) {
    for (const s of opts.sections) {
      doc += `${'#'.repeat(s.level)} ${s.heading}\n`;
      if (s.content) {
        doc += `${s.content}\n\n`;
      }
    }
  }

  return doc;
}

// ---------------------------------------------------------------------------
// parseSections
// ---------------------------------------------------------------------------

describe('parseSections', () => {
  test('parses document with 3 H2 sections', () => {
    const content = makeDoc({
      title: 'My Document',
      sections: [
        { level: 2, heading: 'Introduction', content: 'Welcome to the document.' },
        { level: 2, heading: 'Body', content: 'Main content goes here.' },
        { level: 2, heading: 'Conclusion', content: 'That is all.' },
      ],
    });

    const result = parseSections(content);

    expect(result.title).toBe('My Document');
    expect(result.sections).toHaveLength(3);
    expect(result.sections[0].id).toBe('introduction');
    expect(result.sections[0].heading).toBe('Introduction');
    expect(result.sections[0].level).toBe(2);
    expect(result.sections[1].id).toBe('body');
    expect(result.sections[2].id).toBe('conclusion');
  });

  test('parses document with H2 + H3 nested sections', () => {
    const content = [
      '# Title',
      '',
      '## Overview',
      'Overview content here.',
      '',
      '### Details',
      'Details content here.',
      '',
      '### More Details',
      'More details content here.',
      '',
      '## Summary',
      'Summary content here.',
    ].join('\n');

    const result = parseSections(content);

    expect(result.title).toBe('Title');
    expect(result.sections).toHaveLength(2);

    const overview = result.sections[0];
    expect(overview.id).toBe('overview');
    expect(overview.subsections).toHaveLength(2);
    expect(overview.subsections[0].id).toBe('details');
    expect(overview.subsections[0].heading).toBe('Details');
    expect(overview.subsections[0].level).toBe(3);
    expect(overview.subsections[1].id).toBe('more-details');

    const summary = result.sections[1];
    expect(summary.id).toBe('summary');
    expect(summary.subsections).toHaveLength(0);
  });

  test('ignores headings inside fenced code blocks (triple backtick)', () => {
    const content = [
      '# Title',
      '',
      '## Real Section',
      'Some content.',
      '',
      '```',
      '## Fake Section Inside Code',
      'This is code, not a heading.',
      '```',
      '',
      '## Another Real Section',
      'More content.',
    ].join('\n');

    const result = parseSections(content);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].id).toBe('real-section');
    expect(result.sections[1].id).toBe('another-real-section');
  });

  test('ignores headings inside fenced code blocks (triple tilde)', () => {
    const content = [
      '# Title',
      '',
      '## Real Section',
      'Some content.',
      '',
      '~~~',
      '## Fake Section Inside Code',
      '~~~',
      '',
      '## Another Real Section',
      'More content.',
    ].join('\n');

    const result = parseSections(content);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].id).toBe('real-section');
    expect(result.sections[1].id).toBe('another-real-section');
  });

  test('handles document with no headings', () => {
    const content = 'Just some plain text.\nNo headings here.';

    const result = parseSections(content);

    expect(result.title).toBeNull();
    expect(result.sections).toHaveLength(0);
  });

  test('handles document with only H1 title', () => {
    const content = '# My Title\n\nSome body text but no sections.';

    const result = parseSections(content);

    expect(result.title).toBe('My Title');
    expect(result.sections).toHaveLength(0);
  });

  test('handles empty sections (heading with no content)', () => {
    const content = [
      '# Title',
      '',
      '## Empty Section',
      '## Non-Empty Section',
      'Some content here.',
    ].join('\n');

    const result = parseSections(content);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].id).toBe('empty-section');
    expect(result.sections[0].wordCount).toBe(0);
    expect(result.sections[0].content.trim()).toBe('');
    expect(result.sections[1].id).toBe('non-empty-section');
    expect(result.sections[1].wordCount).toBeGreaterThan(0);
  });

  test('separates frontmatter from body', () => {
    const content = [
      '---',
      'title: Test Doc',
      'version: 1.0',
      'status: draft',
      '---',
      '',
      '# Test Doc',
      '',
      '## Section One',
      'Content.',
    ].join('\n');

    const result = parseSections(content);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.title).toBe('Test Doc');
    expect(result.frontmatter!.version).toBe(1.0);
    expect(result.frontmatter!.status).toBe('draft');
    expect(result.title).toBe('Test Doc');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].id).toBe('section-one');
  });

  test('handles document without frontmatter', () => {
    const content = '# No Frontmatter\n\n## Section\nContent.';

    const result = parseSections(content);

    expect(result.frontmatter).toBeNull();
    expect(result.title).toBe('No Frontmatter');
    expect(result.sections).toHaveLength(1);
  });

  test('computes correct word count for each section', () => {
    const content = [
      '# Title',
      '',
      '## Short',
      'One two three.',
      '',
      '## Long',
      'Alpha beta gamma delta epsilon zeta eta theta iota kappa.',
    ].join('\n');

    const result = parseSections(content);

    expect(result.sections).toHaveLength(2);
    // "One two three." = 3 words (period attached to word)
    expect(result.sections[0].wordCount).toBe(3);
    // "Alpha beta gamma delta epsilon zeta eta theta iota kappa." = 10 words
    expect(result.sections[1].wordCount).toBe(10);
  });

  test('generates correct section IDs from headings', () => {
    const content = [
      '# Title',
      '',
      '## Functional Requirements',
      'Content.',
      '',
      '## API Design',
      'Content.',
      '',
      '## Error Handling Strategy',
      'Content.',
    ].join('\n');

    const result = parseSections(content);

    expect(result.sections[0].id).toBe('functional-requirements');
    expect(result.sections[1].id).toBe('api-design');
    expect(result.sections[2].id).toBe('error-handling-strategy');
  });
});

// ---------------------------------------------------------------------------
// toSectionId
// ---------------------------------------------------------------------------

describe('toSectionId', () => {
  test('"Functional Requirements" -> "functional-requirements"', () => {
    expect(toSectionId('Functional Requirements')).toBe('functional-requirements');
  });

  test('"API Design (v2)" -> "api-design-v2"', () => {
    expect(toSectionId('API Design (v2)')).toBe('api-design-v2');
  });

  test('handles special characters', () => {
    expect(toSectionId('Hello, World!')).toBe('hello-world');
    expect(toSectionId('Test & Verify')).toBe('test-verify');
    expect(toSectionId('A/B Testing')).toBe('ab-testing');
    expect(toSectionId('  Spaces  Around  ')).toBe('spaces-around');
    expect(toSectionId('---dashes---')).toBe('dashes');
  });
});

// ---------------------------------------------------------------------------
// countWords
// ---------------------------------------------------------------------------

describe('countWords', () => {
  test('empty string returns 0', () => {
    expect(countWords('')).toBe(0);
  });

  test('"hello world" returns 2', () => {
    expect(countWords('hello world')).toBe(2);
  });

  test('handles multiple spaces', () => {
    expect(countWords('one   two    three')).toBe(3);
  });

  test('handles whitespace-only string', () => {
    expect(countWords('   ')).toBe(0);
  });

  test('handles newlines in text', () => {
    expect(countWords('one\ntwo\nthree')).toBe(3);
  });
});
