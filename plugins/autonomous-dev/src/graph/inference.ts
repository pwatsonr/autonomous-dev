/**
 * Graph-enriched project inference (ONBOARD Phase 1 — P1.6 / AC6, FR-E1/D3).
 *
 * Sources per-repo signals (owners + deps) FROM the Neo4j graph and reuses the
 * existing pure `inferProjects` union-find — so the graph enriches inference
 * (it carries deps the owner-only file signals lack) without duplicating logic.
 * If the graph is unconfigured/unreachable/errors, it FALLS BACK to file
 * inference over the supplied signals — ingestion's project inference always
 * works (graceful degradation).
 */

import type { GraphClient } from './types';
import type { RepoSignals, ProposedProject } from '../ingest/inference';
import { inferProjects } from '../ingest/inference';

/** results[0].data[].row → array of rows. */
function extractRows(results: unknown[]): unknown[][] {
  const first = results[0] as { data?: { row?: unknown[] }[] } | undefined;
  if (!first || !Array.isArray(first.data)) return [];
  return first.data.map((d) => (Array.isArray(d.row) ? d.row : [])).filter((r) => r.length > 0);
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).map((x) => String(x)) : [];
}

/** Read every repo's owners + deps from the graph as RepoSignals, or undefined on failure. */
export async function graphRepoSignals(client: GraphClient): Promise<RepoSignals[] | undefined> {
  const res = await client.run([
    {
      statement:
        'MATCH (r:Repo) ' +
        'OPTIONAL MATCH (r)-[:OWNED_BY]->(w:Owner) ' +
        'OPTIONAL MATCH (r)-[:DEPENDS_ON]->(d:Dependency) ' +
        'RETURN r.id AS repo, collect(DISTINCT w.id) AS owners, collect(DISTINCT d.id) AS deps',
    },
  ]);
  if (!res.ok || !res.results) return undefined;
  return extractRows(res.results).map((row) => ({
    repoId: String(row[0]),
    owners: asStrings(row[1]),
    deps: asStrings(row[2]),
  }));
}

export interface GraphInferResult {
  proposals: ProposedProject[];
  /** which substrate produced the proposals. */
  source: 'graph' | 'file';
}

/** Infer projects from the graph when available; otherwise from the file signals (FR-D3). */
export async function inferProjectsWithGraph(
  client: GraphClient | undefined,
  fallbackSignals: RepoSignals[],
): Promise<GraphInferResult> {
  if (client) {
    const signals = await graphRepoSignals(client);
    // undefined = graph error → fall back to file; [] = graph up but empty → use graph (don't mask "run graph sync").
    if (signals !== undefined) return { proposals: inferProjects(signals), source: 'graph' };
  }
  return { proposals: inferProjects(fallbackSignals), source: 'file' };
}
