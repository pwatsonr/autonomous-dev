// SPEC-015-3-01 — CostAggregator: NDJSON ledger ingestion + rollups.
//
// Eager loadLedger() reads the full file; loadLedgerStream() is offered
// for ledgers >10MB. All malformed lines are dropped with a debug log;
// invalid entry shapes are dropped with a warn. Missing files surface
// as an empty array (UI renders an empty state, never an error).

import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
    CANONICAL_PHASES,
    type AggregatorLogger,
    type CostLedgerEntry,
    type CostPhase,
    type DailySummary,
    type MonthlySummary,
    type PhaseBreakdown,
    type Projection,
    type RepoBreakdown,
    type TopRequest,
} from "./types";
import {
    aggregateByDay,
    aggregateByMonth,
    aggregateByPhase,
    aggregateByRepo,
    sevenDayProjection,
    topNExpensive,
} from "./queries";

const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const PHASE_SET: ReadonlySet<string> = new Set(CANONICAL_PHASES);

function isCostPhase(value: unknown): value is CostPhase {
    return typeof value === "string" && PHASE_SET.has(value);
}

function validateEntry(obj: unknown): CostLedgerEntry | null {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.timestamp !== "string") return null;
    if (typeof o.request_id !== "string") return null;
    if (typeof o.repository !== "string") return null;
    if (!isCostPhase(o.phase)) return null;
    if (typeof o.cost_tokens !== "number" || !Number.isFinite(o.cost_tokens)) {
        return null;
    }
    if (typeof o.cost_usd !== "number" || !Number.isFinite(o.cost_usd)) {
        return null;
    }
    if (o.cost_usd < 0) return null;
    if (typeof o.model !== "string") return null;
    if (typeof o.operation !== "string") return null;
    return {
        timestamp: o.timestamp,
        request_id: o.request_id,
        repository: o.repository,
        phase: o.phase,
        cost_tokens: o.cost_tokens,
        cost_usd: o.cost_usd,
        model: o.model,
        operation: o.operation,
    };
}

export class CostAggregator {
    constructor(
        private readonly ledgerPath: string,
        private readonly clock: () => Date = () => new Date(),
        private readonly logger?: AggregatorLogger,
    ) {}

    /**
     * Eager load. Missing file → []. Malformed lines are skipped with
     * debug logs; invalid entries with warn. Returns validated entries.
     */
    async loadLedger(): Promise<CostLedgerEntry[]> {
        let stat;
        try {
            stat = await fs.stat(this.ledgerPath);
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") {
                this.logger?.warn?.(
                    `cost ledger not found at ${this.ledgerPath}; returning []`,
                );
                return [];
            }
            this.logger?.warn?.(
                `failed to stat cost ledger ${this.ledgerPath}: ${(err as Error).message}`,
            );
            return [];
        }
        if (stat.size > LARGE_FILE_BYTES) {
            this.logger?.warn?.(
                `cost ledger >10MB (${String(stat.size)} bytes); consider loadLedgerStream()`,
            );
        }
        let raw: string;
        try {
            raw = await fs.readFile(this.ledgerPath, "utf8");
        } catch (err) {
            this.logger?.warn?.(
                `failed to read cost ledger ${this.ledgerPath}: ${(err as Error).message}`,
            );
            return [];
        }
        const out: CostLedgerEntry[] = [];
        let lineNo = 0;
        let skipParse = 0;
        let skipShape = 0;
        for (const line of raw.split("\n")) {
            lineNo += 1;
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                skipParse += 1;
                this.logger?.debug?.(
                    `cost ledger: malformed JSON at line ${String(lineNo)}`,
                );
                continue;
            }
            const entry = validateEntry(parsed);
            if (!entry) {
                skipShape += 1;
                this.logger?.warn?.(
                    `cost ledger: invalid entry shape at line ${String(lineNo)}`,
                );
                continue;
            }
            out.push(entry);
        }
        if (skipParse > 0 || skipShape > 0) {
            this.logger?.warn?.(
                `cost ledger: skipped ${String(skipParse)} malformed and ${String(skipShape)} invalid entries`,
            );
        }
        return out;
    }

    /** Streaming load for files >10MB. Same skip semantics. */
    async *loadLedgerStream(): AsyncIterable<CostLedgerEntry> {
        let exists = true;
        try {
            await fs.stat(this.ledgerPath);
        } catch {
            exists = false;
        }
        if (!exists) return;
        const rl = createInterface({
            input: createReadStream(this.ledgerPath, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        let lineNo = 0;
        for await (const raw of rl) {
            lineNo += 1;
            const trimmed = raw.trim();
            if (trimmed.length === 0) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                this.logger?.debug?.(
                    `cost ledger: malformed JSON at line ${String(lineNo)}`,
                );
                continue;
            }
            const entry = validateEntry(parsed);
            if (!entry) {
                this.logger?.warn?.(
                    `cost ledger: invalid entry shape at line ${String(lineNo)}`,
                );
                continue;
            }
            yield entry;
        }
    }

    daily(
        entries: ReadonlyArray<CostLedgerEntry>,
        startDate: string,
        endDate: string,
    ): DailySummary[] {
        return aggregateByDay(entries, startDate, endDate);
    }

    monthly(
        entries: ReadonlyArray<CostLedgerEntry>,
        startMonth: string,
        endMonth: string,
    ): MonthlySummary[] {
        return aggregateByMonth(entries, startMonth, endMonth);
    }

    byRepository(entries: ReadonlyArray<CostLedgerEntry>): RepoBreakdown[] {
        return aggregateByRepo(entries);
    }

    byPhase(entries: ReadonlyArray<CostLedgerEntry>): PhaseBreakdown[] {
        return aggregateByPhase(entries);
    }

    topExpensive(
        entries: ReadonlyArray<CostLedgerEntry>,
        limit: number,
    ): TopRequest[] {
        return topNExpensive(entries, limit);
    }

    projectSevenDay(entries: ReadonlyArray<CostLedgerEntry>): Projection {
        return sevenDayProjection(entries, this.clock());
    }
}
