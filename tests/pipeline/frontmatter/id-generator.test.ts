import {
  generateDocumentId,
  InMemoryIdCounter,
} from '../../../src/pipeline/frontmatter/id-generator';
import { DocumentType } from '../../../src/pipeline/types/document-type';

/**
 * Unit tests for generateDocumentId and InMemoryIdCounter (SPEC-003-1-03, Task 8).
 */

const PIPELINE_ID = 'PIPE-2026-0408-001';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test_generates_prd_id_as_prd_seq_format(): Promise<void> {
  const counter = new InMemoryIdCounter();
  const id = await generateDocumentId(DocumentType.PRD, PIPELINE_ID, counter);
  assert(id === 'PRD-001', `Expected PRD-001, got ${id}`);
  console.log('PASS: generates PRD ID as PRD-{SEQ} format');
}

async function test_generates_tdd_id_as_tdd_seq_docseq_format(): Promise<void> {
  const counter = new InMemoryIdCounter();
  const id = await generateDocumentId(DocumentType.TDD, PIPELINE_ID, counter);
  assert(id === 'TDD-001-01', `Expected TDD-001-01, got ${id}`);
  console.log('PASS: generates TDD ID as TDD-{SEQ}-{DOC_SEQ} format');
}

async function test_generates_plan_spec_code_ids(): Promise<void> {
  const counter = new InMemoryIdCounter();

  const planId = await generateDocumentId(DocumentType.PLAN, PIPELINE_ID, counter);
  assert(planId === 'PLAN-001-01', `Expected PLAN-001-01, got ${planId}`);

  const specId = await generateDocumentId(DocumentType.SPEC, PIPELINE_ID, counter);
  assert(specId === 'SPEC-001-01', `Expected SPEC-001-01, got ${specId}`);

  const codeId = await generateDocumentId(DocumentType.CODE, PIPELINE_ID, counter);
  assert(codeId === 'CODE-001-01', `Expected CODE-001-01, got ${codeId}`);

  console.log('PASS: generates PLAN, SPEC, CODE IDs correctly');
}

async function test_sequential_calls_produce_incrementing_sequences(): Promise<void> {
  const counter = new InMemoryIdCounter();

  const id1 = await generateDocumentId(DocumentType.TDD, PIPELINE_ID, counter);
  const id2 = await generateDocumentId(DocumentType.TDD, PIPELINE_ID, counter);
  const id3 = await generateDocumentId(DocumentType.TDD, PIPELINE_ID, counter);

  assert(id1 === 'TDD-001-01', `Expected TDD-001-01, got ${id1}`);
  assert(id2 === 'TDD-001-02', `Expected TDD-001-02, got ${id2}`);
  assert(id3 === 'TDD-001-03', `Expected TDD-001-03, got ${id3}`);

  console.log('PASS: sequential calls produce incrementing document sequences');
}

async function test_different_types_have_independent_counters(): Promise<void> {
  const counter = new InMemoryIdCounter();

  const tdd1 = await generateDocumentId(DocumentType.TDD, PIPELINE_ID, counter);
  const spec1 = await generateDocumentId(DocumentType.SPEC, PIPELINE_ID, counter);
  const tdd2 = await generateDocumentId(DocumentType.TDD, PIPELINE_ID, counter);
  const spec2 = await generateDocumentId(DocumentType.SPEC, PIPELINE_ID, counter);

  assert(tdd1 === 'TDD-001-01', `Expected TDD-001-01, got ${tdd1}`);
  assert(spec1 === 'SPEC-001-01', `Expected SPEC-001-01, got ${spec1}`);
  assert(tdd2 === 'TDD-001-02', `Expected TDD-001-02, got ${tdd2}`);
  assert(spec2 === 'SPEC-001-02', `Expected SPEC-001-02, got ${spec2}`);

  console.log('PASS: different types have independent counters');
}

async function test_pads_sequences_with_leading_zeros(): Promise<void> {
  const counter = new InMemoryIdCounter();
  const id = await generateDocumentId(DocumentType.TDD, PIPELINE_ID, counter);

  // Should be zero-padded to 2 digits
  assert(id === 'TDD-001-01', `Expected TDD-001-01, got ${id}`);

  // Pipeline seq should be zero-padded to 3 digits (from pipeline ID)
  const pipelineId2 = 'PIPE-2026-0408-042';
  const counter2 = new InMemoryIdCounter();
  const id2 = await generateDocumentId(DocumentType.SPEC, pipelineId2, counter2);
  assert(id2 === 'SPEC-042-01', `Expected SPEC-042-01, got ${id2}`);

  console.log('PASS: pads sequences with leading zeros');
}

async function test_in_memory_counter_starts_at_1(): Promise<void> {
  const counter = new InMemoryIdCounter();
  const val = await counter.next('test-scope');
  assert(val === 1, `Expected first value to be 1, got ${val}`);

  const val2 = await counter.next('test-scope');
  assert(val2 === 2, `Expected second value to be 2, got ${val2}`);

  // Different scope starts at 1
  const val3 = await counter.next('other-scope');
  assert(val3 === 1, `Expected first value of new scope to be 1, got ${val3}`);

  console.log('PASS: InMemoryIdCounter starts at 1');
}

async function test_no_collisions_across_10000_ids(): Promise<void> {
  const counter = new InMemoryIdCounter();
  const ids = new Set<string>();
  const types = [DocumentType.TDD, DocumentType.PLAN, DocumentType.SPEC, DocumentType.CODE];

  for (let i = 0; i < 2500; i++) {
    for (const type of types) {
      const id = await generateDocumentId(type, PIPELINE_ID, counter);
      assert(!ids.has(id), `Collision detected: ${id}`);
      ids.add(id);
    }
  }

  assert(ids.size === 10000, `Expected 10000 unique IDs, got ${ids.size}`);
  console.log('PASS: no collisions across 10,000 generated IDs');
}

async function test_extracts_pipe_seq_from_various_pipeline_ids(): Promise<void> {
  const counter = new InMemoryIdCounter();

  const id1 = await generateDocumentId(DocumentType.TDD, 'PIPE-2026-0408-001', counter);
  assert(id1 === 'TDD-001-01', `Expected TDD-001-01, got ${id1}`);

  const counter2 = new InMemoryIdCounter();
  const id2 = await generateDocumentId(DocumentType.TDD, 'PIPE-2026-0101-999', counter2);
  assert(id2 === 'TDD-999-01', `Expected TDD-999-01, got ${id2}`);

  console.log('PASS: extracts pipe_seq from various pipeline IDs');
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

const tests: Array<() => Promise<void>> = [
  test_generates_prd_id_as_prd_seq_format,
  test_generates_tdd_id_as_tdd_seq_docseq_format,
  test_generates_plan_spec_code_ids,
  test_sequential_calls_produce_incrementing_sequences,
  test_different_types_have_independent_counters,
  test_pads_sequences_with_leading_zeros,
  test_in_memory_counter_starts_at_1,
  test_no_collisions_across_10000_ids,
  test_extracts_pipe_seq_from_various_pipeline_ids,
];

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.log(`FAIL: ${test.name} -- ${err}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
