/**
 * Run ID generation and audit log initialization (SPEC-007-1-4, Task 9).
 *
 * Run IDs follow the format RUN-YYYYMMDD-HHMMSS, providing a unique,
 * human-readable identifier for each observation run.
 */

/**
 * Generates a run ID in the format RUN-YYYYMMDD-HHMMSS.
 *
 * @param now Optional Date for testability (defaults to current time)
 * @returns A run ID string, e.g. "RUN-20260408-143000"
 */
export function generateRunId(now: Date = new Date()): string {
  const year = now.getUTCFullYear().toString();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');

  return `RUN-${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Parses a run ID back into its constituent date components.
 *
 * @param runId A run ID in RUN-YYYYMMDD-HHMMSS format
 * @returns The Date represented by the run ID, or null if the format is invalid
 */
export function parseRunId(runId: string): Date | null {
  const match = runId.match(
    /^RUN-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/,
  );
  if (!match) return null;

  const [, year, month, day, hours, minutes, seconds] = match;
  return new Date(
    Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hours, 10),
      parseInt(minutes, 10),
      parseInt(seconds, 10),
    ),
  );
}

/**
 * Validates that a string matches the RUN-YYYYMMDD-HHMMSS format.
 *
 * @param runId The string to validate
 * @returns true if the string is a valid run ID
 */
export function isValidRunId(runId: string): boolean {
  return /^RUN-\d{8}-\d{6}$/.test(runId) && parseRunId(runId) !== null;
}
