/**
 * Unit tests for the semantic duplicate detector (SPEC-008-1-08).
 *
 * Covers:
 *  - `cosineSimilarity` with known vector pairs: identical (1.0), orthogonal (0.0), zero vector (0.0), computed pair
 *  - Disabled config skips detection
 *  - Mocked embedder and database to verify the detection flow
 *  - 100% of `cosineSimilarity` and `detectDuplicate` branches
 *
 * @module duplicate_detector.test
 */

import {
  cosineSimilarity,
  DuplicateDetector,
  DEFAULT_DUPLICATE_CONFIG,
  type DuplicateDetectionConfig,
  type DuplicateResult,
  type EmbeddingRepository,
  type EmbeddingRow,
} from '../../core/duplicate_detector';
import type { ParsedRequest, RequestStatus } from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ParsedRequest for testing. */
function makeParsedRequest(overrides: Partial<ParsedRequest> = {}): ParsedRequest {
  return {
    title: 'Add user API endpoint',
    description: 'Create a REST endpoint to get user profiles.',
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

/** Create a Float32Array embedding from number array. */
function f32(values: number[]): Float32Array {
  return new Float32Array(values);
}

/** Convert a Float32Array to a Buffer (simulates DB storage). */
function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/** Create a mock EmbeddingRepository. */
function createMockRepo(
  rows: EmbeddingRow[] = [],
): EmbeddingRepository & { storedEmbeddings: Array<{ requestId: string; embedding: Buffer }> } {
  const storedEmbeddings: Array<{ requestId: string; embedding: Buffer }> = [];
  return {
    getRequestEmbeddings: jest.fn().mockResolvedValue(rows),
    storeRequestEmbedding: jest.fn().mockImplementation((requestId, embedding) => {
      storedEmbeddings.push({ requestId, embedding });
    }),
    storedEmbeddings,
  };
}

// ---------------------------------------------------------------------------
// Tests: cosineSimilarity()
// ---------------------------------------------------------------------------

describe('cosineSimilarity()', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = f32([1, 2, 3, 4, 5]);
    const b = f32([1, 2, 3, 4, 5]);
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = f32([1, 0, 0]);
    const b = f32([0, 1, 0]);
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(0.0, 5);
  });

  it('returns 0.0 when first vector is zero', () => {
    const a = f32([0, 0, 0]);
    const b = f32([1, 2, 3]);
    const result = cosineSimilarity(a, b);
    expect(result).toBe(0);
  });

  it('returns 0.0 when second vector is zero', () => {
    const a = f32([1, 2, 3]);
    const b = f32([0, 0, 0]);
    const result = cosineSimilarity(a, b);
    expect(result).toBe(0);
  });

  it('returns 0.0 when both vectors are zero', () => {
    const a = f32([0, 0, 0]);
    const b = f32([0, 0, 0]);
    const result = cosineSimilarity(a, b);
    expect(result).toBe(0);
  });

  it('computes correct similarity for a known pair', () => {
    // a = [1, 2, 3], b = [4, 5, 6]
    // dot = 4+10+18 = 32
    // normA = 1+4+9 = 14 -> sqrt(14)
    // normB = 16+25+36 = 77 -> sqrt(77)
    // cosine = 32 / (sqrt(14)*sqrt(77)) = 32 / sqrt(1078)
    const a = f32([1, 2, 3]);
    const b = f32([4, 5, 6]);
    const expected = 32 / Math.sqrt(14 * 77);
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(expected, 5);
  });

  it('returns -1.0 for opposite-direction vectors', () => {
    const a = f32([1, 2, 3]);
    const b = f32([-1, -2, -3]);
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(-1.0, 5);
  });

  it('handles single-element vectors', () => {
    const a = f32([5]);
    const b = f32([3]);
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: DuplicateDetector.detectDuplicate() - disabled config
// ---------------------------------------------------------------------------

describe('DuplicateDetector - disabled config', () => {
  it('skips detection when config.enabled is false', async () => {
    const detector = new DuplicateDetector();
    const repo = createMockRepo();
    const disabledConfig: DuplicateDetectionConfig = {
      enabled: false,
      similarity_threshold: 0.85,
      lookback_days: 30,
    };

    const result = await detector.detectDuplicate(makeParsedRequest(), repo, disabledConfig);

    expect(result.isDuplicate).toBe(false);
    expect(result.candidates).toHaveLength(0);
    // Should not call the repository at all
    expect(repo.getRequestEmbeddings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: DuplicateDetector.detectDuplicate() - with mocked embedder
// ---------------------------------------------------------------------------

describe('DuplicateDetector - detection flow', () => {
  let detector: DuplicateDetector;

  beforeEach(() => {
    detector = new DuplicateDetector();
    // Replace the embedder with a mock that returns a known embedding
    (detector as any).embedder = jest.fn().mockResolvedValue({
      data: f32([1, 0, 0, 0]),
    });
  });

  it('detects duplicate when similarity exceeds threshold', async () => {
    // Existing embedding is identical to the query embedding
    const existingEmbedding = f32([1, 0, 0, 0]);
    const repo = createMockRepo([
      {
        request_id: 'REQ-000001',
        title: 'Existing request',
        embedding: embeddingToBuffer(existingEmbedding),
        status: 'queued' as RequestStatus,
      },
    ]);

    const result = await detector.detectDuplicate(
      makeParsedRequest(),
      repo,
      DEFAULT_DUPLICATE_CONFIG,
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].requestId).toBe('REQ-000001');
    expect(result.candidates[0].similarity).toBeCloseTo(1.0);
  });

  it('does not detect duplicate when similarity is below threshold', async () => {
    // Existing embedding is orthogonal to the query embedding
    const existingEmbedding = f32([0, 1, 0, 0]);
    const repo = createMockRepo([
      {
        request_id: 'REQ-000002',
        title: 'Different request',
        embedding: embeddingToBuffer(existingEmbedding),
        status: 'active' as RequestStatus,
      },
    ]);

    const result = await detector.detectDuplicate(
      makeParsedRequest(),
      repo,
      DEFAULT_DUPLICATE_CONFIG,
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it('returns up to 5 candidates sorted by similarity descending', async () => {
    const candidates: EmbeddingRow[] = [];
    // Create 7 candidates with varying similarity
    const embeddings = [
      f32([1, 0, 0, 0]),     // similarity ~ 1.0
      f32([0.9, 0.1, 0, 0]), // high similarity
      f32([0.95, 0.05, 0, 0]),
      f32([0.92, 0.08, 0, 0]),
      f32([0.88, 0.12, 0, 0]),
      f32([0.86, 0.14, 0, 0]),
      f32([0.5, 0.5, 0, 0]),  // lower similarity (may be below threshold)
    ];
    for (let i = 0; i < embeddings.length; i++) {
      candidates.push({
        request_id: `REQ-${String(i).padStart(6, '0')}`,
        title: `Request ${i}`,
        embedding: embeddingToBuffer(embeddings[i]),
        status: 'queued' as RequestStatus,
      });
    }

    const repo = createMockRepo(candidates);
    const result = await detector.detectDuplicate(
      makeParsedRequest(),
      repo,
      { ...DEFAULT_DUPLICATE_CONFIG, similarity_threshold: 0.80 },
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    // Sorted descending by similarity
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].similarity).toBeGreaterThanOrEqual(
        result.candidates[i].similarity,
      );
    }
  });

  it('returns empty candidates when no embeddings exist in the database', async () => {
    const repo = createMockRepo([]);

    const result = await detector.detectDuplicate(
      makeParsedRequest(),
      repo,
      DEFAULT_DUPLICATE_CONFIG,
    );

    expect(result.isDuplicate).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it('encode() throws when embedder is not initialized', async () => {
    const rawDetector = new DuplicateDetector();
    // Do NOT set the embedder
    await expect(rawDetector.encode('test text')).rejects.toThrow(
      'DuplicateDetector has not been initialized',
    );
  });

  it('encodes query text as title + description', async () => {
    const req = makeParsedRequest({
      title: 'My Title',
      description: 'My Description',
    });
    const repo = createMockRepo([]);

    await detector.detectDuplicate(req, repo, DEFAULT_DUPLICATE_CONFIG);

    // The embedder should have been called with "My Title My Description"
    expect((detector as any).embedder).toHaveBeenCalledWith(
      'My Title My Description',
      { pooling: 'mean', normalize: true },
    );
  });

  it('passes correct cutoff date based on lookback_days', async () => {
    const repo = createMockRepo([]);
    const config: DuplicateDetectionConfig = {
      enabled: true,
      similarity_threshold: 0.85,
      lookback_days: 7,
    };

    const before = new Date();
    await detector.detectDuplicate(makeParsedRequest(), repo, config);
    const after = new Date();

    const callArg = (repo.getRequestEmbeddings as jest.Mock).mock.calls[0][0] as Date;
    // Cutoff should be approximately 7 days before now
    const expectedCutoff = new Date();
    expectedCutoff.setDate(expectedCutoff.getDate() - 7);
    expect(Math.abs(callArg.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
  });
});
