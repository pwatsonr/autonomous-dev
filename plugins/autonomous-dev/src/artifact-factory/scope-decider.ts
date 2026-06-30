/**
 * Scope decision heuristic (ONBOARD Phase 2 — #590, P2.3, FR-B).
 *
 * Groups opportunities by identity `(kind, normalizedSuggestedName)` and decides
 * a PROPOSED scope for each group — propose-don't-apply:
 *   - seen in exactly one repo            → `repo:<id>`
 *   - recurring within one project        → `project:<id>` (high confidence at ≥K)
 *   - recurring across projects / no shared project → `global`
 *
 * PURE — no IO, never writes ownership. repo→project membership comes from the
 * existing `Ownership.repos[].projectId` (Phase 0), NOT `inferProjects` (which
 * proposes *new* projects and is the wrong tool here). The graph layer (P1.6)
 * can later enrich the confidence, not the structure.
 */

import type { Ownership, ArtifactScope } from '../ownership/types';
import type { ArtifactKind } from './types';
import type { Opportunity } from './detectors';

export interface ScopedProposal {
  kind: ArtifactKind;
  /** normalized (lowercased/trimmed) suggested base name. */
  suggestedName: string;
  scope: ArtifactScope;
  /** the repos the signal occurred in (deduped, sorted). */
  repoIds: string[];
  confidence: number; // 0..1
  rationale: string;
  /** per-repo evidence snippets. */
  evidence: string[];
}

const DEFAULT_K = 3;

function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

function decideOne(
  repoIds: string[],
  repoProject: Map<string, string | null>,
  k: number,
): { scope: ArtifactScope; confidence: number; rationale: string } {
  if (repoIds.length === 1) {
    return {
      scope: `repo:${repoIds[0]}`,
      confidence: 0.9,
      rationale: `Seen only in ${repoIds[0]} → repo scope.`,
    };
  }
  const projects = repoIds.map((id) => repoProject.get(id) ?? null);
  const distinct = [...new Set(projects)];
  if (distinct.length === 1 && distinct[0] !== null) {
    const project = distinct[0];
    const strong = repoIds.length >= k;
    return {
      scope: `project:${project}`,
      confidence: strong ? 0.85 : 0.6,
      rationale: strong
        ? `Recurs in ${repoIds.length} repos (≥K=${k}) all in project "${project}" → project scope.`
        : `Recurs in ${repoIds.length} repos of project "${project}" (below K=${k} — lower confidence) → project scope.`,
    };
  }
  const namedProjects = distinct.filter((p): p is string => p !== null);
  return {
    scope: 'global',
    confidence: repoIds.length >= k ? 0.7 : 0.5,
    rationale:
      namedProjects.length > 1
        ? `Recurs across ${namedProjects.length} projects → global scope.`
        : `Recurs across repos with no single shared project → global scope.`,
  };
}

/** Group opportunities and decide a proposed scope for each distinct signal. Pure. */
export function decideScopes(
  opportunities: Opportunity[],
  own: Ownership,
  k: number = DEFAULT_K,
): ScopedProposal[] {
  const groups = new Map<string, Opportunity[]>();
  for (const o of opportunities) {
    const key = `${o.kind}::${normalizeName(o.suggestedName)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }

  const repoProject = new Map<string, string | null>();
  for (const r of own.repos) repoProject.set(r.id, r.projectId);

  const proposals: ScopedProposal[] = [];
  for (const group of groups.values()) {
    const repoIds = [...new Set(group.map((o) => o.repoId))].sort();
    const { scope, confidence, rationale } = decideOne(repoIds, repoProject, k);
    proposals.push({
      kind: group[0].kind,
      suggestedName: normalizeName(group[0].suggestedName),
      scope,
      repoIds,
      confidence,
      rationale,
      evidence: group.map((o) => `${o.repoId}: ${o.evidence}`),
    });
  }
  return proposals.sort(
    (a, b) => a.suggestedName.localeCompare(b.suggestedName) || a.scope.localeCompare(b.scope),
  );
}
