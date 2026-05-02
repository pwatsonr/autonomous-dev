#!/usr/bin/env node
/**
 * aggregate-cli.js - Bash↔TS bridge for the reviewer-slot mechanic
 * (SPEC-019-4-02 Task 3).
 *
 * The bash score-evaluator shells out here to ask the TS HookRegistry for
 * facts about reviewer slots. Two subcommands:
 *
 *   --count --gate <gate>
 *       Print the number of reviewer slots currently registered for <gate>.
 *       Used to decide whether the multi-reviewer minimum is met.
 *
 * The CLI does not itself drive the registry — it reads a snapshot file at
 * AUTONOMOUS_DEV_REGISTRY_SNAPSHOT (an NDJSON of {gate, plugin_id} entries
 * the daemon writes whenever the registry is reloaded). When the snapshot
 * is missing the CLI prints "0" — same as the empty-registry case so the
 * fallback path engages, which is the safe default.
 *
 * Exits 0 on success (including missing snapshot), 2 on argument error.
 */

'use strict';

const fs = require('node:fs');

function fail(msg) {
  process.stderr.write(`aggregate-cli: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { count: false, gate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') {
      out.count = true;
    } else if (a === '--gate') {
      const v = argv[++i];
      if (!v) fail('--gate requires a value');
      out.gate = v;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: aggregate-cli.js --count --gate <gate>\n' +
          '       AUTONOMOUS_DEV_REGISTRY_SNAPSHOT must point at an NDJSON\n' +
          '       file of {"gate":"<gate>","plugin_id":"<id>"} entries.\n',
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  return out;
}

function countForGate(snapshotPath, gate) {
  let raw;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && entry.gate === gate) count++;
  }
  return count;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.count) fail('expected --count subcommand');
  if (!opts.gate) fail('--gate is required');
  const snapshotPath =
    process.env.AUTONOMOUS_DEV_REGISTRY_SNAPSHOT ||
    `${process.env.HOME || ''}/.autonomous-dev/registry-snapshot.ndjson`;
  const n = countForGate(snapshotPath, opts.gate);
  process.stdout.write(`${n}\n`);
}

main();
