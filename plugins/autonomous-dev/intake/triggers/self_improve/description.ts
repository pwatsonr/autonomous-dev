/**
 * TASK-008 — Submit payload builder for the self-improvement loop.
 *
 * `buildSubmitPayload` composes the description, acceptance criteria,
 * priority, and type from a GitHub issue snapshot. Handles truncation of
 * oversized bodies to `cfg.bodyTruncateBytes` bytes (UTF-8-safe boundary).
 *
 * @module intake/triggers/self_improve/description
 */

import type { IssueSnapshot } from './actionable';
import type { ActionableClassId } from './actionable';
import type { SelfImproveConfig } from './config';
import { parsePriorityLabel, parseTypeLabel } from './labels';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Source-issue metadata embedded in the request payload. */
export interface SourceIssueMeta {
  repoId: string;
  issueNumber: number;
  url: string;
  fingerprint: string | null;
}

/** Full payload passed to `requestSubmit`. */
export interface SubmitPayload {
  description: string;
  type: 'bug' | 'refactor';
  priority: 'high' | 'normal' | 'low';
  sourceIssue: SourceIssueMeta;
  acceptanceCriteria: string[];
  truncation: { truncated: boolean; originalBytes: number; truncatedBytes: number };
}

// ---------------------------------------------------------------------------
// Body truncation (UTF-8-safe)
// ---------------------------------------------------------------------------

/**
 * Truncate `body` to at most `maxBytes` UTF-8 bytes at a safe character
 * boundary. Does not split multi-byte sequences.
 *
 * Algorithm:
 * 1. Slice to `maxBytes`.
 * 2. Walk backward past any UTF-8 continuation bytes (0x80–0xBF).
 * 3. If the byte at the new boundary is a leading byte whose sequence
 *    extends beyond `maxBytes`, exclude it too.
 *
 * @param body - Input string.
 * @param maxBytes - Maximum byte length.
 * @returns Truncated string (never exceeds `maxBytes` bytes when re-encoded).
 */
function truncateUtf8(body: string, maxBytes: number): string {
  const buf = Buffer.from(body, 'utf8');
  if (buf.byteLength <= maxBytes) return body;

  let end = maxBytes;

  // Walk backward past UTF-8 continuation bytes (10xxxxxx = 0x80..0xBF).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }

  // `buf[end]` is now either an ASCII byte or a leading byte.
  // If it is a leading byte whose multi-byte sequence does not fit entirely
  // within `maxBytes`, exclude it as well.
  if (end > 0 && buf[end] !== undefined && (buf[end] & 0x80) !== 0) {
    const b = buf[end];
    const seqLen =
      (b & 0xf8) === 0xf0 ? 4 : // 4-byte sequence
      (b & 0xf0) === 0xe0 ? 3 : // 3-byte sequence
      (b & 0xe0) === 0xc0 ? 2 : // 2-byte sequence
      1;
    if (end + seqLen > maxBytes) {
      end--;
    }
  }

  return buf.slice(0, end).toString('utf8');
}

// ---------------------------------------------------------------------------
// Acceptance-criteria extraction (three-tier fallback)
// ---------------------------------------------------------------------------

const HEADING_RE = /^##\s+acceptance\s+criteria\s*$/im;
const NEXT_HEADING_RE = /^##\s/m;
const BULLET_RE = /^\s*[-*]\s+(.+)$/;

/** Tier 1: extract from `## Acceptance Criteria` heading. */
function extractFromHeading(body: string): string[] | null {
  const match = HEADING_RE.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = NEXT_HEADING_RE.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const bullets: string[] = [];
  for (const line of section.split('\n')) {
    const m = BULLET_RE.exec(line);
    if (m) bullets.push(m[1].trim());
  }
  return bullets.length > 0 ? bullets : null;
}

const FENCED_BLOCK_RE = /^```(test|expected)\s*\n([\s\S]*?)^```/gim;

/** Tier 2: extract from fenced ```test / ```expected blocks. */
function extractFromFencedBlocks(body: string): string[] | null {
  const criteria: string[] = [];
  let m: RegExpExecArray | null;
  FENCED_BLOCK_RE.lastIndex = 0;
  while ((m = FENCED_BLOCK_RE.exec(body)) !== null) {
    const blockContent = m[2];
    for (const line of blockContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) criteria.push(trimmed);
    }
  }
  return criteria.length > 0 ? criteria : null;
}

/** Tier 3: synthesized fallback. */
const SYNTHESIZED = [
  'Reproduce the failure described above; verify the corresponding test/check now passes after the fix.',
];

function extractAcceptanceCriteria(body: string): string[] {
  return extractFromHeading(body) ?? extractFromFencedBlocks(body) ?? SYNTHESIZED;
}

// ---------------------------------------------------------------------------
// Priority mapping
// ---------------------------------------------------------------------------

function mapPriority(labels: string[]): 'high' | 'normal' | 'low' {
  const tag = parsePriorityLabel(labels);
  if (tag === 'P0' || tag === 'P1') return 'high';
  if (tag === 'P3') return 'low';
  return 'normal'; // P2 and null
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

function mapType(issue: IssueSnapshot, klass: ActionableClassId): 'bug' | 'refactor' {
  // #641: `type: bug` requires a --bug-context-path that the self-improve
  // submit path does not synthesize, so a bug-typed submit fails validation.
  // Until bug-context synthesis lands, submit self-improvement fixes as
  // 'refactor' — the full pipeline runs, needs no bug-context, and the issue
  // detail is carried verbatim in the request description. An explicit A3
  // `refactor` type-label is honoured (same result).
  if (klass === 'A3') {
    const typeTag = parseTypeLabel(issue.labels);
    if (typeTag === 'refactor') return 'refactor';
  }
  return 'refactor';
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build the full submit payload for a self-improvement fix request.
 *
 * Composition order in `description` (joined with `\n\n`):
 * 1. Auto-generated header line.
 * 2. Source URL line.
 * 3. Fenced verbatim body (truncated to `cfg.bodyTruncateBytes`).
 * 4. `## Acceptance Criteria` section.
 * 5. `## Constraints` footer.
 *
 * @param issue - The source issue snapshot.
 * @param klass - The actionable class that matched.
 * @param cfg - Self-improvement config (for `bodyTruncateBytes`).
 * @returns A fully-populated `SubmitPayload`.
 */
export function buildSubmitPayload(
  issue: IssueSnapshot,
  klass: ActionableClassId,
  cfg: SelfImproveConfig,
): SubmitPayload {
  const originalBytes = Buffer.byteLength(issue.body, 'utf8');
  const truncatedBody = truncateUtf8(issue.body, cfg.bodyTruncateBytes);
  const truncatedBytes = Buffer.byteLength(truncatedBody, 'utf8');
  const truncated = truncatedBytes < originalBytes;

  const acceptanceCriteria = extractAcceptanceCriteria(issue.body);

  const criteriaSection =
    '## Acceptance Criteria\n\n' + acceptanceCriteria.map((c) => `- ${c}`).join('\n');

  const constraintsSection =
    '## Constraints\n\n' +
    // NB: self-improve PRs AUTO-MERGE when CI is green at the repo's trust level
    // (operator policy). Do NOT claim "human merge required" here — the merge
    // decision does not honor it, and stamping a false constraint made the
    // system say one thing and do another. Keep the change minimal + reversible.
    '- Auto-merges when CI is green at the repo trust level; keep the change minimal and reversible.\n' +
    '- Follow existing test conventions.\n' +
    '- No changes outside the failing scope unless justified.';

  const parts = [
    `Auto-generated from ${issue.repoId}#${issue.number}: ${issue.title}`,
    `Source: ${issue.htmlUrl}`,
    '```\n' + truncatedBody + '\n```',
    criteriaSection,
    constraintsSection,
  ];

  const description = parts.join('\n\n');

  return {
    description,
    type: mapType(issue, klass),
    priority: mapPriority(issue.labels),
    sourceIssue: {
      repoId: issue.repoId,
      issueNumber: issue.number,
      url: issue.htmlUrl,
      fingerprint: issue.fingerprint,
    },
    acceptanceCriteria,
    truncation: { truncated, originalBytes, truncatedBytes },
  };
}
