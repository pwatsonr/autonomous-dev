/**
 * Concrete InvokeReviewerFn dispatcher (SPEC-020-2-04, Task 7 — production
 * replacement for the previous stub). Extended by SPEC-REQ-000050 to support
 * configurable timeouts and a tolerant verdict parser.
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
 *   - `parseReviewerOutput(stdout)` — pure verdict parser: tries four
 *     strategies in order; returns ParsedVerdict or ParseFailure.
 *   - `resolveReviewerTimeoutMs(entry, envValue?)` — pure timeout resolver;
 *     returns a finite integer in [30_000, 3_600_000].
 *   - `ReviewerTimeoutError` — thrown when subprocess exits with code 124.
 *   - `ReviewerParseError` — thrown when `parseReviewerOutput` returns a
 *     ParseFailure.
 *
 * Command built per reviewer:
 *   `claude --print --agent <reviewerName> --add-dir <repoPath> <prompt>`
 *   The prompt is POSITIONAL (the `claude` CLI has no `--input-json` flag);
 *   it instructs the agent to emit the verdict JSON described below. The
 *   subprocess inherits `process.env` so PATH + Anthropic credentials survive.
 *
 * Output parsing (SPEC-REQ-000050):
 *   The dispatcher calls `parseReviewerOutput(stdout)` which tries four
 *   strategies in precedence order:
 *     1. Verdict-JSON  — last balanced `{…}` with `score` (number) + `verdict`.
 *     2. Phase-result envelope — last balanced `{…}` with `status`/`phase`.
 *     3. Markdown-fenced JSON — strip backtick fence, re-run strategies 1+2.
 *     4. Verdict marker — VERDICT: APPROVE|REQUEST_CHANGES|BLOCK on its own line.
 *
 * Error contract (SPEC-REQ-000050):
 *   - Exit code 124 → throws `ReviewerTimeoutError`.
 *   - Other non-zero exit code → throws generic `Error`.
 *   - Parse failure → throws `ReviewerParseError`.
 *   - The `ReviewerRunner` converts any thrown error into `verdict: 'ERROR'`.
 *
 * @module intake/reviewers/invoke-reviewer
 */

import { spawn as nodeSpawn } from 'node:child_process';

import type { ChangeSetContext, ReviewerEntry } from './types';
import type { InvokeReviewerFn } from './runner';
import {
  TIMEOUT_DEFAULT,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  clampTimeoutMs,
} from './timeout';

// ---------------------------------------------------------------------------
// SpawnFn — injectable subprocess abstraction
// ---------------------------------------------------------------------------

/**
 * Subprocess runner contract. Returns a Promise that resolves once the
 * process exits, capturing stdout, stderr, and the exit code. The
 * implementation is intentionally minimal: no streaming — just capture.
 *
 * When `opts.timeoutMs` is set, the child is SIGKILLed on expiry and the
 * run resolves with code 124.
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
 * Default SpawnFn backed by `child_process.spawn`. Buffers stdout/stderr
 * and resolves when the process exits. A non-zero exit code still resolves
 * (not rejects) so the caller controls error handling semantics. When
 * `opts.timeoutMs` is set, the child is SIGKILLed on expiry and the run
 * resolves with code 124.
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
// Tagged error classes (SPEC-REQ-000050)
// ---------------------------------------------------------------------------

/**
 * Thrown by the dispatcher when `spawnFn` returns exit code 124
 * (SIGKILL on subprocess wall-clock timeout). The runner detects this
 * subclass via `instanceof` and the `timeout_ms` is embedded in `message`.
 *
 * `.message` is exactly:
 *   `reviewer '<reviewer_name>' timed out after <timeout_ms>ms`
 */
export class ReviewerTimeoutError extends Error {
  readonly name: 'ReviewerTimeoutError' = 'ReviewerTimeoutError';
  readonly reviewer_name: string;
  readonly timeout_ms: number;

  constructor(reviewer_name: string, timeout_ms: number) {
    super(`reviewer '${reviewer_name}' timed out after ${timeout_ms}ms`);
    this.reviewer_name = reviewer_name;
    this.timeout_ms = timeout_ms;
    Object.setPrototypeOf(this, ReviewerTimeoutError.prototype);
  }
}

/**
 * Thrown by the dispatcher when `parseReviewerOutput` returns a
 * ParseFailure. The runner detects this subclass via `instanceof` and
 * copies `raw_output` onto the resulting ReviewerResult.
 *
 * `.message` is exactly:
 *   `reviewer '<reviewer_name>' produced unparseable output: <reason>`
 * The `raw_output` is NOT inlined into `.message` — it travels on its own
 * field to avoid blowing up log lines.
 */
export class ReviewerParseError extends Error {
  readonly name: 'ReviewerParseError' = 'ReviewerParseError';
  readonly reviewer_name: string;
  readonly reason: string;
  readonly raw_output: string;

  constructor(reviewer_name: string, reason: string, raw_output: string) {
    super(`reviewer '${reviewer_name}' produced unparseable output: ${reason}`);
    this.reviewer_name = reviewer_name;
    this.reason = reason;
    this.raw_output = raw_output;
    Object.setPrototypeOf(this, ReviewerParseError.prototype);
  }
}

// ---------------------------------------------------------------------------
// ParsedVerdict / ParseFailure discriminated unions (SPEC-REQ-000050)
// ---------------------------------------------------------------------------

/**
 * Successful parse — one of three legitimate reviewer output shapes.
 *
 *   - `verdict-json`: bare JSON with `score` (number) + `verdict`.
 *   - `phase-result-envelope`: `{ status: 'pass'|'fail', phase: string, ... }`.
 *   - `verdict-marker`: a `VERDICT: APPROVE|REQUEST_CHANGES` line.
 */
export type ParsedVerdict =
  | {
      kind: 'verdict-json';
      score: number;
      verdict: 'APPROVE' | 'REQUEST_CHANGES';
      findings?: object;
    }
  | {
      kind: 'phase-result-envelope';
      status: 'pass' | 'fail';
      phase: string;
      feedback?: string;
      findings?: unknown;
    }
  | {
      kind: 'verdict-marker';
      verdict: 'APPROVE' | 'REQUEST_CHANGES';
      score?: number;
    };

/**
 * Parse failure with the captured raw stdout (trimmed + truncated).
 *
 *   - `reason`: human-readable explanation (e.g., "no verdict marker, no JSON object, no envelope").
 *   - `raw_output`: trimmed stdout; ≤ 8192 chars + optional " … [truncated]".
 */
export interface ParseFailure {
  kind: 'parse-failure';
  reason: string;
  raw_output: string;
}

// ---------------------------------------------------------------------------
// Balanced-brace scanner (shared between strategies 1 and 2)
// ---------------------------------------------------------------------------

/**
 * Scan `text` right-to-left for balanced `{…}` blocks. Yields candidate
 * substrings from last to first occurrence so strategies can try parsing
 * each one. Uses the same algorithm as the original `extractJsonVerdict`.
 */
function* scanJsonCandidates(text: string): Generator<string> {
  let end = text.lastIndexOf('}');
  while (end >= 0) {
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
    if (start < 0) break;
    yield text.slice(start, end + 1);
    end = text.lastIndexOf('}', end - 1);
  }
}

// ---------------------------------------------------------------------------
// Individual parse strategies
// ---------------------------------------------------------------------------

/**
 * Strategy 1: Verdict-JSON — scan right-to-left for the last balanced
 * `{…}` block whose parsed shape has `score: number` and `verdict` in
 * `{'APPROVE', 'REQUEST_CHANGES'}`.
 */
function tryVerdictJson(text: string): Extract<ParsedVerdict, { kind: 'verdict-json' }> | null {
  for (const candidate of scanJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (
        typeof parsed.score === 'number' &&
        (parsed.verdict === 'APPROVE' || parsed.verdict === 'REQUEST_CHANGES')
      ) {
        return {
          kind: 'verdict-json',
          score: parsed.score,
          verdict: parsed.verdict,
          findings:
            typeof parsed.findings === 'object' && parsed.findings !== null
              ? (parsed.findings as object)
              : undefined,
        };
      }
    } catch {
      // Not valid JSON — try the next candidate.
    }
  }
  return null;
}

/**
 * Strategy 2: Phase-result envelope — scan right-to-left for the last
 * balanced `{…}` block whose parsed shape is
 * `{ status: 'pass'|'fail', phase: string, feedback?: string, findings?: unknown }`.
 */
function tryEnvelope(
  text: string,
): Extract<ParsedVerdict, { kind: 'phase-result-envelope' }> | null {
  for (const candidate of scanJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (
        (parsed.status === 'pass' || parsed.status === 'fail') &&
        typeof parsed.phase === 'string'
      ) {
        return {
          kind: 'phase-result-envelope',
          status: parsed.status,
          phase: parsed.phase,
          feedback: typeof parsed.feedback === 'string' ? parsed.feedback : undefined,
          findings: parsed.findings,
        };
      }
    } catch {
      // Not valid JSON — try the next candidate.
    }
  }
  return null;
}

/**
 * Strategy 3: Markdown-fenced JSON — strip a single outer pair of triple
 * backticks (optionally with a language tag matching /^[a-zA-Z0-9_-]*$/)
 * from the trimmed stdout, then re-run strategies 1 and 2 on the inner
 * content.
 *
 * Returns the inner ParsedVerdict if either inner strategy matches,
 * otherwise null.
 */
function tryFencedJson(text: string): ParsedVerdict | null {
  const trimmed = text.trim();
  // Match opening fence: ```<optional-lang-tag><newline>
  const fenceOpen = /^```[a-zA-Z0-9_-]*\r?\n/;
  const fenceClose = /\r?\n```\s*$/;
  const openMatch = fenceOpen.exec(trimmed);
  if (!openMatch) return null;
  if (!fenceClose.test(trimmed)) return null;

  const inner = trimmed
    .slice(openMatch[0].length)
    .replace(/\r?\n```\s*$/, '')
    .trim();

  const vj = tryVerdictJson(inner);
  if (vj) return vj;
  return tryEnvelope(inner);
}

/**
 * Strategy 4: Verdict-marker — scan line-by-line for a line matching
 * `/^\s*VERDICT:\s*(APPROVE|REQUEST_CHANGES|BLOCK)\s*$/` (case-sensitive
 * on the verdict token). BLOCK normalises to REQUEST_CHANGES.
 *
 * This is the LAST strategy — only runs if 1–3 all returned no match.
 */
const VERDICT_MARKER_RE = /^\s*VERDICT:\s*(APPROVE|REQUEST_CHANGES|BLOCK)\s*$/;

function tryVerdictMarker(text: string): Extract<ParsedVerdict, { kind: 'verdict-marker' }> | null {
  for (const line of text.split(/\r?\n/)) {
    const m = VERDICT_MARKER_RE.exec(line);
    if (m) {
      const raw = m[1] as 'APPROVE' | 'REQUEST_CHANGES' | 'BLOCK';
      const verdict: 'APPROVE' | 'REQUEST_CHANGES' =
        raw === 'BLOCK' ? 'REQUEST_CHANGES' : raw;
      return { kind: 'verdict-marker', verdict };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

const RAW_OUTPUT_MAX = 8192;
const TRUNCATION_SUFFIX = ' … [truncated]'; // ' … [truncated]'

/**
 * Trim and truncate raw stdout for embedding in ParseFailure / error fields.
 * When trimmed length exceeds 8192 characters, the result is exactly
 * `stdout.trim().slice(0, 8192) + ' … [truncated]'`.
 */
function truncateRawOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length <= RAW_OUTPUT_MAX) return trimmed;
  return trimmed.slice(0, RAW_OUTPUT_MAX) + TRUNCATION_SUFFIX;
}

// ---------------------------------------------------------------------------
// parseReviewerOutput — public pure parser (SPEC-REQ-000050)
// ---------------------------------------------------------------------------

/**
 * Pure (no side effects) verdict parser. Tries four strategies in order
 * and returns the first hit; otherwise returns a ParseFailure.
 *
 * Strategy order (FIRST match wins, BUT see precedence rule below):
 *   1. Verdict-JSON: scan stdout right-to-left for the LAST balanced
 *      `{...}` block and JSON.parse it. Accept iff
 *      `typeof parsed.score === 'number'` AND
 *      `parsed.verdict ∈ {'APPROVE','REQUEST_CHANGES'}`.
 *   2. Phase-result envelope: scan stdout right-to-left for the LAST
 *      balanced `{...}` block whose parsed shape is
 *      `{ status: 'pass'|'fail', phase: string, feedback?: string,
 *         findings?: unknown }`.
 *   3. Markdown-fenced JSON: strip a single outer pair of triple
 *      backticks (optionally with a language tag) from the trimmed
 *      stdout, then re-run strategies 1 and 2 on the inner content.
 *   4. Verdict-marker: scan the input line-by-line for a line matching
 *      `/^\s*VERDICT:\s*(APPROVE|REQUEST_CHANGES|BLOCK)\s*$/`
 *      (case-sensitive on the verdict token; BLOCK normalises to
 *      REQUEST_CHANGES).
 *
 * Precedence rule (#618 ordering): when a stdout contains BOTH a valid
 * verdict-JSON/envelope AND a VERDICT: marker line, the JSON/envelope
 * MUST win. Strategy 4 (marker) is the LAST strategy; it only runs if
 * 1–3 all returned no match.
 *
 * Never throws. Pure function — does not consult globals or process.env.
 *
 * @param stdout  Captured subprocess stdout (UTF-8, may be empty).
 * @returns       ParsedVerdict on success; ParseFailure with truncated
 *                raw_output otherwise.
 */
export function parseReviewerOutput(stdout: string): ParsedVerdict | ParseFailure {
  // Strategy 1: verdict-json
  const vj = tryVerdictJson(stdout);
  if (vj) return vj;

  // Strategy 2: phase-result envelope
  const env = tryEnvelope(stdout);
  if (env) return env;

  // Strategy 3: markdown-fenced JSON
  const fenced = tryFencedJson(stdout);
  if (fenced) return fenced;

  // Strategy 4: verdict marker
  const marker = tryVerdictMarker(stdout);
  if (marker) return marker;

  // All strategies exhausted — parse failure
  return {
    kind: 'parse-failure',
    reason: 'no verdict marker, no JSON object, no envelope',
    raw_output: truncateRawOutput(stdout),
  };
}

// ---------------------------------------------------------------------------
// resolveReviewerTimeoutMs — pure timeout resolver (SPEC-REQ-000050)
// ---------------------------------------------------------------------------

/**
 * Pure resolver for the effective per-invocation timeout. Never throws.
 * Always returns a finite integer in [30_000, 3_600_000].
 *
 * Precedence:
 *   1. entry.timeout_ms (if finite integer)
 *   2. envValue parsed as an integer (Number.isFinite + Number.isInteger)
 *   3. 900_000 (built-in default)
 * After selection: clamp to [30_000, 3_600_000].
 *
 * NOTE: layers 2-4 of the full TDD precedence chain
 * (gate_defaults / defaults / env) are populated by the chain-resolver
 * onto `entry.timeout_ms` BEFORE the dispatcher calls this function.
 * The dispatcher path therefore only needs to consider entry-level value
 * and env-var fallback (in case a caller invokes the dispatcher with a
 * raw, unresolved entry — e.g. unit tests). `chain-resolver` MUST
 * populate `entry.timeout_ms` so production code always sees layer 1.
 *
 * Note: `Number.parseInt('500000ms', 10)` returns `500000` — lenient
 * JavaScript parsing behaviour is accepted intentionally.
 *
 * @param entry      Object with optional `timeout_ms` (number).
 * @param envValue   Optional `process.env.REVIEWER_TIMEOUT_MS` string.
 * @returns          A finite integer in [30_000, 3_600_000].
 */
export function resolveReviewerTimeoutMs(
  entry: Pick<ReviewerEntry, 'timeout_ms'>,
  envValue?: string,
): number {
  let candidate: number | undefined;

  // Layer 1: entry-level timeout
  if (
    entry.timeout_ms !== undefined &&
    Number.isFinite(entry.timeout_ms) &&
    Number.isInteger(entry.timeout_ms)
  ) {
    candidate = entry.timeout_ms;
  }

  // Layer 2: env var
  if (candidate === undefined && envValue !== undefined && envValue !== '') {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && Number.isInteger(parsed)) {
      candidate = parsed;
    }
  }

  // Layer 3: built-in default
  if (candidate === undefined) {
    candidate = TIMEOUT_DEFAULT;
  }

  // Clamp to [TIMEOUT_MIN, TIMEOUT_MAX]; NaN-safe via clampTimeoutMs.
  return clampTimeoutMs(candidate);
}

// ---------------------------------------------------------------------------
// normaliseVerdict — internal helper
// ---------------------------------------------------------------------------

/**
 * Map a ParsedVerdict to the InvokeReviewerFn return shape
 * `{ score, verdict, findings? }`. Score defaulting per SPEC-REQ-000050:
 *
 *   - kind 'verdict-json': pass through verbatim.
 *   - kind 'phase-result-envelope', status 'pass':
 *       verdict = 'APPROVE', score = entry.threshold,
 *       findings = parsed.findings if typeof === 'object' && not null.
 *   - kind 'phase-result-envelope', status 'fail':
 *       verdict = 'REQUEST_CHANGES', score = 0,
 *       findings = parsed.findings if typeof === 'object' && not null.
 *   - kind 'verdict-marker', verdict 'APPROVE':
 *       verdict = 'APPROVE', score = entry.threshold.
 *   - kind 'verdict-marker', verdict 'REQUEST_CHANGES':
 *       verdict = 'REQUEST_CHANGES', score = 0.
 */
function normaliseVerdict(
  parsed: ParsedVerdict,
  entry: ReviewerEntry,
): { score: number; verdict: 'APPROVE' | 'REQUEST_CHANGES'; findings?: object } {
  if (parsed.kind === 'verdict-json') {
    return { score: parsed.score, verdict: parsed.verdict, findings: parsed.findings };
  }

  if (parsed.kind === 'phase-result-envelope') {
    const verdict: 'APPROVE' | 'REQUEST_CHANGES' =
      parsed.status === 'pass' ? 'APPROVE' : 'REQUEST_CHANGES';
    const score = parsed.status === 'pass' ? entry.threshold : 0;
    const findings =
      typeof parsed.findings === 'object' && parsed.findings !== null
        ? (parsed.findings as object)
        : undefined;
    return { score, verdict, findings };
  }

  // kind === 'verdict-marker'
  const verdict: 'APPROVE' | 'REQUEST_CHANGES' = parsed.verdict;
  const score = verdict === 'APPROVE' ? entry.threshold : 0;
  return { score, verdict };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the positional prompt handed to `claude --print --agent <name>`.
 *
 * The reviewer agents' own system prompts emit a markdown review and a
 * `phase-result` envelope (`{status, phase, feedback, findings}`) — a shape
 * the dispatcher's parser handles via strategy 2 (phase-result envelope).
 * The caller must also instruct the agent to additionally print a single
 * machine-readable verdict JSON object, matching strategy 1.
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
 * Options for `createClaudeDispatcher`. All fields are optional.
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
  /**
   * Optional telemetry emit function for structured events
   * (`reviewer.timeout`, `reviewer.parse_failure`). Additive — no breaking
   * change. When absent, events are silently dropped. (SPEC-REQ-000050)
   */
  telemetry?: (payload: Record<string, unknown>) => void;
}

/**
 * Build a concrete `InvokeReviewerFn` that dispatches a reviewer by
 * shelling out to Claude with `--print --agent <name>`.
 *
 * The returned function (SPEC-REQ-000050 extended behaviour):
 *   1. Resolves the per-invocation timeout via `resolveReviewerTimeoutMs`.
 *   2. Builds a positional review prompt from `entry` + `context`.
 *   3. Calls `spawn("claude", [...], { cwd, env: process.env, timeoutMs })`.
 *   4. If `result.code === 124`: throws `ReviewerTimeoutError` + emits telemetry.
 *   5. Else if `result.code !== 0`: throws generic `Error` (unchanged).
 *   6. Else: calls `parseReviewerOutput(result.stdout)`.
 *      - If parse-failure: throws `ReviewerParseError` + emits telemetry.
 *      - Else: calls `normaliseVerdict(parsed, entry)` and returns its result.
 *
 * @param opts  Injectable options (spawn function, cwd, telemetry).
 */
export function createClaudeDispatcher(opts: CreateClaudeDispatcherOpts = {}): InvokeReviewerFn {
  const spawnFn: SpawnFn = opts.spawn ?? realSpawn;
  const cwd: string = opts.cwd ?? process.cwd();
  const safeEmitTelemetry = (payload: Record<string, unknown>): void => {
    if (!opts.telemetry) return;
    try {
      opts.telemetry(payload);
    } catch {
      // Fire-and-forget: telemetry must not affect reviewer flow.
    }
  };

  return async (
    entry: ReviewerEntry,
    context: ChangeSetContext,
  ): Promise<{ score: number; verdict: 'APPROVE' | 'REQUEST_CHANGES'; findings?: object }> => {
    const prompt = buildReviewerPrompt(entry, context);
    const timeoutMs = resolveReviewerTimeoutMs(entry, process.env.REVIEWER_TIMEOUT_MS);

    // `claude [options] [prompt]` — the prompt is POSITIONAL and must be the
    // last argument. `--add-dir` is VARIADIC, so it MUST be followed by
    // another option (here `--agent`) to terminate it.
    const args = ['--print', '--add-dir', context.repoPath, '--agent', entry.name, prompt];

    const result = await spawnFn('claude', args, {
      cwd,
      env: process.env,
      timeoutMs,
    });

    if (result.code === 124) {
      // Telemetry emitted at error-construction site (not in runner, to avoid
      // double-emit per SPEC-REQ-000050 §5).
      safeEmitTelemetry({
        event: 'reviewer.timeout',
        reviewer: entry.name,
        gate: context.gate,
        request_id: context.requestId,
        timeout_ms: timeoutMs,
      });
      throw new ReviewerTimeoutError(entry.name, timeoutMs);
    }

    if (result.code !== 0) {
      throw new Error(
        `reviewer '${entry.name}' exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const parsed = parseReviewerOutput(result.stdout);
    if (parsed.kind === 'parse-failure') {
      safeEmitTelemetry({
        event: 'reviewer.parse_failure',
        reviewer: entry.name,
        gate: context.gate,
        request_id: context.requestId,
        raw_output_truncated_chars: Math.min(result.stdout.trim().length, RAW_OUTPUT_MAX),
      });
      throw new ReviewerParseError(entry.name, parsed.reason, parsed.raw_output);
    }

    return normaliseVerdict(parsed, entry);
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
