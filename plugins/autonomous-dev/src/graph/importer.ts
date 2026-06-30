/**
 * Graph importer (ONBOARD Phase 1 — P1.6 / AC6).
 *
 * Turns the ownership tree + per-repo signals into idempotent Neo4j upserts:
 *   (Org) ←IN_ORG← (Project) ←IN_PROJECT← (Repo) →OWNED_BY→ (Owner)
 *                                          (Repo) →DEPENDS_ON→ (Dependency)
 *
 * SECURITY: every crawled value (repo id, owner, dependency) is passed as a
 * Cypher PARAMETER, never string-interpolated into the statement — so a hostile
 * repo name can't inject Cypher. `syncGraph` is best-effort + chunked; a missing
 * client (Neo4j unconfigured) or a failed run degrades gracefully (FR-D3).
 */

import type { Ownership } from '../ownership/types';
import type { RepoSignals } from '../ingest/inference';
import type { GraphClient, GraphStatement } from './types';

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.trim().length > 0))];
}

/** Build the idempotent MERGE statements (pure; all crawled values parameterized). */
export function buildGraphStatements(
  org: string,
  ownership: Ownership,
  signals: RepoSignals[],
): GraphStatement[] {
  const stmts: GraphStatement[] = [{ statement: 'MERGE (o:Org {id:$org})', parameters: { org } }];
  const knownProjects = new Set(ownership.projects.map((p) => p.id));

  for (const p of ownership.projects) {
    stmts.push({
      statement:
        'MERGE (o:Org {id:$org}) MERGE (p:Project {id:$pid}) SET p.name=$name MERGE (p)-[:IN_ORG]->(o)',
      parameters: { org, pid: p.id, name: p.name },
    });
  }

  const byRepo = new Map(signals.map((s) => [s.repoId, s]));
  for (const r of ownership.repos) {
    stmts.push({
      statement: 'MERGE (o:Org {id:$org}) MERGE (r:Repo {id:$rid}) MERGE (r)-[:IN_ORG]->(o)',
      parameters: { org, rid: r.id },
    });
    // Only link to a KNOWN project — never MERGE an orphan Project node for a dangling projectId.
    if (r.projectId && knownProjects.has(r.projectId)) {
      stmts.push({
        statement:
          'MERGE (r:Repo {id:$rid}) MERGE (p:Project {id:$pid}) MERGE (r)-[:IN_PROJECT]->(p)',
        parameters: { rid: r.id, pid: r.projectId },
      });
    }
    const sig = byRepo.get(r.id);
    if (!sig) continue;
    for (const owner of unique(sig.owners)) {
      stmts.push({
        statement:
          'MERGE (r:Repo {id:$rid}) MERGE (w:Owner {id:$owner}) MERGE (r)-[:OWNED_BY]->(w)',
        parameters: { rid: r.id, owner },
      });
    }
    for (const dep of unique(sig.deps)) {
      stmts.push({
        statement:
          'MERGE (r:Repo {id:$rid}) MERGE (d:Dependency {id:$dep}) MERGE (r)-[:DEPENDS_ON]->(d)',
        parameters: { rid: r.id, dep },
      });
    }
  }
  return stmts;
}

export interface SyncResult {
  ok: boolean;
  applied: number;
  error?: string;
  /** true when skipped because Neo4j is not configured/reachable (degradation, not failure). */
  skipped?: boolean;
}

/** Upsert the graph (best-effort, chunked). A missing client → skipped (FR-D3). */
export async function syncGraph(
  client: GraphClient | undefined,
  org: string,
  ownership: Ownership,
  signals: RepoSignals[],
  chunkSize = 200,
): Promise<SyncResult> {
  if (!client)
    return {
      ok: false,
      applied: 0,
      skipped: true,
      error: 'Neo4j not configured (graph layer skipped)',
    };
  const cs = chunkSize >= 1 ? Math.floor(chunkSize) : 1; // guard against 0/negative → infinite loop
  const stmts = buildGraphStatements(org, ownership, signals);
  let applied = 0;
  for (let i = 0; i < stmts.length; i += cs) {
    const chunk = stmts.slice(i, i + cs);
    const res = await client.run(chunk);
    if (!res.ok) return { ok: false, applied, error: res.error };
    applied += chunk.length;
  }
  return { ok: true, applied };
}
