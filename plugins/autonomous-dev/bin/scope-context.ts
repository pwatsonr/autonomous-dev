#!/usr/bin/env bun
/**
 * scope-context.ts — runtime scoped-context resolver CLI (ONBOARD #597 / #598).
 *
 * Given a target repo path, emit the resolved scoped agent / memory / skill
 * context as JSON for the bash run path (bin/supervisor-loop.sh) to consume.
 *
 * This is the seam between the daemon's bash hot path and the TS scope/registry
 * logic. It is BEST-EFFORT by contract: any failure prints a safe fallback JSON
 * (the unscoped default) and exits 0, so the daemon's default behavior can never
 * be broken by scope resolution.
 *
 * Usage:
 *   scope-context.ts --repo <path> [--phase <phase>] [--default-agent <name>]
 *
 * Output (stdout, single line JSON):
 *   {
 *     "scoped": boolean,
 *     "repoId": string|null,
 *     "projectId": string|null,
 *     "agent": string,            // scoped override, else the default
 *     "memoryPaths": string[],    // general -> specific, read all
 *     "skillPaths": string[],     // most-specific scope wins per name
 *     "addDirs": string[]         // dirs to grant the session read access to
 *   }
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readOwnership } from '../src/ownership/store';
import { AgentRegistry } from '../src/agent-factory/registry';
import type { ScopeContext } from '../src/ownership/types';
import {
  resolveScopeContext,
  type AgentResolver,
  type ScopeContextResult,
} from '../src/runner/scope-context';

function parseArgs(argv: string[]): { repo?: string; phase?: string; defaultAgent?: string } {
  const out: { repo?: string; phase?: string; defaultAgent?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--phase') out.phase = argv[++i];
    else if (a === '--default-agent') out.defaultAgent = argv[++i];
  }
  return out;
}

function emit(result: ScopeContextResult): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function main(): Promise<number> {
  const { repo, phase, defaultAgent = '' } = parseArgs(process.argv.slice(2));

  // The unscoped fallback — printed on every early/error exit so the bash
  // caller always receives valid JSON and keeps its default behavior.
  const fallback: ScopeContextResult = {
    scoped: false,
    repoId: null,
    projectId: null,
    agent: defaultAgent,
    memoryPaths: [],
    skillPaths: [],
    addDirs: [],
  };

  if (!repo) {
    emit(fallback);
    return 0;
  }

  try {
    const ownership = readOwnership();

    // Build a registry-backed agent resolver. Loading the registry can fail
    // (missing agents dir, parse errors); if so we resolve with no override.
    let agentResolver: AgentResolver | undefined;
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const agentsDir = resolve(here, '..', 'agents');
      const registry = new AgentRegistry();
      const load = await registry.load(agentsDir);
      if (load.loaded > 0) {
        agentResolver = (def: string, ctx: ScopeContext): string | undefined => {
          // Prefer a NON-GLOBAL (repo/project-scoped) agent tagged for the
          // phase. Global matches are ignored so the supervisor's default is
          // only overridden by an explicitly scoped agent — conservative.
          const ranked = registry.getForTask(phase ?? '', phase ?? '', ctx);
          const scoped = ranked.find(
            (r) => (r.agent.agent.scope ?? 'global') !== 'global',
          );
          return scoped ? scoped.agent.agent.name : def;
        };
      }
    } catch {
      agentResolver = undefined;
    }

    const result = resolveScopeContext({
      repoPath: repo,
      ownership,
      phase,
      defaultAgent,
      agentResolver,
    });
    emit(result);
    return 0;
  } catch {
    emit(fallback);
    return 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch(() => {
    // Last-resort guard: never throw out of the CLI.
    process.stdout.write(
      JSON.stringify({
        scoped: false,
        repoId: null,
        projectId: null,
        agent: '',
        memoryPaths: [],
        skillPaths: [],
        addDirs: [],
      }) + '\n',
    );
    process.exit(0);
  });
