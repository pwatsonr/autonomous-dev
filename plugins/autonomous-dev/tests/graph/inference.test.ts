import { graphRepoSignals, inferProjectsWithGraph } from '../../src/graph/inference';
import type { GraphClient } from '../../src/graph/types';
import type { RepoSignals } from '../../src/ingest/inference';

/**
 * Unit tests for graph-enriched inference (ONBOARD P1.6 / AC6).
 * Fake client returning canned tx-API rows; asserts graph-sourced inference +
 * file fallback (FR-D3 graceful degradation).
 */

// canned tx-API shape: results[0].data[].row = [repo, owners[], deps[]]
function rowsClient(rows: unknown[][], ok = true): GraphClient {
  return {
    async run() {
      return ok ? { ok: true, results: [{ columns: ['repo', 'owners', 'deps'], data: rows.map((row) => ({ row })) }] } : { ok: false, error: 'down' };
    },
    async verifyConnectivity() {
      return ok;
    },
  };
}

const FILE_SIGNALS: RepoSignals[] = [
  { repoId: 'acme/a', owners: ['@team/x'], deps: [] },
  { repoId: 'acme/b', owners: ['@team/x'], deps: [] },
];

async function test_graph_signals_parsed(): Promise<void> {
  const client = rowsClient([
    ['acme/a', ['@team/x'], ['express', 'node-vault']],
    ['acme/b', [null], []], // collect(DISTINCT null) → [null]; must be filtered
  ]);
  const sig = await graphRepoSignals(client);
  assert(!!sig && sig.length === 2, 'two repos');
  assert(sig![0].deps.join(',') === 'express,node-vault', 'deps sourced from graph (enrichment)');
  assert(sig![1].owners.length === 0, 'null owners filtered out');
  console.log('PASS: test_graph_signals_parsed');
}

async function test_infers_from_graph(): Promise<void> {
  const client = rowsClient([
    ['acme/a', ['@team/x'], []],
    ['acme/b', ['@team/x'], []],
  ]);
  const res = await inferProjectsWithGraph(client, []);
  assert(res.source === 'graph', 'used the graph');
  assert(res.proposals.length === 1 && res.proposals[0].repoIds.length === 2, 'grouped the shared-owner pair from the graph');
  console.log('PASS: test_infers_from_graph');
}

async function test_falls_back_to_file(): Promise<void> {
  // no client → file
  const noClient = await inferProjectsWithGraph(undefined, FILE_SIGNALS);
  assert(noClient.source === 'file' && noClient.proposals.length === 1, 'no client → file inference');
  // client errors → file
  const downClient = await inferProjectsWithGraph(rowsClient([], false), FILE_SIGNALS);
  assert(downClient.source === 'file' && downClient.proposals.length === 1, 'graph down → file inference');
  console.log('PASS: test_falls_back_to_file');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('graph/inference', () => {
  it('test_graph_signals_parsed', test_graph_signals_parsed);
  it('test_infers_from_graph', test_infers_from_graph);
  it('test_falls_back_to_file', test_falls_back_to_file);
});
