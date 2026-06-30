/**
 * Tests for the runtime scoped-context resolver (ONBOARD #597 / #598).
 *
 * Covers: unowned repo -> unscoped fallback (byte-identical default), memory
 * ACCUMULATION (general -> specific), skill most-specific-wins per basename,
 * agent override via the injected resolver, and addDirs derivation.
 */

import * as path from 'path';

import type { Ownership } from '../../src/ownership/types';
import { resolveScopeContext, type ScopeContextIO } from '../../src/runner/scope-context';

const HOME = '/home/test';
const MEM = path.join(HOME, '.autonomous-dev', 'memory');
const ART = path.join(HOME, '.autonomous-dev', 'artifacts');

/** Fake IO driven by a basename map keyed on absolute dir path. */
function makeIO(dirs: Record<string, string[]>): ScopeContextIO {
  return {
    homedir: () => HOME,
    listDir: (dirPath) => dirs[dirPath] ?? [],
  };
}

const ownership: Ownership = {
  org: null,
  projects: [{ id: 'acme', name: 'Acme', tags: {} }],
  repos: [
    { id: 'acme/api', projectId: 'acme', path: '/work/api', tags: {} },
    { id: 'solo/cli', projectId: null, path: '/work/cli', tags: {} },
  ],
};

describe('resolveScopeContext', () => {
  it('returns the unscoped fallback for a repo not in the ownership tree', () => {
    const io = makeIO({});
    const r = resolveScopeContext({
      repoPath: '/somewhere/unknown',
      ownership,
      phase: 'code',
      defaultAgent: 'code-executor',
      io,
    });
    expect(r.scoped).toBe(false);
    expect(r.repoId).toBeNull();
    expect(r.projectId).toBeNull();
    expect(r.agent).toBe('code-executor');
    expect(r.memoryPaths).toEqual([]);
    expect(r.skillPaths).toEqual([]);
    expect(r.addDirs).toEqual([]);
  });

  it('accumulates memory general -> specific and ignores non-.md files', () => {
    const io = makeIO({
      [path.join(MEM, 'global')]: ['standards.md', 'notes.txt'],
      [path.join(MEM, 'project', 'acme')]: ['architecture.md'],
      [path.join(MEM, 'repo', 'acme/api')]: ['conventions.md'],
    });
    const r = resolveScopeContext({
      repoPath: '/work/api',
      ownership,
      phase: 'code',
      defaultAgent: 'code-executor',
      io,
    });
    expect(r.scoped).toBe(true);
    expect(r.repoId).toBe('acme/api');
    expect(r.projectId).toBe('acme');
    expect(r.memoryPaths).toEqual([
      path.join(MEM, 'global', 'standards.md'),
      path.join(MEM, 'project', 'acme', 'architecture.md'),
      path.join(MEM, 'repo', 'acme/api', 'conventions.md'),
    ]);
  });

  it('resolves skills with most-specific scope winning per basename', () => {
    const io = makeIO({
      [path.join(ART, 'global', 'skills')]: ['common.md', 'dup.md'],
      [path.join(ART, 'project', 'acme', 'skills')]: ['proj.md'],
      [path.join(ART, 'repo', 'acme/api', 'skills')]: ['dup.md', 'repoonly.md'],
    });
    const r = resolveScopeContext({
      repoPath: '/work/api',
      ownership,
      defaultAgent: 'code-executor',
      io,
    });
    // dup.md must come from the repo scope (most specific), not global.
    expect(r.skillPaths).toEqual([
      path.join(ART, 'global', 'skills', 'common.md'),
      path.join(ART, 'repo', 'acme/api', 'skills', 'dup.md'),
      path.join(ART, 'project', 'acme', 'skills', 'proj.md'),
      path.join(ART, 'repo', 'acme/api', 'skills', 'repoonly.md'),
    ]);
    // addDirs are the unique parent dirs of the resolved paths.
    expect(r.addDirs).toContain(path.join(ART, 'global', 'skills'));
    expect(r.addDirs).toContain(path.join(ART, 'repo', 'acme/api', 'skills'));
    expect(r.addDirs).toContain(path.join(ART, 'project', 'acme', 'skills'));
  });

  it('applies the scoped agent override from the injected resolver', () => {
    const io = makeIO({});
    const r = resolveScopeContext({
      repoPath: '/work/api',
      ownership,
      phase: 'code',
      defaultAgent: 'code-executor',
      io,
      agentResolver: (def, ctx) => (ctx.repoId === 'acme/api' ? 'code-executor-acme' : def),
    });
    expect(r.agent).toBe('code-executor-acme');
  });

  it('keeps the default agent when the resolver returns the default or falsy', () => {
    const io = makeIO({});
    const keepDefault = resolveScopeContext({
      repoPath: '/work/api',
      ownership,
      phase: 'code',
      defaultAgent: 'code-executor',
      io,
      agentResolver: (def) => def,
    });
    expect(keepDefault.agent).toBe('code-executor');

    const falsy = resolveScopeContext({
      repoPath: '/work/api',
      ownership,
      phase: 'code',
      defaultAgent: 'code-executor',
      io,
      agentResolver: () => undefined,
    });
    expect(falsy.agent).toBe('code-executor');
  });

  it('handles a standalone repo (no project) without a project memory layer', () => {
    const io = makeIO({
      [path.join(MEM, 'global')]: ['standards.md'],
      [path.join(MEM, 'repo', 'solo/cli')]: ['cli.md'],
    });
    const r = resolveScopeContext({
      repoPath: '/work/cli',
      ownership,
      defaultAgent: 'code-executor',
      io,
    });
    expect(r.scoped).toBe(true);
    expect(r.repoId).toBe('solo/cli');
    expect(r.projectId).toBeNull();
    expect(r.memoryPaths).toEqual([
      path.join(MEM, 'global', 'standards.md'),
      path.join(MEM, 'repo', 'solo/cli', 'cli.md'),
    ]);
  });
});
