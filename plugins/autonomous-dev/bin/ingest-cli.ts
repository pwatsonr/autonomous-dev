#!/usr/bin/env bun
/**
 * Ingestion / org CLI (ONBOARD Phase 1 — #587). Dispatched from autonomous-dev.sh:
 *
 *   autonomous-dev org link <org>            Link a GitHub org (records ownership.org)
 *   autonomous-dev org ingest [org]          READ-ONLY crawl of the org into scoped memory
 *   autonomous-dev project infer             Propose project groupings from ingested memory
 *   autonomous-dev questions list [--repo <id>] [--status pending|answered]
 *   autonomous-dev questions answer <id> <choice>
 *
 * Thin wrapper: all logic lives in src/ (typed + unit-tested). Ingestion is
 * read-only by construction (src/ingest/adapters) and writes ONLY to the memory
 * tree (~/.autonomous-dev/memory) + the ownership manifest — never to a crawled
 * repo and never to the live autonomous-dev checkout (R1).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readOwnership, writeOwnership } from '../src/ownership/store';
import { linkOrg, registerRepos, isOrgLogin } from '../src/ownership/commands';
import { ingestOrg, enqueueAmbiguityQuestions } from '../src/ingest/orchestrator';
import { createGhOrgClient } from '../src/ingest/adapters';
import { signalsFromMemory } from '../src/ingest/inference';
import type { RepoSignals } from '../src/ingest/inference';
import { loadKnownShas, saveKnownShas, nextKnownShas } from '../src/ingest/shas';
import { loadSignalsSidecar } from '../src/ingest/signals-sidecar';
import { readScopeMemory } from '../src/memory/store';
import { listQuestions, answerQuestion } from '../src/ingest/questions';
import { readNeo4jCreds } from '../src/graph/secrets';
import { httpGraphClient } from '../src/graph/client';
import { syncGraph } from '../src/graph/importer';
import { inferProjectsWithGraph } from '../src/graph/inference';

const USAGE = `Usage:
  autonomous-dev org link <org>            Link a GitHub org
  autonomous-dev org ingest [org] [--full] Read-only crawl of the org into scoped memory (--full ignores saved shas)
  autonomous-dev project infer             Propose project groupings (graph-enriched if Neo4j is up)
  autonomous-dev graph sync                Upsert the org/project/repo/owner graph into Neo4j
  autonomous-dev graph status              Show Neo4j connectivity + node counts
  autonomous-dev questions list [--repo <id>] [--status pending|answered]
  autonomous-dev questions answer <id> <choice>`;

/** A graph client from the stored Neo4j credential, or undefined if not configured. */
function graphClient() {
  const creds = readNeo4jCreds();
  return creds ? { client: httpGraphClient(creds), httpUrl: creds.httpUrl } : undefined;
}

/** i-th positional argument (skips flags), or '' if the next token is a flag/missing. */
function positional(args: string[], i = 0): string {
  return args[i] && !args[i].startsWith('--') ? args[i] : '';
}

/** Value following the first occurrence of `--flag`, or undefined (not the next flag). */
function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  return value.startsWith('--') ? undefined : value;
}

/** An ABSOLUTE home dir (refuses an empty/relative $HOME so writes never land under CWD — R1). */
function homeDir(): string {
  const h = process.env.HOME;
  if (h && path.isAbsolute(h)) return h;
  const fallback = os.homedir();
  if (!path.isAbsolute(fallback)) throw new Error('Cannot resolve an absolute home directory.');
  return fallback;
}

function ingestHome(): string {
  return path.join(homeDir(), '.autonomous-dev', 'ingest');
}

/**
 * Per-repo inference signals (#588): PREFER the structured sidecar written at
 * extraction time, FALL BACK to re-parsing the `ownership` memory markdown when
 * the sidecar is missing/corrupt — so older ingests with no sidecar still infer.
 */
function repoSignals(repoId: string): RepoSignals {
  return loadSignalsSidecar(repoId) ?? signalsFromMemory(repoId, readScopeMemory(`repo:${repoId}`));
}

async function main(argv: string[]): Promise<number> {
  const [family, verb, ...rest] = argv;

  if (family === 'org' && verb === 'link') {
    const { ownership, message } = linkOrg(readOwnership(), positional(rest));
    writeOwnership(ownership);
    process.stdout.write(`${message}\n`);
    return 0;
  }

  if (family === 'org' && verb === 'ingest') {
    const org = positional(rest) || readOwnership().org;
    if (!org) {
      process.stderr.write('No org linked. Run: autonomous-dev org link <org> (or pass <org>).\n');
      return 1;
    }
    if (!isOrgLogin(org)) {
      process.stderr.write(`Invalid org login "${org}"; 1–39 chars [a-z0-9-], no leading/trailing dash.\n`);
      return 1;
    }
    const ingestRoot = ingestHome();
    const scratchDir = path.join(ingestRoot, 'clones');
    // Scratch hygiene: clear our own throwaway shallow clones so re-runs don't
    // collide. Hard guard before any recursive remove: the resolved path MUST be
    // exactly <home>/.autonomous-dev/ingest/clones.
    const expected = path.resolve(ingestRoot, 'clones');
    if (path.resolve(scratchDir) !== expected) {
      process.stderr.write('Refusing to use an unexpected scratch dir.\n');
      return 2;
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(scratchDir, { recursive: true });

    // Incremental crawl: load the persisted repoId->headSha map so unchanged
    // repos are skipped, unless --full forces a full re-crawl.
    const full = rest.includes('--full');
    const known = full ? {} : loadKnownShas();

    process.stdout.write(`Ingesting org "${org}" (read-only${full ? ', full re-crawl' : ', incremental'})…\n`);
    const client = createGhOrgClient({ scratchDir });
    const result = await ingestOrg(org, client, undefined, { knownShas: known });

    // Persist the updated head shas for next run's incremental skip (atomic, 0600).
    saveKnownShas(nextKnownShas(known, result));

    const ingestedIds = result.repos.map((r) => r.repoId);
    const { ownership, message } = registerRepos(readOwnership(), ingestedIds);
    writeOwnership(ownership);

    const docs = result.repos.reduce((n, r) => n + r.topicsWritten.length, 0);
    process.stdout.write(
      `Ingested ${result.repos.length} repo(s) (${docs} memory docs), skipped ${result.skipped.length} (archived/unchanged).\n`,
    );
    process.stdout.write(`${message}\n`);
    const failed = result.repos.filter((r) => r.errors.length);
    if (failed.length) {
      process.stdout.write(`Note: ${failed.length} repo(s) had per-extractor errors (partial memory written).\n`);
    }
    process.stdout.write('Next: autonomous-dev project infer\n');
    return 0;
  }

  if (family === 'project' && verb === 'infer') {
    const own = readOwnership();
    if (own.repos.length === 0) {
      process.stdout.write('No ingested repos. Run: autonomous-dev org ingest first.\n');
      return 0;
    }
    const signals = own.repos.map((r) => repoSignals(r.id));
    // PRODUCER: a repo whose signals place it in 2+ candidate projects becomes an
    // answerable blocking question (feeds the queue the CONSUMER already drains).
    const askedIds = enqueueAmbiguityQuestions(signals);
    if (askedIds.length) {
      process.stdout.write(
        `Enqueued ${askedIds.length} blocking question(s) for ambiguous repo(s); resolve with: autonomous-dev questions list\n`,
      );
    }
    const gc = graphClient();
    const { proposals, source } = await inferProjectsWithGraph(gc?.client, signals);
    process.stdout.write(`(inference source: ${source}${source === 'file' && gc ? ' — Neo4j unreachable, fell back' : ''})\n`);
    if (proposals.length === 0) {
      process.stdout.write('(no project groupings inferred — repos share no owner/name signal)\n');
      return 0;
    }
    process.stdout.write(`Proposed ${proposals.length} project grouping(s) — propose-only, nothing applied:\n\n`);
    for (const p of proposals) {
      process.stdout.write(
        `  ${p.id}  (confidence ${Math.round(p.confidence * 100)}%)\n` +
          `    repos: ${p.repoIds.join(', ')}\n` +
          `    ${p.rationale}\n\n`,
      );
    }
    process.stdout.write('Apply a grouping with:\n  autonomous-dev project add <id>\n  autonomous-dev repo assign <repo> --project <id>\n');
    return 0;
  }

  if (family === 'graph' && verb === 'sync') {
    const own = readOwnership();
    if (!own.org) {
      process.stderr.write('No org linked. Run: autonomous-dev org link <org> first.\n');
      return 1;
    }
    const gc = graphClient();
    if (!gc) {
      process.stdout.write('Neo4j not configured (~/.autonomous-dev/secrets/neo4j.json absent) — graph layer skipped.\n');
      return 0;
    }
    const signals = own.repos.map((r) => repoSignals(r.id));
    process.stdout.write(`Syncing graph for org "${own.org}" → ${gc.httpUrl}…\n`);
    const res = await syncGraph(gc.client, own.org, own, signals);
    if (res.ok) {
      process.stdout.write(`Graph synced: ${res.applied} upsert statement(s) for ${own.projects.length} project(s) + ${own.repos.length} repo(s).\n`);
      return 0;
    }
    process.stderr.write(`Graph sync failed (${res.applied} applied): ${res.error}\n`);
    return 1;
  }

  if (family === 'graph' && verb === 'status') {
    const gc = graphClient();
    if (!gc) {
      process.stdout.write('Neo4j: not configured (~/.autonomous-dev/secrets/neo4j.json absent).\n');
      return 0;
    }
    if (!(await gc.client.verifyConnectivity())) {
      process.stderr.write(`Neo4j: UNREACHABLE (${gc.httpUrl}).\n`);
      return 1;
    }
    process.stdout.write(`Neo4j: reachable (${gc.httpUrl}).\n`);
    const counts = await gc.client.run([{ statement: 'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY label' }]);
    if (counts.ok && counts.results) {
      const data = (counts.results[0] as { data?: { row?: unknown[] }[] })?.data ?? [];
      for (const d of data) process.stdout.write(`  ${String(d.row?.[0] ?? '?')}: ${String(d.row?.[1] ?? 0)}\n`);
    }
    return 0;
  }

  if (family === 'questions' && verb === 'list') {
    const statusArg = flag(rest, '--status');
    const status = statusArg === 'pending' || statusArg === 'answered' ? statusArg : undefined;
    const qs = listQuestions(undefined, { status, repoId: flag(rest, '--repo') });
    if (qs.length === 0) {
      process.stdout.write('(no questions)\n');
      return 0;
    }
    for (const q of qs) {
      const mark = q.status === 'pending' ? '● pending ' : '○ answered';
      process.stdout.write(
        `${mark}  ${q.id}  [${q.repoId}]  ${q.question}\n` +
          `    options: ${q.options.join(' | ')}${q.answer ? `   -> ${q.answer}` : ''}\n`,
      );
    }
    return 0;
  }

  if (family === 'questions' && verb === 'answer') {
    const id = positional(rest, 0);
    const choice = positional(rest, 1);
    if (!id || !choice) {
      process.stderr.write('Usage: autonomous-dev questions answer <id> <choice>\n');
      return 1;
    }
    const q = answerQuestion(id, choice);
    process.stdout.write(`Answered ${q.id}: "${q.answer}". Repo "${q.repoId}" unblocked.\n`);
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
