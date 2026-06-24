import {
  enqueueQuestion,
  answerQuestion,
  listQuestions,
  isRepoBlocked,
  loadQuestions,
  questionsPath,
} from '../../src/ingest/questions';
import type { QuestionStoreIO } from '../../src/ingest/questions';

/**
 * Unit tests for the blocking-question queue (ONBOARD Phase 1, #587, AC3).
 * Injected fake IO — never touches operator state.
 */

function fakeIO(): QuestionStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
  };
}

function test_enqueue_blocks_and_answer_unblocks(): void {
  const io = fakeIO();
  enqueueQuestion(
    { id: 'q1', repoId: 'acme/api', question: 'Which project?', options: ['payments', 'identity'] },
    io,
  );
  // pending question => repo blocked (AC3: ingestion pauses)
  assert(isRepoBlocked('acme/api', io) === true, 'repo blocked while pending');
  assert(listQuestions(io, { status: 'pending' }).length === 1, 'one pending');

  // answer with a valid option => answered + unblocked
  const answered = answerQuestion('q1', 'payments', io);
  assert(answered.status === 'answered' && answered.answer === 'payments', 'answered + answer set');
  assert(isRepoBlocked('acme/api', io) === false, 'repo unblocked after answer');
  assert(listQuestions(io, { status: 'pending' }).length === 0, 'no pending after answer');
  console.log('PASS: test_enqueue_blocks_and_answer_unblocks');
}

function test_answer_validation(): void {
  const io = fakeIO();
  enqueueQuestion({ id: 'q', repoId: 'r', question: 'Q?', options: ['a', 'b'] }, io);
  // invalid choice rejected
  let threw = false;
  try {
    answerQuestion('q', 'c', io);
  } catch {
    threw = true;
  }
  assert(threw, 'non-option answer rejected');
  // unknown question rejected
  threw = false;
  try {
    answerQuestion('nope', 'a', io);
  } catch {
    threw = true;
  }
  assert(threw, 'unknown question rejected');
  // still pending after failed answers
  assert(isRepoBlocked('r', io) === true, 'still blocked after rejected answers');
  console.log('PASS: test_answer_validation');
}

function test_idempotent_and_robust_store(): void {
  const io = fakeIO();
  enqueueQuestion({ id: 'q', repoId: 'r', question: 'v1', options: ['a'] }, io);
  enqueueQuestion({ id: 'q', repoId: 'r', question: 'v2', options: ['a'] }, io);
  assert(loadQuestions(io).length === 1, 'enqueue idempotent by id');
  assert(loadQuestions(io)[0].question === 'v2', 're-enqueue replaces');

  // empty option list rejected
  let threw = false;
  try {
    enqueueQuestion({ id: 'x', repoId: 'r', question: 'Q', options: [] }, io);
  } catch {
    threw = true;
  }
  assert(threw, 'empty options rejected');

  // corrupt store => [] (non-destructive read)
  const io2 = fakeIO();
  io2.files[questionsPath(io2)] = '{ broken';
  assert(loadQuestions(io2).length === 0, 'corrupt store reads empty');
  // missing store => []
  assert(loadQuestions(fakeIO()).length === 0, 'missing store reads empty');
  console.log('PASS: test_idempotent_and_robust_store');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ingest/questions (blocking queue)', () => {
  it('test_enqueue_blocks_and_answer_unblocks', test_enqueue_blocks_and_answer_unblocks);
  it('test_answer_validation', test_answer_validation);
  it('test_idempotent_and_robust_store', test_idempotent_and_robust_store);
});
