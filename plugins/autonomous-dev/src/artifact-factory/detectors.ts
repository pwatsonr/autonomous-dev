/**
 * Opportunity detectors (ONBOARD Phase 2 — #590, P2.2).
 *
 * A detector reads a repo's ingested memory docs (Phase 1) and emits zero+
 * `Opportunity` records — "this repo has X; we could generate a scoped skill for
 * it". Detectors are PURE over the docs (no IO, no LLM, best-effort + independent
 * — mirrors the Phase 1 `Extractor`); `detectOpportunities` does the IO + runs
 * them best-effort. They read the repo's OWN memory layer (`repo:<id>`), the
 * signal source for a repo-specific opportunity. Generation/gating is later
 * (P2.4/P2.5); detection only proposes candidates.
 */

import { readScopeMemory, defaultMemoryIO } from '../memory/store';
import type { MemoryStoreIO } from '../memory/store';
import type { MemoryDoc } from '../memory/types';
import type { ArtifactKind } from './types';

export interface Opportunity {
  /** Stable id `${kind}:${suggestedName}:${repoId}`; (kind, suggestedName) is the aggregation key (FR-B1). */
  id: string;
  kind: ArtifactKind;
  repoId: string;
  title: string;
  /** The memory snippet/topic that triggered it (audit + human review). */
  evidence: string;
  /** kebab base name; the scope-decider (P2.3) derives the final scoped name. */
  suggestedName: string;
}

export interface OpportunityDetector {
  name: string;
  detect(repoId: string, docs: MemoryDoc[]): Opportunity[];
}

function docByTopic(docs: MemoryDoc[], topic: string): MemoryDoc | undefined {
  return docs.find((d) => d.topic === topic);
}

function firstMatchLine(content: string, re: RegExp): string | undefined {
  for (const line of content.slice(0, 200_000).split('\n')) {
    if (re.test(line)) return line.trim().slice(0, 200);
  }
  return undefined;
}

function oppId(kind: ArtifactKind, suggestedName: string, repoId: string): string {
  return `${kind}:${suggestedName}:${repoId}`;
}

const VAULT_RE = /\b(vault|hashicorp|sops|sealed[-\s]?secrets|doppler|infisical|akeyless|secrets?[-\s]?manager)\b/i;

/** A secrets/vault signal in the deps or build/deploy memory → a vault-access skill. */
export const vaultDetector: OpportunityDetector = {
  name: 'vault',
  detect(repoId, docs) {
    for (const topic of ['dependencies', 'build-deploy']) {
      const doc = docByTopic(docs, topic);
      if (!doc) continue;
      const line = firstMatchLine(doc.content, VAULT_RE);
      if (line) {
        return [
          {
            id: oppId('skill', 'vault-access', repoId),
            kind: 'skill',
            repoId,
            suggestedName: 'vault-access',
            title: `Secrets/vault access skill for ${repoId}`,
            evidence: `[${topic}] ${line}`,
          },
        ];
      }
    }
    return [];
  },
};

/** A recorded test setup → a run/scaffold-tests skill. */
export const testConventionDetector: OpportunityDetector = {
  name: 'test-convention',
  detect(repoId, docs) {
    const doc = docByTopic(docs, 'test-conventions');
    if (!doc || doc.content.trim().length < 40) return [];
    const detected = firstMatchLine(doc.content, /Detected:/) ?? 'test setup present';
    return [
      {
        id: oppId('skill', 'run-tests', repoId),
        kind: 'skill',
        repoId,
        suggestedName: 'run-tests',
        title: `Test runner skill for ${repoId}`,
        evidence: `[test-conventions] ${detected}`,
      },
    ];
  },
};

/** A rich, STRUCTURED overview/README → a domain-context skill capturing the glossary. */
export const domainGlossaryDetector: OpportunityDetector = {
  name: 'domain-glossary',
  detect(repoId, docs) {
    const doc = docByTopic(docs, 'overview');
    if (!doc) return [];
    const content = doc.content.slice(0, 200_000);
    if (content.trim().length < 600) return [];
    // Require a structural signal — not just length — to cut noise from long prose READMEs.
    const headings = (content.match(/^##\s/gm) ?? []).length;
    const hasGlossary = /\b(glossary|terminology|domain\s+model|key\s+concepts|ubiquitous\s+language)\b/i.test(content);
    if (headings < 2 && !hasGlossary) return [];
    return [
      {
        id: oppId('skill', 'domain-context', repoId),
        kind: 'skill',
        repoId,
        suggestedName: 'domain-context',
        title: `Domain context skill for ${repoId}`,
        evidence: `[overview] ${doc.content.trim().slice(0, 160)}…`,
      },
    ];
  },
};

export const defaultDetectors: OpportunityDetector[] = [
  vaultDetector,
  testConventionDetector,
  domainGlossaryDetector,
];

export interface DetectionResult {
  repoId: string;
  opportunities: Opportunity[];
  errors: { detector: string; error: string }[];
}

/** Run detectors over a repo's own memory (best-effort per detector). Read-only. */
export function detectOpportunities(
  repoId: string,
  io: MemoryStoreIO = defaultMemoryIO,
  detectors: OpportunityDetector[] = defaultDetectors,
): DetectionResult {
  const docs = readScopeMemory(`repo:${repoId}`, io);
  const opportunities: Opportunity[] = [];
  const errors: { detector: string; error: string }[] = [];
  for (const d of detectors) {
    try {
      opportunities.push(...d.detect(repoId, docs));
    } catch (err) {
      errors.push({ detector: d.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { repoId, opportunities, errors };
}
