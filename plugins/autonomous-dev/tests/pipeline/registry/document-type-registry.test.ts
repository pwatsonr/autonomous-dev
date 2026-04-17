import { DocumentType } from '../../../src/pipeline/types/document-type';
import {
  DocumentTypeRegistry,
  documentTypeRegistry,
} from '../../../src/pipeline/registry/document-type-registry';

describe('DocumentTypeRegistry', () => {
  // Use the singleton for all tests (it is immutable after construction)
  const registry = documentTypeRegistry;

  test('getDefinition returns correct definition for each type', () => {
    for (const type of Object.values(DocumentType)) {
      const def = registry.getDefinition(type);
      expect(def).toBeDefined();
      expect(def.type).toBe(type);
    }
  });

  test('getDefinition throws for unknown type', () => {
    expect(() => registry.getDefinition('UNKNOWN' as DocumentType)).toThrow(
      'No definition registered for document type: UNKNOWN'
    );
  });

  test('getAllDefinitions returns exactly 5 definitions', () => {
    const all = registry.getAllDefinitions();
    expect(all).toHaveLength(5);
  });

  test('PRD definition: depth=0, childType=TDD, parentType=null, decomposition=domain', () => {
    const prd = registry.getDefinition(DocumentType.PRD);
    expect(prd.depth).toBe(0);
    expect(prd.childType).toBe(DocumentType.TDD);
    expect(prd.parentType).toBeNull();
    expect(prd.decompositionStrategy).toBe('domain');
  });

  test('TDD definition: depth=1, childType=PLAN, parentType=PRD, decomposition=phase', () => {
    const tdd = registry.getDefinition(DocumentType.TDD);
    expect(tdd.depth).toBe(1);
    expect(tdd.childType).toBe(DocumentType.PLAN);
    expect(tdd.parentType).toBe(DocumentType.PRD);
    expect(tdd.decompositionStrategy).toBe('phase');
  });

  test('PLAN definition: depth=2, childType=SPEC, parentType=TDD, decomposition=task', () => {
    const plan = registry.getDefinition(DocumentType.PLAN);
    expect(plan.depth).toBe(2);
    expect(plan.childType).toBe(DocumentType.SPEC);
    expect(plan.parentType).toBe(DocumentType.TDD);
    expect(plan.decompositionStrategy).toBe('task');
  });

  test('SPEC definition: depth=3, childType=CODE, parentType=PLAN, decomposition=direct', () => {
    const spec = registry.getDefinition(DocumentType.SPEC);
    expect(spec.depth).toBe(3);
    expect(spec.childType).toBe(DocumentType.CODE);
    expect(spec.parentType).toBe(DocumentType.PLAN);
    expect(spec.decompositionStrategy).toBe('direct');
  });

  test('CODE definition: depth=4, childType=null, parentType=SPEC, decomposition=null', () => {
    const code = registry.getDefinition(DocumentType.CODE);
    expect(code.depth).toBe(4);
    expect(code.childType).toBeNull();
    expect(code.parentType).toBe(DocumentType.SPEC);
    expect(code.decompositionStrategy).toBeNull();
  });

  test('All definitions have valid reviewConfig with approvalThreshold 85', () => {
    const all = registry.getAllDefinitions();
    for (const def of all) {
      expect(def.reviewConfig).toBeDefined();
      expect(def.reviewConfig.approvalThreshold).toBe(85);
      expect(def.reviewConfig.maxIterations).toBe(3);
      expect(def.reviewConfig.regressionMargin).toBe(5);
      expect(typeof def.reviewConfig.panelSize).toBe('number');
      expect(def.reviewConfig.panelSize).toBeGreaterThanOrEqual(1);
    }
  });

  test('PRD and TDD have panelSize 2; PLAN and SPEC have panelSize 1; CODE has panelSize 2', () => {
    expect(registry.getDefinition(DocumentType.PRD).reviewConfig.panelSize).toBe(2);
    expect(registry.getDefinition(DocumentType.TDD).reviewConfig.panelSize).toBe(2);
    expect(registry.getDefinition(DocumentType.PLAN).reviewConfig.panelSize).toBe(1);
    expect(registry.getDefinition(DocumentType.SPEC).reviewConfig.panelSize).toBe(1);
    expect(registry.getDefinition(DocumentType.CODE).reviewConfig.panelSize).toBe(2);
  });

  test('All rubric category weights sum to 1.0', () => {
    const all = registry.getAllDefinitions();
    for (const def of all) {
      const weightSum = def.rubric.categories.reduce((sum, cat) => sum + cat.weight, 0);
      expect(weightSum).toBeCloseTo(1.0, 10);
    }
  });

  test('Each definition has a valid label', () => {
    const all = registry.getAllDefinitions();
    for (const def of all) {
      expect(def.label).toBeTruthy();
      expect(typeof def.label).toBe('string');
    }
  });

  test('Each definition has a valid templateId', () => {
    const all = registry.getAllDefinitions();
    for (const def of all) {
      expect(def.templateId).toBeTruthy();
      expect(typeof def.templateId).toBe('string');
    }
  });

  test('Singleton documentTypeRegistry is an instance of DocumentTypeRegistry', () => {
    expect(documentTypeRegistry).toBeInstanceOf(DocumentTypeRegistry);
  });
});
