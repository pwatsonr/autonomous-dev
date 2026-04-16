/**
 * Log Archival (SPEC-009-5-3, Task 6).
 *
 * Migrates audit events older than the retention period from the active
 * JSONL log to cold-storage archive files. Preserves hash chain continuity
 * via a metadata sidecar that records the chain head hash at archival time.
 *
 * Safety guarantees:
 *   1. Archive file is written and fsynced BEFORE active log is rewritten.
 *      A crash between these steps leaves the archive present and the
 *      active log unchanged (events duplicated, never lost).
 *   2. Active log rewrite is atomic (write to temp, rename).
 *   3. Metadata sidecar records chain head hash for cross-archive
 *      verification.
 *   4. Original events are NOT deleted until the archive is confirmed
 *      written and fsynced.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import type { AuditEvent } from "./types";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ArchiveResult {
  archivedEventCount: number;
  activeEventCount: number;
  archiveFilePath: string;
  chainHeadHashAtArchival: string;
}

export interface ArchiveInfo {
  filePath: string;
  dateRange: { from: string; to: string };
  eventCount: number;
  chainHeadHash: string;
}

// ---------------------------------------------------------------------------
// LogArchival
// ---------------------------------------------------------------------------

/**
 * Archive engine that moves old audit events from the active log to
 * date-ranged archive files in a designated archive directory.
 */
export class LogArchival {
  private readonly activeRetentionDays: number;

  constructor(
    private readonly logPath: string,
    private readonly archivePath: string,
    activeRetentionDays: number = 90,
  ) {
    this.activeRetentionDays = activeRetentionDays;
  }

  /**
   * Archive events older than the retention period.
   *
   * Algorithm (from spec):
   *   1. Read all events from active log.
   *   2. Partition into toArchive (older than cutoff) and toKeep.
   *   3. If nothing to archive, return early.
   *   4. Write archive atomically (temp + fsync + rename).
   *   5. Write metadata sidecar with chain head hash.
   *   6. Rewrite active log atomically (temp + fsync + rename).
   *   7. Verify active log event count.
   *
   * @returns  Summary of the archival operation.
   */
  async archive(): Promise<ArchiveResult> {
    // Ensure archive directory exists
    if (!fs.existsSync(this.archivePath)) {
      fs.mkdirSync(this.archivePath, { recursive: true });
    }

    // Read all events from the active log
    const allEvents = this.readJsonLines(this.logPath);

    // Compute cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.activeRetentionDays);
    const cutoffIso = cutoffDate.toISOString();

    // Partition events
    const toArchive: AuditEvent[] = [];
    const toKeep: AuditEvent[] = [];

    for (const event of allEvents) {
      if (event.timestamp < cutoffIso) {
        toArchive.push(event);
      } else {
        toKeep.push(event);
      }
    }

    // Nothing to archive
    if (toArchive.length === 0) {
      return {
        archivedEventCount: 0,
        activeEventCount: allEvents.length,
        archiveFilePath: "",
        chainHeadHashAtArchival: "",
      };
    }

    // Determine archive file name from date range
    const dateFrom = toArchive[0].timestamp.slice(0, 10); // YYYY-MM-DD
    const dateTo = toArchive[toArchive.length - 1].timestamp.slice(0, 10);
    const archiveFile = path.join(
      this.archivePath,
      `events-${dateFrom}-to-${dateTo}.jsonl`,
    );

    // Step 1: Write archive atomically
    const archiveTmpFile = archiveFile + ".tmp." + randomSuffix();
    this.writeJsonLines(archiveTmpFile, toArchive);
    fsyncFile(archiveTmpFile);

    // Step 2: Determine chain head hash at point of archival
    // The chain head hash is the hash of the last archived event
    const chainHeadHash =
      toArchive[toArchive.length - 1].hash || computeFallbackHash(toArchive);

    // Step 3: Write metadata sidecar
    const metaFile = archiveFile + ".meta.json";
    const metadata = {
      dateRange: { from: dateFrom, to: dateTo },
      eventCount: toArchive.length,
      chainHeadHash,
    };
    fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2) + "\n", "utf-8");

    // Step 4: Rename temp archive to final path (atomic)
    fs.renameSync(archiveTmpFile, archiveFile);

    // Step 5: Rewrite active log with remaining events (atomic)
    const activeTmpFile = this.logPath + ".tmp." + randomSuffix();
    this.writeJsonLines(activeTmpFile, toKeep);
    fsyncFile(activeTmpFile);

    // Step 6: Atomic replace of active log
    fs.renameSync(activeTmpFile, this.logPath);

    // Step 7: Verify active log has correct event count
    const verifyEvents = this.readJsonLines(this.logPath);
    if (verifyEvents.length !== toKeep.length) {
      // Log warning but do not throw -- the archive is safe
      process.stderr.write(
        `[ARCHIVAL_WARNING] Active log verification mismatch: expected ${toKeep.length}, got ${verifyEvents.length}\n`,
      );
    }

    return {
      archivedEventCount: toArchive.length,
      activeEventCount: toKeep.length,
      archiveFilePath: archiveFile,
      chainHeadHashAtArchival: chainHeadHash,
    };
  }

  /**
   * List all available archive files with their metadata.
   *
   * Scans the archive directory for `.jsonl` files and reads their
   * corresponding `.meta.json` sidecars.
   *
   * @returns  Array of archive info sorted by date range (ascending).
   */
  listArchives(): ArchiveInfo[] {
    if (!fs.existsSync(this.archivePath)) {
      return [];
    }

    const entries = fs.readdirSync(this.archivePath);
    const archives: ArchiveInfo[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(this.archivePath, entry);
      const metaPath = filePath + ".meta.json";

      if (fs.existsSync(metaPath)) {
        // Read metadata from sidecar
        try {
          const metaRaw = fs.readFileSync(metaPath, "utf-8");
          const meta = JSON.parse(metaRaw) as {
            dateRange: { from: string; to: string };
            eventCount: number;
            chainHeadHash: string;
          };
          archives.push({
            filePath,
            dateRange: meta.dateRange,
            eventCount: meta.eventCount,
            chainHeadHash: meta.chainHeadHash,
          });
        } catch {
          // Skip archives with unreadable metadata
          continue;
        }
      } else {
        // No sidecar -- reconstruct metadata from file contents
        try {
          const events = this.readJsonLines(filePath);
          if (events.length > 0) {
            archives.push({
              filePath,
              dateRange: {
                from: events[0].timestamp.slice(0, 10),
                to: events[events.length - 1].timestamp.slice(0, 10),
              },
              eventCount: events.length,
              chainHeadHash: events[events.length - 1].hash || "",
            });
          }
        } catch {
          continue;
        }
      }
    }

    // Sort by date range ascending
    archives.sort((a, b) => a.dateRange.from.localeCompare(b.dateRange.from));

    return archives;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Read a JSONL file and return parsed events.
   * Skips blank lines and malformed JSON.
   */
  private readJsonLines(filePath: string): AuditEvent[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const events: AuditEvent[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as AuditEvent);
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return events;
  }

  /**
   * Write an array of events to a JSONL file.
   */
  private writeJsonLines(filePath: string, events: AuditEvent[]): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * fsync a file by path: open, fsync, close.
 */
function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Generate a short random suffix for temp file names.
 */
function randomSuffix(): string {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Compute a fallback hash for the chain head when events have empty
 * hash fields (Phase 1/2 mode where hash chain is disabled).
 * Uses SHA-256 of the last event's canonical JSON.
 */
function computeFallbackHash(events: AuditEvent[]): string {
  if (events.length === 0) {
    return "";
  }
  const lastEvent = events[events.length - 1];
  const canonical = JSON.stringify(lastEvent);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
