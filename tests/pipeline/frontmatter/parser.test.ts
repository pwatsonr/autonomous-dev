import { parseFrontmatter, FrontmatterParseError } from '../../../src/pipeline/frontmatter/parser';

/**
 * Unit tests for parseFrontmatter (SPEC-003-1-03, Task 6b).
 */

// ---------------------------------------------------------------------------
// Helper: build a complete valid frontmatter document
// ---------------------------------------------------------------------------
function validDocument(body?: string): string {
  const fm = [
    '---',
    'id: PRD-001',
    'title: Test Document',
    'pipeline_id: PIPE-2026-0408-001',
    'type: PRD',
    'status: draft',
    'version: 1.0',
    'created_at: 2026-04-08T10:00:00Z',
    'updated_at: 2026-04-08T10:00:00Z',
    'author_agent: agent-planner-v1',
    'parent_id: null',
    'traces_from: []',
    'traces_to: []',
    'depth: 0',
    'sibling_index: 0',
    'sibling_count: 1',
    'depends_on: []',
    'dependency_type: []',
    'execution_mode: parallel',
    'priority: normal',
    '---',
  ].join('\n');

  if (body !== undefined) {
    return fm + '\n' + body;
  }
  return fm + '\n';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_parses_valid_frontmatter_with_all_fields(): void {
  const content = validDocument('# Body');
  const result = parseFrontmatter(content);

  assert(result.frontmatter.id === 'PRD-001', `id should be PRD-001, got ${result.frontmatter.id}`);
  assert(result.frontmatter.title === 'Test Document', `title mismatch`);
  assert(result.frontmatter.pipeline_id === 'PIPE-2026-0408-001', `pipeline_id mismatch`);
  assert(result.frontmatter.type === 'PRD', `type mismatch`);
  assert(result.frontmatter.status === 'draft', `status mismatch`);
  assert(result.frontmatter.version === '1.0', `version mismatch`);
  assert(result.frontmatter.depth === 0, `depth should be 0, got ${result.frontmatter.depth}`);
  assert(result.frontmatter.sibling_index === 0, `sibling_index should be 0`);
  assert(result.frontmatter.sibling_count === 1, `sibling_count should be 1`);
  assert(result.frontmatter.parent_id === null, `parent_id should be null`);
  assert(result.frontmatter.execution_mode === 'parallel', `execution_mode mismatch`);
  assert(result.frontmatter.priority === 'normal', `priority mismatch`);
  assert(Array.isArray(result.frontmatter.traces_from), `traces_from should be array`);
  assert(Array.isArray(result.frontmatter.traces_to), `traces_to should be array`);
  assert(Array.isArray(result.frontmatter.depends_on), `depends_on should be array`);
  assert(Array.isArray(result.frontmatter.dependency_type), `dependency_type should be array`);
  console.log('PASS: parses valid frontmatter with all fields');
}

function test_returns_body_after_frontmatter(): void {
  const content = validDocument('# Heading\n\nSome body content.');
  const result = parseFrontmatter(content);

  assert(result.body === '# Heading\n\nSome body content.', `body mismatch: "${result.body}"`);
  console.log('PASS: returns body after frontmatter');
}

function test_throws_no_frontmatter_when_no_delimiter(): void {
  const content = '# Just a heading\n\nNo frontmatter here.';
  try {
    parseFrontmatter(content);
    assert(false, 'Should have thrown');
  } catch (err) {
    assertParseError(err, 'NO_FRONTMATTER');
  }
  console.log('PASS: throws NO_FRONTMATTER when document has no --- delimiter');
}

function test_throws_empty_frontmatter(): void {
  const content = '---\n---\n# Body';
  try {
    parseFrontmatter(content);
    assert(false, 'Should have thrown');
  } catch (err) {
    assertParseError(err, 'EMPTY_FRONTMATTER');
  }
  console.log('PASS: throws EMPTY_FRONTMATTER when --- immediately followed by ---');
}

function test_throws_malformed_yaml(): void {
  const content = '---\n: no key here\n---\n';
  try {
    parseFrontmatter(content);
    assert(false, 'Should have thrown');
  } catch (err) {
    assertParseError(err, 'MALFORMED_YAML');
  }
  console.log('PASS: throws MALFORMED_YAML for invalid YAML syntax');
}

function test_handles_frontmatter_no_body(): void {
  const content = '---\nid: PRD-001\ntitle: Test\n---';
  const result = parseFrontmatter(content);

  assert(result.body === '', `body should be empty string, got "${result.body}"`);
  assert(result.frontmatter.id === 'PRD-001', `id mismatch`);
  console.log('PASS: handles document with frontmatter but no body');
}

function test_handles_multiline_yaml_strings(): void {
  const content = '---\nid: PRD-001\ntitle: A document with many words in the title\nversion: 1.0\n---\n';
  const result = parseFrontmatter(content);

  assert(result.frontmatter.title === 'A document with many words in the title', `title mismatch`);
  console.log('PASS: handles multiline YAML strings in frontmatter');
}

function test_preserves_raw_yaml(): void {
  const rawYaml = 'id: PRD-001\ntitle: Test\n';
  const content = '---\n' + rawYaml + '---\n# Body';
  const result = parseFrontmatter(content);

  assert(result.rawYaml === rawYaml, `rawYaml mismatch: "${result.rawYaml}"`);
  console.log('PASS: preserves raw YAML string in result');
}

function test_handles_windows_line_endings(): void {
  const content = '---\r\nid: PRD-001\r\ntitle: Test\r\n---\r\n# Body\r\n';
  const result = parseFrontmatter(content);

  assert(result.frontmatter.id === 'PRD-001', `id mismatch`);
  assert(result.frontmatter.title === 'Test', `title mismatch`);
  console.log('PASS: handles Windows line endings (CRLF)');
}

function test_handles_special_characters(): void {
  const content = '---\nid: PRD-001\ntitle: "Special: chars [in] title, yes"\nversion: 1.0\n---\n';
  const result = parseFrontmatter(content);

  assert(result.frontmatter.title === 'Special: chars [in] title, yes', `title mismatch: ${result.frontmatter.title}`);
  console.log('PASS: handles frontmatter with special characters');
}

function test_preserves_raw_content(): void {
  const content = validDocument('# Body');
  const result = parseFrontmatter(content);

  assert(result.rawContent === content, `rawContent should match input`);
  console.log('PASS: preserves rawContent');
}

function test_parses_arrays_with_values(): void {
  const content = '---\nid: TDD-001-01\ntitle: Test\ntraces_from: [section-1, section-2]\ndepends_on: [TDD-001-02]\n---\n';
  const result = parseFrontmatter(content);

  const tracesFrom = result.frontmatter.traces_from as string[];
  assert(Array.isArray(tracesFrom), `traces_from should be array`);
  assert(tracesFrom.length === 2, `traces_from should have 2 items, got ${tracesFrom.length}`);
  assert(tracesFrom[0] === 'section-1', `first traces_from item mismatch`);
  assert(tracesFrom[1] === 'section-2', `second traces_from item mismatch`);
  console.log('PASS: parses arrays with values');
}

function test_no_closing_delimiter(): void {
  const content = '---\nid: PRD-001\ntitle: Test\n';
  try {
    parseFrontmatter(content);
    assert(false, 'Should have thrown');
  } catch (err) {
    assertParseError(err, 'NO_FRONTMATTER');
  }
  console.log('PASS: throws NO_FRONTMATTER when no closing delimiter');
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertParseError(err: unknown, expectedCode: string): void {
  assert(err instanceof FrontmatterParseError, `Expected FrontmatterParseError, got ${err}`);
  const parseErr = err as FrontmatterParseError;
  assert(
    parseErr.code === expectedCode,
    `Expected code '${expectedCode}', got '${parseErr.code}'`,
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_parses_valid_frontmatter_with_all_fields,
  test_returns_body_after_frontmatter,
  test_throws_no_frontmatter_when_no_delimiter,
  test_throws_empty_frontmatter,
  test_throws_malformed_yaml,
  test_handles_frontmatter_no_body,
  test_handles_multiline_yaml_strings,
  test_preserves_raw_yaml,
  test_handles_windows_line_endings,
  test_handles_special_characters,
  test_preserves_raw_content,
  test_parses_arrays_with_values,
  test_no_closing_delimiter,
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
