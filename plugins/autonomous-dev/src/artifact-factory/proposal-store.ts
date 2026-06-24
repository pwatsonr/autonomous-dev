/**
 * Artifact proposal store (ONBOARD Phase 2 — #590, P2.6, FR-E1).
 *
 * A standalone JSON-backed park store for generated-skill proposals — modeled on
 * the agent ProposalStore's status-machine + append pattern, but re-implemented
 * (no native dep, no shared types; mirrors the P1 questions store). Each proposal
 * SELF-AUDITS via its `history` array, so Phase 2 touches neither the shared
 * `AuditEventType` union nor the agent loop. Injected IO (incl. a clock) keeps it
 * deterministic in tests; the home dir is the fail-closed absolute home (R1).
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveAbsoluteHome } from '../home';
import type { ArtifactScope } from '../ownership/types';
import type { GeneratedArtifact, ArtifactKind } from './types';
import type { ArtifactConstraintViolation } from './constraints';
import type { ArtifactMetaFinding } from './meta-review';

export type ArtifactProposalStatus =
  | 'pending_meta_review'
  | 'meta_approved'
  | 'meta_rejected'
  | 'promoted'
  | 'rejected';

export interface ProposalHistoryEntry {
  at: string;
  event: string;
  detail?: string;
}

export interface ArtifactProposal {
  /** stable id `${kind}::${scope}::${name}` (re-proposing replaces). */
  id: string;
  kind: ArtifactKind;
  name: string;
  scope: ArtifactScope;
  status: ArtifactProposalStatus;
  artifact: GeneratedArtifact;
  /** per-repo evidence that drove generation. */
  evidence: string[];
  /** scope-decision rationale. */
  rationale: string;
  confidence: number;
  metaReview?: { verdict: 'approved' | 'rejected'; findings: ArtifactMetaFinding[] };
  constraintViolations?: ArtifactConstraintViolation[];
  /** operator-granted extra tools at accept-time. */
  toolOverride?: string[];
  createdAt: string;
  history: ProposalHistoryEntry[];
}

export interface ArtifactStoreIO {
  homedir(): string;
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, data: string): void;
  now(): string;
}

export const defaultArtifactStoreIO: ArtifactStoreIO = {
  homedir: () => resolveAbsoluteHome(),
  readFile: (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined),
  writeFile: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  },
  now: () => new Date().toISOString(),
};

export function proposalsPath(io: ArtifactStoreIO = defaultArtifactStoreIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'artifacts', 'proposals.json');
}

export function proposalId(kind: ArtifactKind, scope: ArtifactScope, name: string): string {
  return `${kind}::${scope}::${name}`;
}

export function loadProposals(io: ArtifactStoreIO = defaultArtifactStoreIO): ArtifactProposal[] {
  const raw = io.readFile(proposalsPath(io));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ArtifactProposal[]) : [];
  } catch {
    return [];
  }
}

function saveProposals(ps: ArtifactProposal[], io: ArtifactStoreIO): void {
  io.writeFile(proposalsPath(io), `${JSON.stringify(ps, null, 2)}\n`);
}

/** Insert or replace a proposal by id (idempotent re-propose). */
export function upsertProposal(p: ArtifactProposal, io: ArtifactStoreIO = defaultArtifactStoreIO): ArtifactProposal {
  const ps = loadProposals(io);
  const idx = ps.findIndex((x) => x.id === p.id);
  if (idx >= 0) ps[idx] = p;
  else ps.push(p);
  saveProposals(ps, io);
  return p;
}

export function getProposal(id: string, io: ArtifactStoreIO = defaultArtifactStoreIO): ArtifactProposal | undefined {
  return loadProposals(io).find((p) => p.id === id);
}

export function listProposals(
  io: ArtifactStoreIO = defaultArtifactStoreIO,
  filter?: { status?: ArtifactProposalStatus },
): ArtifactProposal[] {
  let ps = loadProposals(io);
  if (filter?.status) ps = ps.filter((p) => p.status === filter.status);
  return ps;
}

/** Transition a proposal's status + append a history entry. Throws if absent. */
export function setStatus(
  id: string,
  status: ArtifactProposalStatus,
  event: string,
  io: ArtifactStoreIO = defaultArtifactStoreIO,
  detail?: string,
): ArtifactProposal {
  const ps = loadProposals(io);
  const p = ps.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown proposal "${id}".`);
  p.status = status;
  p.history.push({ at: io.now(), event, detail });
  saveProposals(ps, io);
  return p;
}
