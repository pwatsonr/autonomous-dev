/**
 * Contradiction detector for smoke tests.
 *
 * Heuristic-based contradiction detection across sibling child documents.
 * Extracts technology/entity names and compares every pair of siblings for
 * conflicting technology choices, numeric value conflicts, and keyword-based
 * potential conflicts.
 *
 * Provides a pluggable interface (ContradictionDetectionStrategy) for future
 * AI-agent-based detection in Phase 3.
 *
 * Based on SPEC-004-4-1 section 4.
 */

import {
  ChildDocument,
  Contradiction,
  ContradictionResult,
  ContradictionDetectionStrategy,
} from './types';

// ---------------------------------------------------------------------------
// Confidence constants
// ---------------------------------------------------------------------------

const CONFIDENCE_DIRECT_TECH_CONFLICT = 0.9;
const CONFIDENCE_NUMERIC_CONFLICT = 0.7;
const CONFIDENCE_KEYWORD_CONFLICT = 0.4;
const CONFIDENCE_REPORT_THRESHOLD = 0.4;
const CONFIDENCE_BLOCK_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extracts technology/entity names from content.
 * Returns a Map of entity names to the sentences mentioning them.
 */
export function extractEntities(content: string): Map<string, string[]> {
  const entities = new Map<string, string[]>();

  // Split content into sentences for statement association
  const sentences = content.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);

  // Pattern 1: Known technology names (capitalized words that look like tech)
  const techPattern = /\b((?:[A-Z][a-zA-Z]*(?:SQL|DB|MQ|API))|(?:PostgreSQL|MongoDB|MySQL|Redis|Kafka|RabbitMQ|GraphQL|REST|gRPC|Docker|Kubernetes|Terraform|AWS|GCP|Azure))\b/g;

  // Pattern 2: "use X" / "uses X" / "using X" patterns
  const usePattern = /\b(?:use|uses|using|adopt|adopts|adopting|implement|implements|implementing)\s+([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\b/g;

  // Pattern 3: "X for Y" patterns (technology for purpose)
  const forPattern = /\b([A-Z][a-zA-Z0-9]+)\s+(?:for|as)\s+(?:the\s+)?(\w+(?:\s+\w+){0,3})\b/g;

  for (const sentence of sentences) {
    // Pattern 1: Technology names
    let match: RegExpExecArray | null;
    const techRegex = new RegExp(techPattern.source, techPattern.flags);
    while ((match = techRegex.exec(sentence)) !== null) {
      const entity = match[1];
      if (!entities.has(entity)) {
        entities.set(entity, []);
      }
      entities.get(entity)!.push(sentence);
    }

    // Pattern 2: "use X" patterns
    const useRegex = new RegExp(usePattern.source, usePattern.flags);
    while ((match = useRegex.exec(sentence)) !== null) {
      const entity = match[1];
      if (!entities.has(entity)) {
        entities.set(entity, []);
      }
      entities.get(entity)!.push(sentence);
    }

    // Pattern 3: "X for Y" patterns
    const forRegex = new RegExp(forPattern.source, forPattern.flags);
    while ((match = forRegex.exec(sentence)) !== null) {
      const entity = match[1];
      if (!entities.has(entity)) {
        entities.set(entity, []);
      }
      entities.get(entity)!.push(sentence);
    }
  }

  return entities;
}

// ---------------------------------------------------------------------------
// Category mapping for technology conflicts
// ---------------------------------------------------------------------------

/** Known technology categories for detecting conflicts. */
const TECH_CATEGORIES: Record<string, string> = {
  PostgreSQL: 'database',
  MongoDB: 'database',
  MySQL: 'database',
  Redis: 'cache',
  Kafka: 'message_queue',
  RabbitMQ: 'message_queue',
  GraphQL: 'api_protocol',
  REST: 'api_protocol',
  gRPC: 'api_protocol',
  Docker: 'containerization',
  Kubernetes: 'orchestration',
  Terraform: 'iac',
  AWS: 'cloud_provider',
  GCP: 'cloud_provider',
  Azure: 'cloud_provider',
};

/**
 * Finds the category of a technology name, if known.
 */
function getTechCategory(entity: string): string | undefined {
  return TECH_CATEGORIES[entity];
}

// ---------------------------------------------------------------------------
// Numeric value extraction
// ---------------------------------------------------------------------------

/**
 * Extracts numeric property patterns from a sentence.
 * Looks for patterns like "timeout: 30s", "max_retries: 3", "limit 100".
 */
function extractNumericProperties(
  sentence: string
): { property: string; value: number; unit: string; raw: string }[] {
  const results: { property: string; value: number; unit: string; raw: string }[] = [];

  // Pattern: "property: NUMBERunit" or "property NUMBERunit"
  const numericPattern = /\b(\w+)[\s:=]+(\d+(?:\.\d+)?)\s*(s|ms|seconds?|minutes?|hours?|%|mb|gb|kb)?\b/gi;
  let match: RegExpExecArray | null;

  while ((match = numericPattern.exec(sentence)) !== null) {
    results.push({
      property: match[1].toLowerCase(),
      value: parseFloat(match[2]),
      unit: (match[3] || '').toLowerCase(),
      raw: match[0],
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// HeuristicContradictionStrategy
// ---------------------------------------------------------------------------

/**
 * Default heuristic-based contradiction detection strategy.
 * Extracts entities and compares technology choices and numeric values.
 */
export class HeuristicContradictionStrategy implements ContradictionDetectionStrategy {
  async detect(childA: ChildDocument, childB: ChildDocument): Promise<Contradiction[]> {
    const contradictions: Contradiction[] = [];

    const contentA = childA.sections.map((s) => s.content).join('\n');
    const contentB = childB.sections.map((s) => s.content).join('\n');

    const entitiesA = extractEntities(contentA);
    const entitiesB = extractEntities(contentB);

    // Find shared entities
    const sharedEntities = new Set<string>();
    for (const entity of entitiesA.keys()) {
      if (entitiesB.has(entity)) {
        sharedEntities.add(entity);
      }
    }

    // Check for technology category conflicts
    // Build category -> tech mappings per child
    const categoriesA = new Map<string, Set<string>>();
    const categoriesB = new Map<string, Set<string>>();

    for (const entity of entitiesA.keys()) {
      const category = getTechCategory(entity);
      if (category) {
        if (!categoriesA.has(category)) {
          categoriesA.set(category, new Set());
        }
        categoriesA.get(category)!.add(entity);
      }
    }

    for (const entity of entitiesB.keys()) {
      const category = getTechCategory(entity);
      if (category) {
        if (!categoriesB.has(category)) {
          categoriesB.set(category, new Set());
        }
        categoriesB.get(category)!.add(entity);
      }
    }

    // Check each shared category for different technologies
    for (const [category, techsA] of categoriesA) {
      const techsB = categoriesB.get(category);
      if (!techsB) {
        continue;
      }

      // Find technologies in A but not in B, and vice versa
      for (const techA of techsA) {
        for (const techB of techsB) {
          if (techA !== techB) {
            const statementsA = entitiesA.get(techA) ?? [];
            const statementsB = entitiesB.get(techB) ?? [];

            contradictions.push({
              child_a_id: childA.id,
              child_b_id: childB.id,
              entity: category,
              statement_a: statementsA[0] ?? `Uses ${techA}`,
              statement_b: statementsB[0] ?? `Uses ${techB}`,
              confidence: CONFIDENCE_DIRECT_TECH_CONFLICT,
            });
          }
        }
      }
    }

    // Check for numeric value conflicts on shared entities
    for (const entity of sharedEntities) {
      const statementsA = entitiesA.get(entity)!;
      const statementsB = entitiesB.get(entity)!;

      for (const stmtA of statementsA) {
        const propsA = extractNumericProperties(stmtA);
        for (const stmtB of statementsB) {
          const propsB = extractNumericProperties(stmtB);

          for (const propA of propsA) {
            for (const propB of propsB) {
              if (
                propA.property === propB.property &&
                propA.value !== propB.value &&
                propA.unit === propB.unit
              ) {
                contradictions.push({
                  child_a_id: childA.id,
                  child_b_id: childB.id,
                  entity,
                  statement_a: stmtA,
                  statement_b: stmtB,
                  confidence: CONFIDENCE_NUMERIC_CONFLICT,
                });
              }
            }
          }
        }
      }
    }

    return contradictions;
  }
}

// ---------------------------------------------------------------------------
// ContradictionDetector
// ---------------------------------------------------------------------------

export class ContradictionDetector {
  private strategy: ContradictionDetectionStrategy;

  constructor(strategy?: ContradictionDetectionStrategy) {
    this.strategy = strategy ?? new HeuristicContradictionStrategy();
  }

  /**
   * Detects contradictions across all pairs of sibling children.
   *
   * Compares every pair (i, j) where i < j and collects all contradictions
   * with confidence >= 0.4 (the report threshold).
   *
   * pass = no contradictions with confidence >= 0.7.
   */
  async detect(children: ChildDocument[]): Promise<ContradictionResult> {
    const allContradictions: Contradiction[] = [];

    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const pairContradictions = await this.strategy.detect(children[i], children[j]);
        allContradictions.push(...pairContradictions);
      }
    }

    // Filter to report threshold
    const reportedContradictions = allContradictions.filter(
      (c) => c.confidence >= CONFIDENCE_REPORT_THRESHOLD
    );

    // pass = no contradictions with confidence >= 0.7
    const blockingContradictions = reportedContradictions.filter(
      (c) => c.confidence >= CONFIDENCE_BLOCK_THRESHOLD
    );

    return {
      contradictions: reportedContradictions,
      pass: blockingContradictions.length === 0,
    };
  }
}
