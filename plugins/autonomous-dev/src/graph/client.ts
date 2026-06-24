/**
 * Neo4j HTTP client (ONBOARD Phase 1 — P1.6 / AC6).
 *
 * Talks to Neo4j's HTTP transactional endpoint (`POST <httpUrl>/db/neo4j/tx/commit`)
 * with basic auth. Transport is injected (real impl wraps global `fetch`), so the
 * client is unit-tested with a fake — no live DB, and the password never leaves
 * the auth header. Best-effort: errors return `{ ok: false }` rather than throw,
 * so callers degrade gracefully (FR-D3).
 */

import type { GraphClient, GraphStatement, GraphRunResult, GraphTransport, Neo4jCreds } from './types';

/** Real transport over global fetch (available in bun + Node 18+). */
export const fetchTransport: GraphTransport = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  return { status: r.status, text: await r.text() };
};

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Create an HTTP-API-backed GraphClient. */
export function httpGraphClient(creds: Neo4jCreds, transport: GraphTransport = fetchTransport): GraphClient {
  const url = `${creds.httpUrl.replace(/\/$/, '')}/db/neo4j/tx/commit`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: basicAuth(creds.user, creds.password),
  };

  async function run(statements: GraphStatement[]): Promise<GraphRunResult> {
    let res: { status: number; text: string };
    try {
      res = await transport({ url, method: 'POST', headers, body: JSON.stringify({ statements }) });
    } catch (err) {
      return { ok: false, error: `transport error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    let parsed: { results?: unknown[]; errors?: { message?: string }[] };
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return { ok: false, error: 'invalid JSON from Neo4j' };
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return { ok: false, error: parsed.errors.map((e) => e.message ?? 'error').join('; '), results: parsed.results };
    }
    return { ok: true, results: parsed.results };
  }

  return {
    run,
    async verifyConnectivity(): Promise<boolean> {
      return (await run([{ statement: 'RETURN 1 AS ok' }])).ok;
    },
  };
}
