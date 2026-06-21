/**
 * Concrete InvokeReviewerFn dispatcher (SPEC-020-2-04, Task 7 — production
 * replacement for the previous stub).
 *
 * Exports:
 *   - `createClaudeDispatcher(opts?)` — factory that returns an
 *     `InvokeReviewerFn` which shells out to `claude --print --agent <name>`.
 *     The underlying `SpawnFn` is injectable so tests can run without Claude.
 *   - `invokeReviewer` — compatibility export used by `index.ts` and any
 *     other barrel consumers. Delegates to a `createClaudeDispatcher()`
 *     instance built with the real subprocess runner.
 *   - `getRegisteredReviewerNames()` — list of the six known reviewer names
 *     from the default chain config (preserved from the old stub for callers
 *     that enumerate the registry).
 *
 * Command built per reviewer:
 *   `claude --print --agent <reviewerName> --input-json <contextJSON>`
 *
 * Output parsing:
 *   The dispatcher expects Claude to emit a JSON object with the shape
 *   `{ score: number, verdict: "APPROVE" | "REQUEST_CHANGES", findings? }`.
 *   The JSON may be embedded in surrounding text (chain-of-thought prefix);
 *   the parser scans for the LAST balanced `{…}` block in stdout.
 *
 * Error contract:
 *   - Non-zero exit code → throws `Error`.
 *   - Unparseable stdout (no valid JSON object found) → throws `Error`.
 *   - The `ReviewerRunner` converts a thrown error into `verdict: 'ERROR'`.
 *
 * Existing production callers (verified by grep):
 *   - `intake/reviewers/index.ts` re-exports `invokeReviewer` and
 *     `getRegisteredReviewerNames` — both are preserved here unchanged.
 *   - No other production file imports these by name.
 *
 * @module intake/reviewers/invoke-reviewer
 */

import { spawn as nodeSpawn } from 'node:child_process';

import type { ChangeSetContext, ReviewerEntry } from './types';
import type { InvokeReviewerFn } from './runner';

// ---------------------------------------------------------------------------
// SpawnFn — injectable subprocess abstraction
// ---------------------------------------------------------------------------

/**
 * Subprocess runner contract. Returns a Promise that resolves once the
 * process exits, capturing stdout, stderr, and the exit code. The
 * implementation is intentionally minimal: no streaming, no timeout —
 * Claude reviewer invocations are expected to complete within the caller's
 * outer timeout (e.g., the gate's wall-clock limit in the daemon).
 *
 * Tests inject a mock that returns canned `{ code, stdout, stderr }` triples
 * without spawning any process.
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Default SpawnFn backed by `child_process.spawn`. Buffers stdout/stderr
 * and resolves when the process exits. A non-zero exit code still resolves
 * (not rejects) so the caller controls error handling semantics.
 */
function realSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    child.on('error', (err) => {
      resolve({
        code: 1,
        stdout: '',
        stderr: err.message,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// JSON extraction — tolerant of chain-of-thought surrounding text
// ---------------------------------------------------------------------------

/**
 * The shape we expect from the reviewer's JSON output.
 */
interface ReviewerOutput {
  score: number;
  verdict: 'APPROVE' | 'REQUEST_CHANGES';
  findings?: object;
}

/**
 * Scan `text` for the last balanced `{…}` block and attempt to parse it as
 * a `ReviewerOutput`. Returns the parsed object on success, or `null` if no
 * valid JSON object is found or the parsed object is missing required fields.
 *
 * "Last" is preferred over "first" because Claude sometimes emits a
 * chain-of-thought block before the final structured output.
 */
function extractJsonVerdict(text: string): ReviewerOutput | null {
  // Walk backwards through the string to find the last `}`.
  let end = text.lastIndexOf('}');
  while (end >= 0) {
    // Find the matching opening `{` by tracking brace depth.
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') {
        depth--;
        if (depth === 0) {
          start = i;
          break;
        }
      }
    }
    if (start < 0) break; // malformed — give up

    const candidate = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (
        typeof parsed.score === 'number' &&
        (parsed.verdict === 'APPROVE' || parsed.verdict === 'REQUEST_CHANGES')
      ) {
        return {
          score: parsed.score,
          verdict: parsed.verdict,
          findings:
            typeof parsed.findings === 'object' && parsed.findings !== null
              ? (parsed.findings as object)
              : undefined,
        };
      }
    } catch {
      // Not valid JSON — try the next `}` further left.
    }
    // Move to the character before this `}` and try again.
    end = text.lastIndexOf('}', end - 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for `createClaudeDispatcher`. Both fields are optional.
 */
export interface CreateClaudeDispatcherOpts {
  /**
   * Subprocess runner. Defaults to the real `child_process.spawn`-based
   * implementation. Tests inject a mock to avoid spawning Claude.
   */
  spawn?: SpawnFn;
  /**
   * Working directory passed to the subprocess. Defaults to `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Build a concrete `InvokeReviewerFn` that dispatches a reviewer by
 * shelling out to Claude with `--print --agent <name>`.
 *
 * The returned function:
 *   1. Serialises `{ entry, context }` as `--input-json <json>`.
 *   2. Calls `spawn("claude", ["--print", "--agent", name, "--input-json", json], opts)`.
 *   3. Throws on non-zero exit.
 *   4. Scans stdout for the last balanced JSON object matching
 *      `{ score, verdict, findings? }`.
 *   5. Throws if no valid verdict JSON is found.
 *
 * @param opts  Injectable options (spawn function, cwd).
 */
export function createClaudeDispatcher(opts: CreateClaudeDispatcherOpts = {}): InvokeReviewerFn {
  const spawnFn: SpawnFn = opts.spawn ?? realSpawn;
  const cwd: string = opts.cwd ?? process.cwd();

  return async (
    entry: ReviewerEntry,
    context: ChangeSetContext,
  ): Promise<{ score: number; verdict: 'APPROVE' | 'REQUEST_CHANGES'; findings?: object }> => {
    const inputPayload = JSON.stringify({ entry, context });

    const result = await spawnFn(
      'claude',
      ['--print', '--agent', entry.name, '--input-json', inputPayload],
      { cwd, env: {} },
    );

    if (result.code !== 0) {
      throw new Error(
        `reviewer '${entry.name}' exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const verdict = extractJsonVerdict(result.stdout);
    if (verdict === null) {
      throw new Error(
        `reviewer '${entry.name}' produced unparseable output (no valid verdict JSON found in stdout)`,
      );
    }

    return verdict;
  };
}

// ---------------------------------------------------------------------------
// Compatibility exports (preserved from the original stub)
// ---------------------------------------------------------------------------

/**
 * Canonical list of reviewer names defined in the default chain config.
 * Used by callers that enumerate the registry (e.g., validation tooling).
 */
const KNOWN_REVIEWER_NAMES: string[] = [
  'code-reviewer',
  'security-reviewer',
  'qa-edge-case-reviewer',
  'ux-ui-reviewer',
  'accessibility-reviewer',
  'rule-set-enforcement-reviewer',
];

/** Public list of reviewer names known to the default chain config. */
export function getRegisteredReviewerNames(): string[] {
  return [...KNOWN_REVIEWER_NAMES];
}

/**
 * Production `InvokeReviewerFn` backed by `createClaudeDispatcher()` with
 * the real subprocess runner.
 *
 * Preserved for compatibility with `intake/reviewers/index.ts` which
 * re-exports this name. New code should prefer `createClaudeDispatcher()`
 * directly so the spawn function is injectable.
 */
export const invokeReviewer: InvokeReviewerFn = createClaudeDispatcher();
