import { scopesForContext, scopeDir } from '../../src/memory/resolver';
import {
  readScopeMemory,
  writeMemoryDoc,
  resolveMemory,
  memoryRoot,
} from '../../src/memory/store';
import type { MemoryStoreIO } from '../../src/memory/store';

/**
 * Unit tests for the scoped memory module (ONBOARD Phase 1, #587).
 * Pure resolver + an injected fake IO — never touches real operator state.
 */

function fakeIO(): MemoryStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p: string) => files[p],
    writeFile: (p: string, data: string) => {
      files[p] = data;
    },
    listDir: (dir: string) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (rest.length > 0 && !rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

function test_scopes_for_context(): void {
  assert(JSON.stringify(scopesForContext({})) === JSON.stringify(['global']), 'empty => global only');
  assert(
    JSON.stringify(scopesForContext({ orgId: 'o', projectId: 'p', repoId: 'r' })) ===
      JSON.stringify(['global', 'org:o', 'project:p', 'repo:r']),
    'full hierarchy general->specific',
  );
  // skipped levels: repo without project still lists global + org? no org -> global + repo
  assert(
    JSON.stringify(scopesForContext({ repoId: 'acme/api' })) ===
      JSON.stringify(['global', 'repo:acme/api']),
    'repo only => global + repo',
  );
  console.log('PASS: test_scopes_for_context');
}

function test_scope_dir(): void {
  assert(scopeDir('global') === 'global', 'global dir');
  assert(scopeDir('org:acme') === 'org/acme', 'org dir');
  assert(scopeDir('project:payments') === 'project/payments', 'project dir');
  assert(scopeDir('repo:acme/api') === 'repo/acme/api', 'repo dir (id keeps slash)');
  console.log('PASS: test_scope_dir');
}

function test_write_read_roundtrip(): void {
  const io = fakeIO();
  writeMemoryDoc('repo:acme/api', 'architecture', '# Arch\nhex', io);
  writeMemoryDoc('repo:acme/api', 'standards', '# Standards', io);
  // written under the right path
  assert(
    io.files[`${memoryRoot(io)}/repo/acme/api/architecture.md`] === '# Arch\nhex',
    'doc written to scoped path',
  );
  const docs = readScopeMemory('repo:acme/api', io);
  assert(docs.length === 2, 'two docs read');
  assert(docs[0].topic === 'architecture' && docs[1].topic === 'standards', 'sorted by topic');
  assert(docs[0].content === '# Arch\nhex', 'content preserved');
  // invalid topic rejected
  let threw = false;
  try {
    writeMemoryDoc('global', 'bad topic!', 'x', io);
  } catch {
    threw = true;
  }
  assert(threw, 'invalid topic rejected');
  // unknown scope dir => empty
  assert(readScopeMemory('project:none', io).length === 0, 'empty scope => no docs');
  console.log('PASS: test_write_read_roundtrip');
}

function test_resolve_memory_layers(): void {
  const io = fakeIO();
  writeMemoryDoc('global', 'patterns', 'G', io);
  writeMemoryDoc('org:acme', 'conventions', 'O', io);
  writeMemoryDoc('project:payments', 'architecture', 'P', io);
  writeMemoryDoc('repo:acme/api', 'learnings', 'R', io);

  const resolved = resolveMemory({ orgId: 'acme', projectId: 'payments', repoId: 'acme/api' }, io);
  assert(resolved.layers.length === 4, 'four layers');
  assert(
    resolved.layers.map((l) => l.scope).join(',') === 'global,org:acme,project:payments,repo:acme/api',
    'layers general->specific',
  );
  assert(resolved.layers[0].docs[0].content === 'G', 'global layer doc');
  assert(resolved.layers[3].docs[0].content === 'R', 'repo layer doc (most specific)');

  // empty context => just the global layer
  const justGlobal = resolveMemory({}, io);
  assert(justGlobal.layers.length === 1 && justGlobal.layers[0].scope === 'global', 'empty ctx => global only');
  console.log('PASS: test_resolve_memory_layers');
}

// P1 review: a traversal-shaped scope id must never write/read outside the memory root
function test_scope_id_traversal_guard(): void {
  const io = fakeIO();
  for (const bad of ['repo:../../etc/passwd', 'repo:a/../b', 'repo:a//b', 'project:..', 'foo:bar']) {
    let threw = false;
    try {
      writeMemoryDoc(bad as Parameters<typeof writeMemoryDoc>[0], 'overview', 'x', io);
    } catch {
      threw = true;
    }
    assert(threw, `writeMemoryDoc refuses unsafe scope "${bad}"`);
    // read skips (returns []) rather than crashing resolution
    assert(readScopeMemory(bad as Parameters<typeof readScopeMemory>[0], io).length === 0, `read skips unsafe scope "${bad}"`);
  }
  // nothing escaped the memory root
  const escaped = Object.keys(io.files).some((p) => !p.startsWith(memoryRoot(io)) || p.includes('..'));
  assert(!escaped, 'no file written outside the memory root');
  console.log('PASS: test_scope_id_traversal_guard');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('memory (scoped)', () => {
  it('test_scopes_for_context', test_scopes_for_context);
  it('test_scope_dir', test_scope_dir);
  it('test_write_read_roundtrip', test_write_read_roundtrip);
  it('test_resolve_memory_layers', test_resolve_memory_layers);
  it('test_scope_id_traversal_guard', test_scope_id_traversal_guard);
});
