/**
 * Artifact-factory orchestration (ONBOARD Phase 2 — #590, P2.6, FR-E).
 *
 * `proposeArtifacts` ties the pipeline together: detect opportunities across
 * repos → decide scope → generate → deterministic constraints gate → meta-review
 * → PARK. `promoteProposal` (human `artifact accept`) re-checks constraints and
 * writes the skill into the platform's own scoped store
 * (`~/.autonomous-dev/artifacts/<scope>/skills/<name>.md`) — never a crawled repo
 * (R1). Auto-promote never happens. All model calls go through an injected
 * `ArtifactRuntime` so the whole pipeline is unit-tested with a fake.
 */

import * as path from 'path';

import type { Ownership, ArtifactScope } from '../ownership/types';
import { readScopeMemory, defaultMemoryIO } from '../memory/store';
import type { MemoryStoreIO } from '../memory/store';
import { detectOpportunities } from './detectors';
import type { OpportunityDetector, Opportunity } from './detectors';
import { decideScopes } from './scope-decider';
import { generateArtifact } from './generator';
import { enforceArtifactConstraints } from './constraints';
import { reviewArtifact } from './meta-review';
import type { ArtifactRuntime } from './runtime';
import { serializeArtifact, parseArtifact } from './parser';
import {
  upsertProposal,
  getProposal,
  setStatus,
  proposalId,
  defaultArtifactStoreIO,
} from './proposal-store';
import type { ArtifactProposal, ArtifactStoreIO } from './proposal-store';

export interface ProposeOptions {
  repoIds: string[];
  ownership: Ownership;
  runtime: ArtifactRuntime;
  reviewerSystemPrompt?: string;
  memIO?: MemoryStoreIO;
  storeIO?: ArtifactStoreIO;
  detectors?: OpportunityDetector[];
  k?: number;
}

export interface ProposeResult {
  proposals: ArtifactProposal[];
  skipped: { suggestedName: string; scope: string; reason: string }[];
  /** per-repo detector failures (FR-A4) — surfaced for --verbose. */
  detectionErrors: { repoId: string; detector: string; error: string }[];
}

/** Run the full pipeline for a set of repos and PARK the results. */
export async function proposeArtifacts(opts: ProposeOptions): Promise<ProposeResult> {
  const memIO = opts.memIO ?? defaultMemoryIO;
  const storeIO = opts.storeIO ?? defaultArtifactStoreIO;

  const allOpps: Opportunity[] = [];
  const detectionErrors: { repoId: string; detector: string; error: string }[] = [];
  for (const id of opts.repoIds) {
    const d = detectOpportunities(id, memIO, opts.detectors);
    allOpps.push(...d.opportunities);
    for (const e of d.errors)
      detectionErrors.push({ repoId: id, detector: e.detector, error: e.error });
  }
  const scoped = decideScopes(allOpps, opts.ownership, opts.k);

  const proposals: ArtifactProposal[] = [];
  const skipped: { suggestedName: string; scope: string; reason: string }[] = [];

  for (const sp of scoped) {
    // Never silently overwrite an already-promoted proposal (B5 — preserves the audit + on-disk skill).
    const existing = getProposal(proposalId(sp.kind, sp.scope, sp.suggestedName), storeIO);
    if (existing && existing.status === 'promoted') {
      skipped.push({
        suggestedName: sp.suggestedName,
        scope: sp.scope,
        reason: 'already promoted (re-propose skipped)',
      });
      continue;
    }
    // Ground generation in ALL member repos' memory (B4), bounded so the prompt stays sane.
    const repoDocs = sp.repoIds.slice(0, 3).flatMap((rid) => readScopeMemory(`repo:${rid}`, memIO));
    const opportunity = {
      id: `${sp.kind}:${sp.suggestedName}:${sp.repoIds[0]}`,
      kind: sp.kind,
      repoId: sp.repoIds[0],
      title: `${sp.suggestedName} ${sp.kind} (${sp.scope})`,
      evidence: sp.evidence.join(' | '),
      suggestedName: sp.suggestedName,
    };

    const gen = await generateArtifact(
      { opportunity, scope: sp.scope, suggestedName: sp.suggestedName, repoDocs },
      opts.runtime,
    );
    if (!gen.artifact) {
      skipped.push({
        suggestedName: sp.suggestedName,
        scope: sp.scope,
        reason: gen.errors.join('; ') || 'generation failed',
      });
      continue;
    }

    const now = storeIO.now();
    const base: ArtifactProposal = {
      id: proposalId(sp.kind, sp.scope, sp.suggestedName),
      kind: sp.kind,
      name: sp.suggestedName,
      scope: sp.scope,
      status: 'pending_meta_review',
      artifact: gen.artifact,
      evidence: sp.evidence,
      rationale: sp.rationale,
      confidence: sp.confidence,
      createdAt: now,
      history: [{ at: now, event: 'generated' }],
    };

    const violations = enforceArtifactConstraints(gen.artifact, { ownership: opts.ownership });
    if (violations.length > 0) {
      base.status = 'meta_rejected';
      base.constraintViolations = violations;
      base.history.push({
        at: storeIO.now(),
        event: 'constraint_rejected',
        detail: violations.map((v) => v.rule).join(', '),
      });
      proposals.push(upsertProposal(base, storeIO));
      continue;
    }

    const review = await reviewArtifact(gen.artifact, opts.runtime, {
      evidence: sp.evidence.join('; '),
      systemPrompt: opts.reviewerSystemPrompt,
    });
    base.metaReview = { verdict: review.verdict, findings: review.findings };
    base.status = review.verdict === 'approved' ? 'meta_approved' : 'meta_rejected';
    base.history.push({
      at: storeIO.now(),
      event: `meta_${review.verdict}`,
      detail: review.findings.map((f) => `${f.severity}:${f.message}`).join('; '),
    });
    proposals.push(upsertProposal(base, storeIO));
  }

  return { proposals, skipped, detectionErrors };
}

/** Relative dir for a scope under the artifact store (mirrors the memory tree, no org). */
export function artifactScopeDir(scope: ArtifactScope): string {
  if (scope === 'global') return 'global';
  const idx = scope.indexOf(':');
  return `${scope.slice(0, idx)}/${scope.slice(idx + 1)}`;
}

/** Absolute path where a promoted skill lands. */
export function artifactPath(io: ArtifactStoreIO, scope: ArtifactScope, name: string): string {
  return path.join(
    io.homedir(),
    '.autonomous-dev',
    'artifacts',
    artifactScopeDir(scope),
    'skills',
    `${name}.md`,
  );
}

export interface PromoteOptions {
  toolOverride?: string[];
  ownership?: Ownership;
  storeIO?: ArtifactStoreIO;
}

export interface PromoteResult {
  path: string;
  proposal: ArtifactProposal;
}

/** Human `artifact accept`: re-check constraints (incl. override) then write to the scoped store. */
export function promoteProposal(id: string, opts: PromoteOptions = {}): PromoteResult {
  const storeIO = opts.storeIO ?? defaultArtifactStoreIO;
  const p = getProposal(id, storeIO);
  if (!p) throw new Error(`Unknown proposal "${id}".`);
  // Require the FULL approved state, not just the status flag (defends against a hand-edited
  // proposals.json that flips status without a real meta-review / despite constraint violations).
  if (
    p.status !== 'meta_approved' ||
    p.metaReview?.verdict !== 'approved' ||
    (p.constraintViolations?.length ?? 0) > 0
  ) {
    throw new Error(
      `Proposal "${id}" is not promotable (status: ${p.status}, verdict: ${p.metaReview?.verdict ?? 'none'}).`,
    );
  }
  // The on-disk target uses p.scope; the constraint re-check uses p.artifact.scope — they must agree.
  if (p.scope !== p.artifact.scope) {
    throw new Error(
      `Proposal "${id}" scope/artifact-scope mismatch (${p.scope} vs ${p.artifact.scope}).`,
    );
  }

  // The promoted skill GETS the operator-authorized tools (override widens its surface).
  const finalArtifact = {
    ...p.artifact,
    allowedTools: [...new Set([...p.artifact.allowedTools, ...(opts.toolOverride ?? [])])],
  };

  // Defense-in-depth: re-run the deterministic gate WITH the override before writing.
  const violations = enforceArtifactConstraints(finalArtifact, {
    ownership: opts.ownership,
    toolOverride: opts.toolOverride,
  });
  if (violations.length > 0) {
    throw new Error(`Refusing to promote "${id}": ${violations.map((v) => v.detail).join('; ')}`);
  }

  const target = artifactPath(storeIO, p.scope, p.name);
  // R1 containment: the resolved path MUST stay under the artifacts root.
  const root = path.join(storeIO.homedir(), '.autonomous-dev', 'artifacts');
  if (
    path.resolve(target) !== target ||
    !path.resolve(target).startsWith(path.resolve(root) + path.sep)
  ) {
    throw new Error(`Refusing to write outside the artifact store: ${target}`);
  }
  const serialized = serializeArtifact(finalArtifact);
  // AC5: the promoted file must be re-parseable (guards against a serializer edge case).
  const reparse = parseArtifact(serialized);
  if (!reparse.success) {
    throw new Error(
      `Refusing to promote "${id}": serialized skill is not re-parseable (${reparse.errors.map((e) => e.message).join('; ')}).`,
    );
  }
  storeIO.writeFile(target, serialized);
  if (opts.toolOverride && opts.toolOverride.length > 0) {
    // upsertProposal re-merges prior history from disk; pass history:[] so the loaded
    // copy's history isn't doubled (it is preserved by the merge against disk).
    upsertProposal(
      { ...p, toolOverride: opts.toolOverride, artifact: finalArtifact, history: [] },
      storeIO,
    );
  }
  const promoted = setStatus(id, 'promoted', 'promoted', storeIO, `wrote ${target}`);
  return { path: target, proposal: promoted };
}

/** Human `artifact reject`: terminally dismiss a parked proposal. */
export function rejectProposal(
  id: string,
  storeIO: ArtifactStoreIO = defaultArtifactStoreIO,
): ArtifactProposal {
  const p = getProposal(id, storeIO);
  if (!p) throw new Error(`Unknown proposal "${id}".`);
  if (p.status === 'promoted') throw new Error(`Proposal "${id}" already promoted.`);
  return setStatus(id, 'rejected', 'rejected_by_operator', storeIO);
}
