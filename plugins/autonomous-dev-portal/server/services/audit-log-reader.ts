// SPEC-015-4-02 §AuditLogReader — paginated, filterable, integrity-aware
// access to the HMAC-chained NDJSON audit log produced by AuditLogger
// (PLAN-014-3 §audit-logger.ts).
//
// Streaming line-read is mandatory: production logs may be 50+ MB. We
// use `readline.createInterface(fs.createReadStream(...))` so memory
// stays bounded. Each malformed line is skipped with a single warn.
//
// On-disk → public type mapping:
//   - on-disk `user` → `AuditEntry.operatorId`
//   - on-disk `previous_hmac === ""` → `AuditEntry.previous_hmac === null`
// All other fields pass through as-is.

import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";

import { computeEntryHmac } from "../security/hmac-chain";
import type {
    AuditEntry,
    AuditFilters,
    AuditPageResult,
    IntegrityDetail,
    IntegrityStatus,
} from "../types/audit-types";

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 200;

/** Verifier abstraction — keeps the reader testable without a key file. */
export interface AuditChainVerifier {
    /** Returns null when the verification key is unavailable. */
    getKey(): Buffer | null;
}

/** Trivial in-process verifier — wraps a single static key. */
export class StaticAuditChainVerifier implements AuditChainVerifier {
    constructor(private readonly key: Buffer | null) {}
    getKey(): Buffer | null {
        return this.key;
    }
}

interface RawEntry {
    timestamp?: unknown;
    sequence?: unknown;
    action?: unknown;
    user?: unknown;
    operatorId?: unknown;
    resource?: unknown;
    details?: unknown;
    previous_hmac?: unknown;
    key_id?: unknown;
    entry_hmac?: unknown;
}

interface ParsedLine {
    /** Public-facing entry. */
    entry: AuditEntry;
    /** Original on-disk previous_hmac (empty string for sequence=1). */
    diskPreviousHmac: string;
    /** Original on-disk key_id, used by the verifier. */
    keyId: string;
    /** On-disk resource — needed to recompute the canonical HMAC. */
    resource: string;
}

/**
 * Streams the audit log, applies filters, paginates, and reports a
 * per-page integrity status. Constructed once per request — there is no
 * shared in-memory state between calls.
 */
export class AuditLogReader {
    constructor(
        private readonly auditLogPath: string,
        private readonly verifier: AuditChainVerifier,
    ) {}

    async getPage(
        page: number = 1,
        pageSize: number = DEFAULT_PAGE_SIZE,
        filters: AuditFilters = {},
    ): Promise<AuditPageResult> {
        const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
        const safeSize = clamp(
            Number.isFinite(pageSize) ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE,
            MIN_PAGE_SIZE,
            MAX_PAGE_SIZE,
        );

        let parsed: ParsedLine[];
        try {
            await fs.access(this.auditLogPath);
            parsed = await this.readAll();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
                JSON.stringify({
                    event: "audit_log_unreadable",
                    path: this.auditLogPath,
                    error: (err as Error).message,
                }),
            );
            return {
                entries: [],
                totalCount: 0,
                hasNext: false,
                hasPrevious: false,
                currentPage: safePage,
                pageSize: safeSize,
                integrityStatus: "error",
            };
        }

        // Filter on the public-facing entry shape.
        const filtered = parsed.filter((p) => matchesFilters(p.entry, filters));
        // Newest-first display order.
        filtered.sort((a, b) => b.entry.sequence - a.entry.sequence);

        const totalCount = filtered.length;
        const startIndex = (safePage - 1) * safeSize;
        const endIndex = startIndex + safeSize;
        const slice = filtered.slice(startIndex, endIndex);

        const integrity = this.checkPageIntegrity(slice);

        return {
            entries: slice.map((p) => p.entry),
            totalCount,
            hasNext: endIndex < totalCount,
            hasPrevious: safePage > 1,
            currentPage: safePage,
            pageSize: safeSize,
            integrityStatus: integrity.status,
            integrityDetail: integrity.detail,
        };
    }

    /**
     * Walks the file and returns every parseable line in original
     * (ascending sequence) order. Malformed lines emit a single warn and
     * are dropped.
     */
    private async readAll(): Promise<ParsedLine[]> {
        const stream = createReadStream(this.auditLogPath, { encoding: "utf8" });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const out: ParsedLine[] = [];
        let lineNo = 0;
        for await (const line of rl) {
            lineNo += 1;
            if (line.length === 0) continue;
            const parsed = parseLine(line, lineNo);
            if (parsed !== null) out.push(parsed);
        }
        return out;
    }

    /**
     * Verify the chain integrity of a (newest-first) page slice. The
     * verification walk runs in ASCENDING order so the prior-entry
     * lookup matches the on-disk write order.
     */
    private checkPageIntegrity(slice: ParsedLine[]): {
        status: IntegrityStatus;
        detail?: IntegrityDetail;
    } {
        if (slice.length === 0) {
            return { status: "verified" };
        }
        const key = this.verifier.getKey();
        if (key === null) {
            return { status: "unknown" };
        }
        const ascending = [...slice].sort(
            (a, b) => a.entry.sequence - b.entry.sequence,
        );
        // Detect non-contiguous slices (filters that punched holes).
        const first = ascending[0];
        const last = ascending[ascending.length - 1];
        if (first === undefined || last === undefined) {
            return { status: "verified" };
        }
        const expectedRange = last.entry.sequence - first.entry.sequence + 1;
        if (expectedRange !== ascending.length) {
            return { status: "unknown" };
        }

        let sequenceGaps = 0;
        let hmacFailures = 0;
        let firstFailingSequence: number | undefined;

        for (let i = 0; i < ascending.length; i += 1) {
            const cur = ascending[i];
            if (cur === undefined) continue;
            if (i > 0) {
                const prev = ascending[i - 1];
                if (prev === undefined) continue;
                if (cur.entry.sequence !== prev.entry.sequence + 1) {
                    sequenceGaps += 1;
                }
                if (cur.diskPreviousHmac !== prev.entry.entry_hmac) {
                    hmacFailures += 1;
                    if (firstFailingSequence === undefined) {
                        firstFailingSequence = cur.entry.sequence;
                    }
                }
            }
            const expected = computeEntryHmac(key, cur.diskPreviousHmac, {
                timestamp: cur.entry.timestamp,
                sequence: cur.entry.sequence,
                action: cur.entry.action,
                user: cur.entry.operatorId,
                resource: cur.resource,
                details: cur.entry.details,
                previous_hmac: cur.diskPreviousHmac,
                key_id: cur.keyId,
            });
            if (expected !== cur.entry.entry_hmac) {
                hmacFailures += 1;
                if (firstFailingSequence === undefined) {
                    firstFailingSequence = cur.entry.sequence;
                }
            }
        }

        if (hmacFailures > 0) {
            return {
                status: "error",
                detail: { sequenceGaps, hmacFailures, firstFailingSequence },
            };
        }
        if (sequenceGaps > 0) {
            return {
                status: "warning",
                detail: { sequenceGaps, hmacFailures: 0 },
            };
        }
        return { status: "verified" };
    }
}

// ---- helpers ---------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

function matchesFilters(entry: AuditEntry, filters: AuditFilters): boolean {
    if (filters.operatorId !== undefined && entry.operatorId !== filters.operatorId) {
        return false;
    }
    if (filters.action !== undefined) {
        const needle = filters.action.toLowerCase();
        if (!entry.action.toLowerCase().includes(needle)) return false;
    }
    if (filters.startDate !== undefined || filters.endDate !== undefined) {
        const ts = Date.parse(entry.timestamp);
        if (!Number.isFinite(ts)) return false;
        if (filters.startDate !== undefined && ts < filters.startDate.getTime()) {
            return false;
        }
        if (filters.endDate !== undefined && ts > filters.endDate.getTime()) {
            return false;
        }
    }
    return true;
}

function parseLine(line: string, lineNo: number): ParsedLine | null {
    let raw: RawEntry;
    try {
        raw = JSON.parse(line) as RawEntry;
    } catch {
        // eslint-disable-next-line no-console
        console.warn(
            JSON.stringify({
                event: "audit_log_malformed_line",
                line_no: lineNo,
            }),
        );
        return null;
    }
    const sequence = numberField(raw.sequence);
    const timestamp = stringField(raw.timestamp);
    const action = stringField(raw.action);
    const operatorId = stringField(raw.operatorId) ?? stringField(raw.user);
    const entryHmac = stringField(raw.entry_hmac);
    const diskPreviousHmac = stringField(raw.previous_hmac) ?? "";
    const keyId = stringField(raw.key_id) ?? "";
    const resource = stringField(raw.resource) ?? "";
    if (
        sequence === null ||
        timestamp === null ||
        action === null ||
        operatorId === null ||
        entryHmac === null
    ) {
        // eslint-disable-next-line no-console
        console.warn(
            JSON.stringify({
                event: "audit_log_missing_fields",
                line_no: lineNo,
                sequence,
            }),
        );
        return null;
    }
    const details =
        raw.details !== null && typeof raw.details === "object" && !Array.isArray(raw.details)
            ? (raw.details as Record<string, unknown>)
            : {};
    return {
        entry: {
            sequence,
            timestamp,
            operatorId,
            action,
            details,
            previous_hmac: diskPreviousHmac.length > 0 ? diskPreviousHmac : null,
            entry_hmac: entryHmac,
        },
        diskPreviousHmac,
        keyId,
        resource,
    };
}

function stringField(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function numberField(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
