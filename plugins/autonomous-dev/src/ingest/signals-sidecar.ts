/**
 * Structured signals sidecar (ONBOARD Phase 1 — #588).
 *
 * Project inference historically sourced its per-repo signals by RE-PARSING the
 * human-readable `ownership` memory markdown (`signalsFromMemory`). That couples
 * inference to a human-editable render format. This sidecar DECOUPLES the two:
 * at EXTRACTION time (when a repo is crawled and its memory docs are written) we
 * ALSO write a slim machine-readable JSON of the extracted `RepoSignals` to
 * `~/.autonomous-dev/ingest/signals/<repoId>.json`; at INFERENCE time the caller
 * PREFERS the sidecar and FALLS BACK to the markdown parse when it is
 * missing/corrupt (so existing data + tests keep working). It is also the
 * natural home for future `deps` enrichment + the graph importer's structured
 * facts.
 *
 * Persisted via injected IO (no native dep), written atomically (tmp + rename,
 * mode 0600) — mirroring the question / known-sha / ownership stores.
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveAbsoluteHome } from '../home';
import type { RepoSignals } from './inference';

/** On-disk envelope. Versioned so the shape can evolve without misreading old files. */
interface SignalsSidecar {
  version: 1;
  signals: RepoSignals;
}

export interface SignalsSidecarIO {
  homedir(): string;
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, data: string): void;
}

export const defaultSignalsIO: SignalsSidecarIO = {
  homedir: () => resolveAbsoluteHome(),
  readFile: (filePath) =>
    fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined,
  writeFile: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  },
};

/** Directory holding the per-repo sidecars. */
export function signalsDir(io: SignalsSidecarIO = defaultSignalsIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'ingest', 'signals');
}

/**
 * A FLAT, traversal-safe file base for a repo id. A repo id is `owner/name`; the
 * `/` (and any other non `[a-z0-9._-]` char) is collapsed to `_`, and any leading
 * dots are neutralised — so the result is always a single path segment that can
 * never escape `signalsDir` (defense-in-depth, R1). Reversibility is not needed:
 * the canonical `repoId` is stored INSIDE the JSON, not derived from the name.
 */
export function sidecarFileName(repoId: string): string {
  const base = repoId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^\.+/, '_');
  return `${base || 'repo'}.json`;
}

/** Absolute path of a repo's signals sidecar. */
export function sidecarPath(repoId: string, io: SignalsSidecarIO = defaultSignalsIO): string {
  return path.join(signalsDir(io), sidecarFileName(repoId));
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Narrow an arbitrary parsed value to `RepoSignals`, or undefined if it isn't one. */
function asRepoSignals(value: unknown): RepoSignals | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as Record<string, unknown>;
  if (typeof s.repoId !== 'string' || !s.repoId) return undefined;
  if (!isStringArray(s.owners) || !isStringArray(s.deps)) return undefined;
  if (s.namePrefix !== undefined && typeof s.namePrefix !== 'string') return undefined;
  return {
    repoId: s.repoId,
    owners: s.owners,
    deps: s.deps,
    ...(typeof s.namePrefix === 'string' ? { namePrefix: s.namePrefix } : {}),
  };
}

/**
 * Write the machine-readable signals sidecar for a repo (atomic, 0600).
 * Best-effort is the CALLER's responsibility — this throws on an IO error so the
 * orchestrator can decide to isolate it; the orchestrator wraps it in try/catch
 * so a sidecar failure never aborts a crawl.
 */
export function writeSignalsSidecar(
  repoId: string,
  signals: RepoSignals,
  io: SignalsSidecarIO = defaultSignalsIO,
): void {
  const envelope: SignalsSidecar = { version: 1, signals };
  io.writeFile(sidecarPath(repoId, io), `${JSON.stringify(envelope, null, 2)}\n`);
}

/**
 * Load a repo's signals sidecar — BEST-EFFORT: a missing or corrupt/invalid file
 * reads as `undefined`, signalling the caller to fall back to `signalsFromMemory`
 * (the markdown parse). Never throws.
 */
export function loadSignalsSidecar(
  repoId: string,
  io: SignalsSidecarIO = defaultSignalsIO,
): RepoSignals | undefined {
  let raw: string | undefined;
  try {
    raw = io.readFile(sidecarPath(repoId, io));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const env = parsed as Record<string, unknown>;
    // Tolerate either the versioned envelope or a bare RepoSignals object.
    const candidate = 'signals' in env ? env.signals : env;
    return asRepoSignals(candidate);
  } catch {
    return undefined;
  }
}
