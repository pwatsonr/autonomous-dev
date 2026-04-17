import { DocumentType } from '../../../src/pipeline/types/document-type';
import {
  DEFAULT_REVIEW_GATE_CONFIGS,
  ReviewGateConfig,
} from '../../../src/pipeline/types/review-gate-config';

describe('ReviewGateConfig', () => {
  test('DEFAULT_REVIEW_GATE_CONFIGS has entries for all 5 types', () => {
    const types = Object.values(DocumentType);
    expect(types).toHaveLength(5);
    for (const type of types) {
      expect(DEFAULT_REVIEW_GATE_CONFIGS[type]).toBeDefined();
    }
  });

  test('PRD panelSize is 2', () => {
    expect(DEFAULT_REVIEW_GATE_CONFIGS[DocumentType.PRD].panelSize).toBe(2);
  });

  test('TDD panelSize is 2', () => {
    expect(DEFAULT_REVIEW_GATE_CONFIGS[DocumentType.TDD].panelSize).toBe(2);
  });

  test('PLAN panelSize is 1', () => {
    expect(DEFAULT_REVIEW_GATE_CONFIGS[DocumentType.PLAN].panelSize).toBe(1);
  });

  test('SPEC panelSize is 1', () => {
    expect(DEFAULT_REVIEW_GATE_CONFIGS[DocumentType.SPEC].panelSize).toBe(1);
  });

  test('CODE panelSize is 2', () => {
    expect(DEFAULT_REVIEW_GATE_CONFIGS[DocumentType.CODE].panelSize).toBe(2);
  });

  test('All types have approvalThreshold 85', () => {
    for (const type of Object.values(DocumentType)) {
      expect(DEFAULT_REVIEW_GATE_CONFIGS[type].approvalThreshold).toBe(85);
    }
  });

  test('All types have maxIterations 3', () => {
    for (const type of Object.values(DocumentType)) {
      expect(DEFAULT_REVIEW_GATE_CONFIGS[type].maxIterations).toBe(3);
    }
  });

  test('All types have regressionMargin 5', () => {
    for (const type of Object.values(DocumentType)) {
      expect(DEFAULT_REVIEW_GATE_CONFIGS[type].regressionMargin).toBe(5);
    }
  });

  test('ReviewGateConfig interface accepts all required fields', () => {
    const config: ReviewGateConfig = {
      panelSize: 3,
      maxIterations: 5,
      approvalThreshold: 90,
      regressionMargin: 10,
    };
    expect(config.panelSize).toBe(3);
    expect(config.maxIterations).toBe(5);
    expect(config.approvalThreshold).toBe(90);
    expect(config.regressionMargin).toBe(10);
  });
});
