#!/usr/bin/env bun
/**
 * Artifact-factory CLI (ONBOARD Phase 2 — #590). Dispatched from autonomous-dev.sh:
 *
 *   autonomous-dev artifact propose --repo <id> | --project <id>
 *   autonomous-dev artifact list [--status pending_meta_review|meta_approved|meta_rejected|promoted|rejected]
 *   autonomous-dev artifact show <id>
 *   autonomous-dev artifact accept <id> [--allow-tool <Tool> ...]
 *   autonomous-dev artifact reject <id>
 *
 * Thin wrapper: the pipeline lives in src/artifact-factory (typed + unit-tested).
 * `propose` invokes the real model via the headless `claude` runtime + the
 * artifact-meta-reviewer's system prompt. Generated skills are PARKED; nothing is
 * applied until `accept`, which writes ONLY to the platform's scoped artifact
 * store (~/.autonomous-dev/artifacts/...) — never a crawled repo (R1).
 */

import * as fs from 'fs';
import * as path from 'path';

import { readOwnership } from '../src/ownership/store';
import { proposeArtifacts, promoteProposal, rejectProposal } from '../src/artifact-factory/orchestrator';
import { listProposals, getProposal } from '../src/artifact-factory/proposal-store';
import { claudeArtifactRuntime } from '../src/artifact-factory/runtime';
import { extractFrontmatter, serializeArtifact } from '../src/artifact-factory/parser';

const USAGE = `Usage:
  autonomous-dev artifact propose --repo <id> | --project <id>
  autonomous-dev artifact list [--status <status>]
  autonomous-dev artifact show <id>
  autonomous-dev artifact accept <id> [--allow-tool <Tool> ...]
  autonomous-dev artifact reject <id>`;

function positional(args: string[], i = 0): string {
  return args[i] && !args[i].startsWith('--') ? args[i] : '';
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  const v = args[idx + 1];
  return v.startsWith('--') ? undefined : v;
}

function multi(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length && !args[i + 1].startsWith('--')) out.push(args[i + 1]);
  }
  return out;
}

/** The artifact-meta-reviewer agent's body, used as the meta-review system prompt. */
function reviewerSystemPrompt(): string | undefined {
  try {
    const md = fs.readFileSync(path.join(import.meta.dir, '..', 'agents', 'artifact-meta-reviewer.md'), 'utf-8');
    return extractFrontmatter(md)?.body;
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;

  if (verb === 'propose') {
    const own = readOwnership();
    const repo = flag(rest, '--repo');
    const project = flag(rest, '--project');
    let repoIds: string[];
    if (repo) {
      repoIds = [repo];
    } else if (project) {
      repoIds = own.repos.filter((r) => r.projectId === project).map((r) => r.id);
      if (repoIds.length === 0) {
        process.stderr.write(`No repos in project "${project}". Assign some first.\n`);
        return 1;
      }
    } else {
      process.stderr.write('Specify --repo <id> or --project <id>.\n');
      return 1;
    }
    process.stdout.write(`Proposing scoped skills from ${repoIds.length} repo(s)…\n`);
    const { proposals, skipped } = await proposeArtifacts({
      repoIds,
      ownership: own,
      runtime: claudeArtifactRuntime(),
      reviewerSystemPrompt: reviewerSystemPrompt(),
    });
    if (proposals.length === 0 && skipped.length === 0) {
      process.stdout.write('No opportunities detected.\n');
      return 0;
    }
    for (const p of proposals) {
      const mark = p.status === 'meta_approved' ? '[approved]' : '[rejected]';
      process.stdout.write(`${mark} ${p.scope}  ${p.name}  (${Math.round(p.confidence * 100)}%)  id=${p.id}\n`);
    }
    for (const s of skipped) process.stdout.write(`· skipped ${s.scope} ${s.suggestedName}: ${s.reason}\n`);
    process.stdout.write('\nReview: autonomous-dev artifact show <id>; promote: autonomous-dev artifact accept <id>\n');
    return 0;
  }

  if (verb === 'list') {
    const status = flag(rest, '--status');
    const ps = listProposals(undefined, status ? { status: status as never } : undefined);
    if (ps.length === 0) {
      process.stdout.write('(no proposals)\n');
      return 0;
    }
    for (const p of ps) {
      process.stdout.write(`${p.status.padEnd(20)} ${p.scope}  ${p.name}  id=${p.id}\n`);
    }
    return 0;
  }

  if (verb === 'show') {
    const id = positional(rest);
    const p = getProposal(id);
    if (!p) {
      process.stderr.write(`Unknown proposal "${id}".\n`);
      return 1;
    }
    process.stdout.write(`# ${p.name}  [${p.status}]  scope=${p.scope}  confidence=${Math.round(p.confidence * 100)}%\n`);
    process.stdout.write(`rationale: ${p.rationale}\n`);
    process.stdout.write(`evidence:\n  ${p.evidence.join('\n  ')}\n`);
    if (p.constraintViolations?.length) {
      process.stdout.write(`constraint violations:\n  ${p.constraintViolations.map((v) => `${v.rule}: ${v.detail}`).join('\n  ')}\n`);
    }
    if (p.metaReview) {
      process.stdout.write(`meta-review: ${p.metaReview.verdict}\n`);
      for (const f of p.metaReview.findings) process.stdout.write(`  [${f.severity}] ${f.message}\n`);
    }
    process.stdout.write(`\n--- proposed skill ---\n${serializeArtifact(p.artifact)}\n`);
    return 0;
  }

  if (verb === 'accept') {
    const id = positional(rest);
    if (!id) {
      process.stderr.write('Usage: autonomous-dev artifact accept <id> [--allow-tool <Tool> ...]\n');
      return 1;
    }
    const toolOverride = multi(rest, '--allow-tool');
    const { path: target } = promoteProposal(id, { ownership: readOwnership(), toolOverride: toolOverride.length ? toolOverride : undefined });
    process.stdout.write(`Promoted ${id}\n  wrote ${target}\n`);
    if (toolOverride.length) process.stdout.write(`  operator-authorized tools: ${toolOverride.join(', ')}\n`);
    return 0;
  }

  if (verb === 'reject') {
    const id = positional(rest);
    if (!id) {
      process.stderr.write('Usage: autonomous-dev artifact reject <id>\n');
      return 1;
    }
    const p = rejectProposal(id);
    process.stdout.write(`Rejected ${id} (status: ${p.status}).\n`);
    return 0;
  }

  process.stderr.write(`${USAGE}\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
