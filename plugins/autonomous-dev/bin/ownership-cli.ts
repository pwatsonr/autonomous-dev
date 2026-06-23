#!/usr/bin/env bun
/**
 * Ownership CLI (ONBOARD Phase 0 — #584). Dispatched from autonomous-dev.sh:
 *
 *   autonomous-dev project add <id> [--name <n>] [--tag k=v ...]
 *   autonomous-dev project list
 *   autonomous-dev repo assign <repoId> --project <pid> [--path <p>] [--remote <r>]
 *   autonomous-dev repo tag <repoId> --set k=v [--set k=v ...]
 *   autonomous-dev repo list [--project <pid>]
 *
 * Reads/writes the ownership tree in ~/.claude/autonomous-dev.json via the
 * store, applying one pure command from src/ownership/commands.
 */

import {
  addProject,
  assignRepo,
  tagRepo,
  listProjects,
  listRepos,
} from '../src/ownership/commands';
import { readOwnership, writeOwnership } from '../src/ownership/store';

const USAGE = `Usage:
  autonomous-dev project add <id> [--name <name>] [--tag k=v ...]
  autonomous-dev project list
  autonomous-dev repo assign <repoId> --project <projectId> [--path <p>] [--remote <r>]
  autonomous-dev repo tag <repoId> --set k=v [--set k=v ...]
  autonomous-dev repo list [--project <projectId>]`;

/** First positional argument (the id), or '' if the next token is a flag. */
function positional(args: string[]): string {
  return args[0] && !args[0].startsWith('--') ? args[0] : '';
}

/** Value following the first occurrence of `--flag`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** All values following each occurrence of `--flag`. */
function multi(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

function main(argv: string[]): number {
  const [family, verb, ...rest] = argv;
  try {
    if (family === 'project' && verb === 'add') {
      const { ownership, message } = addProject(readOwnership(), {
        id: positional(rest),
        name: flag(rest, '--name'),
        tags: multi(rest, '--tag'),
      });
      writeOwnership(ownership);
      process.stdout.write(`${message}\n`);
      return 0;
    }
    if (family === 'project' && verb === 'list') {
      process.stdout.write(`${listProjects(readOwnership())}\n`);
      return 0;
    }
    if (family === 'repo' && verb === 'assign') {
      const { ownership, message } = assignRepo(readOwnership(), {
        repoId: positional(rest),
        projectId: flag(rest, '--project') ?? '',
        path: flag(rest, '--path'),
        remote: flag(rest, '--remote'),
      });
      writeOwnership(ownership);
      process.stdout.write(`${message}\n`);
      return 0;
    }
    if (family === 'repo' && verb === 'tag') {
      const { ownership, message } = tagRepo(readOwnership(), {
        repoId: positional(rest),
        set: multi(rest, '--set'),
      });
      writeOwnership(ownership);
      process.stdout.write(`${message}\n`);
      return 0;
    }
    if (family === 'repo' && verb === 'list') {
      process.stdout.write(`${listRepos(readOwnership(), flag(rest, '--project'))}\n`);
      return 0;
    }
    process.stderr.write(`${USAGE}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
