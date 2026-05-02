/**
 * Frontend-change detection helper for the specialist reviewer suite
 * (SPEC-020-1-02, Task 6).
 *
 * Provides a shared, per-request cache so the UX/UI and accessibility
 * reviewers do not each re-scan the diff. The PLAN-020-2 scheduler
 * dispatches both reviewers optimistically and lets them short-circuit
 * to APPROVE on backend-only diffs; this module is what makes that
 * cheap (single scan per request_id, all subsequent reads cache-hit).
 *
 * Path-mapping note: SPEC-020-1-02 documents this module at
 * `src/reviewers/frontend-detection.ts`. The autonomous-dev plugin uses
 * `intake/reviewers/...` as the canonical home for runtime helpers
 * sibling to `intake/reviewers/aggregate.ts` (PLAN-019-4).
 *
 * @module intake/reviewers/frontend-detection
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Result of a single frontend-change detection call.
 *
 * - `isFrontendChange` is `true` iff at least one changed file matches a
 *   frontend path pattern (components/views/pages directory or
 *   .tsx/.jsx/.vue/.svelte extension).
 * - `detectedFiles` is the subset of `changedFiles` that matched.
 * - `framework` is resolved from the repo's `package.json` dependencies
 *   only when at least one file matched; otherwise `undefined`.
 * - `hasViewportMeta` is `true` iff any detected file's contents include
 *   a `<meta name="viewport"` tag (case-insensitive). Heuristic for
 *   "is this a real web app vs. a component library snippet".
 */
export interface FrontendDetection {
  isFrontendChange: boolean;
  detectedFiles: string[];
  framework?: 'react' | 'vue' | 'svelte' | 'angular' | 'vanilla';
  hasViewportMeta: boolean;
}

/** Path patterns that mark a file as a frontend artifact. */
const FRONTEND_PATH_PATTERNS: readonly RegExp[] = [
  /\/components\//,
  /\/views\//,
  /\/pages\//,
  /\.(tsx|jsx|vue|svelte)$/,
];

/**
 * Framework precedence list. Order matters: more specific frameworks
 * (react before next, vue before nuxt) are listed first because Next.js
 * and Nuxt projects also list the underlying framework in their deps.
 * The first match wins.
 */
const FRAMEWORK_DEPS: ReadonlyArray<
  [Exclude<FrontendDetection['framework'], undefined | 'vanilla'>, readonly string[]]
> = [
  ['react', ['react', 'react-dom', 'next']],
  ['vue', ['vue', 'nuxt']],
  ['svelte', ['svelte', '@sveltejs/kit']],
  ['angular', ['@angular/core']],
];

/**
 * Per-request cache. Keys are request_ids supplied by the scheduler.
 * Process-local; PLAN-020-2's scheduler is responsible for calling
 * `clearCache(requestId)` on request completion.
 */
const cache = new Map<string, FrontendDetection>();

/**
 * Detect whether a change set touches frontend code and, if so, which
 * framework the project uses.
 *
 * Idempotent per `requestId`: the second call with the same id returns
 * the same object reference (cache hit), regardless of `changedFiles`.
 * The scheduler must call `clearCache(requestId)` when the request ends.
 *
 * @param requestId  Stable id for this review request (cache key).
 * @param repoPath   Absolute path to the repo root (where `package.json`
 *                   lives). Missing `package.json` resolves to `'vanilla'`.
 * @param changedFiles Repo-relative paths of files in the diff.
 */
export function detectFrontendChanges(
  requestId: string,
  repoPath: string,
  changedFiles: string[],
): FrontendDetection {
  const cached = cache.get(requestId);
  if (cached !== undefined) return cached;

  const detected = changedFiles.filter((f) =>
    FRONTEND_PATH_PATTERNS.some((re) => re.test(f)),
  );

  const isFrontend = detected.length > 0;
  const framework = isFrontend ? detectFramework(repoPath) : undefined;
  const hasViewportMeta = isFrontend
    ? scanForViewportMeta(repoPath, detected)
    : false;

  const result: FrontendDetection = {
    isFrontendChange: isFrontend,
    detectedFiles: detected,
    framework,
    hasViewportMeta,
  };
  cache.set(requestId, result);
  return result;
}

/**
 * Evict cache entries.
 *
 * - With a `requestId`: evict only that entry. Safe to call for an
 *   unknown id (no-op).
 * - Without arguments: evict every entry. Used by tests and by the
 *   scheduler on shutdown.
 */
export function clearCache(requestId?: string): void {
  if (requestId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(requestId);
}

/**
 * Internal handle on the cache map for unit tests only. Production code
 * MUST NOT import this — use `clearCache` and `detectFrontendChanges`.
 *
 * @internal
 */
export const __cacheForTests: Map<string, FrontendDetection> = cache;

/**
 * Resolve the project framework by inspecting `<repoPath>/package.json`.
 * Returns the first match in `FRAMEWORK_DEPS` order, or `'vanilla'` if
 * the package.json is missing, unparseable, or lists no known framework.
 */
function detectFramework(repoPath: string): FrontendDetection['framework'] {
  const pkgPath = join(repoPath, 'package.json');
  if (!existsSync(pkgPath)) return 'vanilla';
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return 'vanilla';
  }
  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  for (const [framework, candidates] of FRAMEWORK_DEPS) {
    if (candidates.some((dep) => Object.prototype.hasOwnProperty.call(deps, dep))) {
      return framework;
    }
  }
  return 'vanilla';
}

/**
 * Scan the detected files for a `<meta name="viewport">` tag.
 *
 * Best-effort: missing files are silently skipped (they may have been
 * deleted in this diff). Non-text files (>1 MB) are skipped to bound
 * worst-case I/O.
 */
function scanForViewportMeta(repoPath: string, files: string[]): boolean {
  const needle = /<meta\s+name=["']viewport["']/i;
  for (const file of files) {
    const abs = resolve(repoPath, file);
    if (!existsSync(abs)) continue;
    try {
      const stat = statSync(abs);
      if (stat.size > 1_048_576) continue;
      const text = readFileSync(abs, 'utf8');
      if (needle.test(text)) return true;
    } catch {
      // Unreadable file: ignore and continue.
    }
  }
  return false;
}
