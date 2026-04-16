import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';

/**
 * Review feedback schema per TDD Section 4.2.
 */
export interface ReviewFinding {
  /** Finding severity: critical, major, minor, suggestion */
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  /** Section ID in the document this finding relates to */
  section: string;
  /** Description of the issue */
  description: string;
  /** Suggested resolution */
  suggestedResolution: string;
}

export interface ReviewFeedback {
  /** Unique review ID */
  reviewId: string;
  /** Document being reviewed */
  documentId: string;
  /** Version of the document being reviewed */
  documentVersion: string;
  /** Agent that performed the review */
  reviewerAgent: string;
  /** Which iteration of review (1-based) */
  reviewIteration: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Review outcome: approved, changes_requested, rejected */
  outcome: 'approved' | 'changes_requested' | 'rejected';
  /** Per-category scores (categoryId -> score 0-100) */
  scores: Record<string, number>;
  /** Weighted aggregate score */
  aggregateScore: number;
  /** Threshold that was used for this review */
  approvalThreshold: number;
  /** List of findings */
  findings: ReviewFinding[];
  /** Optional: if this review found an upstream defect */
  upstreamDefect?: {
    /** Target document that has the defect */
    targetDocumentId: string;
    /** Affected sections in the target document */
    affectedSections: string[];
    /** Description of the defect */
    description: string;
  };
}

/**
 * Writes a review feedback file to the document's reviews/ directory.
 *
 * File naming: v{VERSION}-review-{SEQ}.yaml
 * SEQ is 3-digit zero-padded, incrementing for each review of the same version.
 *
 * @returns Absolute path to the written review file
 */
export async function writeReviewFeedback(
  feedback: ReviewFeedback,
  pipelineId: string,
  type: DocumentType,
  directoryManager: DirectoryManager,
): Promise<string> {
  const reviewsDir = directoryManager.getReviewsDir(
    pipelineId, type, feedback.documentId,
  );

  // Determine sequence number by counting existing reviews for this version
  const existingFiles = await fs.readdir(reviewsDir).catch(() => []);
  const prefix = `v${feedback.documentVersion}-review-`;
  const existingForVersion = existingFiles.filter(f => f.startsWith(prefix));
  const seq = existingForVersion.length + 1;
  const seqStr = String(seq).padStart(3, '0');

  const filename = `v${feedback.documentVersion}-review-${seqStr}.yaml`;
  const filePath = path.join(reviewsDir, filename);

  const yamlContent = yaml.dump(feedback, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(filePath, yamlContent);
  return filePath;
}

/**
 * Reads all review feedback files for a document, optionally filtered by version.
 *
 * @returns Array of ReviewFeedback sorted by timestamp
 */
export async function readReviewFeedback(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
  version?: string,
): Promise<ReviewFeedback[]> {
  const reviewsDir = directoryManager.getReviewsDir(pipelineId, type, documentId);

  let files: string[];
  try {
    files = await fs.readdir(reviewsDir);
  } catch {
    return [];
  }

  // Filter by version if specified
  const pattern = version
    ? new RegExp(`^v${version.replace('.', '\\.')}-review-\\d{3}\\.yaml$`)
    : /^v[\d.]+-review-\d{3}\.yaml$/;

  const reviewFiles = files.filter(f => pattern.test(f)).sort();
  const reviews: ReviewFeedback[] = [];

  for (const file of reviewFiles) {
    const content = await fs.readFile(path.join(reviewsDir, file), 'utf-8');
    reviews.push(yaml.load(content) as ReviewFeedback);
  }

  return reviews.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Returns the latest aggregate score for a document (from the most recent review).
 * Returns null if no reviews exist.
 */
export async function getLatestScore(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
): Promise<number | null> {
  const reviews = await readReviewFeedback(pipelineId, type, documentId, directoryManager);
  if (reviews.length === 0) return null;
  return reviews[reviews.length - 1].aggregateScore;
}
