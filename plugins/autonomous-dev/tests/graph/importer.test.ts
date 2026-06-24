import { buildGraphStatements, syncGraph } from '../../src/graph/importer';
import type { Ownership } from '../../src/ownership/types';
import type { RepoSignals } from '../../src/ingest/inference';
import type { GraphClient, GraphStatement } from '../../src/graph/types';

/**
 * Unit tests for the graph importer (ONBOARD P1.6 / AC6).
 * Pure builder + fake client — no live DB. Asserts idempotent MERGE + that
 * crawled values are PARAMETERS (no Cypher injection) + graceful degradation.
 */

const OWN: Ownership = {
  org: 'acme',
  projects: [{ id: 'payments', name: 'Payments', tags: {} }],
  repos: [
    { id: 'acme/orders', projectId: 'payments', tags: {} },
    { id: 'acme/site', projectId: null, tags: {} },
  ],
};

const SIGNALS: RepoSignals[] = [
  { repoId: 'acme/orders', owners: ['@acme/pay', '@acme/pay'], deps: ['express', 'node-vault'] },
  { repoId: 'acme/site', owners: [], deps: [] },
];

function fakeClient(captured: GraphStatement[], ok = true): GraphClient {
  return {
    async run(statements) {
      captured.push(...statements);
      return ok ? { ok: true, results: [] } : { ok: false, error: 'boom' };
    },
    async verifyConnectivity() {
      return ok;
    },
  };
}

function test_build_statements(): void {
  const stmts = buildGraphStatements('acme', OWN, SIGNALS);
  const joined = stmts.map((s) => s.statement).join('\n');
  assert(stmts[0].statement.includes('MERGE (o:Org {id:$org})'), 'org node first');
  assert(joined.includes(':Project {id:$pid}') && joined.includes('IN_ORG'), 'project + IN_ORG');
  assert(joined.includes(':Repo {id:$rid}') && joined.includes('IN_PROJECT'), 'repo + IN_PROJECT');
  assert(joined.includes('OWNED_BY') && joined.includes('DEPENDS_ON'), 'owner + dep rels');
  // owners deduped: @acme/pay appears once as a param across owner statements
  const ownerStmts = stmts.filter((s) => s.statement.includes('OWNED_BY'));
  assert(ownerStmts.length === 1, 'deduped owner → one OWNED_BY statement');
  const depStmts = stmts.filter((s) => s.statement.includes('DEPENDS_ON'));
  assert(depStmts.length === 2, 'two deps');
  console.log('PASS: test_build_statements');
}

function test_values_are_parameters_not_interpolated(): void {
  // a hostile repo id must NEVER appear in the Cypher text — only in parameters
  const evil = 'acme/x"}) DETACH DELETE n //';
  const own: Ownership = { org: 'acme', projects: [], repos: [{ id: evil, projectId: null, tags: {} }] };
  const stmts = buildGraphStatements('acme', own, [{ repoId: evil, owners: ['@evil"}) //'], deps: [] }]);
  for (const s of stmts) {
    assert(!s.statement.includes('DETACH DELETE'), 'hostile id never interpolated into Cypher');
  }
  const repoStmt = stmts.find((s) => s.statement.includes(':Repo'));
  assert(!!repoStmt && repoStmt.parameters!.rid === evil, 'hostile id carried as a parameter');
  console.log('PASS: test_values_are_parameters_not_interpolated');
}

async function test_sync_runs_and_chunks(): Promise<void> {
  const captured: GraphStatement[] = [];
  const res = await syncGraph(fakeClient(captured), 'acme', OWN, SIGNALS, 2);
  assert(res.ok && res.applied === captured.length, 'all statements applied');
  assert(captured.length >= 6, 'org+project+2 repos+rels');
  console.log('PASS: test_sync_runs_and_chunks');
}

async function test_sync_degrades(): Promise<void> {
  const skipped = await syncGraph(undefined, 'acme', OWN, SIGNALS);
  assert(!skipped.ok && skipped.skipped === true, 'no client → skipped (not a hard failure)');
  const failed = await syncGraph(fakeClient([], false), 'acme', OWN, SIGNALS);
  assert(!failed.ok && !failed.skipped, 'run failure → ok:false (not skipped)');
  console.log('PASS: test_sync_degrades');
}

async function test_chunk_size_guard(): Promise<void> {
  // B2: chunkSize 0 must NOT infinite-loop — treated as 1
  const captured: GraphStatement[] = [];
  let runs = 0;
  const client: GraphClient = {
    async run(s) {
      runs++;
      captured.push(...s);
      return { ok: true, results: [] };
    },
    async verifyConnectivity() {
      return true;
    },
  };
  const res = await syncGraph(client, 'acme', OWN, SIGNALS, 0);
  assert(res.ok && res.applied === captured.length, 'chunkSize 0 terminates + applies all');
  assert(runs === captured.length, 'chunkSize 0 → one run per statement (treated as 1)');
  console.log('PASS: test_chunk_size_guard');
}

function test_no_orphan_project(): void {
  // M1: a repo whose projectId points at a non-existent project must NOT emit IN_PROJECT
  const own: Ownership = { org: 'acme', projects: [], repos: [{ id: 'acme/x', projectId: 'ghost', tags: {} }] };
  const stmts = buildGraphStatements('acme', own, []);
  assert(!stmts.some((s) => s.statement.includes('IN_PROJECT')), 'dangling projectId → no orphan Project / IN_PROJECT');
  console.log('PASS: test_no_orphan_project');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('graph/importer', () => {
  it('test_build_statements', test_build_statements);
  it('test_values_are_parameters_not_interpolated', test_values_are_parameters_not_interpolated);
  it('test_sync_runs_and_chunks', test_sync_runs_and_chunks);
  it('test_sync_degrades', test_sync_degrades);
  it('test_chunk_size_guard', test_chunk_size_guard);
  it('test_no_orphan_project', test_no_orphan_project);
});
