/**
 * Ownership config loader (ONBOARD Phase 0 — epic #583 / issue #584).
 *
 * Pure functions over an injected raw config object (the parsed
 * `~/.claude/autonomous-dev.json`). Keeping these pure means tests never touch
 * live operator state (NFR-4) — the daemon/CLI inject the already-read manifest.
 *
 * Tolerant by design (mirrors the trust-config validation style): malformed or
 * missing input falls back to an empty ownership tree; a repo whose `projectId`
 * references a non-existent project is dropped to standalone (null) with a
 * warning. Absence of an `ownership` tree preserves today's behavior exactly.
 *
 * Design: docs/tdd/ONBOARD-phase0-ownership-scope.md (§4.1, ADR-1).
 */

import type { Ownership, Project, Repo, Tags, ScopeContext } from './types';

/** The empty ownership tree returned when no/invalid config is present. */
export const DEFAULT_OWNERSHIP: Readonly<Ownership> = {
  org: null,
  projects: [],
  repos: [],
};

function asTags(val: unknown): Tags {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return {};
  const out: Tags = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function asProject(val: unknown): Project | null {
  if (val === null || typeof val !== 'object') return null;
  const o = val as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (id === '') return null;
  return {
    id,
    name: typeof o.name === 'string' && o.name.trim() !== '' ? o.name : id,
    tags: asTags(o.tags),
  };
}

function asRepo(val: unknown): Repo | null {
  if (val === null || typeof val !== 'object') return null;
  const o = val as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (id === '') return null;
  const projectId =
    typeof o.projectId === 'string' && o.projectId.trim() !== '' ? o.projectId.trim() : null;
  return {
    id,
    path: typeof o.path === 'string' ? o.path : undefined,
    remote: typeof o.remote === 'string' ? o.remote : undefined,
    projectId,
    tags: asTags(o.tags),
  };
}

/**
 * Parse + validate the `ownership` section of the config manifest.
 *
 * @param raw  The value at config `.ownership` (or undefined).
 * @returns    A clean Ownership tree; missing/invalid input -> empty tree.
 */
export function loadOwnershipConfig(raw: unknown): Ownership {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { org: null, projects: [], repos: [] };
  }
  const o = raw as Record<string, unknown>;

  const org = typeof o.org === 'string' && o.org.trim() !== '' ? o.org.trim() : null;

  const projects = Array.isArray(o.projects)
    ? o.projects.map(asProject).filter((p): p is Project => p !== null)
    : [];
  const projectIds = new Set(projects.map((p) => p.id));

  const repos = Array.isArray(o.repos)
    ? o.repos.map(asRepo).filter((r): r is Repo => r !== null)
    : [];

  // Drop dangling project memberships to standalone (null) with a warning.
  for (const r of repos) {
    if (r.projectId !== null && !projectIds.has(r.projectId)) {
      console.warn(
        `[ownership] repo "${r.id}" references unknown project "${r.projectId}"; treating as standalone.`,
      );
      r.projectId = null;
    }
  }

  return { org, projects, repos };
}

/** The project id a repo belongs to, or null if standalone/unknown. */
export function projectForRepo(o: Ownership, repoId: string): string | null {
  const repo = o.repos.find((r) => r.id === repoId);
  return repo ? repo.projectId : null;
}

/**
 * The scope context `{ repoId, projectId? }` used by the registry resolver.
 * A repo not present in the tree yields `{ repoId }` (global + repo scopes only).
 */
export function scopeContextForRepo(o: Ownership, repoId: string): ScopeContext {
  const projectId = projectForRepo(o, repoId);
  return projectId ? { repoId, projectId } : { repoId };
}

/** Reverse lookup: the repo id whose `path` matches `absPath`, or undefined. */
export function repoIdForPath(o: Ownership, absPath: string): string | undefined {
  const repo = o.repos.find((r) => r.path === absPath);
  return repo ? repo.id : undefined;
}
