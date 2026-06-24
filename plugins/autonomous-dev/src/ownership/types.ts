/**
 * Ownership & scope model types (ONBOARD Phase 0 — epic #583 / issue #584).
 *
 * Org -> Project -> Repo hierarchy plus a flexible grouping-tag dimension, and
 * the artifact-scope primitives shared with the agent registry.
 *
 * Design: docs/tdd/ONBOARD-phase0-ownership-scope.md (ADR-1, ADR-8, ADR-9).
 */

/**
 * Flexible grouping tags, e.g. `{ team: 'payments', domain: 'checkout' }`.
 * Keys are intentionally NOT constrained to an enum — the ratified decision is
 * a flexible tag dimension (default surfaced key "team"; "domain",
 * "product-line", "business-unit", etc. all valid with no schema change).
 */
export interface Tags {
  [key: string]: string;
}

/** A logical grouping of repos (a microservice system, product line, or unit). */
export interface Project {
  /** kebab slug, e.g. 'payments'. */
  id: string;
  name: string;
  tags: Tags;
}

/** A repository, optionally a member of exactly one project. */
export interface Repo {
  /** Remote 'owner/name' (lowercased) or a path-basename slug (ADR-8). */
  id: string;
  /** Local absolute path (an allowlist entry), when known. */
  path?: string;
  /** Remote identifier, e.g. 'github.com/acme/api', when known. */
  remote?: string;
  /** Project membership; null = standalone. */
  projectId: string | null;
  tags: Tags;
  /**
   * ONBOARD Phase 1 (#587): opted into auto-improvement. Default (absent) =
   * NOT enrolled — ingestion is read-only and never auto-enrolls (ingest ≠ enroll).
   */
  participate_in_auto_improvement?: boolean;
}

/** The Org -> projects -> repos tree, persisted in the config manifest. */
export interface Ownership {
  /** Linked GitHub org login, or null when unset. */
  org: string | null;
  projects: Project[];
  repos: Repo[];
}

/**
 * Artifact scope: global (default), or bound to a specific project or repo.
 * Stored verbatim in agent/skill/command frontmatter as `scope:`.
 */
export type ArtifactScope = 'global' | `project:${string}` | `repo:${string}`;

/**
 * The scope context of a request target, used to resolve which scoped
 * artifacts apply. Empty context ({}) means "global only" (back-compat).
 */
export interface ScopeContext {
  repoId?: string;
  projectId?: string;
}
