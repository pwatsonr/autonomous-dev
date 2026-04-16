/**
 * Unit tests for the NLP request parser (SPEC-008-1-08).
 *
 * Covers:
 *  - Structured extraction with valid response
 *  - Repo extraction priority: flag > URL > known-repos > null
 *  - Fallback on API failure
 *  - Ambiguity conditions: low confidence, no repo, short non-technical input
 *  - Clarifying question generation (mocked)
 *  - 5-round limit enforcement
 *  - 100% of parse pipeline stages
 *
 * @module request_parser.test
 */

import {
  parseRequest,
  detectAmbiguity,
  MAX_CLARIFICATION_ROUNDS,
  type ClaudeApiClient,
  type ParserOptions,
  type AmbiguityResult,
  type Logger,
} from '../../core/request_parser';
import type { ParsedRequest } from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Claude API client. */
function createMockClient(response: string | Error = '{}'): ClaudeApiClient {
  if (response instanceof Error) {
    return {
      createMessage: jest.fn().mockRejectedValue(response),
    };
  }
  return {
    createMessage: jest.fn().mockResolvedValue(response),
  };
}

/** Create a mock logger. */
function createMockLogger(): Logger {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  };
}

/** A well-formed NLP extraction response. */
const VALID_NLP_RESPONSE = JSON.stringify({
  title: 'Add user profile endpoint',
  description: 'Create a REST API endpoint to retrieve user profile data including name, email, and avatar.',
  priority: 'high',
  target_repo: 'org/backend-api',
  deadline: '2026-05-01',
  related_tickets: ['https://jira.example.com/PROJ-123'],
  technical_constraints: 'Must use existing auth middleware',
  acceptance_criteria: 'Returns 200 with user JSON on success',
  confidence: 0.92,
});

// ---------------------------------------------------------------------------
// Tests: parseRequest()
// ---------------------------------------------------------------------------

describe('parseRequest()', () => {
  describe('structured extraction with valid response', () => {
    it('parses a valid NLP extraction response', async () => {
      const client = createMockClient(VALID_NLP_RESPONSE);
      const result = await parseRequest('Add user profile endpoint', client);

      expect(result.title).toBe('Add user profile endpoint');
      expect(result.description).toContain('REST API endpoint');
      expect(result.priority).toBe('high');
      expect(result.target_repo).toBe('org/backend-api');
      expect(result.deadline).toBe('2026-05-01');
      expect(result.related_tickets).toEqual(['https://jira.example.com/PROJ-123']);
      expect(result.technical_constraints).toBe('Must use existing auth middleware');
      expect(result.acceptance_criteria).toBe('Returns 200 with user JSON on success');
      expect(result.confidence).toBe(0.92);
    });

    it('handles code-fenced JSON response', async () => {
      const codeFencedResponse = '```json\n' + VALID_NLP_RESPONSE + '\n```';
      const client = createMockClient(codeFencedResponse);
      const result = await parseRequest('Add user profile endpoint', client);

      expect(result.title).toBe('Add user profile endpoint');
      expect(result.confidence).toBe(0.92);
    });

    it('truncates title to 100 characters', async () => {
      const longTitle = 'A'.repeat(200);
      const response = JSON.stringify({ title: longTitle, confidence: 0.9 });
      const client = createMockClient(response);
      const result = await parseRequest('test', client);

      expect(result.title.length).toBeLessThanOrEqual(100);
    });

    it('defaults priority to normal for invalid value', async () => {
      const response = JSON.stringify({ title: 'Test', priority: 'urgent', confidence: 0.8 });
      const client = createMockClient(response);
      const result = await parseRequest('test', client);

      expect(result.priority).toBe('normal');
    });

    it('defaults confidence to 0.5 when out of range', async () => {
      const response = JSON.stringify({ title: 'Test', confidence: 1.5 });
      const client = createMockClient(response);
      const result = await parseRequest('test', client);

      expect(result.confidence).toBe(0.5);
    });

    it('defaults confidence to 0.5 when negative', async () => {
      const response = JSON.stringify({ title: 'Test', confidence: -0.5 });
      const client = createMockClient(response);
      const result = await parseRequest('test', client);

      expect(result.confidence).toBe(0.5);
    });

    it('filters non-string entries from related_tickets', async () => {
      const response = JSON.stringify({
        title: 'Test',
        related_tickets: ['valid-url', 42, null, 'another-url'],
        confidence: 0.8,
      });
      const client = createMockClient(response);
      const result = await parseRequest('test', client);

      expect(result.related_tickets).toEqual(['valid-url', 'another-url']);
    });
  });

  // =========================================================================
  // Repo extraction priority
  // =========================================================================

  describe('repo extraction priority', () => {
    it('--repo flag overrides everything', async () => {
      const response = JSON.stringify({
        title: 'Test',
        target_repo: 'nlp-extracted/repo',
        confidence: 0.9,
      });
      const client = createMockClient(response);
      const options: ParserOptions = { repoFlag: 'flag/repo' };

      const result = await parseRequest(
        'Work on https://github.com/url/repo for feature X',
        client,
        options,
      );

      expect(result.target_repo).toBe('flag/repo');
    });

    it('URL extraction takes priority over known-repos and NLP', async () => {
      const response = JSON.stringify({
        title: 'Test',
        target_repo: 'nlp/repo',
        confidence: 0.9,
      });
      const client = createMockClient(response);
      const options: ParserOptions = {
        knownRepos: ['known/repo'],
      };

      const result = await parseRequest(
        'Fix bug in https://github.com/url/repo project',
        client,
        options,
      );

      expect(result.target_repo).toBe('url/repo');
    });

    it('known-repos matching takes priority over NLP-extracted value', async () => {
      const response = JSON.stringify({
        title: 'Test',
        target_repo: 'nlp/repo',
        confidence: 0.9,
      });
      const client = createMockClient(response);
      const options: ParserOptions = {
        knownRepos: ['org/my-service'],
      };

      // Text mentions "my-service" which matches known-repo
      const result = await parseRequest(
        'Update the my-service project to add logging',
        client,
        options,
      );

      expect(result.target_repo).toBe('org/my-service');
    });

    it('NLP-extracted repo is used when no flag, URL, or known-repo matches', async () => {
      const response = JSON.stringify({
        title: 'Test',
        target_repo: 'nlp/extracted',
        confidence: 0.9,
      });
      const client = createMockClient(response);

      const result = await parseRequest('Some request without repo info', client);

      expect(result.target_repo).toBe('nlp/extracted');
    });

    it('returns null when no repo is found by any method', async () => {
      const response = JSON.stringify({
        title: 'Test',
        target_repo: null,
        confidence: 0.9,
      });
      const client = createMockClient(response);

      const result = await parseRequest('Vague request with no repo info', client);

      expect(result.target_repo).toBeNull();
    });

    it('extracts repo from GitLab URL', async () => {
      const response = JSON.stringify({
        title: 'Test',
        target_repo: null,
        confidence: 0.9,
      });
      const client = createMockClient(response);

      const result = await parseRequest(
        'Fix the bug in https://gitlab.com/myorg/myproject',
        client,
      );

      expect(result.target_repo).toBe('myorg/myproject');
    });
  });

  // =========================================================================
  // Fallback on API failure
  // =========================================================================

  describe('fallback on API failure', () => {
    it('returns fallback parsed request on API error', async () => {
      const client = createMockClient(new Error('Network error'));
      const logger = createMockLogger();

      const result = await parseRequest('Build a new dashboard', client, {}, logger);

      expect(result.title).toBe('Build a new dashboard');
      expect(result.description).toBe('Build a new dashboard');
      expect(result.priority).toBe('normal');
      expect(result.confidence).toBe(0.3);
      expect(result.target_repo).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it('returns fallback when response is not valid JSON', async () => {
      const client = createMockClient('This is not JSON at all.');

      const result = await parseRequest('Build a new dashboard', client);

      // parseApiResponse should fail JSON.parse and return fallback
      expect(result.title).toBe('Build a new dashboard');
      expect(result.confidence).toBe(0.3);
    });

    it('fallback title is truncated to 100 characters', async () => {
      const longInput = 'A'.repeat(200);
      const client = createMockClient(new Error('fail'));

      const result = await parseRequest(longInput, client);

      expect(result.title.length).toBe(100);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: detectAmbiguity()
// ---------------------------------------------------------------------------

describe('detectAmbiguity()', () => {
  describe('ambiguity conditions', () => {
    it('flags low confidence (< 0.6) as ambiguous', async () => {
      const client = createMockClient('["What exactly do you need?"]');
      const parsed = makeParsedRequest({ confidence: 0.4 });

      const result = await detectAmbiguity('some input text', parsed, 1, client);

      expect(result.isAmbiguous).toBe(true);
      expect(result.issues.some((i) => i.includes('Low confidence'))).toBe(true);
    });

    it('does not flag confidence >= 0.6', async () => {
      const client = createMockClient('[]');
      const parsed = makeParsedRequest({ confidence: 0.8, target_repo: 'org/repo' });

      const result = await detectAmbiguity(
        'Create a REST API endpoint for user management with full CRUD operations and authentication',
        parsed,
        1,
        client,
      );

      expect(result.isAmbiguous).toBe(false);
    });

    it('flags missing target_repo (no --repo flag) as ambiguous', async () => {
      const client = createMockClient('["Which repository should this go in?"]');
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.9 });

      const result = await detectAmbiguity(
        'Create a REST API endpoint for user management with full CRUD operations and authentication support',
        parsed,
        1,
        client,
      );

      expect(result.isAmbiguous).toBe(true);
      expect(result.issues.some((i) => i.includes('No target repository'))).toBe(true);
    });

    it('does not flag missing repo when --repo flag is provided', async () => {
      const client = createMockClient('[]');
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.9 });

      const result = await detectAmbiguity(
        'Create a REST API endpoint for user management with full CRUD operations and authentication support',
        parsed,
        1,
        client,
        { repoFlag: 'org/repo' },
      );

      expect(result.isAmbiguous).toBe(false);
    });

    it('flags short non-technical input as ambiguous', async () => {
      const client = createMockClient('["Could you describe what you need?"]');
      const parsed = makeParsedRequest({ target_repo: 'org/repo', confidence: 0.9 });

      const result = await detectAmbiguity(
        'make it better please',
        parsed,
        1,
        client,
      );

      expect(result.isAmbiguous).toBe(true);
      expect(result.issues.some((i) => i.includes('too short'))).toBe(true);
    });

    it('does not flag short input with technical terms', async () => {
      const client = createMockClient('[]');
      const parsed = makeParsedRequest({ target_repo: 'org/repo', confidence: 0.9 });

      const result = await detectAmbiguity(
        'fix the database migration bug',
        parsed,
        1,
        client,
      );

      // "database" and "migration" and "bug" are technical terms
      expect(result.isAmbiguous).toBe(false);
    });

    it('detects multiple ambiguity conditions simultaneously', async () => {
      const client = createMockClient('["Q1?", "Q2?"]');
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.3 });

      const result = await detectAmbiguity(
        'do the thing',
        parsed,
        1,
        client,
      );

      expect(result.isAmbiguous).toBe(true);
      // Should have at least 3 issues: low confidence, no repo, short non-technical
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // Clarifying question generation
  // =========================================================================

  describe('clarifying question generation', () => {
    it('generates clarifying questions via Claude API', async () => {
      const questions = ['What repository?', 'What priority?', 'Any deadline?'];
      const client = createMockClient(JSON.stringify(questions));
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      const result = await detectAmbiguity('vague request', parsed, 1, client);

      expect(result.suggestedQuestions).toEqual(questions);
      expect(result.suggestedQuestions.length).toBeLessThanOrEqual(3);
    });

    it('limits questions to 3 even if API returns more', async () => {
      const questions = ['Q1?', 'Q2?', 'Q3?', 'Q4?', 'Q5?'];
      const client = createMockClient(JSON.stringify(questions));
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      const result = await detectAmbiguity('vague', parsed, 1, client);

      expect(result.suggestedQuestions.length).toBeLessThanOrEqual(3);
    });

    it('handles code-fenced JSON response for questions', async () => {
      const questions = ['What is the target repo?'];
      const client = createMockClient('```json\n' + JSON.stringify(questions) + '\n```');
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      const result = await detectAmbiguity('vague', parsed, 1, client);

      expect(result.suggestedQuestions).toEqual(questions);
    });

    it('falls back to issue-based questions on API failure', async () => {
      const client = createMockClient(new Error('API failure'));
      const logger = createMockLogger();
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      const result = await detectAmbiguity('vague', parsed, 1, client, {}, logger);

      expect(result.isAmbiguous).toBe(true);
      expect(result.suggestedQuestions.length).toBeGreaterThan(0);
      // Fallback questions are derived from issues
      for (const q of result.suggestedQuestions) {
        expect(q).toContain('Could you clarify');
      }
      expect(logger.warn).toHaveBeenCalled();
    });

    it('extracts question-like lines as fallback when response is not JSON', async () => {
      const client = createMockClient(
        'Here are some questions:\n- What repository should this go in?\n- What is the expected deadline?\n',
      );
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      const result = await detectAmbiguity('vague', parsed, 1, client);

      // Should extract lines ending with '?'
      expect(result.suggestedQuestions.length).toBeGreaterThan(0);
      for (const q of result.suggestedQuestions) {
        expect(q).toMatch(/\?$/);
      }
    });

    it('returns empty suggestedQuestions when not ambiguous', async () => {
      const client = createMockClient('[]');
      const parsed = makeParsedRequest({ target_repo: 'org/repo', confidence: 0.9 });

      const result = await detectAmbiguity(
        'Create a comprehensive REST API endpoint for user profile management with full CRUD operations and JWT authentication',
        parsed,
        1,
        client,
      );

      expect(result.isAmbiguous).toBe(false);
      expect(result.suggestedQuestions).toHaveLength(0);
    });
  });

  // =========================================================================
  // Round limit enforcement
  // =========================================================================

  describe('round limit enforcement', () => {
    it('allows up to MAX_CLARIFICATION_ROUNDS (5)', async () => {
      const client = createMockClient('["Q?"]');
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      // Round 5 should succeed
      const result = await detectAmbiguity('vague', parsed, 5, client);
      expect(result.isAmbiguous).toBe(true);
    });

    it('throws on round 6 (exceeds MAX_CLARIFICATION_ROUNDS)', async () => {
      const client = createMockClient('["Q?"]');
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      await expect(
        detectAmbiguity('vague', parsed, 6, client),
      ).rejects.toThrow('Maximum clarification rounds reached');
    });

    it('throws on any round beyond the limit', async () => {
      const client = createMockClient('["Q?"]');
      const parsed = makeParsedRequest({ target_repo: null, confidence: 0.4 });

      await expect(
        detectAmbiguity('vague', parsed, 10, client),
      ).rejects.toThrow('Maximum clarification rounds reached');
    });

    it('MAX_CLARIFICATION_ROUNDS equals 5', () => {
      expect(MAX_CLARIFICATION_ROUNDS).toBe(5);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers used in ambiguity tests
// ---------------------------------------------------------------------------

function makeParsedRequest(overrides: Partial<ParsedRequest> = {}): ParsedRequest {
  return {
    title: 'Test Request',
    description: 'A test description for the feature request.',
    priority: 'normal',
    target_repo: 'org/repo',
    deadline: null,
    related_tickets: [],
    technical_constraints: null,
    acceptance_criteria: null,
    confidence: 0.9,
    ...overrides,
  };
}
