import { DocumentType } from '../../../src/pipeline/types/document-type';
import {
  getStrategy,
  getAllStrategies,
  DecompositionStrategyId,
} from '../../../src/pipeline/decomposition/strategy-registry';

describe('Strategy Registry', () => {
  test('PRD->TDD returns domain strategy', () => {
    const strategy = getStrategy(DocumentType.PRD, DocumentType.TDD);
    expect(strategy.id).toBe('domain');
    expect(strategy.parentType).toBe(DocumentType.PRD);
    expect(strategy.childType).toBe(DocumentType.TDD);
    expect(strategy.description).toBeTruthy();
  });

  test('TDD->PLAN returns phase strategy', () => {
    const strategy = getStrategy(DocumentType.TDD, DocumentType.PLAN);
    expect(strategy.id).toBe('phase');
    expect(strategy.parentType).toBe(DocumentType.TDD);
    expect(strategy.childType).toBe(DocumentType.PLAN);
    expect(strategy.description).toBeTruthy();
  });

  test('PLAN->SPEC returns task strategy', () => {
    const strategy = getStrategy(DocumentType.PLAN, DocumentType.SPEC);
    expect(strategy.id).toBe('task');
    expect(strategy.parentType).toBe(DocumentType.PLAN);
    expect(strategy.childType).toBe(DocumentType.SPEC);
    expect(strategy.description).toBeTruthy();
  });

  test('SPEC->CODE returns direct strategy', () => {
    const strategy = getStrategy(DocumentType.SPEC, DocumentType.CODE);
    expect(strategy.id).toBe('direct');
    expect(strategy.parentType).toBe(DocumentType.SPEC);
    expect(strategy.childType).toBe(DocumentType.CODE);
    expect(strategy.description).toBeTruthy();
  });

  test('CODE->anything throws', () => {
    expect(() => getStrategy(DocumentType.CODE, DocumentType.PRD)).toThrow(
      'No decomposition strategy for transition CODE -> PRD',
    );
    expect(() => getStrategy(DocumentType.CODE, DocumentType.TDD)).toThrow(
      'No decomposition strategy for transition CODE -> TDD',
    );
  });

  test('invalid transition throws', () => {
    expect(() => getStrategy(DocumentType.PRD, DocumentType.PLAN)).toThrow(
      'No decomposition strategy for transition PRD -> PLAN',
    );
    expect(() => getStrategy(DocumentType.TDD, DocumentType.CODE)).toThrow(
      'No decomposition strategy for transition TDD -> CODE',
    );
  });

  test('getAllStrategies returns 4 strategies', () => {
    const strategies = getAllStrategies();
    expect(strategies).toHaveLength(4);
  });

  test('getAllStrategies returns copies (not references to internal array)', () => {
    const strategies1 = getAllStrategies();
    const strategies2 = getAllStrategies();
    expect(strategies1).not.toBe(strategies2);
    expect(strategies1).toEqual(strategies2);
  });

  test('all strategy ids are unique', () => {
    const strategies = getAllStrategies();
    const ids = strategies.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all strategies have the four expected ids', () => {
    const strategies = getAllStrategies();
    const ids = strategies.map(s => s.id).sort();
    const expected: DecompositionStrategyId[] = ['direct', 'domain', 'phase', 'task'];
    expect(ids).toEqual(expected);
  });
});
