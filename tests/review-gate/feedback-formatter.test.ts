/**
 * Unit tests for FeedbackFormatter (SPEC-004-3-2, Task 4).
 *
 * Covers all 18 test cases from the spec:
 * 1.  Single reviewer, no deduplication needed
 * 2.  Two reviewers, no duplicates
 * 3.  Two reviewers, exact duplicate
 * 4.  Keyword overlap threshold -- below 0.5
 * 5.  Keyword overlap above threshold -- at 0.6
 * 6.  Same section, different category -- not duplicates
 * 7.  Same category, different section -- not duplicates
 * 8.  Severity escalation on merge
 * 9.  Critical sub preference (reject over blocking)
 * 10. Suggested resolution -- highest severity wins
 * 11. Suggested resolution -- tied severity, longest wins
 * 12. Upstream defect propagation
 * 13. Sorting: severity then section_id
 * 14. Group by section
 * 15. Deduplication stats
 * 16. Pluggable similarity function
 * 17. Three-way merge
 * 18. Empty findings
 */

import type { ReviewOutput, Finding, MergedFinding } from '../../src/review-gate/types';
import {
  FeedbackFormatter,
  keywordOverlap,
  tokenize,
  SEVERITY_ORDER,
  STOP_WORDS,
} from '../../src/review-gate/feedback-formatter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let findingCounter = 0;

/** Build a minimal Finding for testing. */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  findingCounter++;
  return {
    id: overrides.id ?? `finding-${findingCounter}`,
    section_id: overrides.section_id ?? 'section-default',
    category_id: overrides.category_id ?? 'category-default',
    severity: overrides.severity ?? 'minor',
    critical_sub: overrides.critical_sub ?? null,
    upstream_defect: overrides.upstream_defect ?? false,
    description: overrides.description ?? `Default description ${findingCounter}`,
    evidence: overrides.evidence ?? `Default evidence ${findingCounter}`,
    suggested_resolution: overrides.suggested_resolution ?? `Default resolution ${findingCounter}`,
  };
}

/** Build a minimal ReviewOutput with given findings. */
function makeReviewOutput(
  reviewerId: string,
  findings: Finding[],
): ReviewOutput {
  return {
    reviewer_id: reviewerId,
    reviewer_role: 'test-role',
    document_id: 'doc-1',
    document_version: '1.0',
    timestamp: '2026-04-08T12:00:00Z',
    scoring_mode: 'document_level',
    category_scores: [],
    findings,
    summary: 'Test review',
  };
}

beforeEach(() => {
  findingCounter = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeedbackFormatter', () => {
  let formatter: FeedbackFormatter;

  beforeEach(() => {
    formatter = new FeedbackFormatter();
  });

  // -----------------------------------------------------------------------
  // Test 1: Single reviewer, no deduplication needed
  // -----------------------------------------------------------------------
  test('1. Single reviewer, no deduplication needed', () => {
    const findings = [
      makeFinding({ section_id: 'goals', category_id: 'measurability', description: 'Goals lack measurable targets' }),
      makeFinding({ section_id: 'risks', category_id: 'risk_identification', description: 'Missing risk mitigation plan' }),
      makeFinding({ section_id: 'scope', category_id: 'scope_clarity', description: 'Scope boundaries unclear' }),
    ];
    const output = makeReviewOutput('reviewer-a', findings);

    const result = formatter.formatFindings([output]);

    expect(result.merged_findings).toHaveLength(3);
    expect(result.total_findings).toBe(3);
    for (const mf of result.merged_findings) {
      expect(mf.reported_by).toEqual(['reviewer-a']);
    }
    expect(result.deduplication_stats).toEqual({
      total_raw: 3,
      after_dedup: 3,
      duplicates_merged: 0,
    });
  });

  // -----------------------------------------------------------------------
  // Test 2: Two reviewers, no duplicates
  // -----------------------------------------------------------------------
  test('2. Two reviewers, no duplicates', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Goals lack measurable targets',
    });
    const findingB = makeFinding({
      section_id: 'risks',
      category_id: 'risk_identification',
      description: 'Missing risk mitigation plan',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);

    expect(result.merged_findings).toHaveLength(2);
    expect(result.total_findings).toBe(2);
    expect(result.deduplication_stats.duplicates_merged).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 3: Two reviewers, exact duplicate
  // -----------------------------------------------------------------------
  test('3. Two reviewers, exact duplicate', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Goals section lacks measurable success criteria and KPIs',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Goals section lacks measurable success criteria and KPIs',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);

    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].reported_by).toContain('reviewer-a');
    expect(result.merged_findings[0].reported_by).toContain('reviewer-b');
    expect(result.deduplication_stats).toEqual({
      total_raw: 2,
      after_dedup: 1,
      duplicates_merged: 1,
    });
  });

  // -----------------------------------------------------------------------
  // Test 4: Keyword overlap threshold -- below 0.5, not merged
  // -----------------------------------------------------------------------
  test('4. Keyword overlap below threshold (< 0.5): not merged', () => {
    // Descriptions with low overlap
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Authentication module needs better error handling for edge cases',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Database schema requires normalization improvements and indexing',
    });

    // Verify the overlap is below 0.5
    const overlap = keywordOverlap(findingA.description, findingB.description);
    expect(overlap).toBeLessThan(0.5);

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Test 5: Keyword overlap above threshold (>= 0.5), merged
  // -----------------------------------------------------------------------
  test('5. Keyword overlap above threshold (>= 0.5): merged', () => {
    // Descriptions with high overlap
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Missing measurable success criteria for project goals',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Project goals lack measurable success criteria',
    });

    // Verify the overlap is >= 0.5
    const overlap = keywordOverlap(findingA.description, findingB.description);
    expect(overlap).toBeGreaterThanOrEqual(0.5);

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].reported_by).toEqual(['reviewer-a', 'reviewer-b']);
  });

  // -----------------------------------------------------------------------
  // Test 6: Same section, different category -- not duplicates
  // -----------------------------------------------------------------------
  test('6. Same section, different category -- not duplicates', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Goals need measurable success criteria and clear KPIs',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'completeness',
      description: 'Goals need measurable success criteria and clear KPIs',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Test 7: Same category, different section -- not duplicates
  // -----------------------------------------------------------------------
  test('7. Same category, different section -- not duplicates', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'requirements_completeness',
      description: 'Requirements completeness lacking in goals section',
    });
    const findingB = makeFinding({
      section_id: 'architecture',
      category_id: 'requirements_completeness',
      description: 'Requirements completeness lacking in architecture section',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Test 8: Severity escalation on merge
  // -----------------------------------------------------------------------
  test('8. Severity escalation on merge: minor + major = major', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      severity: 'minor',
      description: 'Missing measurable success criteria for project goals',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      severity: 'major',
      description: 'Project goals lack measurable success criteria',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].severity).toBe('major');
  });

  // -----------------------------------------------------------------------
  // Test 9: Critical sub preference (reject over blocking)
  // -----------------------------------------------------------------------
  test('9. Critical sub preference: reject over blocking', () => {
    const findingA = makeFinding({
      section_id: 'security',
      category_id: 'security_depth',
      severity: 'critical',
      critical_sub: 'blocking',
      description: 'Critical security vulnerability in authentication module detected',
    });
    const findingB = makeFinding({
      section_id: 'security',
      category_id: 'security_depth',
      severity: 'critical',
      critical_sub: 'reject',
      description: 'Critical security vulnerability in authentication detected',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].severity).toBe('critical');
    expect(result.merged_findings[0].critical_sub).toBe('reject');
  });

  // -----------------------------------------------------------------------
  // Test 10: Suggested resolution -- highest severity wins
  // -----------------------------------------------------------------------
  test('10. Suggested resolution -- highest severity wins', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      severity: 'major',
      description: 'Missing measurable success criteria for project goals',
      suggested_resolution: 'Fix X',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      severity: 'minor',
      description: 'Project goals lack measurable success criteria',
      suggested_resolution: 'Consider fixing X',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].suggested_resolution).toBe('Fix X');
  });

  // -----------------------------------------------------------------------
  // Test 11: Suggested resolution -- tied severity, longest wins
  // -----------------------------------------------------------------------
  test('11. Suggested resolution -- tied severity, longest wins', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      severity: 'major',
      description: 'Missing measurable success criteria for project goals',
      suggested_resolution: 'Fix X.',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      severity: 'major',
      description: 'Project goals lack measurable success criteria',
      suggested_resolution: 'Fix X by changing Y and Z.',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].suggested_resolution).toBe('Fix X by changing Y and Z.');
  });

  // -----------------------------------------------------------------------
  // Test 12: Upstream defect propagation
  // -----------------------------------------------------------------------
  test('12. Upstream defect propagation: true if any in cluster', () => {
    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      upstream_defect: false,
      description: 'Missing measurable success criteria for project goals',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      upstream_defect: true,
      description: 'Project goals lack measurable success criteria',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = formatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].upstream_defect).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 13: Sorting by severity then section_id
  // -----------------------------------------------------------------------
  test('13. Sorting: critical before major before minor; within severity, alphabetical section_id', () => {
    const findings = [
      makeFinding({ section_id: 'goals', category_id: 'cat-1', severity: 'minor', description: 'Minor issue in goals unique alpha' }),
      makeFinding({ section_id: 'architecture', category_id: 'cat-2', severity: 'critical', critical_sub: 'blocking', description: 'Critical architecture issue unique beta' }),
      makeFinding({ section_id: 'goals', category_id: 'cat-3', severity: 'major', description: 'Major issue in goals unique gamma' }),
      makeFinding({ section_id: 'architecture', category_id: 'cat-4', severity: 'major', description: 'Major issue in architecture unique delta' }),
    ];

    const output = makeReviewOutput('reviewer-a', findings);
    const result = formatter.formatFindings([output]);

    expect(result.merged_findings).toHaveLength(4);
    // critical first
    expect(result.merged_findings[0].severity).toBe('critical');
    expect(result.merged_findings[0].section_id).toBe('architecture');
    // then major, alphabetical: architecture before goals
    expect(result.merged_findings[1].severity).toBe('major');
    expect(result.merged_findings[1].section_id).toBe('architecture');
    expect(result.merged_findings[2].severity).toBe('major');
    expect(result.merged_findings[2].section_id).toBe('goals');
    // then minor
    expect(result.merged_findings[3].severity).toBe('minor');
    expect(result.merged_findings[3].section_id).toBe('goals');
  });

  // -----------------------------------------------------------------------
  // Test 14: Group by section
  // -----------------------------------------------------------------------
  test('14. Group by section: 5 findings across 3 sections', () => {
    const findings = [
      makeFinding({ section_id: 'goals', category_id: 'cat-1', description: 'Unique alpha bravo charlie' }),
      makeFinding({ section_id: 'goals', category_id: 'cat-2', description: 'Unique delta echo foxtrot' }),
      makeFinding({ section_id: 'risks', category_id: 'cat-3', description: 'Unique golf hotel india' }),
      makeFinding({ section_id: 'risks', category_id: 'cat-4', description: 'Unique juliet kilo lima' }),
      makeFinding({ section_id: 'scope', category_id: 'cat-5', description: 'Unique mike november oscar' }),
    ];

    const output = makeReviewOutput('reviewer-a', findings);
    const result = formatter.formatFindings([output]);

    expect(result.findings_by_section.size).toBe(3);
    expect(result.findings_by_section.get('goals')).toHaveLength(2);
    expect(result.findings_by_section.get('risks')).toHaveLength(2);
    expect(result.findings_by_section.get('scope')).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Test 15: Deduplication stats
  // -----------------------------------------------------------------------
  test('15. Deduplication stats: 6 raw, 2 duplicate clusters of size 2, result: 4 after dedup', () => {
    // Cluster 1: same section/category/description -> will merge
    const f1a = makeFinding({ section_id: 'goals', category_id: 'measurability', description: 'Missing measurable success criteria for project goals' });
    const f1b = makeFinding({ section_id: 'goals', category_id: 'measurability', description: 'Project goals lack measurable success criteria' });

    // Cluster 2: same section/category/description -> will merge
    const f2a = makeFinding({ section_id: 'risks', category_id: 'risk_identification', description: 'Risk mitigation strategies completely missing from document' });
    const f2b = makeFinding({ section_id: 'risks', category_id: 'risk_identification', description: 'Missing risk mitigation strategies from document' });

    // Unique findings
    const f3 = makeFinding({ section_id: 'scope', category_id: 'scope_clarity', description: 'Unique finding about scope boundaries alpha bravo' });
    const f4 = makeFinding({ section_id: 'arch', category_id: 'architecture', description: 'Unique finding about architecture gamma delta' });

    const outputA = makeReviewOutput('reviewer-a', [f1a, f2a, f3]);
    const outputB = makeReviewOutput('reviewer-b', [f1b, f2b, f4]);

    const result = formatter.formatFindings([outputA, outputB]);

    expect(result.deduplication_stats.total_raw).toBe(6);
    expect(result.deduplication_stats.after_dedup).toBe(4);
    expect(result.deduplication_stats.duplicates_merged).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Test 16: Pluggable similarity function
  // -----------------------------------------------------------------------
  test('16. Pluggable similarity function: always returns 1.0, all same-section-category pairs merged', () => {
    const alwaysSimilar = (_a: string, _b: string): number => 1.0;
    const customFormatter = new FeedbackFormatter({
      similarity_function: alwaysSimilar,
      similarity_threshold: 0.85,
    });

    const findingA = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Completely different description about authentication',
    });
    const findingB = makeFinding({
      section_id: 'goals',
      category_id: 'measurability',
      description: 'Entirely unrelated text about database schemas',
    });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);

    const result = customFormatter.formatFindings([outputA, outputB]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].reported_by).toEqual(['reviewer-a', 'reviewer-b']);
  });

  // -----------------------------------------------------------------------
  // Test 17: Three-way merge
  // -----------------------------------------------------------------------
  test('17. Three-way merge: 3 reviewers flag same issue, reported_by has all 3 IDs', () => {
    const desc = 'Missing measurable success criteria for project goals definition';
    const findingA = makeFinding({ section_id: 'goals', category_id: 'measurability', description: desc });
    const findingB = makeFinding({ section_id: 'goals', category_id: 'measurability', description: desc });
    const findingC = makeFinding({ section_id: 'goals', category_id: 'measurability', description: desc });

    const outputA = makeReviewOutput('reviewer-a', [findingA]);
    const outputB = makeReviewOutput('reviewer-b', [findingB]);
    const outputC = makeReviewOutput('reviewer-c', [findingC]);

    const result = formatter.formatFindings([outputA, outputB, outputC]);
    expect(result.merged_findings).toHaveLength(1);
    expect(result.merged_findings[0].reported_by).toHaveLength(3);
    expect(result.merged_findings[0].reported_by).toContain('reviewer-a');
    expect(result.merged_findings[0].reported_by).toContain('reviewer-b');
    expect(result.merged_findings[0].reported_by).toContain('reviewer-c');
  });

  // -----------------------------------------------------------------------
  // Test 18: Empty findings
  // -----------------------------------------------------------------------
  test('18. Empty findings: no findings from any reviewer', () => {
    const outputA = makeReviewOutput('reviewer-a', []);
    const outputB = makeReviewOutput('reviewer-b', []);

    const result = formatter.formatFindings([outputA, outputB]);

    expect(result.merged_findings).toHaveLength(0);
    expect(result.total_findings).toBe(0);
    expect(result.findings_by_section.size).toBe(0);
    expect(result.severity_counts).toEqual({ critical: 0, major: 0, minor: 0, suggestion: 0 });
    expect(result.deduplication_stats).toEqual({ total_raw: 0, after_dedup: 0, duplicates_merged: 0 });
  });
});

// ---------------------------------------------------------------------------
// tokenize() unit tests
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  test('lowercases and strips punctuation', () => {
    const tokens = tokenize('Hello, World! This is a Test.');
    expect(tokens).not.toContain('Hello');
    expect(tokens).not.toContain('this');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('test');
  });

  test('removes words with 2 or fewer characters', () => {
    const tokens = tokenize('I am a big cat');
    expect(tokens).not.toContain('am');
    expect(tokens).toContain('big');
    expect(tokens).toContain('cat');
  });

  test('removes stop words', () => {
    const tokens = tokenize('the quick brown fox should also jump');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('should');
    expect(tokens).not.toContain('also');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
    expect(tokens).toContain('jump');
  });
});

// ---------------------------------------------------------------------------
// keywordOverlap() unit tests
// ---------------------------------------------------------------------------

describe('keywordOverlap', () => {
  test('identical descriptions return 1.0', () => {
    const desc = 'Missing measurable success criteria';
    expect(keywordOverlap(desc, desc)).toBe(1);
  });

  test('completely different descriptions return 0', () => {
    expect(keywordOverlap('authentication module error handling', 'database normalization indexing schema')).toBe(0);
  });

  test('both empty descriptions return 0', () => {
    expect(keywordOverlap('', '')).toBe(0);
  });

  test('partial overlap returns correct Jaccard coefficient', () => {
    // "missing success criteria" -> tokens: ["missing", "success", "criteria"]
    // "missing success metrics"  -> tokens: ["missing", "success", "metrics"]
    // intersection: {"missing", "success"} = 2
    // union: {"missing", "success", "criteria", "metrics"} = 4
    // Jaccard = 2/4 = 0.5
    const overlap = keywordOverlap('missing success criteria', 'missing success metrics');
    expect(overlap).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// SEVERITY_ORDER tests
// ---------------------------------------------------------------------------

describe('SEVERITY_ORDER', () => {
  test('critical > major > minor > suggestion', () => {
    expect(SEVERITY_ORDER.critical).toBeGreaterThan(SEVERITY_ORDER.major);
    expect(SEVERITY_ORDER.major).toBeGreaterThan(SEVERITY_ORDER.minor);
    expect(SEVERITY_ORDER.minor).toBeGreaterThan(SEVERITY_ORDER.suggestion);
  });
});
