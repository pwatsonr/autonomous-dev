/**
 * Unit tests for the ProposalStore status state machine and persistence
 * (SPEC-005-3-5, Task 11).
 *
 * Exercises the real ProposalStore against a JSONL primary store. Note:
 * better-sqlite3 is unsupported under the Bun test runner, so the SQLite
 * index paths fall back to no-op / JSONL — every assertion here targets the
 * JSONL source of truth (mirrors weakness-report-store.test.ts).
 *
 * Coverage:
 *   - VALID_TRANSITIONS: every legal `updateStatus` transition succeeds; a
 *     representative set of illegal transitions throw.
 *   - append + getById + getByStatus + getByAgent round-trips.
 *   - setMetaReviewId / setEvaluationId persist.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ProposalStore } from '../../../src/agent-factory/improvement/proposal-store';
import type { AgentProposal, ProposalStatus } from '../../../src/agent-factory/improvement/types';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

// ---------------------------------------------------------------------------
// Temp-dir helpers (mirror existing store tests)
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-store-test-'));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const silentLogger = { warn: () => {} };

/**
 * Construct a ProposalStore over a fresh temp dir. The SQLite db path points
 * inside the same temp dir (under Bun the native module is unavailable, so
 * the store falls back to JSONL — which is exactly what we assert against).
 */
function makeStore(tmpDir: string): ProposalStore {
  const jsonlPath = path.join(tmpDir, 'proposals.jsonl');
  const sqlitePath = path.join(tmpDir, 'agent-metrics.db');
  return new ProposalStore(jsonlPath, sqlitePath, silentLogger);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProposal(overrides?: Partial<AgentProposal>): AgentProposal {
  return {
    proposal_id: 'prop-001',
    agent_name: 'code-executor',
    current_version: '1.0.0',
    proposed_version: '1.0.1',
    version_bump: 'patch',
    weakness_report_id: 'report-001',
    current_definition: '---\nname: code-executor\nversion: 1.0.0\n---\nOriginal.',
    proposed_definition: '---\nname: code-executor\nversion: 1.0.1\n---\nImproved.',
    diff: '--- a/code-executor.md\n+++ b/code-executor.md\n@@ -1 +1 @@\n-Original.\n+Improved.',
    rationale: 'Improve test coverage guidance',
    status: 'pending_meta_review',
    created_at: '2026-04-08T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The complete legal transition matrix, derived from VALID_TRANSITIONS in
// proposal-store.ts. Each entry is one [from, to] edge that must succeed.
// ---------------------------------------------------------------------------

const LEGAL_TRANSITIONS: ReadonlyArray<[ProposalStatus, ProposalStatus]> = [
  ['pending_meta_review', 'meta_approved'],
  ['pending_meta_review', 'meta_rejected'],
  ['pending_meta_review', 'pending_human_review'],
  ['meta_approved', 'validating'],
  ['meta_approved', 'promoted'], // #539: the self-review-bypass promotion path
  ['validating', 'validated_positive'],
  ['validating', 'validated_negative'],
  ['validated_positive', 'promoted'],
  ['validated_positive', 'rejected'],
  ['validated_negative', 'rejected'],
];

// A representative set of ILLEGAL transitions: terminal-state exits, skips,
// and backward moves. Each must throw.
const ILLEGAL_TRANSITIONS: ReadonlyArray<[ProposalStatus, ProposalStatus]> = [
  // Terminal states have no outgoing edges.
  ['promoted', 'rejected'],
  ['rejected', 'promoted'],
  ['meta_rejected', 'meta_approved'],
  ['pending_human_review', 'meta_approved'],
  // Skipping intermediate states.
  ['pending_meta_review', 'validating'],
  ['pending_meta_review', 'promoted'],
  ['validating', 'promoted'],
  // Backward / sideways moves.
  ['meta_approved', 'pending_meta_review'],
  ['validated_negative', 'validated_positive'],
  ['validated_positive', 'validating'],
];

// ---------------------------------------------------------------------------
// Transition matrix tests
// ---------------------------------------------------------------------------

function test_every_legal_transition_succeeds(): void {
  const tmpDir = makeTempDir();
  try {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      const store = makeStore(makeTempDir2(tmpDir, `${from}-${to}`));
      const id = `prop-${from}-${to}`;
      // Seed a proposal already in the `from` state (append does not validate).
      store.append(makeProposal({ proposal_id: id, status: from }));

      store.updateStatus(id, to);

      const updated = store.getById(id);
      assert(updated !== null, `proposal ${id} should exist after ${from} -> ${to}`);
      assert(
        updated!.status === to,
        `expected status ${to} after ${from} -> ${to}, got ${updated!.status}`,
      );
      store.close();
    }
    // Sanity: assert we exercised exactly the matrix we expect.
    assert(
      LEGAL_TRANSITIONS.length === 10,
      `expected 10 legal transitions, got ${LEGAL_TRANSITIONS.length}`,
    );
    console.log('PASS: test_every_legal_transition_succeeds');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_illegal_transitions_throw(): void {
  const tmpDir = makeTempDir();
  try {
    for (const [from, to] of ILLEGAL_TRANSITIONS) {
      const store = makeStore(makeTempDir2(tmpDir, `bad-${from}-${to}`));
      const id = `prop-bad-${from}-${to}`;
      store.append(makeProposal({ proposal_id: id, status: from }));

      assertThrows(
        () => store.updateStatus(id, to),
        `illegal transition ${from} -> ${to} should throw`,
      );

      // Status must be unchanged after a rejected transition.
      const after = store.getById(id);
      assert(
        after!.status === from,
        `status should remain ${from} after rejected ${from} -> ${to}, got ${after!.status}`,
      );
      store.close();
    }
    console.log('PASS: test_illegal_transitions_throw');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_update_status_unknown_proposal_throws(): void {
  const tmpDir = makeTempDir();
  try {
    const store = makeStore(tmpDir);
    assertThrows(
      () => store.updateStatus('does-not-exist', 'meta_approved'),
      'updateStatus on an unknown proposal id should throw',
    );
    store.close();
    console.log('PASS: test_update_status_unknown_proposal_throws');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_full_happy_path_lifecycle(): void {
  // Drive a single proposal through the canonical promote path, only ever
  // using legal transitions, to confirm the state machine composes.
  const tmpDir = makeTempDir();
  try {
    const store = makeStore(tmpDir);
    store.append(makeProposal({ proposal_id: 'lifecycle', status: 'pending_meta_review' }));

    const path1: ProposalStatus[] = [
      'meta_approved',
      'validating',
      'validated_positive',
      'promoted',
    ];
    for (const next of path1) {
      store.updateStatus('lifecycle', next);
    }

    const final = store.getById('lifecycle');
    assert(final!.status === 'promoted', `expected promoted, got ${final!.status}`);

    // promoted is terminal — any further transition must throw.
    assertThrows(
      () => store.updateStatus('lifecycle', 'rejected'),
      'promoted is terminal and should reject further transitions',
    );
    store.close();
    console.log('PASS: test_full_happy_path_lifecycle');
  } finally {
    cleanupDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// CRUD / round-trip tests
// ---------------------------------------------------------------------------

function test_append_and_get_by_id_roundtrip(): void {
  const tmpDir = makeTempDir();
  try {
    const store = makeStore(tmpDir);
    const proposal = makeProposal({ proposal_id: 'roundtrip-1' });
    store.append(proposal);

    const fetched = store.getById('roundtrip-1');
    assert(fetched !== null, 'getById should find the appended proposal');
    // Full proposal (incl. definitions) round-trips through JSONL.
    assert(fetched!.proposal_id === proposal.proposal_id, 'proposal_id round-trips');
    assert(fetched!.agent_name === proposal.agent_name, 'agent_name round-trips');
    assert(
      fetched!.current_definition === proposal.current_definition,
      'current_definition round-trips',
    );
    assert(
      fetched!.proposed_definition === proposal.proposed_definition,
      'proposed_definition round-trips',
    );
    assert(fetched!.diff === proposal.diff, 'diff round-trips');
    assert(fetched!.rationale === proposal.rationale, 'rationale round-trips');
    assert(fetched!.version_bump === proposal.version_bump, 'version_bump round-trips');

    const missing = store.getById('nope');
    assert(missing === null, 'getById returns null for a missing id');
    store.close();
    console.log('PASS: test_append_and_get_by_id_roundtrip');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_get_by_status_and_by_agent(): void {
  const tmpDir = makeTempDir();
  try {
    const store = makeStore(tmpDir);

    store.append(
      makeProposal({
        proposal_id: 'ce-1',
        agent_name: 'code-executor',
        status: 'pending_meta_review',
      }),
    );
    store.append(
      makeProposal({ proposal_id: 'ce-2', agent_name: 'code-executor', status: 'meta_approved' }),
    );
    store.append(
      makeProposal({
        proposal_id: 'ce-3',
        agent_name: 'code-executor',
        status: 'pending_meta_review',
      }),
    );
    store.append(
      makeProposal({
        proposal_id: 'pa-1',
        agent_name: 'prd-author',
        status: 'pending_meta_review',
      }),
    );

    // getByStatus
    const pending = store.getByStatus('pending_meta_review');
    assert(pending.length === 3, `expected 3 pending_meta_review, got ${pending.length}`);
    const approved = store.getByStatus('meta_approved');
    assert(approved.length === 1, `expected 1 meta_approved, got ${approved.length}`);
    assert(store.getByStatus('promoted').length === 0, 'expected 0 promoted');

    // getByAgent (no status filter)
    const ce = store.getByAgent('code-executor');
    assert(ce.length === 3, `expected 3 code-executor proposals, got ${ce.length}`);
    const pa = store.getByAgent('prd-author');
    assert(pa.length === 1, `expected 1 prd-author proposal, got ${pa.length}`);

    // getByAgent (with status filter)
    const cePending = store.getByAgent('code-executor', 'pending_meta_review');
    assert(cePending.length === 2, `expected 2 code-executor pending, got ${cePending.length}`);
    const ceApproved = store.getByAgent('code-executor', 'meta_approved');
    assert(
      ceApproved.length === 1,
      `expected 1 code-executor meta_approved, got ${ceApproved.length}`,
    );
    store.close();
    console.log('PASS: test_get_by_status_and_by_agent');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_jsonl_is_source_of_truth_after_update(): void {
  // The JSONL file is the source of truth; a fresh store reading the same
  // file must observe an updated status (proving the rewrite persisted, not
  // just an in-memory mutation).
  const tmpDir = makeTempDir();
  try {
    const jsonlPath = path.join(tmpDir, 'proposals.jsonl');
    const sqlitePath = path.join(tmpDir, 'agent-metrics.db');

    const store1 = new ProposalStore(jsonlPath, sqlitePath, silentLogger);
    store1.append(makeProposal({ proposal_id: 'persist-1', status: 'pending_meta_review' }));
    store1.updateStatus('persist-1', 'meta_approved');
    store1.close();

    // Confirm the on-disk JSONL contains exactly one line with the new status.
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    assert(lines.length === 1, `expected exactly 1 JSONL line after rewrite, got ${lines.length}`);
    const onDisk = JSON.parse(lines[0]) as AgentProposal;
    assert(
      onDisk.status === 'meta_approved',
      `on-disk status should be meta_approved, got ${onDisk.status}`,
    );

    // A new store reading the same file sees the persisted status.
    const store2 = new ProposalStore(jsonlPath, sqlitePath, silentLogger);
    const reread = store2.getById('persist-1');
    assert(
      reread!.status === 'meta_approved',
      `re-read status should be meta_approved, got ${reread!.status}`,
    );
    store2.close();
    console.log('PASS: test_jsonl_is_source_of_truth_after_update');
  } finally {
    cleanupDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// setMetaReviewId / setEvaluationId persistence
// ---------------------------------------------------------------------------

function test_set_meta_review_id_persists(): void {
  const tmpDir = makeTempDir();
  try {
    const store = makeStore(tmpDir);
    store.append(makeProposal({ proposal_id: 'meta-id-1' }));
    assert(
      store.getById('meta-id-1')!.meta_review_id === undefined,
      'meta_review_id should start unset',
    );

    store.setMetaReviewId('meta-id-1', 'review-abc');

    const fetched = store.getById('meta-id-1');
    assert(
      fetched!.meta_review_id === 'review-abc',
      `meta_review_id should persist, got ${fetched!.meta_review_id}`,
    );

    assertThrows(
      () => store.setMetaReviewId('missing', 'review-x'),
      'setMetaReviewId on a missing proposal should throw',
    );
    store.close();
    console.log('PASS: test_set_meta_review_id_persists');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_set_evaluation_id_persists(): void {
  const tmpDir = makeTempDir();
  try {
    const store = makeStore(tmpDir);
    store.append(makeProposal({ proposal_id: 'eval-id-1' }));
    assert(
      store.getById('eval-id-1')!.evaluation_id === undefined,
      'evaluation_id should start unset',
    );

    store.setEvaluationId('eval-id-1', 'eval-xyz');

    const fetched = store.getById('eval-id-1');
    assert(
      fetched!.evaluation_id === 'eval-xyz',
      `evaluation_id should persist, got ${fetched!.evaluation_id}`,
    );

    assertThrows(
      () => store.setEvaluationId('missing', 'eval-x'),
      'setEvaluationId on a missing proposal should throw',
    );
    store.close();
    console.log('PASS: test_set_evaluation_id_persists');
  } finally {
    cleanupDir(tmpDir);
  }
}

function test_id_setters_do_not_clobber_other_fields(): void {
  // Setting the review/eval IDs must preserve status and all other fields
  // across the JSONL rewrite.
  const tmpDir = makeTempDir();
  try {
    const store = makeStore(tmpDir);
    store.append(makeProposal({ proposal_id: 'preserve-1', status: 'meta_approved' }));

    store.setMetaReviewId('preserve-1', 'rev-1');
    store.setEvaluationId('preserve-1', 'ev-1');

    const fetched = store.getById('preserve-1');
    assert(fetched!.status === 'meta_approved', 'status preserved through setters');
    assert(fetched!.meta_review_id === 'rev-1', 'meta_review_id retained');
    assert(fetched!.evaluation_id === 'ev-1', 'evaluation_id retained');
    assert(
      fetched!.proposed_definition === makeProposal().proposed_definition,
      'definition preserved',
    );
    store.close();
    console.log('PASS: test_id_setters_do_not_clobber_other_fields');
  } finally {
    cleanupDir(tmpDir);
  }
}

// ---------------------------------------------------------------------------
// Helper: per-case temp subdir so each transition test gets an isolated store.
// ---------------------------------------------------------------------------

function makeTempDir2(parent: string, key: string): string {
  const dir = path.join(parent, key.replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('proposal store', () => {
  it('test_every_legal_transition_succeeds', test_every_legal_transition_succeeds);
  it('test_illegal_transitions_throw', test_illegal_transitions_throw);
  it('test_update_status_unknown_proposal_throws', test_update_status_unknown_proposal_throws);
  it('test_full_happy_path_lifecycle', test_full_happy_path_lifecycle);
  it('test_append_and_get_by_id_roundtrip', test_append_and_get_by_id_roundtrip);
  it('test_get_by_status_and_by_agent', test_get_by_status_and_by_agent);
  it('test_jsonl_is_source_of_truth_after_update', test_jsonl_is_source_of_truth_after_update);
  it('test_set_meta_review_id_persists', test_set_meta_review_id_persists);
  it('test_set_evaluation_id_persists', test_set_evaluation_id_persists);
  it('test_id_setters_do_not_clobber_other_fields', test_id_setters_do_not_clobber_other_fields);
});
