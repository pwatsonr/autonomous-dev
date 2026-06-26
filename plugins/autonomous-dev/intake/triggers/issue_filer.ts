/**
 * ONBOARD Phase 6 (#583) — auto-file a GitHub issue when the autonomous system
 * fails. An injected, gh-backed `IssueFiler` seam (never throws) so callers —
 * the stabilization watch (regressed/expired) and the daemon failure hooks
 * (terminal pipeline failure, circuit-breaker trip, state corruption) — get a
 * durable, deduplicated failure tracker without coupling to `gh` and with full
 * unit-testability.
 *
 * Dedup: each issue body carries a hidden fingerprint marker
 * `<!-- autodev-failure: <fp> -->`. Before opening a new issue we search the
 * repo's OPEN issues for that fingerprint; if one exists we COMMENT the
 * recurrence rather than open a duplicate. The fingerprint is a stable hash of
 * the failure's identity, so the same failure always maps to the same issue.
 *
 * Labels are intentionally NOT passed as `--label` (gh errors on a label the
 * target repo hasn't defined, which would silently drop the whole issue); the
 * failure class is encoded in the title prefix + body instead, so creation
 * works on any repo with zero label setup.
 *
 * @module intake/triggers/issue_filer
 */

import { createHash } from 'crypto';

import type { ExecFn } from './checks_client';

/** A failure to be tracked as a GitHub issue. */
export interface FailureIssue {
  /** Target repo SLUG (`owner/name`) the issue is filed on. */
  repo: string;
  title: string;
  body: string;
  /** Stable identity of this failure (the dedup key); see {@link failureFingerprint}. */
  fingerprint: string;
}

export interface IssueFileResult {
  ok: boolean;
  /** URL of the created (or existing, when deduped) issue, when known. */
  url?: string;
  /** True when an existing open issue was found and commented instead of duplicated. */
  deduped?: boolean;
  error?: string;
}

export interface IssueFiler {
  file(issue: FailureIssue): Promise<IssueFileResult>;
}

/** Hidden HTML-comment marker embedded in issue bodies for the dedup search. */
export function fingerprintMarker(fp: string): string {
  return `<!-- autodev-failure: ${fp} -->`;
}

/**
 * Stable fingerprint for a failure identity. Same inputs → same hash, so
 * repeated occurrences of the same failure deduplicate to one issue. 16 hex
 * chars of sha256 is ample to avoid collisions across a repo's open issues.
 */
export function failureFingerprint(parts: {
  repo: string;
  requestId?: string;
  failureClass: string;
  phase?: string;
}): string {
  const key = [parts.repo, parts.requestId ?? '', parts.failureClass, parts.phase ?? ''].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** A GitHub repo slug `owner/name`; anything else is rejected (never reaches a gh arg). */
const SAFE_REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Collapse newlines so a title/comment is a single line for gh. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Build an `IssueFiler` that shells `gh`. Never throws — any failure (gh
 * missing, non-zero exit, unparseable JSON) yields `{ ok:false, error }`. The
 * injected `exec` is the same seam the checks client uses, so production passes
 * the real `gh` runner and tests pass a fake.
 */
export function ghIssueFiler(exec: ExecFn): IssueFiler {
  return {
    async file(issue: FailureIssue): Promise<IssueFileResult> {
      if (!SAFE_REPO_SLUG.test(issue.repo)) {
        return { ok: false, error: `unsafe repo slug: ${issue.repo}` };
      }
      try {
        // 1. Dedup — is there already an open issue carrying this fingerprint?
        const found = await exec('gh', [
          'issue',
          'list',
          '--repo',
          issue.repo,
          '--state',
          'open',
          '--search',
          `${issue.fingerprint} in:body`,
          '--json',
          'number,url',
          '--limit',
          '10',
        ]);
        if (found.ok) {
          let rows: Array<{ number?: number; url?: string }> = [];
          try {
            const parsed: unknown = JSON.parse(found.stdout);
            if (Array.isArray(parsed)) rows = parsed as typeof rows;
          } catch {
            rows = [];
          }
          const existing = rows.find((r) => typeof r.number === 'number');
          if (existing && typeof existing.number === 'number') {
            // Recurrence → comment rather than open a duplicate.
            const commented = await exec('gh', [
              'issue',
              'comment',
              String(existing.number),
              '--repo',
              issue.repo,
              '--body',
              `This failure recurred: ${oneLine(issue.title)}`,
            ]);
            return {
              ok: commented.ok,
              url: existing.url,
              deduped: true,
              error: commented.ok ? undefined : 'gh issue comment failed',
            };
          }
        }
        // 2. No open issue for this fingerprint → create one (marker embedded).
        const created = await exec('gh', [
          'issue',
          'create',
          '--repo',
          issue.repo,
          '--title',
          oneLine(issue.title),
          '--body',
          `${issue.body}\n\n${fingerprintMarker(issue.fingerprint)}\n`,
        ]);
        if (!created.ok) return { ok: false, error: 'gh issue create failed' };
        return { ok: true, url: created.stdout.trim() || undefined };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
