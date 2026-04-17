import { DocumentType } from '../../../src/pipeline/types/document-type';
import { DocumentStorage } from '../../../src/pipeline/storage/document-storage';
import { ProposedChild } from '../../../src/pipeline/decomposition/decomposition-record-io';
import { smokeTest } from '../../../src/pipeline/decomposition/smoke-test';

/**
 * Creates a mock DocumentStorage that returns the given rawContent
 * for readDocument calls.
 */
function mockStorage(rawContent: string): DocumentStorage {
  return {
    readDocument: jest.fn().mockResolvedValue({
      rawContent,
      body: rawContent,
      frontmatter: {},
      version: '1.0',
      filePath: '/mock/path.md',
    }),
  } as unknown as DocumentStorage;
}

/**
 * Helper to create a ProposedChild with defaults.
 */
function makeChild(overrides: Partial<ProposedChild> & { id: string }): ProposedChild {
  return {
    title: `Child ${overrides.id}`,
    tracesFrom: [],
    executionMode: 'parallel',
    dependsOn: [],
    ...overrides,
  };
}

/**
 * A parent document with three sections:
 * ## Overview
 * ## Functional Requirements
 * ## Non-Functional Requirements
 */
const THREE_SECTION_PARENT = [
  '---',
  'id: PRD-001',
  'type: PRD',
  '---',
  '# My Product',
  '',
  '## Overview',
  'This is the overview.',
  '',
  '## Functional Requirements',
  'These are the functional requirements.',
  '',
  '## Non-Functional Requirements',
  'These are the non-functional requirements.',
].join('\n');

/**
 * A parent document with nested sections:
 * ## Overview
 * ### Background
 * ## Requirements
 */
const NESTED_SECTION_PARENT = [
  '---',
  'id: PRD-002',
  'type: PRD',
  '---',
  '# Nested Doc',
  '',
  '## Overview',
  'Overview text.',
  '',
  '### Background',
  'Background text.',
  '',
  '## Requirements',
  'Requirements text.',
].join('\n');

/**
 * A parent document with no sections (only a title).
 */
const EMPTY_PARENT = [
  '---',
  'id: PRD-003',
  'type: PRD',
  '---',
  '# Empty Doc',
  '',
  'Just some body text, no headings.',
].join('\n');

describe('Smoke Test', () => {
  test('full coverage: all parent sections covered by children -> passed', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    const children = [
      makeChild({ id: 'TDD-001-01', tracesFrom: ['overview', 'functional-requirements'] }),
      makeChild({ id: 'TDD-001-02', tracesFrom: ['non-functional-requirements'] }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(true);
    expect(result.coverageComplete).toBe(true);
    expect(result.uncoveredParentSections).toEqual([]);
    expect(result.scopeCreep).toBe(false);
    expect(result.scopeCreepDetails).toEqual([]);
    expect(result.contradictions).toBe(false);
    expect(result.contradictionDetails).toEqual([]);
  });

  test('missing coverage: parent section not in any child tracesFrom -> failed, uncoveredParentSections listed', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    // Only cover 2 of 3 sections
    const children = [
      makeChild({ id: 'TDD-001-01', tracesFrom: ['overview'] }),
      makeChild({ id: 'TDD-001-02', tracesFrom: ['functional-requirements'] }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(false);
    expect(result.coverageComplete).toBe(false);
    expect(result.uncoveredParentSections).toContain('non-functional-requirements');
    expect(result.uncoveredParentSections).toHaveLength(1);
  });

  test('scope creep: child tracesFrom references non-existent parent section -> failed, scopeCreepDetails listed', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    const children = [
      makeChild({
        id: 'TDD-001-01',
        tracesFrom: ['overview', 'functional-requirements', 'non-functional-requirements'],
      }),
      makeChild({
        id: 'TDD-001-02',
        tracesFrom: ['ghost-section'],
      }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(false);
    expect(result.scopeCreep).toBe(true);
    expect(result.scopeCreepDetails).toHaveLength(1);
    expect(result.scopeCreepDetails[0]).toContain('TDD-001-02');
    expect(result.scopeCreepDetails[0]).toContain('ghost-section');
    expect(result.scopeCreepDetails[0]).toContain('does not exist in parent');
  });

  test('no scope creep: all tracesFrom reference valid parent sections', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    const children = [
      makeChild({
        id: 'TDD-001-01',
        tracesFrom: ['overview', 'functional-requirements', 'non-functional-requirements'],
      }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.scopeCreep).toBe(false);
    expect(result.scopeCreepDetails).toEqual([]);
  });

  test('mixed: coverage complete but scope creep present -> failed', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    // All parent sections covered, BUT one child references a non-existent section
    const children = [
      makeChild({
        id: 'TDD-001-01',
        tracesFrom: ['overview', 'functional-requirements', 'non-functional-requirements'],
      }),
      makeChild({
        id: 'TDD-001-02',
        tracesFrom: ['made-up-section'],
      }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(false);
    expect(result.coverageComplete).toBe(true);
    expect(result.scopeCreep).toBe(true);
    expect(result.scopeCreepDetails).toHaveLength(1);
  });

  test('empty parent (no sections): all children trace to nothing -> passed (vacuously)', async () => {
    const storage = mockStorage(EMPTY_PARENT);
    // No sections in parent, so no children need to trace to anything
    const children = [
      makeChild({ id: 'TDD-003-01', tracesFrom: [] }),
    ];

    const result = await smokeTest('PRD-003', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(true);
    expect(result.coverageComplete).toBe(true);
    expect(result.uncoveredParentSections).toEqual([]);
    expect(result.scopeCreep).toBe(false);
  });

  test('single child covering all parent sections -> passed', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    const children = [
      makeChild({
        id: 'TDD-001-01',
        tracesFrom: ['overview', 'functional-requirements', 'non-functional-requirements'],
      }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(true);
    expect(result.coverageComplete).toBe(true);
  });

  test('multiple children with overlapping coverage -> passed (overlap is OK)', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    // Both children trace from the same sections -- overlap is fine
    const children = [
      makeChild({
        id: 'TDD-001-01',
        tracesFrom: ['overview', 'functional-requirements'],
      }),
      makeChild({
        id: 'TDD-001-02',
        tracesFrom: ['functional-requirements', 'non-functional-requirements'],
      }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(true);
    expect(result.coverageComplete).toBe(true);
    expect(result.scopeCreep).toBe(false);
  });

  test('nested sections are included in coverage check', async () => {
    const storage = mockStorage(NESTED_SECTION_PARENT);
    // Parent has: overview, background (nested under overview), requirements
    // If we only cover overview and requirements, background is uncovered
    const children = [
      makeChild({
        id: 'TDD-002-01',
        tracesFrom: ['overview', 'requirements'],
      }),
    ];

    const result = await smokeTest('PRD-002', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(false);
    expect(result.coverageComplete).toBe(false);
    expect(result.uncoveredParentSections).toContain('background');
  });

  test('nested sections fully covered -> passed', async () => {
    const storage = mockStorage(NESTED_SECTION_PARENT);
    const children = [
      makeChild({
        id: 'TDD-002-01',
        tracesFrom: ['overview', 'background', 'requirements'],
      }),
    ];

    const result = await smokeTest('PRD-002', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(true);
    expect(result.coverageComplete).toBe(true);
  });

  test('empty parent with scope creep -> failed', async () => {
    const storage = mockStorage(EMPTY_PARENT);
    // Parent has no sections, but child claims to trace from something
    const children = [
      makeChild({
        id: 'TDD-003-01',
        tracesFrom: ['phantom-section'],
      }),
    ];

    const result = await smokeTest('PRD-003', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(false);
    expect(result.coverageComplete).toBe(true); // vacuously
    expect(result.scopeCreep).toBe(true);
    expect(result.scopeCreepDetails).toHaveLength(1);
  });

  test('no children with non-empty parent -> coverage incomplete', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    const children: ProposedChild[] = [];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.passed).toBe(false);
    expect(result.coverageComplete).toBe(false);
    expect(result.uncoveredParentSections).toHaveLength(3);
    expect(result.scopeCreep).toBe(false);
  });

  test('contradictions field is false for MVP (no explicit conflicts)', async () => {
    const storage = mockStorage(THREE_SECTION_PARENT);
    const children = [
      makeChild({
        id: 'TDD-001-01',
        tracesFrom: ['overview', 'functional-requirements', 'non-functional-requirements'],
      }),
    ];

    const result = await smokeTest('PRD-001', DocumentType.PRD, 'pipeline-1', children, storage);

    expect(result.contradictions).toBe(false);
    expect(result.contradictionDetails).toEqual([]);
  });
});
