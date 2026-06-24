/**
 * File-based scoped memory store (ONBOARD Phase 1 — #587).
 *
 * Memory root: `~/.autonomous-dev/memory/{global, org/<id>, project/<id>,
 * repo/<id>}/<topic>.md`. Atomic write-then-rename. IO is injected so the
 * resolution/store logic is unit-testable without touching disk (NFR-4),
 * mirroring src/ownership/store.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { MemoryScope, MemoryContext, MemoryDoc, MemoryLayer, ResolvedMemory } from './types';
import { scopesForContext, scopeDir } from './resolver';
import { resolveAbsoluteHome } from '../home';

/** Injectable IO boundary for the memory tree. */
export interface MemoryStoreIO {
  homedir(): string;
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, data: string): void;
  /** File names directly under `dirPath` ([] if it does not exist). */
  listDir(dirPath: string): string[];
}

export const defaultMemoryIO: MemoryStoreIO = {
  homedir: () => resolveAbsoluteHome(),
  readFile: (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined),
  writeFile: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  },
  listDir: (dirPath) =>
    fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory() ? fs.readdirSync(dirPath) : [],
};

const TOPIC_RE = /^[a-z0-9._-]+$/i;
const SCOPE_ID_RE = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/i;
const SCOPE_KINDS = new Set(['org', 'project', 'repo']);

/**
 * A scope is safe to turn into a directory path iff it is `global`, or a known
 * kind (org/project/repo) whose id has no traversal (`..`), no empty/absolute
 * segment (`//`), and matches the id charset. Defense-in-depth so a
 * malformed/hostile id — or an `as`-cast scope with an unknown prefix — can
 * never make a memory write/read escape the memory root (R1).
 */
function isSafeScope(scope: MemoryScope): boolean {
  if (scope === 'global') return true;
  const idx = scope.indexOf(':');
  if (idx < 0) return false;
  const kind = scope.slice(0, idx);
  const id = scope.slice(idx + 1);
  return SCOPE_KINDS.has(kind) && SCOPE_ID_RE.test(id) && !id.includes('..') && !id.includes('//');
}

/** Absolute path of the memory root. */
export function memoryRoot(io: MemoryStoreIO = defaultMemoryIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'memory');
}

/** Read all `*.md` memory docs at a scope (sorted by topic). */
export function readScopeMemory(
  scope: MemoryScope,
  io: MemoryStoreIO = defaultMemoryIO,
): MemoryDoc[] {
  if (!isSafeScope(scope)) return []; // skip an unsafe scope rather than crash resolution
  const dir = path.join(memoryRoot(io), scopeDir(scope));
  const docs: MemoryDoc[] = [];
  for (const name of [...io.listDir(dir)].sort()) {
    if (!name.endsWith('.md')) continue;
    const content = io.readFile(path.join(dir, name));
    if (content !== undefined) docs.push({ topic: name.replace(/\.md$/, ''), content });
  }
  return docs;
}

/** Write a memory doc at a scope (`<scope-dir>/<topic>.md`). */
export function writeMemoryDoc(
  scope: MemoryScope,
  topic: string,
  content: string,
  io: MemoryStoreIO = defaultMemoryIO,
): void {
  if (!TOPIC_RE.test(topic)) {
    throw new Error(`Invalid memory topic "${topic}"; use [a-z0-9._-].`);
  }
  if (!isSafeScope(scope)) {
    throw new Error(`Refusing to write memory: unsafe scope id in "${scope}".`);
  }
  io.writeFile(path.join(memoryRoot(io), scopeDir(scope), `${topic}.md`), content);
}

/**
 * Resolve the layered memory for a context — every applicable scope's docs in
 * general→specific order (global, then org, project, repo). The consumer reads
 * all layers; specificity increases down the stack.
 */
export function resolveMemory(
  ctx: MemoryContext,
  io: MemoryStoreIO = defaultMemoryIO,
): ResolvedMemory {
  const layers: MemoryLayer[] = scopesForContext(ctx).map((scope) => ({
    scope,
    docs: readScopeMemory(scope, io),
  }));
  return { context: ctx, layers };
}
