/**
 * Runtime scoped-context resolution (ONBOARD #597 / #598).
 *
 * Given a target repo's working-copy path, resolve — best-effort, never
 * throwing — the scoped knowledge a pipeline phase session should consume at
 * run time:
 *   - the scoped AGENT for the phase, when a repo/project-scoped agent
 *     overrides the supervisor's hardcoded default (via an injected resolver
 *     that wraps AgentRegistry);
 *   - the scoped MEMORY docs (global -> org -> project -> repo, ACCUMULATED);
 *   - the promoted scoped SKILLS (global + project + repo, most-specific-wins).
 *
 * This is the consume-side counterpart to the Phase 0-2 producers. It is
 * ADDITIVE and SAFE: a repo with no ownership entry (the common case today)
 * resolves to the default agent and empty memory/skill sets, so the caller's
 * behavior is byte-identical to the unscoped path.
 */

import * as fs from 'fs';
import * as path from 'path';

import { artifactScopeDir } from '../artifact-factory/orchestrator';
import { resolveAbsoluteHome } from '../home';
import { scopesForContext, scopeDir } from '../memory/resolver';
import type { MemoryContext } from '../memory/types';
import { repoIdForPath, scopeContextForRepo } from '../ownership/loader';
import type { Ownership, ScopeContext, ArtifactScope } from '../ownership/types';

/** Injectable IO boundary so the resolver is unit-testable without disk. */
export interface ScopeContextIO {
  homedir(): string;
  /** Basenames directly under `dirPath` ([] when missing / not a directory). */
  listDir(dirPath: string): string[];
}

export const defaultScopeContextIO: ScopeContextIO = {
  homedir: () => resolveAbsoluteHome(),
  listDir: (dirPath) => {
    try {
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
        ? fs.readdirSync(dirPath)
        : [];
    } catch {
      return [];
    }
  },
};

/** Resolve a phase's agent name within a scope context. Falsy => keep default. */
export type AgentResolver = (defaultAgent: string, ctx: ScopeContext) => string | undefined;

export interface ResolveScopeOptions {
  /** Absolute path to the target repo's working copy. */
  repoPath: string;
  /** The ownership tree (read by the caller). */
  ownership: Ownership;
  /** Current pipeline phase (informational; used by the agent resolver). */
  phase?: string;
  /** The supervisor's hardcoded default agent for the phase. */
  defaultAgent?: string;
  io?: ScopeContextIO;
  /** Optional registry-backed agent override resolver (injected by the CLI). */
  agentResolver?: AgentResolver;
}

export interface ScopeContextResult {
  /** true only when `repoPath` mapped to a known repo id in the ownership tree. */
  scoped: boolean;
  repoId: string | null;
  projectId: string | null;
  /** The agent to dispatch — the scoped override when present, else the default. */
  agent: string;
  /** Memory docs, general -> specific, ACCUMULATED (read all). */
  memoryPaths: string[];
  /** Promoted skill files, most-specific-scope-wins per basename. */
  skillPaths: string[];
  /** Directories the session needs read access to (parents of the paths above). */
  addDirs: string[];
}

function memoryRoot(io: ScopeContextIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'memory');
}

function artifactsRoot(io: ScopeContextIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'artifacts');
}

function safeList(io: ScopeContextIO, dir: string): string[] {
  try {
    return io.listDir(dir);
  } catch {
    return [];
  }
}

/**
 * Resolve the scoped runtime context for a repo path. Never throws; on any
 * failure (or an unowned repo) returns the unscoped fallback so the caller's
 * default behavior is preserved.
 */
export function resolveScopeContext(opts: ResolveScopeOptions): ScopeContextResult {
  const io = opts.io ?? defaultScopeContextIO;
  const defaultAgent = opts.defaultAgent ?? '';
  const fallback: ScopeContextResult = {
    scoped: false,
    repoId: null,
    projectId: null,
    agent: defaultAgent,
    memoryPaths: [],
    skillPaths: [],
    addDirs: [],
  };

  let repoId: string | undefined;
  try {
    repoId = repoIdForPath(opts.ownership, opts.repoPath);
  } catch {
    return fallback;
  }
  if (!repoId) return fallback;

  const ctx: ScopeContext = scopeContextForRepo(opts.ownership, repoId);

  // ── Memory: ACCUMULATE global -> org -> project -> repo ──
  const memCtx: MemoryContext = {
    orgId: opts.ownership.org ?? undefined,
    projectId: ctx.projectId,
    repoId: ctx.repoId,
  };
  const memoryPaths: string[] = [];
  for (const scope of scopesForContext(memCtx)) {
    const dir = path.join(memoryRoot(io), scopeDir(scope));
    const names = safeList(io, dir)
      .filter((n) => n.endsWith('.md'))
      .sort();
    for (const n of names) memoryPaths.push(path.join(dir, n));
  }

  // ── Skills: most-specific-wins per basename (global + project + repo) ──
  const skillScopes: ArtifactScope[] = ['global'];
  if (ctx.projectId) skillScopes.push(`project:${ctx.projectId}`);
  if (ctx.repoId) skillScopes.push(`repo:${ctx.repoId}`);
  // Walk most-specific -> least so the first writer of each basename wins.
  const winners = new Map<string, string>();
  for (let i = skillScopes.length - 1; i >= 0; i--) {
    const dir = path.join(artifactsRoot(io), artifactScopeDir(skillScopes[i]), 'skills');
    for (const n of safeList(io, dir).filter((f) => f.endsWith('.md'))) {
      if (!winners.has(n)) winners.set(n, path.join(dir, n));
    }
  }
  const skillPaths = [...winners.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((e) => e[1]);

  // ── Agent: scoped override if the registry resolves one, else the default ──
  let agent = defaultAgent;
  if (opts.agentResolver) {
    try {
      const resolved = opts.agentResolver(defaultAgent, ctx);
      if (resolved && resolved.length > 0) agent = resolved;
    } catch {
      // keep default
    }
  }

  const addDirs = new Set<string>();
  for (const p of memoryPaths) addDirs.add(path.dirname(p));
  for (const p of skillPaths) addDirs.add(path.dirname(p));

  return {
    scoped: true,
    repoId,
    projectId: ctx.projectId ?? null,
    agent,
    memoryPaths,
    skillPaths,
    addDirs: [...addDirs].sort(),
  };
}
