import {
  DocumentType,
  PIPELINE_ORDER,
  getDepth,
  getChildType,
  getParentType,
} from '../../../src/pipeline/types/document-type';

describe('DocumentType', () => {
  test('DocumentType enum has exactly 5 values', () => {
    const values = Object.values(DocumentType);
    expect(values).toHaveLength(5);
    expect(values).toContain('PRD');
    expect(values).toContain('TDD');
    expect(values).toContain('PLAN');
    expect(values).toContain('SPEC');
    expect(values).toContain('CODE');
  });
});

describe('PIPELINE_ORDER', () => {
  test('PIPELINE_ORDER has length 5 and correct order', () => {
    expect(PIPELINE_ORDER).toHaveLength(5);
    expect(PIPELINE_ORDER[0]).toBe(DocumentType.PRD);
    expect(PIPELINE_ORDER[1]).toBe(DocumentType.TDD);
    expect(PIPELINE_ORDER[2]).toBe(DocumentType.PLAN);
    expect(PIPELINE_ORDER[3]).toBe(DocumentType.SPEC);
    expect(PIPELINE_ORDER[4]).toBe(DocumentType.CODE);
  });
});

describe('getDepth', () => {
  test('getDepth returns 0 for PRD, 4 for CODE', () => {
    expect(getDepth(DocumentType.PRD)).toBe(0);
    expect(getDepth(DocumentType.TDD)).toBe(1);
    expect(getDepth(DocumentType.PLAN)).toBe(2);
    expect(getDepth(DocumentType.SPEC)).toBe(3);
    expect(getDepth(DocumentType.CODE)).toBe(4);
  });

  test('getDepth throws for unknown type', () => {
    expect(() => getDepth('UNKNOWN' as DocumentType)).toThrow('Unknown document type: UNKNOWN');
  });
});

describe('getChildType', () => {
  test('getChildType returns TDD for PRD, null for CODE', () => {
    expect(getChildType(DocumentType.PRD)).toBe(DocumentType.TDD);
    expect(getChildType(DocumentType.TDD)).toBe(DocumentType.PLAN);
    expect(getChildType(DocumentType.PLAN)).toBe(DocumentType.SPEC);
    expect(getChildType(DocumentType.SPEC)).toBe(DocumentType.CODE);
    expect(getChildType(DocumentType.CODE)).toBeNull();
  });
});

describe('getParentType', () => {
  test('getParentType returns null for PRD, SPEC for CODE', () => {
    expect(getParentType(DocumentType.PRD)).toBeNull();
    expect(getParentType(DocumentType.TDD)).toBe(DocumentType.PRD);
    expect(getParentType(DocumentType.PLAN)).toBe(DocumentType.TDD);
    expect(getParentType(DocumentType.SPEC)).toBe(DocumentType.PLAN);
    expect(getParentType(DocumentType.CODE)).toBe(DocumentType.SPEC);
  });
});
