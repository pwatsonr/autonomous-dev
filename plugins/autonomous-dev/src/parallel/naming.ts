/**
 * Name validation, slugification, and branch/path construction utilities
 * for the parallel execution engine.
 *
 * Enforces the `auto/` branch naming convention and rejects names that
 * collide with reserved filesystem names on Windows/macOS.
 */

import * as path from 'path';

/**
 * Valid name pattern: lowercase alphanumeric, hyphens allowed in the middle,
 * minimum 2 chars, maximum 64 chars.
 */
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * Reserved filesystem names on Windows/macOS.
 * These are rejected regardless of case.
 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  '.', '..',
]);

/**
 * Returns true if the name is a valid track/request identifier.
 *
 * Requirements:
 *   - Matches NAME_REGEX (lowercase alnum, hyphens in middle, 2-64 chars)
 *   - Not a reserved filesystem name
 */
export function isValidName(name: string): boolean {
  if (!NAME_REGEX.test(name)) return false;
  if (RESERVED_NAMES.has(name.toLowerCase())) return false;
  return true;
}

/**
 * Convert an arbitrary spec name (e.g. "Add User Authentication Flow")
 * to a valid track name ("add-user-authentication-flow").
 *
 * Steps:
 *   1. Lowercase
 *   2. Replace non-alphanumeric characters with '-'
 *   3. Collapse runs of '-'
 *   4. Trim leading/trailing '-'
 *   5. Truncate to 64 chars
 *   6. Ensure still matches NAME_REGEX (trim trailing '-' after truncate)
 *
 * @throws Error if input cannot be slugified to a valid name
 */
export function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')   // replace non-alnum with '-'
    .replace(/-+/g, '-')           // collapse runs of '-'
    .replace(/^-+/, '')            // trim leading '-'
    .replace(/-+$/, '');           // trim trailing '-'

  // Truncate to 64 chars
  if (slug.length > 64) {
    slug = slug.slice(0, 64);
  }

  // After truncation, trim any trailing '-' that may have appeared
  slug = slug.replace(/-+$/, '');

  // If the slug is a single character after processing, pad it to meet
  // the 2-char minimum by appending '0'
  if (slug.length === 1) {
    slug = slug + '0';
  }

  // Handle reserved names by appending '-0'
  if (RESERVED_NAMES.has(slug)) {
    slug = slug + '-0';
  }

  if (!isValidName(slug)) {
    throw new Error(`Cannot slugify "${input}" to a valid name (result: "${slug}")`);
  }

  return slug;
}

/**
 * Returns the integration branch name for a request.
 * Format: "auto/{requestId}/integration"
 *
 * @throws Error if requestId is not a valid name
 */
export function integrationBranchName(requestId: string): string {
  if (!isValidName(requestId)) {
    throw new Error(`Invalid requestId: "${requestId}"`);
  }
  return `auto/${requestId}/integration`;
}

/**
 * Returns the track branch name for a request and track.
 * Format: "auto/{requestId}/{trackName}"
 *
 * @throws Error if requestId or trackName is not a valid name
 */
export function trackBranchName(requestId: string, trackName: string): string {
  if (!isValidName(requestId)) {
    throw new Error(`Invalid requestId: "${requestId}"`);
  }
  if (!isValidName(trackName)) {
    throw new Error(`Invalid trackName: "${trackName}"`);
  }
  return `auto/${requestId}/${trackName}`;
}

/**
 * Returns the worktree filesystem path for a request and track.
 * Format: "{worktreeRoot}/{requestId}/{trackName}"
 *
 * @param worktreeRoot Root directory for worktrees (absolute or relative)
 * @param requestId The request identifier
 * @param trackName The track identifier
 * @returns The joined path
 */
export function worktreePath(worktreeRoot: string, requestId: string, trackName: string): string {
  return path.join(worktreeRoot, requestId, trackName);
}
