// SPEC-015-4-02 §Types — public types for the audit page reader.
//
// AuditEntry is the on-disk shape (NDJSON, one entry per line). It is
// the same shape produced by AuditLogger (PLAN-014-3 §audit-logger.ts)
// projected into the operator-facing field names; the live HMAC-chain
// implementation uses `previous_hmac` / `entry_hmac` already.

export interface AuditEntry {
    sequence: number;
    /** ISO-8601 UTC, ms precision. */
    timestamp: string;
    operatorId: string;
    /** e.g. "kill-switch.engage". */
    action: string;
    details: Record<string, unknown>;
    /** null only for sequence === 1 (matches the on-disk "" sentinel). */
    previous_hmac: string | null;
    entry_hmac: string;
}

/** Per-page integrity status returned alongside the page slice. */
export type IntegrityStatus = "verified" | "warning" | "error" | "unknown";

export interface AuditFilters {
    /** Exact match on `entry.operatorId`. */
    operatorId?: string;
    /** Case-insensitive substring match on `entry.action`. */
    action?: string;
    /** Inclusive lower bound on `entry.timestamp`. */
    startDate?: Date;
    /** Inclusive upper bound on `entry.timestamp`. */
    endDate?: Date;
}

export interface IntegrityDetail {
    sequenceGaps: number;
    hmacFailures: number;
    /** First sequence whose HMAC failed validation, when known. */
    firstFailingSequence?: number;
}

export interface AuditPageResult {
    /** Page slice, sorted DESCENDING by sequence (newest first). */
    entries: AuditEntry[];
    totalCount: number;
    hasNext: boolean;
    hasPrevious: boolean;
    currentPage: number;
    pageSize: number;
    integrityStatus: IntegrityStatus;
    integrityDetail?: IntegrityDetail;
}
