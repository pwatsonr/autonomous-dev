/**
 * Agent Discovery (SPEC-005-1-3, Task 5).
 *
 * Two-pass domain matching algorithm for finding the best agent for a task:
 *   Pass 1: Exact tag match against agent expertise arrays (fast path).
 *   Pass 2: TF-IDF cosine similarity fallback when no exact match exceeds threshold.
 *
 * Emits a `domain_gap_detected` audit event when no agent meets the threshold.
 */

import {
  AgentRecord,
  RankedAgent,
  DiscoveryOptions,
  AuditEvent,
} from './types';
import { AuditLogger } from './audit';

// ---------------------------------------------------------------------------
// Stop words (common English words excluded from keyword extraction)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'this', 'that',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'can', 'shall', 'not', 'no', 'so', 'if', 'then', 'than', 'too',
  'very', 'just', 'about', 'up', 'out', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
  'into', 'over', 'after', 'before', 'between', 'under', 'again',
  'further', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'what', 'which', 'who', 'whom', 'its', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover agents matching a query using two-pass matching.
 *
 * Pass 1 (exact): Extract keywords from query, match against agent expertise tags.
 * Pass 2 (semantic): TF-IDF cosine similarity fallback if Pass 1 yields no results
 *   above the similarity threshold.
 *
 * If no agent exceeds the threshold in either pass, emits a `domain_gap_detected`
 * audit event and returns an empty array.
 *
 * @param query      Free-text task description or domain query.
 * @param registry   Array of AgentRecords to search (only ACTIVE agents considered).
 * @param options    Optional discovery configuration.
 * @param auditLogger Optional audit logger for domain gap events.
 * @returns          Ranked agents sorted by score descending.
 */
export function discoverAgents(
  query: string,
  registry: AgentRecord[],
  options?: DiscoveryOptions,
  auditLogger?: AuditLogger,
): RankedAgent[] {
  const threshold = options?.similarityThreshold ?? 0.6;
  const maxResults = options?.maxResults ?? 5;

  // Only consider ACTIVE agents
  const activeAgents = registry.filter((r) => r.state === 'ACTIVE');

  if (activeAgents.length === 0) {
    return [];
  }

  // Pass 1: Exact tag match
  const pass1Results = exactTagMatch(query, activeAgents);

  // Check if any Pass 1 result exceeds the threshold
  const pass1AboveThreshold = pass1Results.filter((r) => r.score >= threshold);

  if (pass1AboveThreshold.length > 0) {
    return pass1AboveThreshold.slice(0, maxResults);
  }

  // Pass 2: Semantic similarity (TF-IDF cosine)
  const pass2Results = semanticMatch(query, activeAgents);
  const pass2AboveThreshold = pass2Results.filter((r) => r.score >= threshold);

  if (pass2AboveThreshold.length > 0) {
    return pass2AboveThreshold.slice(0, maxResults);
  }

  // Domain gap: no agent exceeds threshold in either pass
  if (auditLogger) {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      event_type: 'domain_gap_detected',
      details: {
        query,
        agentCount: activeAgents.length,
        bestPass1Score: pass1Results.length > 0 ? pass1Results[0].score : 0,
        bestPass2Score: pass2Results.length > 0 ? pass2Results[0].score : 0,
        threshold,
      },
    };
    auditLogger.log(event);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Pass 1: Exact Tag Match
// ---------------------------------------------------------------------------

/**
 * Extract domain keywords from the query and match against agent expertise tags.
 *
 * Score = number of matching expertise tags / total query keywords.
 * Agents with score > 0 are returned, sorted by score descending.
 */
function exactTagMatch(query: string, agents: AgentRecord[]): RankedAgent[] {
  const keywords = extractKeywords(query);

  if (keywords.length === 0) {
    return [];
  }

  const results: RankedAgent[] = [];

  for (const record of agents) {
    const expertiseLower = record.agent.expertise.map((t) => t.toLowerCase());
    const matchedTags: string[] = [];

    for (const keyword of keywords) {
      if (expertiseLower.includes(keyword)) {
        // Find the original-cased tag
        const idx = expertiseLower.indexOf(keyword);
        matchedTags.push(record.agent.expertise[idx]);
      }
    }

    if (matchedTags.length > 0) {
      const score = matchedTags.length / keywords.length;
      results.push({
        agent: record,
        score,
        matchType: 'exact',
        matchedTags,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Pass 2: Semantic Similarity (TF-IDF Cosine)
// ---------------------------------------------------------------------------

/**
 * Compute TF-IDF cosine similarity between the query and each agent's
 * description + expertise text.
 *
 * Returns agents sorted by similarity score descending.
 */
function semanticMatch(query: string, agents: AgentRecord[]): RankedAgent[] {
  // Build a corpus: query + each agent text
  const queryTokens = tokenize(query);
  const agentTexts = agents.map((record) => {
    return [record.agent.description, ...record.agent.expertise].join(' ');
  });
  const agentTokenArrays = agentTexts.map((text) => tokenize(text));

  // Build vocabulary from all documents
  const allDocuments = [queryTokens, ...agentTokenArrays];
  const vocabulary = buildVocabulary(allDocuments);
  const docCount = allDocuments.length;

  // Compute IDF for each term
  const idf = computeIDF(vocabulary, allDocuments, docCount);

  // Compute TF-IDF vector for query
  const queryVector = computeTfIdfVector(queryTokens, vocabulary, idf);

  // Compute TF-IDF vectors for each agent and cosine similarity
  const results: RankedAgent[] = [];

  for (let i = 0; i < agents.length; i++) {
    const agentVector = computeTfIdfVector(agentTokenArrays[i], vocabulary, idf);
    const similarity = cosineSimilarity(queryVector, agentVector);

    if (similarity > 0) {
      results.push({
        agent: agents[i],
        score: similarity,
        matchType: 'semantic',
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Exported similarity function
// ---------------------------------------------------------------------------

/**
 * Compute the TF-IDF cosine similarity between two texts.
 *
 * Exposed for testing and external use.
 *
 * @param textA  First text.
 * @param textB  Second text.
 * @returns      Cosine similarity score in [0, 1].
 */
export function computeSimilarity(textA: string, textB: string): number {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  const allDocuments = [tokensA, tokensB];
  const vocabulary = buildVocabulary(allDocuments);
  const docCount = allDocuments.length;
  const idf = computeIDF(vocabulary, allDocuments, docCount);

  const vectorA = computeTfIdfVector(tokensA, vocabulary, idf);
  const vectorB = computeTfIdfVector(tokensB, vocabulary, idf);

  return cosineSimilarity(vectorA, vectorB);
}

// ---------------------------------------------------------------------------
// Text Processing Utilities
// ---------------------------------------------------------------------------

/**
 * Extract domain keywords from a query string.
 * Splits on whitespace, lowercases, removes stop words and single-char tokens.
 */
function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Tokenize text into an array of lowercase word tokens.
 * Removes punctuation, stop words, and single-char tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Build a vocabulary (set of unique terms) from all documents.
 */
function buildVocabulary(documents: string[][]): string[] {
  const vocab = new Set<string>();
  for (const doc of documents) {
    for (const token of doc) {
      vocab.add(token);
    }
  }
  return Array.from(vocab);
}

/**
 * Compute Inverse Document Frequency for each term in the vocabulary.
 *
 * IDF(t) = log(N / (1 + df(t)))  where df(t) = number of documents containing t.
 */
function computeIDF(
  vocabulary: string[],
  documents: string[][],
  docCount: number,
): Map<string, number> {
  const idf = new Map<string, number>();

  for (const term of vocabulary) {
    let df = 0;
    for (const doc of documents) {
      if (doc.includes(term)) {
        df++;
      }
    }
    idf.set(term, Math.log(docCount / (1 + df)));
  }

  return idf;
}

/**
 * Compute TF-IDF vector for a document given the vocabulary and IDF values.
 *
 * TF(t, d) = count(t in d) / |d|
 * TF-IDF(t, d) = TF(t, d) * IDF(t)
 */
function computeTfIdfVector(
  document: string[],
  vocabulary: string[],
  idf: Map<string, number>,
): number[] {
  const termCounts = new Map<string, number>();
  for (const token of document) {
    termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
  }

  const docLength = document.length || 1; // avoid division by zero

  return vocabulary.map((term) => {
    const tf = (termCounts.get(term) ?? 0) / docLength;
    const idfVal = idf.get(term) ?? 0;
    return tf * idfVal;
  });
}

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns a value in [0, 1]. Returns 0 if either vector has zero magnitude.
 */
function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < vectorA.length; i++) {
    dotProduct += vectorA[i] * vectorB[i];
    magA += vectorA[i] * vectorA[i];
    magB += vectorB[i] * vectorB[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}
