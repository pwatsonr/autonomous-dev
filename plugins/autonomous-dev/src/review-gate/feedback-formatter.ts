/**
 * FeedbackFormatter: merges, deduplicates, and structures findings from
 * multiple reviewers into a unified review result.
 *
 * Based on SPEC-004-3-2, Task 4.
 *
 * Phase 1: keyword-based Jaccard similarity heuristic.
 * Phase 2: pluggable similarity function (e.g. embedding-based).
 */

import type { ReviewOutput, MergedFinding, FindingSeverity } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pluggable similarity function signature.
 * Returns a value in [0, 1] representing how similar two descriptions are.
 */
export interface SimilarityFunction {
  (descriptionA: string, descriptionB: string): number;
}

/** Configuration for the FeedbackFormatter. */
export interface FeedbackFormatterConfig {
  /** Similarity threshold for duplicate detection. Default 0.85 for Phase 2. */
  similarity_threshold: number;
  /**
   * Custom similarity function. When null, uses Phase 1 keyword heuristic
   * with the Jaccard coefficient and a fixed threshold of 0.5.
   */
  similarity_function: SimilarityFunction | null;
}

/** Structured output from FeedbackFormatter.formatFindings(). */
export interface FormattedFeedback {
  merged_findings: MergedFinding[];
  findings_by_section: Map<string, MergedFinding[]>;
  total_findings: number;
  severity_counts: { critical: number; major: number; minor: number; suggestion: number };
  deduplication_stats: { total_raw: number; after_dedup: number; duplicates_merged: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Severity ordering: higher number = higher severity. */
export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  suggestion: 1,
};

/** Stop words removed during tokenization. */
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
  'can', 'has', 'her', 'was', 'one', 'our', 'out', 'his',
  'how', 'its', 'may', 'who', 'did', 'get', 'let', 'say',
  'she', 'too', 'use', 'this', 'that', 'with', 'have', 'from',
  'they', 'been', 'said', 'each', 'which', 'their', 'will',
  'other', 'about', 'many', 'then', 'them', 'these', 'some',
  'would', 'make', 'like', 'into', 'could', 'than', 'been',
  'what', 'when', 'where', 'should', 'does', 'also',
]);

// ---------------------------------------------------------------------------
// Tokenization & similarity
// ---------------------------------------------------------------------------

/**
 * Tokenizes a description string into lowercase keywords, stripping
 * punctuation, short words (<= 2 chars), and stop words.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP_WORDS.has(w));
}

/**
 * Computes Jaccard similarity between two descriptions using keyword sets.
 * Returns a value in [0, 1]. Returns 0 if both descriptions tokenize to
 * empty sets.
 */
export function keywordOverlap(descA: string, descB: string): number {
  const wordsA = new Set(tokenize(descA));
  const wordsB = new Set(tokenize(descB));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

// ---------------------------------------------------------------------------
// Union-Find (Disjoint Set Union)
// ---------------------------------------------------------------------------

/** Simple union-find for clustering duplicate findings. */
class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array(size).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // path compression
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return;
    // union by rank
    if (this.rank[rootX] < this.rank[rootY]) {
      this.parent[rootX] = rootY;
    } else if (this.rank[rootX] > this.rank[rootY]) {
      this.parent[rootY] = rootX;
    } else {
      this.parent[rootY] = rootX;
      this.rank[rootX]++;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal finding with reviewer attribution
// ---------------------------------------------------------------------------

interface AttributedFinding {
  reviewer_id: string;
  section_id: string;
  category_id: string;
  severity: FindingSeverity;
  critical_sub: 'blocking' | 'reject' | null;
  upstream_defect: boolean;
  description: string;
  evidence: string;
  suggested_resolution: string;
  id: string;
}

// ---------------------------------------------------------------------------
// FeedbackFormatter
// ---------------------------------------------------------------------------

export class FeedbackFormatter {
  private config: FeedbackFormatterConfig;

  constructor(
    config: Partial<FeedbackFormatterConfig> = {},
  ) {
    this.config = {
      similarity_threshold: config.similarity_threshold ?? 0.85,
      similarity_function: config.similarity_function ?? null,
    };
  }

  /**
   * Merges findings from multiple reviewer outputs into a deduplicated,
   * severity-sorted list of MergedFindings.
   */
  formatFindings(
    reviewerOutputs: ReviewOutput[],
    _previousIterationFindings?: MergedFinding[],
  ): FormattedFeedback {
    // Step 1: Collect all findings into a flat attributed list
    const allFindings: AttributedFinding[] = [];
    for (const output of reviewerOutputs) {
      for (const finding of output.findings) {
        allFindings.push({
          reviewer_id: output.reviewer_id,
          section_id: finding.section_id,
          category_id: finding.category_id,
          severity: finding.severity,
          critical_sub: finding.critical_sub,
          upstream_defect: finding.upstream_defect,
          description: finding.description,
          evidence: finding.evidence,
          suggested_resolution: finding.suggested_resolution,
          id: finding.id,
        });
      }
    }

    const totalRaw = allFindings.length;

    if (totalRaw === 0) {
      return {
        merged_findings: [],
        findings_by_section: new Map(),
        total_findings: 0,
        severity_counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        deduplication_stats: { total_raw: 0, after_dedup: 0, duplicates_merged: 0 },
      };
    }

    // Step 2: Pairwise duplicate detection
    const uf = new UnionFind(allFindings.length);
    for (let i = 0; i < allFindings.length; i++) {
      for (let j = i + 1; j < allFindings.length; j++) {
        if (this.isDuplicate(allFindings[i], allFindings[j])) {
          uf.union(i, j);
        }
      }
    }

    // Step 3: Group into clusters
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < allFindings.length; i++) {
      const root = uf.find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(i);
    }

    // Step 4: Merge each cluster into a single MergedFinding
    const mergedFindings: MergedFinding[] = [];
    for (const indices of clusters.values()) {
      mergedFindings.push(this.mergeCluster(indices.map((i) => allFindings[i])));
    }

    // Step 5: Sort by severity desc, then section_id alphabetically
    mergedFindings.sort((a, b) => {
      const severityDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
      if (severityDiff !== 0) return severityDiff;
      return a.section_id.localeCompare(b.section_id);
    });

    // Build output
    const afterDedup = mergedFindings.length;
    const duplicatesMerged = totalRaw - afterDedup;

    return {
      merged_findings: mergedFindings,
      findings_by_section: groupBySection(mergedFindings),
      total_findings: afterDedup,
      severity_counts: this.countSeverities(mergedFindings),
      deduplication_stats: {
        total_raw: totalRaw,
        after_dedup: afterDedup,
        duplicates_merged: duplicatesMerged,
      },
    };
  }

  /**
   * Tests whether two findings are duplicates.
   *
   * Phase 1 (keyword heuristic): same section_id, same category_id, and
   * Jaccard keyword overlap >= 0.5.
   *
   * Phase 2 (pluggable): same section_id, same category_id, and
   * similarity_function(descA, descB) >= similarity_threshold.
   */
  private isDuplicate(a: AttributedFinding, b: AttributedFinding): boolean {
    if (a.section_id !== b.section_id) return false;
    if (a.category_id !== b.category_id) return false;

    if (this.config.similarity_function) {
      const similarity = this.config.similarity_function(a.description, b.description);
      return similarity >= this.config.similarity_threshold;
    }

    // Phase 1: keyword heuristic with fixed threshold 0.5
    return keywordOverlap(a.description, b.description) >= 0.5;
  }

  /**
   * Merges a cluster of duplicate findings into a single MergedFinding.
   */
  private mergeCluster(cluster: AttributedFinding[]): MergedFinding {
    // Sort cluster by severity descending to find highest-severity finding(s)
    const sorted = [...cluster].sort(
      (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity],
    );

    const maxSeverity = sorted[0].severity;
    const maxSeverityFindings = sorted.filter((f) => f.severity === maxSeverity);

    // critical_sub: if severity is critical, prefer "reject" over "blocking"
    let criticalSub: 'blocking' | 'reject' | null = null;
    if (maxSeverity === 'critical') {
      const hasCriticalFindings = sorted.filter((f) => f.severity === 'critical');
      criticalSub = hasCriticalFindings.some((f) => f.critical_sub === 'reject')
        ? 'reject'
        : hasCriticalFindings[0].critical_sub;
    }

    // upstream_defect: true if ANY in the cluster has it
    const upstreamDefect = cluster.some((f) => f.upstream_defect);

    // Pick representative for description/evidence/suggested_resolution:
    // highest severity; if tied, longest suggested_resolution
    const representative = maxSeverityFindings.length === 1
      ? maxSeverityFindings[0]
      : maxSeverityFindings.reduce((best, f) =>
          f.suggested_resolution.length > best.suggested_resolution.length ? f : best,
        );

    // reported_by: all reviewer IDs (deduplicated, preserving order)
    const reportedBy: string[] = [];
    const seen = new Set<string>();
    for (const f of cluster) {
      if (!seen.has(f.reviewer_id)) {
        seen.add(f.reviewer_id);
        reportedBy.push(f.reviewer_id);
      }
    }

    return {
      id: cluster[0].id,
      section_id: cluster[0].section_id,
      category_id: cluster[0].category_id,
      severity: maxSeverity,
      critical_sub: criticalSub,
      upstream_defect: upstreamDefect,
      description: representative.description,
      evidence: representative.evidence,
      suggested_resolution: representative.suggested_resolution,
      reported_by: reportedBy,
      resolution_status: 'open',
      prior_finding_id: null,
    };
  }

  /** Counts findings by severity. */
  private countSeverities(
    findings: MergedFinding[],
  ): { critical: number; major: number; minor: number; suggestion: number } {
    const counts = { critical: 0, major: 0, minor: 0, suggestion: 0 };
    for (const f of findings) {
      counts[f.severity]++;
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Groups findings by section_id into a Map.
 */
export function groupBySection(findings: MergedFinding[]): Map<string, MergedFinding[]> {
  const map = new Map<string, MergedFinding[]>();
  for (const f of findings) {
    if (!map.has(f.section_id)) map.set(f.section_id, []);
    map.get(f.section_id)!.push(f);
  }
  return map;
}
