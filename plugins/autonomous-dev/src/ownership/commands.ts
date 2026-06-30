/**
 * Ownership CLI command logic (ONBOARD Phase 0 — #584).
 *
 * Pure functions over an `Ownership` tree: each returns the mutated tree plus a
 * human message, or throws a validation Error. No IO here — the CLI wrapper
 * reads via the store, applies one of these, and writes back. This keeps the
 * mutation rules unit-testable without touching the manifest (NFR-4).
 *
 * Backs CLI verbs: `project add|list`, `repo assign|tag`. Used by the AC1/AC4
 * acceptance ("a repo can be assigned to a project"; "a grouping tag can be set
 * and listed; vocabulary not hardcoded").
 */

import type { Ownership, Project, Repo, Tags, ArtifactScope } from './types';

export interface CommandResult {
  ownership: Ownership;
  message: string;
}

const ID_RE = /^[a-z0-9-]+$/;
// owner/name or a path-basename slug (ADR-8), anchored so it can't start/end with
// a separator. isSafeRepoId additionally rejects traversal (`..`) and `//` so the
// id can never escape a directory when used as a memory/clone path segment.
const REPO_ID_RE = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/;
const ORG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A repo id safe to use as a filesystem path segment (no traversal). */
function isSafeRepoId(id: string): boolean {
  return REPO_ID_RE.test(id) && !id.includes('..') && !id.includes('//');
}

/** A valid GitHub org/user login (1–39 chars, no leading/trailing dash). */
export function isOrgLogin(s: string): boolean {
  return ORG_RE.test(s) && s.length >= 1 && s.length <= 39;
}

/** Parse `key=value` tag pairs into a Tags map. Throws on malformed input. */
export function parseTags(pairs: string[]): Tags {
  const tags: Tags = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(`Invalid tag "${pair}"; expected key=value.`);
    }
    const key = pair.slice(0, eq).trim();
    if (key === '') {
      throw new Error(`Invalid tag "${pair}"; empty key.`);
    }
    if (UNSAFE_KEYS.has(key)) {
      throw new Error(`Invalid tag key "${key}".`);
    }
    const value = pair.slice(eq + 1).trim();
    if (value === '') {
      throw new Error(`Invalid tag "${pair}"; empty value.`);
    }
    tags[key] = value;
  }
  return tags;
}

/** `project add <id> [--name <name>] [--tag k=v ...]` */
export function addProject(
  own: Ownership,
  opts: { id: string; name?: string; tags?: string[] },
): CommandResult {
  const id = opts.id.trim();
  if (!ID_RE.test(id)) {
    throw new Error(`Invalid project id "${id}"; use kebab-case ([a-z0-9-]).`);
  }
  if (own.projects.some((p) => p.id === id)) {
    throw new Error(`Project "${id}" already exists.`);
  }
  const project: Project = {
    id,
    name: opts.name?.trim() || id,
    tags: parseTags(opts.tags ?? []),
  };
  return {
    ownership: { ...own, projects: [...own.projects, project] },
    message: `Added project "${id}".`,
  };
}

/** `org link <org>` — record the linked GitHub org login (ONBOARD Phase 1 #587). */
export function linkOrg(own: Ownership, org: string): CommandResult {
  const login = org.trim();
  if (!isOrgLogin(login)) {
    throw new Error(
      `Invalid org login "${login}"; 1–39 GitHub login chars ([a-z0-9-], no leading/trailing dash).`,
    );
  }
  return { ownership: { ...own, org: login }, message: `Linked org "${login}".` };
}

/**
 * Register repo ids as STANDALONE (projectId null), UNENROLLED — idempotent.
 * Used by `org ingest` to record crawled repos. Ingestion ≠ enroll: a freshly
 * ingested repo is never auto-enrolled in auto-improvement (FR-G2 / AC4). Malformed
 * ids (best-effort crawl output) are skipped, not fatal.
 */
export function registerRepos(own: Ownership, repoIds: string[]): CommandResult {
  const repos = [...own.repos];
  const skipped: string[] = [];
  let added = 0;
  for (const raw of repoIds) {
    const repoId = raw.trim().toLowerCase();
    if (!isSafeRepoId(repoId)) {
      skipped.push(raw);
      continue;
    }
    if (repos.some((r) => r.id === repoId)) continue; // already known — leave membership/enrollment intact
    repos.push({ id: repoId, projectId: null, tags: {} });
    added++;
  }
  const note = skipped.length ? ` (skipped ${skipped.length} malformed)` : '';
  return {
    ownership: { ...own, repos },
    message: `Registered ${added} new repo(s) as standalone + unenrolled${note}.`,
  };
}

/** `repo assign <repoId> --project <projectId> [--path <p>] [--remote <r>]` */
export function assignRepo(
  own: Ownership,
  opts: { repoId: string; projectId: string; path?: string; remote?: string },
): CommandResult {
  const repoId = opts.repoId.trim();
  const projectId = opts.projectId.trim();
  if (!isSafeRepoId(repoId)) {
    throw new Error(
      `Invalid repo id "${repoId}"; use lowercase [a-z0-9/._-] (e.g. owner/name), no "..".`,
    );
  }
  if (!own.projects.some((p) => p.id === projectId)) {
    throw new Error(
      `Unknown project "${projectId}". Create it first: autonomous-dev project add ${projectId}`,
    );
  }
  const repos = [...own.repos];
  const idx = repos.findIndex((r) => r.id === repoId);
  if (idx >= 0) {
    repos[idx] = {
      ...repos[idx],
      projectId,
      path: opts.path ?? repos[idx].path,
      remote: opts.remote ?? repos[idx].remote,
    };
  } else {
    repos.push({ id: repoId, projectId, path: opts.path, remote: opts.remote, tags: {} });
  }
  return {
    ownership: { ...own, repos },
    message: `Assigned repo "${repoId}" to project "${projectId}".`,
  };
}

/** `repo tag <repoId> --set k=v ...` (vocabulary not constrained — AC4) */
export function tagRepo(own: Ownership, opts: { repoId: string; set: string[] }): CommandResult {
  const repoId = opts.repoId.trim();
  if (!isSafeRepoId(repoId)) {
    throw new Error(`Invalid repo id "${repoId}".`);
  }
  const repos = [...own.repos];
  const idx = repos.findIndex((r) => r.id === repoId);
  if (idx < 0) {
    throw new Error(`Unknown repo "${repoId}". Assign it to a project first.`);
  }
  const tags = { ...repos[idx].tags, ...parseTags(opts.set) };
  repos[idx] = { ...repos[idx], tags };
  return {
    ownership: { ...own, repos },
    message: `Updated tags on repo "${repoId}".`,
  };
}

/** `project list` — human-readable summary. */
export function listProjects(own: Ownership): string {
  if (own.projects.length === 0) return '(no projects)';
  return own.projects
    .map((p: Project) => {
      const repos = own.repos.filter((r) => r.projectId === p.id).map((r) => r.id);
      const tags = Object.entries(p.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      return `${p.id}  "${p.name}"${tags ? `  [${tags}]` : ''}  repos: ${repos.join(', ') || '-'}`;
    })
    .join('\n');
}

/** `repo list [--project <id>]` — human-readable summary. */
export function listRepos(own: Ownership, projectId?: string): string {
  const repos: Repo[] = projectId ? own.repos.filter((r) => r.projectId === projectId) : own.repos;
  if (repos.length === 0) return '(no repos)';
  return repos
    .map((r) => {
      const tags = Object.entries(r.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      const enrolled = r.participate_in_auto_improvement === true ? '  *enrolled*' : '';
      return `${r.id}  project: ${r.projectId ?? '-'}${enrolled}${tags ? `  [${tags}]` : ''}`;
    })
    .join('\n');
}

/** `repo enroll|unenroll <repoId>` — flip the auto-improvement opt-in (AC4). */
export function setEnrollment(
  own: Ownership,
  opts: { repoId: string; enrolled: boolean },
): CommandResult {
  const repoId = opts.repoId.trim();
  if (!isSafeRepoId(repoId)) {
    throw new Error(`Invalid repo id "${repoId}".`);
  }
  const repos = [...own.repos];
  const idx = repos.findIndex((r) => r.id === repoId);
  if (idx < 0) {
    throw new Error(`Unknown repo "${repoId}". Assign or ingest it first.`);
  }
  repos[idx] = {
    ...repos[idx],
    participate_in_auto_improvement: opts.enrolled ? true : undefined,
  };
  return {
    ownership: { ...own, repos },
    message: `Repo "${repoId}" ${opts.enrolled ? 'ENROLLED in' : 'unenrolled from'} auto-improvement.`,
  };
}

/** Whether a repo is enrolled in auto-improvement. Default (ingest≠enroll) = false. */
export function isEnrolled(own: Ownership, repoId: string): boolean {
  return own.repos.find((r) => r.id === repoId)?.participate_in_auto_improvement === true;
}

/** The repo id of a `repo:<id>` artifact scope, else undefined (global/project). */
export function repoIdFromScope(scope: ArtifactScope): string | undefined {
  return scope.startsWith('repo:') ? scope.slice('repo:'.length) : undefined;
}

/**
 * The AUTO-IMPROVEMENT enrollment gate (ONBOARD FR-G2). PROACTIVE
 * auto-generation/improvement of a REPO-scoped artifact is permitted only if that
 * repo is enrolled (opt-in; ingestion never enrolls). Global/project-scoped
 * artifacts are not repo-gated here. Fail-closed: an unknown/unenrolled repo
 * returns false.
 *
 * This is the single canonical gate that Phase 2 (scoped auto-generation) and
 * Phase 4 (scoped triggers) MUST consult before acting on a repo absent an
 * explicit operator request. (Operator-requested work is NOT gated by this —
 * enrollment governs proactive behavior, not requested behavior.)
 */
export function mayAutoImproveScope(own: Ownership, scope: ArtifactScope): boolean {
  const repoId = repoIdFromScope(scope);
  if (repoId === undefined) return true; // global / project — not repo-gated in Phase 1
  return isEnrolled(own, repoId);
}
