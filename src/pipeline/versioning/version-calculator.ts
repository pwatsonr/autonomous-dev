import { VersionReason } from '../types/frontmatter';

/**
 * Parses a version string "MAJOR.MINOR" into components.
 */
export function parseVersion(version: string): { major: number; minor: number } {
  const match = version.match(/^(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid version string: ${version}`);
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

/**
 * Formats major.minor into a version string.
 */
export function formatVersion(major: number, minor: number): string {
  return `${major}.${minor}`;
}

/**
 * Determines the next version number given the current version and reason.
 *
 * Rules (TDD Section 3.5.1):
 *   INITIAL:            Always "1.0" (ignores currentVersion)
 *   REVIEW_REVISION:    Minor increment (1.0 -> 1.1 -> 1.2)
 *   BACKWARD_CASCADE:   Major increment (1.3 -> 2.0)
 *   ROLLBACK:           Minor increment from CURRENT version (not target)
 *                        e.g. current=1.2, rollback to 1.0 -> new version is 1.3
 *
 * Important: minor increments do NOT wrap. 9.9 -> 9.10, NOT 10.0.
 * Major increments reset minor to 0. 1.3 -> 2.0.
 * Version numbers are never reused.
 *
 * @param currentVersion The current (latest) version string, e.g. "1.2"
 * @param reason Why the new version is being created
 * @returns The next version string
 */
export function calculateNextVersion(
  currentVersion: string | null,
  reason: VersionReason,
): string {
  if (reason === 'INITIAL') {
    return '1.0';
  }

  if (currentVersion === null) {
    throw new Error('currentVersion is required for non-INITIAL versions');
  }

  const { major, minor } = parseVersion(currentVersion);

  switch (reason) {
    case 'REVIEW_REVISION':
    case 'ROLLBACK':
      return formatVersion(major, minor + 1);
    case 'BACKWARD_CASCADE':
      return formatVersion(major + 1, 0);
    default:
      throw new Error(`Unknown version reason: ${reason}`);
  }
}
