/**
 * Scoped memory model (ONBOARD Phase 1 — epic #583 / issue #587).
 *
 * Hierarchical knowledge memory: global → org → project → repo, **accumulated**
 * general→specific (more detail the closer you get to the source — operator's
 * vision). Mirrors the Phase 0 ownership/scope pattern, extended with an `org`
 * tier. Unlike config/standards (most-specific-wins OVERRIDE), knowledge memory
 * ACCUMULATES: a consumer reads every applicable layer, general→specific.
 */

export type MemoryScope = 'global' | `org:${string}` | `project:${string}` | `repo:${string}`;

/** The target whose memory we resolve. Empty context => just `global`. */
export interface MemoryContext {
  orgId?: string;
  projectId?: string;
  repoId?: string;
}

/** A single memory document at a scope (e.g. `repo/<id>/architecture.md`). */
export interface MemoryDoc {
  /** File stem, e.g. 'standards', 'architecture', 'conventions'. */
  topic: string;
  content: string;
}

/** One scope's layer in a resolved stack. */
export interface MemoryLayer {
  scope: MemoryScope;
  docs: MemoryDoc[];
}

/** Resolved memory = the applicable layers in general→specific order. */
export interface ResolvedMemory {
  context: MemoryContext;
  layers: MemoryLayer[];
}
