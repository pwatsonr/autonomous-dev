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
 *   `claude --print --agent <reviewerName> --add-dir <repoPath> <prompt>`
 *   The prompt is POSITIONAL (the `claude` CLI has no `--input-json` flag);
 *   it instructs the agent to emit the verdict JSON described below. The
 *   subprocess inherits `process.env` so PATH + Anthropic credentials survive.
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
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Per-reviewer subprocess wall-clock cap (ms). Bounds a single `claude`
 * reviewer invocation so one slow/hung reviewer cannot stall the whole gate
 * up to the daemon's outer phase timeout. On expiry the child is SIGKILLed
 * and the run resolves as a non-zero (timed-out) exit → ERROR verdict.
 */
const REVIEWER_TIMEOUT_MS = 300_000;

/**
 * Default SpawnFn backed by `child_process.spawn`. Buffers stdout/stderr
 * and resolves when the process exits. A non-zero exit code still resolves
 * (not rejects) so the caller controls error handling semantics. When
 * `opts.timeoutMs` is set, the child is SIGKILLed on expiry and the run
 * resolves with a non-zero (124) code.
 */
function realSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(r);
    };

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // child already exited — nothing to kill.
        }
        done({
          code: 124,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: `reviewer subprocess timed out after ${opts.timeoutMs}ms`,
        });
      }, opts.timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      done({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    child.on('error', (err) => {
      done({
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
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the positional prompt handed to `claude --print --agent <name>`.
 *
 * The reviewer agents' own system prompts emit a markdown review and a
 * `phase-result` envelope (`{status, phase, feedback, findings}`) — a shape
 * the dispatcher's `extractJsonVerdict` does NOT understand. So the caller
 * must instruct the agent to additionally print a single machine-readable
 * verdict JSON object as the LAST thing on stdout, matching exactly what
 * `extractJsonVerdict` scans for: `{ score, verdict, findings }`.
 *
 * The prompt also tells the agent which change to review (repo path +
 * changed file list) so it can Read/Grep the relevant files via `--add-dir`.
 */
function buildReviewerPrompt(entry: ReviewerEntry, context: ChangeSetContext): string {
  const fileList =
    context.changedFiles.length > 0
      ? context.changedFiles.map((f) => `  - ${f}`).join('\n')
      : '  (no changed files were reported)';

  return [
    `You are running as the "${entry.name}" reviewer for the "${context.gate}" gate.`,
    `Review the following change set in the repository rooted at ${context.repoPath}.`,
    '',
    `Request ID: ${context.requestId}`,
    `Request type: ${context.requestType}`,
    `Changed files:`,
    fileList,
    '',
    'Read the changed files (and any related files you need) from the repository to perform your review.',
    '',
    'When finished, output ONLY a single JSON object as the LAST thing you print,',
    'on its own line, with EXACTLY this shape and nothing after it:',
    '',
    '{"score": <integer 0-100>, "verdict": "APPROVE" | "REQUEST_CHANGES", "findings": [ { "severity": "blocking|warn|info", "file": "<path>", "line": <number>, "message": "<one sentence>" } ]}',
    '',
    'Rules for the JSON verdict:',
    `- "score" is your overall quality score from 0 to 100 (a passing review is >= ${entry.threshold}).`,
    '- "verdict" MUST be exactly "APPROVE" or "REQUEST_CHANGES" (map any BLOCK decision to "REQUEST_CHANGES").',
    '- "findings" is an array; use [] when you have no findings.',
    '- Do NOT wrap the JSON in markdown code fences. Do NOT print anything after the JSON object.',
  ].join('\n');
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
 *   1. Builds a positional review prompt from `entry` + `context`.
 *   2. Calls `spawn("claude", ["--print", "--agent", name, "--add-dir", repoPath, prompt], { cwd, env: process.env })`.
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
    const prompt = buildReviewerPrompt(entry, context);

    // `claude [options] [prompt]` — the prompt is POSITIONAL and must be the
    // last argument. There is no `--input-json` flag (the previous bug).
    // `--add-dir` grants the read-only reviewer access to the repo under
    // review. CRITICAL ORDERING: `--add-dir` is VARIADIC (`<directories...>`),
    // so it MUST be followed by another option (here `--agent`) to terminate
    // it — otherwise commander swallows the positional prompt as a second
    // directory and claude aborts with "Input must be provided ...".
    const args = ['--print', '--add-dir', context.repoPath, '--agent', entry.name, prompt];

    // Inherit the parent environment so the `claude` subprocess keeps PATH and
    // the Anthropic credentials it needs to run. Passing `env: {}` here (the
    // old bug) stripped both, so the reviewer could not authenticate even with
    // a valid argv.
    const result = await spawnFn('claude', args, {
      cwd,
      env: process.env,
      timeoutMs: REVIEWER_TIMEOUT_MS,
    });

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
  'quality-reviewer',
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
