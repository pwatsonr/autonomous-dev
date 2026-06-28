import { enqueueAmbiguityQuestions } from '../../src/ingest/orchestrator';
import { loadQuestions, answerQuestion, isRepoBlocked } from '../../src/ingest/questions';
import type { QuestionStoreIO } from '../../src/ingest/questions';
import type { RepoSignals } from '../../src/ingest/inference';

/**
 * Unit tests for the question-queue PRODUCER (ONBOARD Phase 1, #587 AC3 / #588).
 * `enqueueAmbiguityQuestions` turns project-membership ambiguity into blocking
 * questions. Injected fake IO — never touches operator state.
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

// o/c bridges an owner-group (with o/a) and a prefix-group (with o/web-ui).
const ambiguous: RepoSignals[] = [
  { repoId: 'o/a', owners: ['@team/pay'], deps: [] },
  { repoId: 'o/c', owners: ['@team/pay'], deps: [], namePrefix: 'web' },
  { repoId: 'o/web-ui', owners: [], deps: [], namePrefix: 'web' },
];

function test_enqueues_on_ambiguity(): void {
  const io = fakeIO();
  const ids = enqueueAmbiguityQuestions(ambiguous, io);
  assert(ids.length === 1 && ids[0] === 'ambiguity:o/c', 'one question for the bridge repo');
  const qs = loadQuestions(io);
  assert(qs.length === 1, 'persisted exactly one question');
  assert(qs[0].repoId === 'o/c' && qs[0].status === 'pending', 'question targets o/c and is pending');
  assert(qs[0].options.join(',') === 'team-pay,web', `options are the candidate project ids, got ${qs[0].options.join(',')}`);
  // CONSUMER contract: the repo is now BLOCKED until answered.
  assert(isRepoBlocked('o/c', io), 'producer output blocks the repo');
  console.log('PASS: test_enqueues_on_ambiguity');
}

function test_dedupes_no_double_enqueue(): void {
  const io = fakeIO();
  enqueueAmbiguityQuestions(ambiguous, io);
  const second = enqueueAmbiguityQuestions(ambiguous, io);
  assert(second.length === 0, 'second run enqueues nothing');
  assert(loadQuestions(io).length === 1, 'still exactly one question (idempotent by id)');
  console.log('PASS: test_dedupes_no_double_enqueue');
}

function test_does_not_clobber_an_answer(): void {
  const io = fakeIO();
  enqueueAmbiguityQuestions(ambiguous, io);
  answerQuestion('ambiguity:o/c', 'web', io); // human resolves it
  const again = enqueueAmbiguityQuestions(ambiguous, io); // re-run inference
  assert(again.length === 0, 're-run does not re-ask an answered question');
  const q = loadQuestions(io)[0];
  assert(q.status === 'answered' && q.answer === 'web', 'the human answer survives re-inference');
  assert(!isRepoBlocked('o/c', io), 'repo stays unblocked');
  console.log('PASS: test_does_not_clobber_an_answer');
}

function test_no_question_when_unambiguous(): void {
  const io = fakeIO();
  const clear: RepoSignals[] = [
    { repoId: 'acme/payments-api', owners: [], deps: [] },
    { repoId: 'acme/payments-web', owners: [], deps: [] },
  ];
  const ids = enqueueAmbiguityQuestions(clear, io);
  assert(ids.length === 0 && loadQuestions(io).length === 0, 'no ambiguity => empty queue');
  console.log('PASS: test_no_question_when_unambiguous');
}

function test_best_effort_never_throws(): void {
  // empty input is the trivial never-throw case; the producer swallows internal errors.
  const io = fakeIO();
  const ids = enqueueAmbiguityQuestions([], io);
  assert(ids.length === 0, 'empty signals => no questions, no throw');
  console.log('PASS: test_best_effort_never_throws');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('ingest/producer (ambiguity -> blocking questions)', () => {
  it('test_enqueues_on_ambiguity', test_enqueues_on_ambiguity);
  it('test_dedupes_no_double_enqueue', test_dedupes_no_double_enqueue);
  it('test_does_not_clobber_an_answer', test_does_not_clobber_an_answer);
  it('test_no_question_when_unambiguous', test_no_question_when_unambiguous);
  it('test_best_effort_never_throws', test_best_effort_never_throws);
});
