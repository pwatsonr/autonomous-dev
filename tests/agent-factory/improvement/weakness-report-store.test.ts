/**
 * Unit tests for Weakness Report Store (SPEC-005-3-1, Task 2).
 *
 * Tests cover:
 *   - WeaknessReport serialization round-trip
 *   - Append to JSONL (multiple reports produce multiple lines)
 *   - Query by agent name
 *   - All required fields present after parse
 *   - WeaknessSeverity enum validation
 *   - OverallAssessment enum validation
 *   - Recommendation enum validation
 *   - Malformed lines are skipped
 *   - Empty file returns empty array
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  WeaknessReportStore,
} from '../../../src/agent-factory/improvement/types';
import type {
  WeaknessReport,
  Weakness,
  MetricsSummary,
  OverallAssessment,
  Recommendation,
  WeaknessSeverity,
} from '../../../src/agent-factory/improvement/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/** Create a temp directory for test JSONL files. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'weakness-report-test-'));
}

/** Clean up a temp directory. */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Silent logger. */
const silentLogger = {
  info: () => {},
  warn: () => {},
};

/** Create a valid WeaknessReport for testing. */
function makeReport(overrides?: Partial<WeaknessReport>): WeaknessReport {
  return {
    report_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    agent_name: 'code-executor',
    agent_version: '1.0.0',
    analysis_date: '2026-04-08T10:00:00.000Z',
    overall_assessment: 'needs_improvement',
    weaknesses: [
      {
        dimension: 'test-coverage',
        severity: 'medium',
        evidence:
          'Average test-coverage score is 2.8/5.0, 1.2 below median. Decline of 0.4 over last 15 invocations.',
        affected_domains: ['python'],
        suggested_focus:
          'Emphasize test generation for non-TypeScript domains',
      },
    ],
    strengths: [
      'correctness score stable at 4.2',
      'spec-adherence consistently above 4.0',
    ],
    recommendation: 'propose_modification',
    metrics_summary: {
      invocation_count: 25,
      approval_rate: 0.80,
      avg_quality_score: 3.6,
      trend_direction: 'declining',
      active_alerts: 1,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_weakness_report_serialization(): void {
  const report = makeReport();
  const json = JSON.stringify(report);
  const parsed = JSON.parse(json) as WeaknessReport;

  assert(parsed.report_id === report.report_id, 'report_id should round-trip');
  assert(parsed.agent_name === report.agent_name, 'agent_name should round-trip');
  assert(parsed.agent_version === report.agent_version, 'agent_version should round-trip');
  assert(parsed.analysis_date === report.analysis_date, 'analysis_date should round-trip');
  assert(parsed.overall_assessment === report.overall_assessment, 'overall_assessment should round-trip');
  assert(parsed.weaknesses.length === 1, 'weaknesses should round-trip');
  assert(parsed.strengths.length === 2, 'strengths should round-trip');
  assert(parsed.recommendation === report.recommendation, 'recommendation should round-trip');
  assert(parsed.metrics_summary.invocation_count === 25, 'metrics_summary should round-trip');

  console.log('PASS: test_weakness_report_serialization');
}

function test_weakness_report_append_to_jsonl(): void {
  const tmpDir = makeTempDir();
  try {
    const filePath = path.join(tmpDir, 'reports.jsonl');
    const store = new WeaknessReportStore(filePath, silentLogger);

    const report1 = makeReport({ report_id: 'report-1' });
    const report2 = makeReport({ report_id: 'report-2', agent_name: 'prd-author' });

    store.append(report1);
    store.append(report2);

    // Verify file has exactly 2 non-empty lines
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    assert(lines.length === 2, `should have 2 lines, got ${lines.length}`);

    // Both lines should be parseable
    const parsed1 = JSON.parse(lines[0]) as WeaknessReport;
    const parsed2 = JSON.parse(lines[1]) as WeaknessReport;
    assert(parsed1.report_id === 'report-1', 'first report should parse correctly');
    assert(parsed2.report_id === 'report-2', 'second report should parse correctly');

    console.log('PASS: test_weakness_report_append_to_jsonl');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_weakness_report_query_by_agent(): void {
  const tmpDir = makeTempDir();
  try {
    const filePath = path.join(tmpDir, 'reports.jsonl');
    const store = new WeaknessReportStore(filePath, silentLogger);

    // Write 3 reports for code-executor, 2 for prd-author
    store.append(makeReport({ report_id: 'ce-1', agent_name: 'code-executor' }));
    store.append(makeReport({ report_id: 'ce-2', agent_name: 'code-executor' }));
    store.append(makeReport({ report_id: 'pa-1', agent_name: 'prd-author' }));
    store.append(makeReport({ report_id: 'ce-3', agent_name: 'code-executor' }));
    store.append(makeReport({ report_id: 'pa-2', agent_name: 'prd-author' }));

    // Query for code-executor
    const ceReports = store.getReports('code-executor');
    assert(ceReports.length === 3, `expected 3 code-executor reports, got ${ceReports.length}`);

    // Query for prd-author
    const paReports = store.getReports('prd-author');
    assert(paReports.length === 2, `expected 2 prd-author reports, got ${paReports.length}`);

    // Query all
    const allReports = store.getReports();
    assert(allReports.length === 5, `expected 5 total reports, got ${allReports.length}`);

    console.log('PASS: test_weakness_report_query_by_agent');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_weakness_report_all_fields_present(): void {
  const report = makeReport();
  const json = JSON.stringify(report);
  const parsed = JSON.parse(json);

  // Top-level fields
  const requiredFields = [
    'report_id',
    'agent_name',
    'agent_version',
    'analysis_date',
    'overall_assessment',
    'weaknesses',
    'strengths',
    'recommendation',
    'metrics_summary',
  ];

  for (const field of requiredFields) {
    assert(field in parsed, `missing required field: ${field}`);
    assert(parsed[field] !== undefined, `field ${field} should not be undefined`);
    assert(parsed[field] !== null, `field ${field} should not be null`);
  }

  // Weakness sub-fields
  const weakness = parsed.weaknesses[0];
  const weaknessFields = [
    'dimension',
    'severity',
    'evidence',
    'affected_domains',
    'suggested_focus',
  ];

  for (const field of weaknessFields) {
    assert(field in weakness, `missing weakness field: ${field}`);
  }

  // MetricsSummary sub-fields
  const summary = parsed.metrics_summary;
  const summaryFields = [
    'invocation_count',
    'approval_rate',
    'avg_quality_score',
    'trend_direction',
    'active_alerts',
  ];

  for (const field of summaryFields) {
    assert(field in summary, `missing metrics_summary field: ${field}`);
  }

  console.log('PASS: test_weakness_report_all_fields_present');
}

function test_weakness_severity_enum(): void {
  const validSeverities: WeaknessSeverity[] = ['low', 'medium', 'high'];

  for (const severity of validSeverities) {
    const weakness: Weakness = {
      dimension: 'test',
      severity,
      evidence: 'test evidence',
      affected_domains: [],
      suggested_focus: 'test focus',
    };
    assert(weakness.severity === severity, `severity ${severity} should be accepted`);
  }

  // Verify the type system would only accept these values
  // (runtime check: confirm the valid set matches spec)
  assert(validSeverities.length === 3, 'exactly 3 severity levels');
  assert(validSeverities.includes('low'), 'should include low');
  assert(validSeverities.includes('medium'), 'should include medium');
  assert(validSeverities.includes('high'), 'should include high');

  console.log('PASS: test_weakness_severity_enum');
}

function test_overall_assessment_enum(): void {
  const validAssessments: OverallAssessment[] = [
    'healthy',
    'needs_improvement',
    'critical',
  ];

  for (const assessment of validAssessments) {
    const report = makeReport({ overall_assessment: assessment });
    assert(
      report.overall_assessment === assessment,
      `assessment ${assessment} should be accepted`,
    );
  }

  assert(validAssessments.length === 3, 'exactly 3 assessment levels');
  assert(validAssessments.includes('healthy'), 'should include healthy');
  assert(validAssessments.includes('needs_improvement'), 'should include needs_improvement');
  assert(validAssessments.includes('critical'), 'should include critical');

  console.log('PASS: test_overall_assessment_enum');
}

function test_recommendation_enum(): void {
  const validRecs: Recommendation[] = [
    'no_action',
    'propose_modification',
    'propose_specialist',
  ];

  for (const rec of validRecs) {
    const report = makeReport({ recommendation: rec });
    assert(
      report.recommendation === rec,
      `recommendation ${rec} should be accepted`,
    );
  }

  assert(validRecs.length === 3, 'exactly 3 recommendation types');
  assert(validRecs.includes('no_action'), 'should include no_action');
  assert(validRecs.includes('propose_modification'), 'should include propose_modification');
  assert(validRecs.includes('propose_specialist'), 'should include propose_specialist');

  console.log('PASS: test_recommendation_enum');
}

function test_malformed_lines_skipped(): void {
  const tmpDir = makeTempDir();
  try {
    const filePath = path.join(tmpDir, 'reports.jsonl');

    // Write a valid report, then a malformed line, then another valid report
    const report1 = makeReport({ report_id: 'valid-1' });
    const report2 = makeReport({ report_id: 'valid-2' });

    fs.writeFileSync(
      filePath,
      JSON.stringify(report1) + '\n' +
      'this is not valid json\n' +
      JSON.stringify(report2) + '\n',
      'utf-8',
    );

    const warnings: string[] = [];
    const store = new WeaknessReportStore(filePath, {
      info: () => {},
      warn: (msg) => { warnings.push(msg); },
    });

    const reports = store.getReports();
    assert(reports.length === 2, `should return 2 valid reports, got ${reports.length}`);
    assert(reports[0].report_id === 'valid-1', 'first report should be valid-1');
    assert(reports[1].report_id === 'valid-2', 'second report should be valid-2');
    assert(warnings.length === 1, `should have 1 warning, got ${warnings.length}`);

    console.log('PASS: test_malformed_lines_skipped');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_nonexistent_file_returns_empty(): void {
  const tmpDir = makeTempDir();
  try {
    const filePath = path.join(tmpDir, 'nonexistent', 'reports.jsonl');
    const store = new WeaknessReportStore(filePath, silentLogger);

    const reports = store.getReports();
    assert(reports.length === 0, 'should return empty array for nonexistent file');

    const filtered = store.getReports('anything');
    assert(filtered.length === 0, 'filtered query should also return empty');

    console.log('PASS: test_nonexistent_file_returns_empty');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_creates_parent_directory_on_write(): void {
  const tmpDir = makeTempDir();
  try {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'reports.jsonl');
    const store = new WeaknessReportStore(filePath, silentLogger);

    store.append(makeReport());

    assert(fs.existsSync(filePath), 'JSONL file should exist after write');
    const reports = store.getReports();
    assert(reports.length === 1, 'should contain 1 report');

    console.log('PASS: test_creates_parent_directory_on_write');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_example_from_spec(): void {
  // Verify the exact example from the spec can be parsed
  const specExample = '{"report_id":"a1b2c3d4-...","agent_name":"code-executor","agent_version":"1.0.0","analysis_date":"2026-04-08T10:00:00.000Z","overall_assessment":"needs_improvement","weaknesses":[{"dimension":"test-coverage","severity":"medium","evidence":"Average test-coverage score is 2.8/5.0, 1.2 below median. Decline of 0.4 over last 15 invocations.","affected_domains":["python"],"suggested_focus":"Emphasize test generation for non-TypeScript domains"}],"strengths":["correctness score stable at 4.2","spec-adherence consistently above 4.0"],"recommendation":"propose_modification","metrics_summary":{"invocation_count":25,"approval_rate":0.80,"avg_quality_score":3.6,"trend_direction":"declining","active_alerts":1}}';

  const parsed = JSON.parse(specExample) as WeaknessReport;
  assert(parsed.report_id === 'a1b2c3d4-...', 'report_id from spec example');
  assert(parsed.agent_name === 'code-executor', 'agent_name from spec example');
  assert(parsed.overall_assessment === 'needs_improvement', 'overall_assessment from spec example');
  assert(parsed.weaknesses.length === 1, 'weaknesses count from spec example');
  assert(parsed.weaknesses[0].dimension === 'test-coverage', 'weakness dimension from spec example');
  assert(parsed.recommendation === 'propose_modification', 'recommendation from spec example');
  assert(parsed.metrics_summary.invocation_count === 25, 'invocation_count from spec example');

  console.log('PASS: test_example_from_spec');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_weakness_report_serialization,
  test_weakness_report_append_to_jsonl,
  test_weakness_report_query_by_agent,
  test_weakness_report_all_fields_present,
  test_weakness_severity_enum,
  test_overall_assessment_enum,
  test_recommendation_enum,
  test_malformed_lines_skipped,
  test_nonexistent_file_returns_empty,
  test_creates_parent_directory_on_write,
  test_example_from_spec,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
  } catch (err) {
    console.log(`FAIL: ${test.name} -- ${err}`);
    failed++;
  }
}

console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
