/**
 * Semantic duplicate detector for the Intake Layer.
 *
 * Uses a local `all-MiniLM-L6-v2` model via `@xenova/transformers` to produce
 * 384-dimensional embeddings and compares incoming requests against existing
 * ones using cosine similarity.  Duplicates are flagged when similarity meets
 * or exceeds a configurable threshold (default 0.85).
 *
 * @module duplicate_detector
 */

import type { ParsedRequest, RequestStatus } from '../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// @xenova/transformers pipeline type
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for duplicate detection behavior. */
export interface DuplicateDetectionConfig {
  /** Whether duplicate detection is enabled. Default: `true`. */
  enabled: boolean;
  /** Cosine similarity threshold above which two requests are duplicates. Default: `0.85`. */
  similarity_threshold: number;
  /** Number of days to look back for candidate duplicates. Default: `30`. */
  lookback_days: number;
}

/** Sensible defaults for duplicate detection. */
export const DEFAULT_DUPLICATE_CONFIG: DuplicateDetectionConfig = {
  enabled: true,
  similarity_threshold: 0.85,
  lookback_days: 30,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** The outcome of a duplicate detection check. */
export interface DuplicateResult {
  /** Whether at least one candidate exceeded the similarity threshold. */
  isDuplicate: boolean;
  /** Up to 5 closest candidates, sorted by similarity descending. */
  candidates: DuplicateCandidate[];
}

/** A single candidate that matched above the similarity threshold. */
export interface DuplicateCandidate {
  /** The `request_id` of the matching request. */
  requestId: string;
  /** Title of the matching request. */
  title: string;
  /** Cosine similarity score (0.0 - 1.0). */
  similarity: number;
  /** Current status of the matching request. */
  status: RequestStatus;
}

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

/** Row returned by the repository when fetching stored embeddings. */
export interface EmbeddingRow {
  request_id: string;
  title: string;
  embedding: Buffer;
  status: RequestStatus;
}

/**
 * Minimal repository interface consumed by the detector.
 * The concrete implementation lives in the DB layer.
 */
export interface EmbeddingRepository {
  /** Retrieve all request embeddings created on or after `cutoff`. */
  getRequestEmbeddings(cutoff: Date): Promise<EmbeddingRow[]> | EmbeddingRow[];
  /** Persist an embedding for a given request. */
  storeRequestEmbedding(requestId: string, embedding: Buffer): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Compute the cosine similarity between two equal-length vectors.
 *
 * Returns 0 when either vector has zero magnitude (avoids division by zero).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// DuplicateDetector
// ---------------------------------------------------------------------------

/**
 * Semantic duplicate detector backed by local MiniLM embeddings.
 *
 * Lifecycle:
 * 1. Construct with `new DuplicateDetector()`.
 * 2. Call `initialize()` once to download / load the model.
 * 3. Call `detectDuplicate()` for each incoming request.
 * 4. Call `encode()` + repository `storeRequestEmbedding()` to persist the
 *    embedding after the request is accepted.
 */
export class DuplicateDetector {
  private embedder: FeatureExtractionPipeline | null = null;

  /**
   * Load the `all-MiniLM-L6-v2` feature-extraction pipeline.
   * The model (~50 MB) is downloaded on first call and cached locally
   * by `@xenova/transformers`.
   */
  async initialize(): Promise<void> {
    // Dynamic import so the module is optional at compile time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { pipeline } = await import('@xenova/transformers');
    this.embedder = (await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
    )) as unknown as FeatureExtractionPipeline;
  }

  /**
   * Encode a text string into a 384-dimensional Float32Array embedding.
   *
   * @throws If `initialize()` has not been called.
   */
  async encode(text: string): Promise<Float32Array> {
    if (!this.embedder) {
      throw new Error(
        'DuplicateDetector has not been initialized. Call initialize() first.',
      );
    }
    const output = await this.embedder(text, {
      pooling: 'mean',
      normalize: true,
    });
    return output.data;
  }

  /**
   * Check whether `newRequest` is semantically similar to any existing
   * request in the database.
   *
   * When `config.enabled` is `false` the method returns immediately
   * without touching the embedder or the database.
   *
   * @returns A {@link DuplicateResult} with up to 5 candidates above
   *          the similarity threshold, sorted by similarity descending.
   */
  async detectDuplicate(
    newRequest: ParsedRequest,
    db: EmbeddingRepository,
    config: DuplicateDetectionConfig,
  ): Promise<DuplicateResult> {
    if (!config.enabled) {
      return { isDuplicate: false, candidates: [] };
    }

    const queryText = `${newRequest.title} ${newRequest.description}`;
    const queryEmbedding = await this.encode(queryText);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.lookback_days);
    const candidates = await db.getRequestEmbeddings(cutoff);

    const scored = candidates.map((c) => ({
      requestId: c.request_id,
      title: c.title,
      similarity: cosineSimilarity(
        queryEmbedding,
        new Float32Array(
          c.embedding.buffer,
          c.embedding.byteOffset,
          c.embedding.byteLength / 4,
        ),
      ),
      status: c.status,
    }));

    const matches = scored
      .filter((s) => s.similarity >= config.similarity_threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    return { isDuplicate: matches.length > 0, candidates: matches };
  }

  /**
   * Convenience: encode text and return a `Buffer` ready for BLOB storage.
   */
  async encodeToBuffer(text: string): Promise<Buffer> {
    const embedding = await this.encode(text);
    return Buffer.from(embedding.buffer);
  }
}
