import { validateFrontmatter } from '../../../src/pipeline/frontmatter/validator';
import { DocumentFrontmatter } from '../../../src/pipeline/types/frontmatter';
import { DocumentType } from '../../../src/pipeline/types/document-type';

/**
 * Unit tests for validateFrontmatter (SPEC-003-1-03, Task 7).
 */

// ---------------------------------------------------------------------------
// Helper: build a complete, valid frontmatter object
// ---------------------------------------------------------------------------
function validFrontmatter(
  overrides?: Partial<DocumentFrontmatter>,
): Partial<DocumentFrontmatter> {
  const base: DocumentFrontmatter = {
    id: 'PRD-001',
    title: 'Test Document',
    pipeline_id: 'PIPE-2026-0408-001',
    type: DocumentType.PRD,
    status: 'draft',
    version: '1.0',
    created_at: '2026-04-08T10:00:00Z',
    updated_at: '2026-04-08T10:00:00Z',
    author_agent: 'agent-planner-v1',
    parent_id: null,
    traces_from: [],
    traces_to: [],
    depth: 0,
    sibling_index: 0,
    sibling_count: 1,
    depends_on: [],
    dependency_type: [],
    execution_mode: 'parallel',
    priority: 'normal',
  };
  return { ...base, ...overrides };
}

function validChildFrontmatter(
  overrides?: Partial<DocumentFrontmatter>,
): Partial<DocumentFrontmatter> {
  return validFrontmatter({
    id: 'TDD-001-01',
    type: DocumentType.TDD,
    depth: 1,
    parent_id: 'PRD-001',
    traces_from: ['section-1'],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function test_returns_valid_for_complete_frontmatter(): void {
  const result = validateFrontmatter(validFrontmatter());
  assert(result.valid === true, `expected valid=true, got valid=${result.valid}`);
  assert(result.errors.length === 0, `expected 0 errors, got ${result.errors.length}: ${JSON.stringify(result.errors)}`);
  console.log('PASS: returns valid for complete, correct frontmatter');
}

function test_returns_error_for_each_missing_required_field(): void {
  const requiredFields: (keyof DocumentFrontmatter)[] = [
    'id', 'title', 'pipeline_id', 'type', 'status', 'version',
    'created_at', 'updated_at', 'author_agent', 'depth',
    'sibling_index', 'sibling_count', 'execution_mode', 'priority',
  ];

  for (const field of requiredFields) {
    const fm = validFrontmatter();
    delete (fm as Record<string, unknown>)[field];
    const result = validateFrontmatter(fm);

    const fieldError = result.errors.find(
      (e) => e.field === field && e.code === 'REQUIRED_FIELD_MISSING',
    );
    assert(
      fieldError !== undefined,
      `Missing required field '${field}' should produce REQUIRED_FIELD_MISSING error`,
    );
  }
  console.log('PASS: returns error for each missing required field');
}

function test_returns_error_when_id_does_not_match_regex(): void {
  const result = validateFrontmatter(validFrontmatter({ id: 'INVALID-ID' }));
  const idError = result.errors.find((e) => e.field === 'id' && e.code === 'INVALID_FORMAT');
  assert(idError !== undefined, `Invalid id should produce INVALID_FORMAT error`);
  console.log('PASS: returns error when id does not match regex pattern');
}

function test_returns_error_when_pipeline_id_does_not_match_regex(): void {
  const result = validateFrontmatter(validFrontmatter({ pipeline_id: 'BAD-PIPE' }));
  const pipeError = result.errors.find((e) => e.field === 'pipeline_id' && e.code === 'INVALID_FORMAT');
  assert(pipeError !== undefined, `Invalid pipeline_id should produce INVALID_FORMAT error`);
  console.log('PASS: returns error when pipeline_id does not match regex');
}

function test_returns_error_when_version_does_not_match_regex(): void {
  const result = validateFrontmatter(validFrontmatter({ version: 'v1' }));
  const versionError = result.errors.find((e) => e.field === 'version' && e.code === 'INVALID_FORMAT');
  assert(versionError !== undefined, `Invalid version should produce INVALID_FORMAT error`);
  console.log('PASS: returns error when version does not match regex');
}

function test_returns_error_when_type_is_invalid(): void {
  const fm = validFrontmatter();
  (fm as Record<string, unknown>).type = 'INVALID';
  const result = validateFrontmatter(fm);
  const typeError = result.errors.find((e) => e.field === 'type' && e.code === 'INVALID_ENUM');
  assert(typeError !== undefined, `Invalid type should produce INVALID_ENUM error`);
  console.log('PASS: returns error when type is not a valid DocumentType');
}

function test_returns_error_when_status_is_invalid(): void {
  const fm = validFrontmatter();
  (fm as Record<string, unknown>).status = 'INVALID';
  const result = validateFrontmatter(fm);
  const statusError = result.errors.find((e) => e.field === 'status' && e.code === 'INVALID_ENUM');
  assert(statusError !== undefined, `Invalid status should produce INVALID_ENUM error`);
  console.log('PASS: returns error when status is not a valid DocumentStatus');
}

function test_returns_error_when_depth_does_not_match_type(): void {
  const fm = validFrontmatter({ depth: 2 }); // PRD should be depth 0
  const result = validateFrontmatter(fm);
  const depthError = result.errors.find((e) => e.field === 'depth' && e.code === 'DEPTH_TYPE_MISMATCH');
  assert(depthError !== undefined, `Depth/type mismatch should produce DEPTH_TYPE_MISMATCH error`);
  console.log('PASS: returns error when depth does not match type');
}

function test_returns_error_when_updated_at_before_created_at(): void {
  const fm = validFrontmatter({
    created_at: '2026-04-08T12:00:00Z',
    updated_at: '2026-04-08T10:00:00Z',
  });
  const result = validateFrontmatter(fm);
  const tsError = result.errors.find((e) => e.field === 'updated_at' && e.code === 'TIMESTAMP_ORDER');
  assert(tsError !== undefined, `updated_at < created_at should produce TIMESTAMP_ORDER error`);
  console.log('PASS: returns error when updated_at < created_at');
}

function test_returns_error_when_depends_on_length_mismatch(): void {
  const fm = validFrontmatter({
    depends_on: ['TDD-001-02'],
    dependency_type: [],
  });
  const result = validateFrontmatter(fm);
  const lenError = result.errors.find((e) => e.field === 'dependency_type' && e.code === 'ARRAY_LENGTH_MISMATCH');
  assert(lenError !== undefined, `Length mismatch should produce ARRAY_LENGTH_MISMATCH error`);
  console.log('PASS: returns error when depends_on.length !== dependency_type.length');
}

function test_returns_error_when_sibling_index_gte_count(): void {
  const fm = validFrontmatter({
    sibling_index: 3,
    sibling_count: 3,
  });
  const result = validateFrontmatter(fm);
  const sibError = result.errors.find((e) => e.field === 'sibling_index' && e.code === 'SIBLING_INDEX_OUT_OF_RANGE');
  assert(sibError !== undefined, `sibling_index >= sibling_count should produce error`);
  console.log('PASS: returns error when sibling_index >= sibling_count');
}

function test_returns_error_when_parent_id_null_and_depth_gt_0(): void {
  const fm = validChildFrontmatter({ parent_id: null });
  const result = validateFrontmatter(fm);
  const parentError = result.errors.find((e) => e.field === 'parent_id' && e.code === 'PARENT_ID_REQUIRED');
  assert(parentError !== undefined, `null parent_id at depth > 0 should produce PARENT_ID_REQUIRED error`);
  console.log('PASS: returns error when parent_id is null and depth > 0');
}

function test_returns_error_when_parent_id_nonnull_and_depth_0(): void {
  const fm = validFrontmatter({ parent_id: 'PRD-001' });
  const result = validateFrontmatter(fm);
  const parentError = result.errors.find((e) => e.field === 'parent_id' && e.code === 'PARENT_ID_DEPTH_MISMATCH');
  assert(parentError !== undefined, `non-null parent_id at depth 0 should produce PARENT_ID_DEPTH_MISMATCH error`);
  console.log('PASS: returns error when parent_id is non-null and depth === 0');
}

function test_returns_warning_for_unknown_fields(): void {
  const fm = validFrontmatter();
  (fm as Record<string, unknown>).custom_field = 'some value';
  const result = validateFrontmatter(fm);
  const unknownWarning = result.warnings.find((w) => w.field === 'custom_field' && w.code === 'UNKNOWN_FIELD');
  assert(unknownWarning !== undefined, `Unknown field should produce UNKNOWN_FIELD warning`);
  // Unknown fields should not cause validation failure
  assert(result.valid === true, `Unknown fields should not block validation`);
  console.log('PASS: returns warning for unknown fields');
}

function test_returns_error_when_traces_from_empty_for_depth_gt_0(): void {
  const fm = validChildFrontmatter({ traces_from: [] });
  const result = validateFrontmatter(fm);
  const tracesError = result.errors.find((e) => e.field === 'traces_from' && e.code === 'TRACES_FROM_REQUIRED');
  assert(tracesError !== undefined, `Empty traces_from at depth > 0 should produce TRACES_FROM_REQUIRED error`);
  console.log('PASS: returns error when traces_from is empty for depth > 0');
}

function test_valid_child_document(): void {
  const fm = validChildFrontmatter();
  const result = validateFrontmatter(fm);
  assert(result.valid === true, `Valid child should pass: ${JSON.stringify(result.errors)}`);
  console.log('PASS: returns valid for complete child document');
}

function test_accepts_all_valid_statuses(): void {
  const statuses = ['draft', 'in-review', 'approved', 'revision-requested', 'rejected', 'cancelled', 'stale'] as const;
  for (const status of statuses) {
    const fm = validFrontmatter({ status });
    const result = validateFrontmatter(fm);
    const statusError = result.errors.find((e) => e.field === 'status');
    assert(statusError === undefined, `Status '${status}' should be valid`);
  }
  console.log('PASS: accepts all valid statuses');
}

function test_accepts_all_valid_priorities(): void {
  const priorities = ['critical', 'high', 'normal', 'low'] as const;
  for (const priority of priorities) {
    const fm = validFrontmatter({ priority });
    const result = validateFrontmatter(fm);
    const priorityError = result.errors.find((e) => e.field === 'priority');
    assert(priorityError === undefined, `Priority '${priority}' should be valid`);
  }
  console.log('PASS: accepts all valid priorities');
}

function test_accepts_all_valid_execution_modes(): void {
  const modes = ['parallel', 'sequential'] as const;
  for (const mode of modes) {
    const fm = validFrontmatter({ execution_mode: mode });
    const result = validateFrontmatter(fm);
    const modeError = result.errors.find((e) => e.field === 'execution_mode');
    assert(modeError === undefined, `Execution mode '${mode}' should be valid`);
  }
  console.log('PASS: accepts all valid execution modes');
}

function test_valid_id_formats(): void {
  const validIds = ['PRD-001', 'TDD-001-01', 'PLAN-999', 'SPEC-123-99', 'CODE-001-01'];
  for (const id of validIds) {
    const fm = validFrontmatter({ id });
    const result = validateFrontmatter(fm);
    const idError = result.errors.find((e) => e.field === 'id' && e.code === 'INVALID_FORMAT');
    assert(idError === undefined, `ID '${id}' should be valid`);
  }
  console.log('PASS: accepts all valid ID formats');
}

function test_invalid_id_formats(): void {
  const invalidIds = ['PRD-01', 'TDD-0001', 'PRD-001-001', 'TASK-001', 'prd-001', ''];
  for (const id of invalidIds) {
    const fm = validFrontmatter({ id });
    const result = validateFrontmatter(fm);
    const idError = result.errors.find((e) => e.field === 'id' && e.code === 'INVALID_FORMAT');
    assert(idError !== undefined, `ID '${id}' should be invalid`);
  }
  console.log('PASS: rejects invalid ID formats');
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  test_returns_valid_for_complete_frontmatter,
  test_returns_error_for_each_missing_required_field,
  test_returns_error_when_id_does_not_match_regex,
  test_returns_error_when_pipeline_id_does_not_match_regex,
  test_returns_error_when_version_does_not_match_regex,
  test_returns_error_when_type_is_invalid,
  test_returns_error_when_status_is_invalid,
  test_returns_error_when_depth_does_not_match_type,
  test_returns_error_when_updated_at_before_created_at,
  test_returns_error_when_depends_on_length_mismatch,
  test_returns_error_when_sibling_index_gte_count,
  test_returns_error_when_parent_id_null_and_depth_gt_0,
  test_returns_error_when_parent_id_nonnull_and_depth_0,
  test_returns_warning_for_unknown_fields,
  test_returns_error_when_traces_from_empty_for_depth_gt_0,
  test_valid_child_document,
  test_accepts_all_valid_statuses,
  test_accepts_all_valid_priorities,
  test_accepts_all_valid_execution_modes,
  test_valid_id_formats,
  test_invalid_id_formats,
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
