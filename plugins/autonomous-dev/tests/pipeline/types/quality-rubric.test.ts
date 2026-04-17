import type {
  RubricCategory,
  ScoringGuideEntry,
  QualityRubric,
  AggregationMethod,
} from '../../../src/pipeline/types/quality-rubric';

describe('RubricCategory interface', () => {
  test('RubricCategory interface accepts all required fields', () => {
    const category: RubricCategory = {
      id: 'completeness',
      name: 'Completeness',
      description: 'All required sections are present.',
      weight: 0.3,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 49, description: 'Major sections missing.' },
        { min: 50, max: 100, description: 'Adequate coverage.' },
      ],
    };

    expect(category.id).toBe('completeness');
    expect(category.name).toBe('Completeness');
    expect(category.description).toBe('All required sections are present.');
    expect(category.weight).toBe(0.3);
    expect(category.minimumScore).toBe(70);
    expect(category.scoringGuide).toHaveLength(2);
    expect(category.scoringGuide[0].min).toBe(0);
    expect(category.scoringGuide[0].max).toBe(49);
    expect(category.scoringGuide[1].min).toBe(50);
    expect(category.scoringGuide[1].max).toBe(100);
  });
});

describe('QualityRubric interface', () => {
  const makeScoringGuide = (): ScoringGuideEntry[] => [
    { min: 0, max: 49, description: 'Poor' },
    { min: 50, max: 100, description: 'Good' },
  ];

  const makeCategory = (id: string, weight: number): RubricCategory => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: `Measures ${id}.`,
    weight,
    minimumScore: 60,
    scoringGuide: makeScoringGuide(),
  });

  test('QualityRubric supports mean aggregation', () => {
    const rubric: QualityRubric = {
      documentType: 'PRD',
      version: '1.0.0',
      categories: [makeCategory('a', 0.5), makeCategory('b', 0.5)],
      aggregationMethod: 'mean',
    };

    expect(rubric.aggregationMethod).toBe('mean');
    expect(rubric.documentType).toBe('PRD');
    expect(rubric.version).toBe('1.0.0');
    expect(rubric.categories).toHaveLength(2);
  });

  test('QualityRubric supports median aggregation', () => {
    const rubric: QualityRubric = {
      documentType: 'TDD',
      version: '1.0.0',
      categories: [makeCategory('a', 0.5), makeCategory('b', 0.5)],
      aggregationMethod: 'median',
    };

    expect(rubric.aggregationMethod).toBe('median');
  });

  test('QualityRubric supports min aggregation', () => {
    const rubric: QualityRubric = {
      documentType: 'SPEC',
      version: '1.0.0',
      categories: [makeCategory('a', 0.5), makeCategory('b', 0.5)],
      aggregationMethod: 'min',
    };

    expect(rubric.aggregationMethod).toBe('min');
  });

  test('AggregationMethod type restricts to valid values', () => {
    const methods: AggregationMethod[] = ['mean', 'median', 'min'];
    expect(methods).toHaveLength(3);
    expect(methods).toContain('mean');
    expect(methods).toContain('median');
    expect(methods).toContain('min');
  });
});
