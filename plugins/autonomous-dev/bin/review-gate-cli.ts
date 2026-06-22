#!/usr/bin/env bun
/**
 * CLI logic for the reviewer-chain gate (SPEC-020-2-04, Task 8).
 *
 * This module EXPORTS `main` and is imported by the jest CLI suite. The
 * executable wrapper that bun runs is `bin/review-gate.ts` (see the note at
 * the bottom of this file for why run and import are split).
 *
 * Usage (via the launcher):
 *   autonomous-dev review-gate \
 *     --repo <path> \
 *     --request-type <feature|bug|infra|refactor|hotfix> \
 *     --gate <code_review|spec_review|...> \
 *     [--context-json <path>]   # load a full ChangeSetContext from JSON
 *     [--request-id <id>]       # override/supply requestId (default: generated)
 *     [--changed-files <f1,f2>] # comma-separated list of changed files
 *     [--frontend]              # mark change-set as a frontend change
 *
 * Exit codes:
 *   0  — gate ran to completion (decision is in the emitted JSON; outcome
 *         may be APPROVE or REQUEST_CHANGES — the exit code does NOT encode
 *         the review outcome).
 *   1  — hard error: bad arguments, config load failure, or unhandled
 *         exception. A human-readable error is printed to stderr.
 *
 * Output:
 *   JSON-encoded `GateDecision` is printed to stdout. Callers should redirect
 *   stderr for diagnostics and parse stdout as JSON.
 *
 * Dependencies injected via the `main(argv, deps)` seam:
 *   - `invoke`: the `InvokeReviewerFn` to use. Defaults to `createClaudeDispatcher()`.
 *   - `emit`:   the `TelemetryEmitFn` to use. Defaults to `emitReviewerInvocation`.
 *   Both are overridable by tests without spawning Claude or needing a live
 *   metrics pipeline.
 *
 * @module bin/review-gate-cli
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runReviewGate, type GateDecision } from '../intake/reviewers/review-gate-orchestrator';
import { createClaudeDispatcher } from '../intake/reviewers/invoke-reviewer';
import { emitReviewerInvocation } from '../intake/reviewers/telemetry';
import type { ChangeSetContext } from '../intake/reviewers/types';
import type { InvokeReviewerFn, TelemetryEmitFn } from '../intake/reviewers/runner';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
Usage: review-gate-cli [options]

Run the reviewer-chain gate for a repository change set.

Options:
  --repo <path>              (required) Absolute path to the repository root.
  --request-type <type>      (required) One of: feature, bug, infra, refactor, hotfix.
  --gate <gate>              (required) Gate name, e.g. code_review, spec_review.
  --context-json <path>      Load a full ChangeSetContext from a JSON file. When
                             supplied, --changed-files and --frontend are ignored.
  --request-id <id>          Override the requestId in the ChangeSetContext.
                             Defaults to a generated UUID.
  --changed-files <f1,f2>    Comma-separated list of changed file paths.
  --frontend                 Mark the change-set as a frontend change.
  --help, -h                 Print this help and exit 0.

Output:
  GateDecision JSON to stdout. Exit 0 on completion; exit 1 on hard error.

Examples:
  review-gate-cli --repo /path/to/repo --request-type feature --gate code_review
  review-gate-cli --repo /path/to/repo --request-type bug --gate code_review \\
    --changed-files src/foo.ts,src/bar.ts --request-id REQ-42
`.trimStart();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  repo: string;
  requestType: string;
  gate: string;
  contextJsonPath?: string;
  requestId?: string;
  changedFiles: string[];
  isFrontendChange: boolean;
  help: boolean;
}

/**
 * Parse an argv array into structured `ParsedArgs`. Returns a `help` flag
 * when `--help` or `-h` is present; the caller prints help and exits 0.
 *
 * @throws `Error` with a human-readable message on invalid arguments.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    repo: '',
    requestType: '',
    gate: '',
    changedFiles: [],
    isFrontendChange: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true;
        i++;
        break;

      case '--repo':
        result.repo = argv[++i] ?? '';
        i++;
        break;

      case '--request-type':
        result.requestType = argv[++i] ?? '';
        i++;
        break;

      case '--gate':
        result.gate = argv[++i] ?? '';
        i++;
        break;

      case '--context-json':
        result.contextJsonPath = argv[++i] ?? '';
        i++;
        break;

      case '--request-id':
        result.requestId = argv[++i] ?? '';
        i++;
        break;

      case '--changed-files': {
        const raw = argv[++i] ?? '';
        result.changedFiles = raw.length > 0 ? raw.split(',').map((f) => f.trim()) : [];
        i++;
        break;
      }

      case '--frontend':
        result.isFrontendChange = true;
        i++;
        break;

      default:
        if (arg.startsWith('-')) {
          throw new Error(`unknown option: ${arg}`);
        }
        i++;
        break;
    }
  }

  return result;
}

/**
 * Validate the parsed arguments. Throws with a clear message on invalid
 * combinations; used before any I/O or gate invocation.
 */
function validateArgs(args: ParsedArgs): void {
  const missing: string[] = [];
  if (args.repo.length === 0) missing.push('--repo');
  if (args.requestType.length === 0) missing.push('--request-type');
  if (args.gate.length === 0) missing.push('--gate');
  if (missing.length > 0) {
    throw new Error(`missing required option(s): ${missing.join(', ')}`);
  }
}

/**
 * Load a `ChangeSetContext` from the parsed arguments. When `--context-json`
 * is supplied, the file is parsed and any CLI overrides (requestId) are
 * applied on top. Otherwise a minimal context is built from the flags.
 *
 * @throws `Error` if the JSON file cannot be read or parsed.
 */
function buildContext(args: ParsedArgs): ChangeSetContext {
  const requestId = args.requestId ?? randomUUID();
  const repoPath = resolve(args.repo);

  if (args.contextJsonPath !== undefined && args.contextJsonPath.length > 0) {
    let raw: string;
    try {
      raw = readFileSync(resolve(args.contextJsonPath), 'utf8');
    } catch (err) {
      throw new Error(
        `failed to read --context-json at ${args.contextJsonPath}: ${(err as Error).message}`,
      );
    }
    let parsed: Partial<ChangeSetContext>;
    try {
      parsed = JSON.parse(raw) as Partial<ChangeSetContext>;
    } catch (err) {
      throw new Error(
        `failed to parse --context-json at ${args.contextJsonPath}: ${(err as Error).message}`,
      );
    }
    return {
      repoPath: parsed.repoPath ?? repoPath,
      changedFiles: parsed.changedFiles ?? [],
      requestId: args.requestId ?? parsed.requestId ?? requestId,
      gate: parsed.gate ?? args.gate,
      requestType: parsed.requestType ?? args.requestType,
      isFrontendChange: parsed.isFrontendChange ?? false,
    };
  }

  return {
    repoPath,
    changedFiles: args.changedFiles,
    requestId,
    gate: args.gate,
    requestType: args.requestType,
    isFrontendChange: args.isFrontendChange,
  };
}

// ---------------------------------------------------------------------------
// Injectable dependencies (the main() seam)
// ---------------------------------------------------------------------------

export interface ReviewGateCliDeps {
  /** Reviewer dispatcher. Defaults to the real Claude subprocess dispatcher. */
  invoke?: InvokeReviewerFn;
  /** Telemetry emitter. Defaults to `emitReviewerInvocation`. */
  emit?: TelemetryEmitFn;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * CLI entry function. Separated from `process.argv` so that tests can call
 * `main(argv, { invoke: mockFn })` and capture stdout via jest mocks.
 *
 * @param argv  The argument vector (exclude the node/bun executable and
 *              script path — i.e., `process.argv.slice(2)`).
 * @param deps  Optional injectable dependencies for testing.
 * @returns     Exit code (0 = success, 1 = error).
 */
export async function main(argv: string[], deps: ReviewGateCliDeps = {}): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    validateArgs(args);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.stderr.write('Run with --help for usage.\n');
    return 1;
  }

  let context: ChangeSetContext;
  try {
    context = buildContext(args);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }

  const invoke = deps.invoke ?? createClaudeDispatcher();
  const emit = deps.emit ?? emitReviewerInvocation;

  let decision: GateDecision;
  try {
    decision = await runReviewGate({
      repoPath: resolve(args.repo),
      requestType: args.requestType,
      gate: args.gate,
      context,
      invoke,
      emit,
    });
  } catch (err) {
    process.stderr.write(`Error running review gate: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(JSON.stringify(decision, null, 2) + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// No entrypoint guard here on purpose.
//
// This module only EXPORTS `main` (+ helpers) so it can be imported cleanly by
// both ts-jest (CJS transpile) and bun. The executable wrapper lives in
// `bin/review-gate.ts`, which bun runs directly and which calls `main`.
// Mixing a CJS `require.main` guard into this ESM file makes bun refuse to run
// it, and an `import.meta.main` guard makes ts-jest fail to parse it — so the
// run-vs-import split is handled by the separate launcher.
// ---------------------------------------------------------------------------
