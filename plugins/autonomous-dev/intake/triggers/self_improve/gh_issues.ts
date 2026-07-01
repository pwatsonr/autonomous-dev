/**
 * TASK-007 — GitHub issue client for the self-improvement scan.
 *
 * Wraps `gh` CLI calls via the existing `ExecFn` seam from `checks_client`.
 * All argv is passed as an array — never interpolated into a shell string.
 * Pagination stops at page 2; beyond that `truncated: true` is set.
 *
 * @module intake/triggers/self_improve/gh_issues
 */

import type { ExecFn } from '../checks_client';
import type { IssueSnapshot, IssueEventsSnapshot } from './actionable';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of listing open issues. */
export interface ListOpenResult {
  issues: IssueSnapshot[];
  truncated: boolean;
}

/** Injectable GitHub issue client. */
export interface GhIssueClient {
  /**
   * List open issues on `repoId` that have any of `labels`.
   *
   * @param repoId - Repository identifier (`owner/name`).
   * @param labels - Labels to filter by (any match).
   * @param limit - Max results per page (≤100).
   */
  listOpen(repoId: string, labels: readonly string[], limit: number): Promise<ListOpenResult>;

  /**
   * Fetch the reduced events snapshot for a single issue.
   *
   * @param repoId - Repository identifier.
   * @param issueNumber - Issue number.
   */
  getEvents(repoId: string, issueNumber: number): Promise<IssueEventsSnapshot>;

  /**
   * Post a comment on an issue.
   *
   * @param repoId - Repository identifier.
   * @param issueNumber - Issue number.
   * @param body - Comment body.
   */
  comment(repoId: string, issueNumber: number, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Raw GitHub issue shape (minimal — only what we need)
// ---------------------------------------------------------------------------

interface RawGhIssue {
  number?: number;
  html_url?: string;
  title?: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  user?: { login?: string };
  updated_at?: string;
}

interface RawGhEvent {
  event?: string;
  label?: { name?: string };
  actor?: { login?: string };
  created_at?: string;
}

// ---------------------------------------------------------------------------
// Fingerprint extraction helpers
// ---------------------------------------------------------------------------

const FAILURE_FP_RE = /<!--\s*autodev-failure:\s*([A-Fa-f0-9]{8,})\s*-->/;
const REVIEWER_FP_RE = /<!--\s*autodev-reviewer:\s*([A-Za-z0-9_.-]+)\s*-->/;

function extractFingerprint(body: string): string | null {
  const m = FAILURE_FP_RE.exec(body);
  return m ? m[1] : null;
}

function extractReviewerBlockFp(body: string): string | null {
  const m = REVIEWER_FP_RE.exec(body);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// HTTP header helpers
// ---------------------------------------------------------------------------

/**
 * Parse the `Link` header to determine if a `rel="next"` page exists.
 * The `-i` flag from `gh api` includes headers in the stdout; we look
 * for the Link header in the text block before the JSON body.
 *
 * @param rawOutput - Raw stdout including headers.
 * @returns `true` when a `rel="next"` link is present.
 */
function hasNextPage(rawOutput: string): boolean {
  // Find the Link header line (case-insensitive)
  const lines = rawOutput.split('\n');
  for (const line of lines) {
    if (/^link:/i.test(line) && line.includes('rel="next"')) return true;
  }
  return false;
}

/**
 * Extract the JSON body from a `gh api -i` response (strip headers).
 *
 * @param rawOutput - Raw stdout with headers prepended.
 * @returns The JSON portion.
 */
function extractJsonBody(rawOutput: string): string {
  // Headers and body are separated by a blank line
  const blankLineIdx = rawOutput.indexOf('\r\n\r\n');
  if (blankLineIdx !== -1) return rawOutput.slice(blankLineIdx + 4);
  const blankLineIdx2 = rawOutput.indexOf('\n\n');
  if (blankLineIdx2 !== -1) return rawOutput.slice(blankLineIdx2 + 2);
  return rawOutput;
}

// ---------------------------------------------------------------------------
// Issue mapping
// ---------------------------------------------------------------------------

function mapIssue(raw: RawGhIssue, repoId: string): IssueSnapshot {
  const body = raw.body ?? '';
  return {
    repoId,
    number: raw.number ?? 0,
    htmlUrl: raw.html_url ?? '',
    title: raw.title ?? '',
    body,
    labels: (raw.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    authorLogin: raw.user?.login ?? '',
    updatedAt: raw.updated_at ?? '',
    fingerprint: extractFingerprint(body),
    reviewerBlockFp: extractReviewerBlockFp(body),
  };
}

// ---------------------------------------------------------------------------
// Page fetcher
// ---------------------------------------------------------------------------

async function fetchPage(
  exec: ExecFn,
  repoId: string,
  labels: readonly string[],
  page: number,
): Promise<{ issues: IssueSnapshot[]; hasNext: boolean }> {
  const labelsParam = labels.join(',');
  const url = `/repos/${repoId}/issues?state=open&per_page=100&labels=${labelsParam}&page=${page}`;
  const { stdout, ok } = await exec('gh', ['api', url, '-i']);
  if (!ok) {
    throw new Error(`gh api failed for ${repoId}: ${stdout}`);
  }
  const hasNext = hasNextPage(stdout);
  const jsonBody = extractJsonBody(stdout);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBody);
  } catch {
    throw new Error(`gh api response not valid JSON for ${repoId}`);
  }
  const rawIssues = Array.isArray(parsed) ? (parsed as RawGhIssue[]) : [];
  return {
    issues: rawIssues.map((r) => mapIssue(r, repoId)),
    hasNext,
  };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Build a `GhIssueClient` that delegates to `exec` (the existing `gh` seam).
 *
 * @param exec - The `ExecFn` to shell `gh` commands through.
 * @returns A `GhIssueClient` instance.
 */
export function ghIssueClient(exec: ExecFn): GhIssueClient {
  return {
    async listOpen(repoId, labels, _limit) {
      // Page 1
      const page1 = await fetchPage(exec, repoId, labels, 1);
      const allIssues = [...page1.issues];
      let truncated = false;

      // Page 2 (only if page 1 indicated a next page)
      if (page1.hasNext) {
        const page2 = await fetchPage(exec, repoId, labels, 2);
        allIssues.push(...page2.issues);
        // If page 2 ALSO has a next page, we stop and flag truncation
        if (page2.hasNext) {
          truncated = true;
        }
      }

      return { issues: allIssues, truncated };
    },

    async getEvents(repoId, issueNumber) {
      const url = `/repos/${repoId}/issues/${issueNumber}/events`;
      const { stdout, ok } = await exec('gh', ['api', url]);
      if (!ok) {
        throw new Error(`gh api events failed for ${repoId}#${issueNumber}: ${stdout}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`gh api events response not valid JSON`);
      }
      const events = Array.isArray(parsed) ? (parsed as RawGhEvent[]) : [];

      // Reduce to labeledBy map; iterate ascending (later overwrites earlier)
      const labeledBy: Record<string, string> = {};
      // Sort by created_at ascending
      const sorted = [...events].sort((a, b) => {
        const ta = a.created_at ?? '';
        const tb = b.created_at ?? '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      for (const ev of sorted) {
        if (ev.event === 'labeled' && ev.label?.name && ev.actor?.login) {
          labeledBy[ev.label.name] = ev.actor.login;
        }
      }
      return { labeledBy };
    },

    async comment(repoId, issueNumber, body) {
      const { ok, stdout } = await exec('gh', [
        'issue',
        'comment',
        String(issueNumber),
        '--repo',
        repoId,
        '--body',
        body,
      ]);
      if (!ok) {
        throw new Error(`gh issue comment failed for ${repoId}#${issueNumber}: ${stdout}`);
      }
    },
  };
}
