/**
 * Deterministic task-size classifier (#526, first conservative cut).
 *
 * Pure, no I/O (modeled after {@link module:request_parser}'s pure helpers).
 * Routes ONLY trivial documentation requests onto a lighter pipeline; every
 * other input maps to `standard` so the default pipeline is unchanged. The
 * classifier is intentionally ASYMMETRIC and conservative: a false-trivial
 * (routing real work onto the light path) is far worse than a false-standard
 * (running the full pipeline on a doc tweak), so the trivial-docs gate is
 * narrow and any single disqualifier forces `standard`.
 *
 * This module makes NO routing decision on its own — the caller (submit
 * handler) decides whether to honor the auto-classification based on the
 * `intake.auto_size_classification.enabled` config flag (default false) and
 * the operator's `--size` / `--full-pipeline` flags. See SubmitHandler.
 *
 * Determinism contract: no LLM, no clock, no randomness, no environment
 * reads. The same `input` always yields the same result.
 *
 * @module task_size_classifier
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Coarse task-size buckets used to pick a pipeline shape.
 *
 * - `trivial-docs` — a tiny prose/docs edit; skips all upfront design phases.
 * - `small`        — a small change; today only reachable via explicit hint.
 * - `standard`     — the default; the full pipeline, byte-for-byte unchanged.
 * - `large`        — a big change; today maps to `standard` (no extra phases).
 */
export type TaskSize = 'trivial-docs' | 'small' | 'standard' | 'large';

/** Ordered list of every {@link TaskSize}, for validation/iteration. */
export const ALL_TASK_SIZES: readonly TaskSize[] = [
  'trivial-docs',
  'small',
  'standard',
  'large',
] as const;

/** Type guard for {@link TaskSize}. */
export function isValidTaskSize(value: string): value is TaskSize {
  return (ALL_TASK_SIZES as readonly string[]).includes(value);
}

/**
 * Input to {@link classifyTaskSize}.
 */
export interface TaskSizeInput {
  /** The (sanitized) request description / title text. */
  description: string;
  /**
   * Explicit operator size hint. When set to a valid {@link TaskSize}, the
   * classifier SHORT-CIRCUITS and returns it verbatim (operator override).
   */
  sizeHint?: TaskSize | string | null;
}

/**
 * Result of {@link classifyTaskSize}.
 */
export interface TaskSizeResult {
  /** The classified size. */
  size: TaskSize;
  /** Human-meaningful signals that matched (for audit/activity log). */
  matchedSignals: string[];
  /** Short, deterministic explanation of why this size was chosen. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Signal definitions (conservative; tuned so false-trivial is hard to reach)
// ---------------------------------------------------------------------------

/**
 * Docs/prose keywords. trivial-docs REQUIRES at least one of these. Word
 * boundaries keep `documentation` from matching inside unrelated tokens; the
 * `.md` and file-name forms are matched explicitly below.
 */
const DOCS_KEYWORD_REGEX =
  /\b(readme|changelog|docs|documentation|comment|comments|typo|wording|append|license|licence|contributing)\b/i;

/** Markdown / doc file extensions count as a docs signal even mid-token. */
const DOCS_FILE_REGEX = /\.md\b/i;

/**
 * Code keywords. ANY occurrence disqualifies trivial-docs (a doc edit that
 * also touches code is not trivial). Beyond literal code nouns, this includes
 * IMPLEMENTATION VERBS (implement/build/create/wire/…) and code-artifact nouns
 * (handler/service/module/…): a request that says "update the README AND
 * implement the login flow" is real feature work wearing a docs hat and must
 * NOT take the light path. (Found by adversarial probing — over-matching here
 * only over-routes a genuine doc task to the full pipeline, the safe direction.)
 */
const CODE_KEYWORD_REGEX =
  /\b(function|class|method|endpoint|test|tests|bug|refactor|implement|implements|implementing|build|builds|building|create|creates|creating|develop|develops|wire|wires|wiring|integrate|integrates|generate|generates|setup|handler|service|component|module|controller|middleware|daemon|server|client|parser|compiler|socket|websocket|pipeline|queue|worker)\b/i;

/**
 * Step-1 disqualifiers — technical / new-surface keywords. Presence of ANY of
 * these forces the size to be at least `standard`, even for a short prose-only
 * request. These name surfaces that demand design/review.
 */
const TECHNICAL_SURFACE_REGEX =
  /\b(api|endpoint|schema|migration|table|database|auth|oauth|jwt|security|crypto|concurrency|race|deploy|rollback|webhook|websocket|socket|interface|protocol|state machine|data model)\b/i;

/**
 * Step-1 disqualifiers — breadth signals. These describe sweeping, multi-file
 * work that is never trivial.
 */
const BREADTH_REGEX =
  /\b(refactor|rename across|migrate|all files|all usages|rewrite|redesign|everywhere|across the codebase)\b/i;

/**
 * Step-1 disqualifiers — test-demanding signals. Work that explicitly requires
 * non-trivial test infrastructure is never trivial.
 */
const TEST_DEMANDING_REGEX =
  /\b(integration test|regression test|test suite|cypress|e2e)\b/i;

/**
 * Step-1 disqualifier — "N tests" / "N+ tests" phrasing (e.g. "add 5 tests",
 * "12+ tests"). Captures a count of demanded tests as a strong signal.
 */
const N_TESTS_REGEX = /\b\d+\+?\s+tests?\b/i;

/** Upper bound below which trivial-docs is even considered. */
const TRIVIAL_DOCS_MAX_WORDS = 25;

/** Word count strictly above this is a Step-1 disqualifier on its own. */
const DISQUALIFY_WORD_COUNT = 60;

/**
 * A request touching >= this many distinct source-file paths is a Step-1
 * disqualifier (breadth proxy).
 */
const MAX_DISTINCT_SOURCE_PATHS = 2;

/**
 * Matches plausible source-file paths in free text: at least one `/` separator
 * and a recognizable code/source extension. Used to count distinct paths.
 *
 * Note: `.md` is intentionally EXCLUDED here — markdown is a docs signal, not a
 * source-file path, so referencing several `.md` files does not disqualify
 * trivial-docs. The disqualifier targets *source* breadth.
 */
const SOURCE_PATH_REGEX =
  /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|h|cpp|cc|sh|sql|yaml|yml|json|tf)\b/gi;

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Count whitespace-delimited words. */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Count DISTINCT source-file paths referenced in the text. */
function countDistinctSourcePaths(text: string): number {
  const matches = text.match(SOURCE_PATH_REGEX);
  if (!matches) return 0;
  const distinct = new Set(matches.map((m) => m.toLowerCase()));
  return distinct.size;
}

/**
 * Collect every Step-1 disqualifier that fires for the given text. Returns the
 * list of disqualifier signal labels (empty => no disqualifier). Used both to
 * gate trivial-docs and to explain why a request is >= standard.
 */
function collectDisqualifiers(text: string, wordCount: number): string[] {
  const hits: string[] = [];

  const tech = text.match(TECHNICAL_SURFACE_REGEX);
  if (tech) hits.push(`technical-surface:${tech[0].toLowerCase()}`);

  const breadth = text.match(BREADTH_REGEX);
  if (breadth) hits.push(`breadth:${breadth[0].toLowerCase()}`);

  const testDemand = text.match(TEST_DEMANDING_REGEX);
  if (testDemand) hits.push(`test-demanding:${testDemand[0].toLowerCase()}`);

  const nTests = text.match(N_TESTS_REGEX);
  if (nTests) hits.push(`test-demanding:${nTests[0].toLowerCase().trim()}`);

  if (wordCount > DISQUALIFY_WORD_COUNT) {
    hits.push(`word-count>${DISQUALIFY_WORD_COUNT}`);
  }

  const pathCount = countDistinctSourcePaths(text);
  if (pathCount >= MAX_DISTINCT_SOURCE_PATHS) {
    hits.push(`distinct-source-paths:${pathCount}`);
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a request's task size.
 *
 * Decision order:
 *   1. Explicit `sizeHint` (valid {@link TaskSize}) — short-circuit, verbatim.
 *   2. ANY Step-1 disqualifier present — force `standard` (never trivial).
 *   3. trivial-docs gate — ALL of: a docs/prose keyword, wordCount<=25, NO
 *      code keyword, AND zero disqualifiers (already guaranteed by step 2).
 *   4. Otherwise — `standard` (the conservative default).
 *
 * Note (first cut): `small` and `large` are never AUTO-classified; they are
 * only reachable via an explicit `sizeHint`. This keeps the blast radius at a
 * single new light path (trivial-docs) while leaving the vocabulary in place.
 *
 * @param input - description text plus optional explicit size hint.
 * @returns the classified {@link TaskSizeResult}.
 */
export function classifyTaskSize(input: TaskSizeInput): TaskSizeResult {
  // 1. Explicit operator hint short-circuits everything.
  if (input.sizeHint != null && isValidTaskSize(String(input.sizeHint))) {
    const size = String(input.sizeHint) as TaskSize;
    return {
      size,
      matchedSignals: ['explicit-size-hint'],
      reason: `explicit size hint '${size}' overrides the classifier`,
    };
  }

  const text = input.description ?? '';
  const wordCount = countWords(text);

  // 2. Step-1 disqualifiers force >= standard. Asymmetric guard: evaluate
  //    these BEFORE the trivial-docs gate so a single technical/breadth/test
  //    signal can never be out-voted by a stray docs keyword.
  const disqualifiers = collectDisqualifiers(text, wordCount);
  if (disqualifiers.length > 0) {
    return {
      size: 'standard',
      matchedSignals: disqualifiers,
      reason: `disqualified from trivial-docs by: ${disqualifiers.join(', ')}`,
    };
  }

  // 3. trivial-docs gate. Requires ALL of the conjunctive conditions.
  const docsKeyword = text.match(DOCS_KEYWORD_REGEX);
  const docsFile = text.match(DOCS_FILE_REGEX);
  const hasDocsSignal = Boolean(docsKeyword) || Boolean(docsFile);
  const codeKeyword = text.match(CODE_KEYWORD_REGEX);
  const withinWordCap = wordCount <= TRIVIAL_DOCS_MAX_WORDS;

  if (hasDocsSignal && withinWordCap && !codeKeyword) {
    const signals: string[] = [];
    if (docsKeyword) signals.push(`docs-keyword:${docsKeyword[0].toLowerCase()}`);
    if (docsFile) signals.push(`docs-file:${docsFile[0].toLowerCase()}`);
    signals.push(`word-count:${wordCount}`);
    return {
      size: 'trivial-docs',
      matchedSignals: signals,
      reason:
        `trivial docs edit: matched ${signals.join(', ')}, ` +
        `no code keyword, no disqualifiers`,
    };
  }

  // 4. Conservative default.
  const why: string[] = [];
  if (!hasDocsSignal) why.push('no docs/prose keyword');
  if (codeKeyword) why.push(`code keyword '${codeKeyword[0].toLowerCase()}'`);
  if (!withinWordCap) why.push(`word count ${wordCount} > ${TRIVIAL_DOCS_MAX_WORDS}`);
  return {
    size: 'standard',
    matchedSignals: [],
    reason: `defaulted to standard: ${why.join('; ') || 'no trivial-docs signal'}`,
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  DOCS_KEYWORD_REGEX,
  DOCS_FILE_REGEX,
  CODE_KEYWORD_REGEX,
  TECHNICAL_SURFACE_REGEX,
  BREADTH_REGEX,
  TEST_DEMANDING_REGEX,
  TRIVIAL_DOCS_MAX_WORDS,
  DISQUALIFY_WORD_COUNT,
  MAX_DISTINCT_SOURCE_PATHS,
};
