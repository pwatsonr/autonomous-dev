/**
 * Neo4j HTTP client (ONBOARD Phase 1 — P1.6 / AC6).
 *
 * Talks to Neo4j's HTTP transactional endpoint (`POST <httpUrl>/db/neo4j/tx/commit`)
 * with basic auth. Transport is injected (real impl wraps global `fetch` with a
 * timeout), so the client is unit-tested with a fake — no live DB, and the
 * password never leaves the auth header. Best-effort: ALL failure modes (timeout,
 * HTTP error, malformed/`null` body, neo4j error array) return `{ ok: false }` —
 * nothing throws out of `run`, so callers degrade gracefully (FR-D3).
 */

import type { GraphClient, GraphStatement, GraphRunResult, GraphTransport, Neo4jCreds } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Real transport over global fetch (bun + Node 18+), with an abort timeout. */
export const fetchTransport: GraphTransport = async (req) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
};

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Best-effort: pull a neo4j error message out of a (possibly non-2xx) body. */
function errorFromBody(text: string): string | undefined {
  try {
    const p = JSON.parse(text) as { errors?: { message?: string }[] };
    if (p && Array.isArray(p.errors) && p.errors.length > 0) {
      return p.errors.map((e) => e.message ?? 'error').join('; ');
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Create an HTTP-API-backed GraphClient. */
export function httpGraphClient(creds: Neo4jCreds, transport: GraphTransport = fetchTransport): GraphClient {
  const url = `${creds.httpUrl.replace(/\/+$/, '')}/db/neo4j/tx/commit`;
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
      return { ok: false, error: errorFromBody(res.text) ?? `HTTP ${res.status}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return { ok: false, error: 'invalid JSON from Neo4j' };
    }
    // The tx API always returns an object {results, errors}; reject anything else
    // (null/array/primitive) so we never throw on property access.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'unexpected response shape from Neo4j' };
    }
    const body = parsed as { results?: unknown[]; errors?: { message?: string }[] };
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return { ok: false, error: body.errors.map((e) => e.message ?? 'error').join('; '), results: body.results };
    }
    return { ok: true, results: body.results };
  }

  return {
    run,
    async verifyConnectivity(): Promise<boolean> {
      const r = await run([{ statement: 'RETURN 1 AS ok' }]);
      // require a structurally-correct result row, not just any 2xx (a stray proxy 200 isn't Neo4j).
      const first = r.results?.[0] as { data?: { row?: unknown[] }[] } | undefined;
      return r.ok && Array.isArray(first?.data) && first!.data.length > 0;
    },
  };
}
