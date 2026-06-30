/**
 * Generated-artifact model (ONBOARD Phase 2 — #590).
 *
 * The agent-factory models AGENTS; skills/commands have no programmatic model.
 * Phase 2 adds a minimal one for the artifacts it GENERATES from ingested
 * memory. The model carries a `kind` discriminant, but Phase 2 implements +
 * gates only `kind: 'skill'` (commands are NG8, a fast-follow). The artifact is
 * a valid Claude Code skill `.md` (name/description/allowed-tools) PLUS our
 * scope metadata (kind/scope/managed) — Claude Code ignores the extra keys, so
 * a promoted artifact is simultaneously a usable skill and self-describing.
 */

import type { ArtifactScope } from '../ownership/types';

/** Phase 2 implements `skill`; `command` is structurally accommodated (NG8). */
export type ArtifactKind = 'skill' | 'command';

/** A generated, scoped artifact. */
export interface GeneratedArtifact {
  kind: ArtifactKind;
  /** kebab id, unique within (scope, kind). */
  name: string;
  /** global | project:<id> | repo:<id> (Phase 0 vocabulary). */
  scope: ArtifactScope;
  /** The skill's trigger description (what makes Claude Code load it). */
  description: string;
  /** Platform-owned + improvable later. Phase 2 generations are always true. */
  managed: boolean;
  /** Tool allowlist (FR-D1a — read-only default; constraints enforce the policy). */
  allowedTools: string[];
  /** Markdown body — the skill instructions. */
  body: string;
}

export interface ArtifactParseError {
  message: string;
  field?: string;
}

export interface ArtifactParseResult {
  success: boolean;
  artifact?: GeneratedArtifact;
  errors: ArtifactParseError[];
}

export const ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'skill',
  'command',
]);
