/**
 * Neo4j graph-layer types (ONBOARD Phase 1 — P1.6 / AC6, #587).
 *
 * The graph is the relationship half of the hybrid substrate. We talk to Neo4j
 * over its HTTP transactional API (`POST /db/neo4j/tx/commit`) — no native
 * driver dep — through an INJECTED transport so the client is unit-tested with a
 * fake (never a live DB in tests). Everything is best-effort: if the graph is
 * unreachable, ingestion still completes the file layer (FR-D3 degradation).
 */

export interface Neo4jCreds {
  /** Derived HTTP endpoint, e.g. http://neo4j.pwatson.space:7474 . */
  httpUrl: string;
  user: string;
  password: string;
}

export interface GraphStatement {
  statement: string;
  parameters?: Record<string, unknown>;
}

export interface GraphRunResult {
  ok: boolean;
  error?: string;
  /** raw `results` array from the tx API (when ok). */
  results?: unknown[];
}

/** Minimal client surface the importer + inference depend on. */
export interface GraphClient {
  run(statements: GraphStatement[]): Promise<GraphRunResult>;
  verifyConnectivity(): Promise<boolean>;
}

/** Injected HTTP transport (real impl wraps global fetch; tests pass a fake). */
export type GraphTransport = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; text: string }>;
