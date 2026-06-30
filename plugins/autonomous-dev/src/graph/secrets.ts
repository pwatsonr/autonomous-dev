/**
 * Neo4j credential reader (ONBOARD Phase 1 — P1.6 / AC6).
 *
 * Reads the operator-provided credential from `~/.autonomous-dev/secrets/neo4j.json`
 * (0600, outside any git repo) via an INJECTED reader so tests never touch it.
 * Returns undefined when absent → the graph layer degrades gracefully (FR-D3).
 * The bolt `uri` is mapped to the HTTP endpoint (we use the HTTP tx API).
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveAbsoluteHome } from '../home';
import type { Neo4jCreds } from './types';

export interface SecretsReader {
  read(filePath: string): string | undefined;
}

export const defaultSecretsReader: SecretsReader = {
  read: (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined),
};

export function neo4jSecretsPath(homedir: string): string {
  return path.join(homedir, '.autonomous-dev', 'secrets', 'neo4j.json');
}

/** bolt://host:7687 | neo4j://[::1] → http://host:7474 (HTTP tx API port); '' if no host. */
export function boltToHttp(uri: string): string {
  const m = uri.match(/^(?:bolt|neo4j)(?:\+s(?:sc)?)?:\/\/(\[[^\]]+\]|[^:/]+)(?::\d+)?/i);
  const host = (m ? m[1] : (uri.replace(/^[a-z+]+:\/\//i, '').split(/[:/]/)[0] ?? '')).trim();
  return host ? `http://${host}:7474` : '';
}

/** Read + normalize the Neo4j credential, or undefined if not configured. */
export function readNeo4jCreds(
  reader: SecretsReader = defaultSecretsReader,
  homedir: string = resolveAbsoluteHome(),
): Neo4jCreds | undefined {
  const raw = reader.read(neo4jSecretsPath(homedir));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const o = parsed as Record<string, unknown>;
  const uri = typeof o.uri === 'string' ? o.uri : undefined;
  const user = typeof o.user === 'string' ? o.user : undefined;
  const password = typeof o.password === 'string' ? o.password : undefined;
  if (!uri || !user || !password) return undefined;
  // a NON-EMPTY httpUrl override wins; else derive from the bolt uri. Reject a malformed result.
  const httpUrl =
    typeof o.httpUrl === 'string' && o.httpUrl.trim() ? o.httpUrl.trim() : boltToHttp(uri);
  if (!httpUrl || !/^https?:\/\/[^/\s]+/i.test(httpUrl)) return undefined;
  return { httpUrl, user, password };
}
