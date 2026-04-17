/**
 * NLP request parser and ambiguity detector.
 *
 * The parser sends the user's sanitized description to Claude API with a
 * structured extraction schema in the system message (defense-in-depth:
 * user text is always a `user` message, never mixed with instructions).
 *
 * The ambiguity detector evaluates the parsed result and raw input to
 * determine whether clarification is needed, then generates focused
 * clarifying questions via Claude API.
 *
 * Together with the sanitizer, these form stages 1-3 of the request
 * parsing pipeline (TDD section 3.5.1).
 *
 * @module request_parser
 */

import type { ParsedRequest } from '../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of clarification rounds before hard stop. */
const MAX_CLARIFICATION_ROUNDS = 5;

/**
 * Regex for detecting technical terms in a request.
 * When present, short inputs are less likely to be flagged as ambiguous.
 */
const TECHNICAL_TERM_REGEX =
  /\b(api|endpoint|database|schema|migration|component|service|microservice|webhook|oauth|jwt|graphql|rest|crud|deployment|docker|kubernetes|ci\/cd|pipeline|test|integration|refactor|bug|fix|feature|module|class|function|interface|type|enum)\b/i;

/**
 * Regex for extracting GitHub/GitLab repository references from URLs.
 * Captures exactly owner/repo (two path segments after the domain).
 */
const REPO_URL_REGEX = /(?:github|gitlab)\.com\/([^/\s]+\/[^/\s]+?)(?:\/|\.git|\s|$)/;

// ---------------------------------------------------------------------------
// System prompt for NLP extraction
// ---------------------------------------------------------------------------

const NLP_SYSTEM_PROMPT = `You are a request parser. Extract structured fields from the user's feature request description.
Return a JSON object matching this exact schema:

{
  "title": "Short title, max 100 characters",
  "description": "Cleaned, expanded description",
  "priority": "high" | "normal" | "low",
  "target_repo": "owner/repo" or null,
  "deadline": "ISO-8601 date" or null,
  "related_tickets": ["URL1", "URL2"],
  "technical_constraints": "string or null",
  "acceptance_criteria": "string or null",
  "confidence": 0.0 to 1.0
}

Rules:
- Extract target_repo from explicit --repo flags, GitHub/GitLab URLs, or recognized repo names.
- If no repo can be identified, set target_repo to null.
- Set confidence based on how clear and actionable the request is.
- Extract URLs from the text as related_tickets.
- Do not add information not present in the input.`;

// ---------------------------------------------------------------------------
// System prompt for clarifying question generation
// ---------------------------------------------------------------------------

const CLARIFICATION_SYSTEM_PROMPT = `You are an assistant that generates clarifying questions for ambiguous feature requests.
Given a list of ambiguity issues and a parsed request, generate at most 3 focused clarifying questions.
Each question must be actionable (can be answered in one sentence).
Return a JSON array of strings, e.g.: ["Question 1?", "Question 2?"]
Do not include more than 3 questions.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of ambiguity detection on a parsed request.
 */
export interface AmbiguityResult {
  /** Whether the request is considered ambiguous. */
  isAmbiguous: boolean;
  /** List of specific ambiguity issues detected. */
  issues: string[];
  /** Suggested clarifying questions to ask the user. */
  suggestedQuestions: string[];
}

/**
 * Options passed to the NLP parser.
 */
export interface ParserOptions {
  /** Explicit --repo flag value; overrides NLP extraction if present. */
  repoFlag?: string;
  /** List of known repo identifiers for matching. */
  knownRepos?: string[];
}

/**
 * A Claude API client interface.
 *
 * Abstracted so callers can inject a real or mock client. The parser
 * only needs a `createMessage` method that accepts system + user messages
 * and returns a text response.
 */
export interface ClaudeApiClient {
  /**
   * Send a message to Claude and receive a text response.
   *
   * @param systemPrompt  The system-level instruction message.
   * @param userMessage   The user-level content (always the user's text, never instructions).
   * @returns The assistant's text response.
   */
  createMessage(systemPrompt: string, userMessage: string): Promise<string>;
}

/**
 * Logger interface for structured logging.
 */
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default no-op logger used when no logger is provided.
 */
const nullLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
};

// ---------------------------------------------------------------------------
// NLP Parser
// ---------------------------------------------------------------------------

/**
 * Parse a sanitized description into a structured `ParsedRequest` using
 * Claude API for NLP extraction.
 *
 * Structural defense: the user's text is always sent as the `user` message,
 * never concatenated into system instructions.
 *
 * Repo extraction priority:
 * 1. Explicit `--repo` flag from command flags (already parsed before NLP).
 * 2. GitHub/GitLab URL pattern in the text.
 * 3. Match against a known-repos list.
 * 4. `null` (triggers ambiguity detector).
 *
 * Fallback on API failure: returns a `ParsedRequest` with `title` = first 100
 * chars of description, `priority = 'normal'`, `confidence = 0.3`, and all
 * other fields null/empty.
 *
 * @param sanitizedText  The sanitized user input (output of the sanitizer).
 * @param client         A Claude API client for NLP extraction.
 * @param options        Parser options including --repo flag and known repos.
 * @param logger         Optional logger for error/warning output.
 * @returns A structured `ParsedRequest`.
 */
export async function parseRequest(
  sanitizedText: string,
  client: ClaudeApiClient,
  options: ParserOptions = {},
  logger: Logger = nullLogger,
): Promise<ParsedRequest> {
  let parsed: ParsedRequest;

  try {
    // Defense-in-depth: system message contains extraction schema only;
    // user message contains the sanitized text verbatim. Nothing else.
    const response = await client.createMessage(NLP_SYSTEM_PROMPT, sanitizedText);
    parsed = parseApiResponse(response, sanitizedText);
  } catch (err) {
    logger.error('Claude API call failed during NLP parsing; using fallback.', {
      error: (err as Error).message,
    });
    parsed = buildFallbackParsedRequest(sanitizedText);
  }

  // Apply repo resolution priority chain
  parsed.target_repo = resolveTargetRepo(
    sanitizedText,
    parsed.target_repo,
    options,
  );

  return parsed;
}

/**
 * Parse the raw Claude API response text into a `ParsedRequest`.
 *
 * Extracts JSON from the response (handles code-fenced JSON blocks),
 * validates the shape, and maps fields.
 *
 * @param responseText    Raw text response from Claude API.
 * @param originalInput   The original sanitized input (used for fallback title).
 * @returns A validated `ParsedRequest`.
 */
function parseApiResponse(responseText: string, originalInput: string): ParsedRequest {
  // Strip markdown code fences if present
  let jsonText = responseText.trim();
  const codeFenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeFenceMatch) {
    jsonText = codeFenceMatch[1].trim();
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonText);
  } catch {
    // If JSON parsing fails, return fallback
    return buildFallbackParsedRequest(originalInput);
  }

  return {
    title: typeof data.title === 'string' ? data.title.slice(0, 100) : originalInput.slice(0, 100),
    description: typeof data.description === 'string' ? data.description : originalInput,
    priority: isValidPriority(data.priority) ? data.priority : 'normal',
    target_repo: typeof data.target_repo === 'string' ? data.target_repo : null,
    deadline: typeof data.deadline === 'string' ? data.deadline : null,
    related_tickets: Array.isArray(data.related_tickets)
      ? data.related_tickets.filter((t): t is string => typeof t === 'string')
      : [],
    technical_constraints:
      typeof data.technical_constraints === 'string' ? data.technical_constraints : null,
    acceptance_criteria:
      typeof data.acceptance_criteria === 'string' ? data.acceptance_criteria : null,
    confidence:
      typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1
        ? data.confidence
        : 0.5,
  };
}

/**
 * Type guard for valid priority values.
 */
function isValidPriority(value: unknown): value is 'high' | 'normal' | 'low' {
  return value === 'high' || value === 'normal' || value === 'low';
}

/**
 * Build a fallback `ParsedRequest` when Claude API is unreachable.
 *
 * @param rawText  The original input text.
 * @returns A minimal `ParsedRequest` with confidence 0.3.
 */
function buildFallbackParsedRequest(rawText: string): ParsedRequest {
  return {
    title: rawText.slice(0, 100),
    description: rawText,
    priority: 'normal',
    target_repo: null,
    deadline: null,
    related_tickets: [],
    technical_constraints: null,
    acceptance_criteria: null,
    confidence: 0.3,
  };
}

/**
 * Resolve `target_repo` according to the priority chain:
 *
 * 1. Explicit `--repo` flag (highest priority, overrides everything).
 * 2. GitHub/GitLab URL extracted from the text.
 * 3. Match against the known-repos list.
 * 4. NLP-extracted value (from Claude response).
 * 5. `null` if nothing matched.
 *
 * @param rawText      The sanitized input text.
 * @param nlpRepo      The repo extracted by the NLP model, or null.
 * @param options      Parser options containing --repo flag and known repos.
 * @returns The resolved target_repo string or null.
 */
function resolveTargetRepo(
  rawText: string,
  nlpRepo: string | null,
  options: ParserOptions,
): string | null {
  // 1. Explicit --repo flag overrides everything
  if (options.repoFlag) {
    return options.repoFlag;
  }

  // 2. GitHub/GitLab URL in the text
  const urlMatch = rawText.match(REPO_URL_REGEX);
  if (urlMatch) {
    return urlMatch[1];
  }

  // 3. Match against known repos list
  if (options.knownRepos && options.knownRepos.length > 0) {
    const lowerText = rawText.toLowerCase();
    for (const repo of options.knownRepos) {
      // Match "owner/name" or just "name" portion
      const repoName = repo.includes('/') ? repo.split('/')[1] : repo;
      if (lowerText.includes(repoName.toLowerCase())) {
        return repo;
      }
    }
  }

  // 4. NLP-extracted value
  if (nlpRepo) {
    return nlpRepo;
  }

  // 5. Nothing matched
  return null;
}

// ---------------------------------------------------------------------------
// Ambiguity Detector
// ---------------------------------------------------------------------------

/**
 * Detect ambiguity in a parsed request and generate clarifying questions.
 *
 * Ambiguity conditions (any one triggers ambiguity):
 * 1. `parsed.confidence < 0.6`
 * 2. `parsed.target_repo === null` (and no `--repo` flag)
 * 3. `raw.split(/\s+/).length < 15 && !TECHNICAL_TERM_REGEX.test(raw)`
 *
 * When ambiguity is detected, a Claude API call generates at most 3
 * focused, actionable clarifying questions.
 *
 * Conversation round tracking: maximum 5 rounds of clarification (FR-28).
 * On round 6, an error is thrown instead of generating more questions.
 *
 * @param rawText     The original (pre-sanitization) user input text.
 * @param parsed      The structured `ParsedRequest` from NLP parsing.
 * @param roundCount  The current clarification round (1-indexed).
 * @param client      A Claude API client for question generation.
 * @param options     Parser options (to check for --repo flag).
 * @param logger      Optional logger.
 * @returns An `AmbiguityResult` with issues and suggested questions.
 * @throws If `roundCount` exceeds `MAX_CLARIFICATION_ROUNDS`.
 */
export async function detectAmbiguity(
  rawText: string,
  parsed: ParsedRequest,
  roundCount: number,
  client: ClaudeApiClient,
  options: ParserOptions = {},
  logger: Logger = nullLogger,
): Promise<AmbiguityResult> {
  // Enforce maximum clarification rounds
  if (roundCount > MAX_CLARIFICATION_ROUNDS) {
    throw new Error(
      'Maximum clarification rounds reached. Please submit a more detailed description.',
    );
  }

  const issues: string[] = [];

  // Condition 1: Low confidence
  if (parsed.confidence < 0.6) {
    issues.push(
      `Low confidence score (${parsed.confidence.toFixed(2)}): the request may be unclear or too vague.`,
    );
  }

  // Condition 2: No target repo (and no --repo flag)
  if (parsed.target_repo === null && !options.repoFlag) {
    issues.push('No target repository could be identified from the request.');
  }

  // Condition 3: Short input without technical terms
  const wordCount = rawText.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < 15 && !TECHNICAL_TERM_REGEX.test(rawText)) {
    issues.push(
      `Request is too short (${wordCount} words) and lacks technical specificity.`,
    );
  }

  const isAmbiguous = issues.length > 0;

  // Generate clarifying questions only when ambiguous
  if (!isAmbiguous) {
    return {
      isAmbiguous: false,
      issues: [],
      suggestedQuestions: [],
    };
  }

  // Generate clarifying questions via Claude API
  let suggestedQuestions: string[] = [];
  try {
    const userPayload = JSON.stringify({
      issues,
      parsedRequest: parsed,
      rawInput: rawText,
    });

    const response = await client.createMessage(CLARIFICATION_SYSTEM_PROMPT, userPayload);
    suggestedQuestions = parseClarifyingQuestions(response);
  } catch (err) {
    logger.warn('Failed to generate clarifying questions via Claude API.', {
      error: (err as Error).message,
    });
    // Fallback: generate generic questions from the issues
    suggestedQuestions = issues.map(
      (issue) => `Could you clarify: ${issue.replace(/\.$/, '')}?`,
    );
  }

  return {
    isAmbiguous: true,
    issues,
    suggestedQuestions,
  };
}

/**
 * Parse the Claude API response for clarifying questions.
 *
 * Expects a JSON array of strings. Limits to at most 3 questions.
 * Falls back to extracting lines that look like questions on parse failure.
 *
 * @param responseText  Raw text response from Claude API.
 * @returns Array of at most 3 clarifying question strings.
 */
function parseClarifyingQuestions(responseText: string): string[] {
  let jsonText = responseText.trim();

  // Strip code fences if present
  const codeFenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeFenceMatch) {
    jsonText = codeFenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .slice(0, 3);
    }
  } catch {
    // Fall through to line extraction
  }

  // Fallback: extract lines ending with '?'
  const lines = responseText
    .split('\n')
    .map((l) => l.replace(/^[\s\-*\d.]+/, '').trim())
    .filter((l) => l.endsWith('?') && l.length > 5);

  return lines.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Exported constants for testing
// ---------------------------------------------------------------------------

export { NLP_SYSTEM_PROMPT, CLARIFICATION_SYSTEM_PROMPT, TECHNICAL_TERM_REGEX, MAX_CLARIFICATION_ROUNDS };
