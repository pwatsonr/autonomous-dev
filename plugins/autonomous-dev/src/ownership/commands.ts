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

import type { Ownership, Project, Repo, Tags } from './types';

export interface CommandResult {
  ownership: Ownership;
  message: string;
}

const ID_RE = /^[a-z0-9-]+$/;
const REPO_ID_RE = /^[a-z0-9/._-]+$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

/** `repo assign <repoId> --project <projectId> [--path <p>] [--remote <r>]` */
export function assignRepo(
  own: Ownership,
  opts: { repoId: string; projectId: string; path?: string; remote?: string },
): CommandResult {
  const repoId = opts.repoId.trim();
  const projectId = opts.projectId.trim();
  if (!REPO_ID_RE.test(repoId)) {
    throw new Error(`Invalid repo id "${repoId}"; use lowercase [a-z0-9/._-] (e.g. owner/name).`);
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
