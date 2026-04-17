import {
  computeDiff,
  VersionDiff,
  SectionDiff,
  FrontmatterChange,
} from '../../../src/pipeline/versioning/diff-engine';

/**
 * Unit tests for diff-engine (SPEC-003-3-02, Task 4).
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
// computeDiff
// ---------------------------------------------------------------------------

describe('computeDiff', () => {
  test('identical documents: all sections unchanged, zero word count delta', () => {
    const content = makeDoc({
      frontmatter: { title: 'Test', version: '1.0' },
      title: 'Test',
      sections: [
        { level: 2, heading: 'Introduction', content: 'Hello world.' },
        { level: 2, heading: 'Body', content: 'Body content here.' },
        { level: 2, heading: 'Conclusion', content: 'The end.' },
      ],
    });

    const diff = computeDiff(content, content, '1.0', '1.0');

    expect(diff.fromVersion).toBe('1.0');
    expect(diff.toVersion).toBe('1.0');
    expect(diff.summary.sectionsAdded).toBe(0);
    expect(diff.summary.sectionsRemoved).toBe(0);
    expect(diff.summary.sectionsModified).toBe(0);
    expect(diff.summary.sectionsUnchanged).toBe(3);
    expect(diff.summary.totalWordCountDelta).toBe(0);
    expect(diff.frontmatterChanges).toHaveLength(0);

    for (const sd of diff.sectionDiffs) {
      expect(sd.changeType).toBe('unchanged');
      expect(sd.wordCountDelta).toBe(0);
    }
  });

  test('completely rewritten document: all sections removed + added', () => {
    const oldContent = makeDoc({
      title: 'Old',
      sections: [
        { level: 2, heading: 'Alpha', content: 'Old content.' },
        { level: 2, heading: 'Beta', content: 'More old content.' },
      ],
    });

    const newContent = makeDoc({
      title: 'New',
      sections: [
        { level: 2, heading: 'Gamma', content: 'New content.' },
        { level: 2, heading: 'Delta', content: 'More new content.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '2.0');

    expect(diff.summary.sectionsRemoved).toBe(2);
    expect(diff.summary.sectionsAdded).toBe(2);
    expect(diff.summary.sectionsModified).toBe(0);
    expect(diff.summary.sectionsUnchanged).toBe(0);

    const removed = diff.sectionDiffs.filter((d) => d.changeType === 'removed');
    const added = diff.sectionDiffs.filter((d) => d.changeType === 'added');
    expect(removed).toHaveLength(2);
    expect(added).toHaveLength(2);
    expect(removed.map((r) => r.sectionId).sort()).toEqual(['alpha', 'beta']);
    expect(added.map((a) => a.sectionId).sort()).toEqual(['delta', 'gamma']);
  });

  test('single section modified: detects modification with word count delta', () => {
    const oldContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'One two three.' },
      ],
    });

    const newContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'One two three four five six.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    expect(diff.summary.sectionsModified).toBe(1);
    expect(diff.summary.sectionsUnchanged).toBe(0);

    const modified = diff.sectionDiffs.find((d) => d.sectionId === 'section');
    expect(modified).toBeDefined();
    expect(modified!.changeType).toBe('modified');
    expect(modified!.wordCountDelta).toBe(3); // 6 - 3
    expect(modified!.oldWordCount).toBe(3);
    expect(modified!.newWordCount).toBe(6);
  });

  test('section added: changeType is added, old content is null', () => {
    const oldContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Existing', content: 'Content.' },
      ],
    });

    const newContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Existing', content: 'Content.' },
        { level: 2, heading: 'New Section', content: 'Brand new content.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    const added = diff.sectionDiffs.find((d) => d.sectionId === 'new-section');
    expect(added).toBeDefined();
    expect(added!.changeType).toBe('added');
    expect(added!.oldContent).toBeNull();
    expect(added!.newContent).toBeTruthy();
    expect(added!.oldWordCount).toBe(0);
    expect(added!.newWordCount).toBeGreaterThan(0);
    expect(added!.wordCountDelta).toBe(added!.newWordCount);
  });

  test('section removed: changeType is removed, new content is null', () => {
    const oldContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Keep', content: 'Staying.' },
        { level: 2, heading: 'Remove Me', content: 'Going away.' },
      ],
    });

    const newContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Keep', content: 'Staying.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    const removed = diff.sectionDiffs.find((d) => d.sectionId === 'remove-me');
    expect(removed).toBeDefined();
    expect(removed!.changeType).toBe('removed');
    expect(removed!.newContent).toBeNull();
    expect(removed!.oldContent).toBeTruthy();
    expect(removed!.newWordCount).toBe(0);
    expect(removed!.oldWordCount).toBeGreaterThan(0);
    expect(removed!.wordCountDelta).toBe(-removed!.oldWordCount);
  });

  test('frontmatter change detected: field old/new values captured', () => {
    const oldContent = makeDoc({
      frontmatter: { title: 'Doc', version: '1.0', status: 'draft' },
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'Content.' },
      ],
    });

    const newContent = makeDoc({
      frontmatter: { title: 'Doc', version: '1.1', status: 'review' },
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'Content.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    expect(diff.frontmatterChanges.length).toBeGreaterThanOrEqual(2);

    const versionChange = diff.frontmatterChanges.find((c) => c.field === 'version');
    expect(versionChange).toBeDefined();
    expect(versionChange!.oldValue).toBe(1.0);
    expect(versionChange!.newValue).toBe(1.1);

    const statusChange = diff.frontmatterChanges.find((c) => c.field === 'status');
    expect(statusChange).toBeDefined();
    expect(statusChange!.oldValue).toBe('draft');
    expect(statusChange!.newValue).toBe('review');
  });

  test('frontmatter field added: oldValue is null', () => {
    const oldContent = makeDoc({
      frontmatter: { title: 'Doc' },
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'Content.' },
      ],
    });

    const newContent = makeDoc({
      frontmatter: { title: 'Doc', author: 'agent-v1' },
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'Content.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    const authorChange = diff.frontmatterChanges.find((c) => c.field === 'author');
    expect(authorChange).toBeDefined();
    expect(authorChange!.oldValue).toBeNull();
    expect(authorChange!.newValue).toBe('agent-v1');
  });

  test('frontmatter field removed: newValue is null', () => {
    const oldContent = makeDoc({
      frontmatter: { title: 'Doc', deprecated: 'true' },
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'Content.' },
      ],
    });

    const newContent = makeDoc({
      frontmatter: { title: 'Doc' },
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Section', content: 'Content.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    const deprecatedChange = diff.frontmatterChanges.find((c) => c.field === 'deprecated');
    expect(deprecatedChange).toBeDefined();
    expect(deprecatedChange!.oldValue).toBe(true);
    expect(deprecatedChange!.newValue).toBeNull();
  });

  test('summary counts correct: 1 added, 1 removed, 1 modified, 2 unchanged', () => {
    const oldContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Stay Same A', content: 'Unchanged content A.' },
        { level: 2, heading: 'Stay Same B', content: 'Unchanged content B.' },
        { level: 2, heading: 'Will Change', content: 'Old version of content.' },
        { level: 2, heading: 'Will Be Removed', content: 'This will go away.' },
      ],
    });

    const newContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'Stay Same A', content: 'Unchanged content A.' },
        { level: 2, heading: 'Stay Same B', content: 'Unchanged content B.' },
        { level: 2, heading: 'Will Change', content: 'New completely different content replacing the old.' },
        { level: 2, heading: 'Brand New', content: 'This is new.' },
      ],
    });

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    expect(diff.summary.sectionsUnchanged).toBe(2);
    expect(diff.summary.sectionsModified).toBe(1);
    expect(diff.summary.sectionsRemoved).toBe(1);
    expect(diff.summary.sectionsAdded).toBe(1);
  });

  test('totalWordCountDelta computed correctly across all sections', () => {
    const oldContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'A', content: 'one two three' },       // 3 words
        { level: 2, heading: 'B', content: 'one two three four' },   // 4 words, will be removed
      ],
    });

    const newContent = makeDoc({
      title: 'Doc',
      sections: [
        { level: 2, heading: 'A', content: 'one two three four five' }, // 5 words (+2)
        { level: 2, heading: 'C', content: 'alpha beta' },              // 2 words (new)
      ],
    });

    // B removed: -4, A modified: +2, C added: +2 => total = 0
    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    expect(diff.summary.totalWordCountDelta).toBe(0);
  });

  test('diff handles documents with nested subsections', () => {
    const oldContent = [
      '# Doc',
      '',
      '## Overview',
      'Overview text.',
      '',
      '### Sub A',
      'Sub A text.',
      '',
      '### Sub B',
      'Sub B text.',
      '',
      '## Conclusion',
      'Conclusion text.',
    ].join('\n');

    const newContent = [
      '# Doc',
      '',
      '## Overview',
      'Overview text changed.',
      '',
      '### Sub A',
      'Sub A text.',
      '',
      '### Sub C',
      'Sub C is new.',
      '',
      '## Conclusion',
      'Conclusion text.',
    ].join('\n');

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    // Sub B removed, Sub C added, Overview modified, Sub A unchanged, Conclusion unchanged
    const subB = diff.sectionDiffs.find((d) => d.sectionId === 'sub-b');
    expect(subB).toBeDefined();
    expect(subB!.changeType).toBe('removed');

    const subC = diff.sectionDiffs.find((d) => d.sectionId === 'sub-c');
    expect(subC).toBeDefined();
    expect(subC!.changeType).toBe('added');

    const overview = diff.sectionDiffs.find((d) => d.sectionId === 'overview');
    expect(overview).toBeDefined();
    expect(overview!.changeType).toBe('modified');

    const subA = diff.sectionDiffs.find((d) => d.sectionId === 'sub-a');
    expect(subA).toBeDefined();
    expect(subA!.changeType).toBe('unchanged');

    const conclusion = diff.sectionDiffs.find((d) => d.sectionId === 'conclusion');
    expect(conclusion).toBeDefined();
    expect(conclusion!.changeType).toBe('unchanged');
  });

  test('diff handles documents with no frontmatter', () => {
    const oldContent = '# Title\n\n## Section\nOld content.';
    const newContent = '# Title\n\n## Section\nNew content.';

    const diff = computeDiff(oldContent, newContent, '1.0', '1.1');

    expect(diff.frontmatterChanges).toHaveLength(0);
    expect(diff.sectionDiffs).toHaveLength(1);
    expect(diff.sectionDiffs[0].changeType).toBe('modified');
  });

  test('computedAt is a valid ISO 8601 timestamp', () => {
    const content = '# Title\n\n## Section\nContent.';
    const diff = computeDiff(content, content, '1.0', '1.0');

    expect(diff.computedAt).toBeDefined();
    const parsed = new Date(diff.computedAt);
    expect(parsed.getTime()).not.toBeNaN();
  });
});
