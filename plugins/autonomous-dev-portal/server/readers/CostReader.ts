// SPEC-015-1-04 — CostReader: read + aggregate cost-ledger.json.
//
// Pure reader. PLAN-015-3 owns trend analysis / forecasting / budget
// alerts; this module shapes the data for dashboards only. Missing
// files surface as an empty-but-valid ledger so UI consumers do not
// need null-check branches.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AggregationCache } from "../cache/AggregationCache";
import { parseCostLedger } from "./schemas/cost";
import type { CostEntry, CostLedger, Result } from "./types";

const LEDGER_TTL_MS = 5_000;
const SUMMARY_TTL_MS = 5_000;
const RECENT_TTL_MS = 5_000;
const DEFAULT_RECENT_LIMIT = 50;
const TOP_REQUEST_LIMIT = 10;

export interface CostSummary {
    total_usd: number;
    daily_usd: Record<string, number>;
    /** Last 50 entries by ts desc. */
    recent_entries: CostEntry[];
    /** Top 10 requests by cost desc. */
    per_request_top: Array<{ request_id: string; cost_usd: number }>;
}

export interface CostReaderDeps {
    /** Repo root. The daemon writes <basePath>/.autonomous-dev/cost-ledger.json. */
    basePath: string;
    cache: AggregationCache;
    logger?: { warn?: (msg: string, ...args: unknown[]) => void };
    /** Inject a clock for tests. Defaults to Date.now. */
    now?: () => number;
}

export class CostReader {
    private readonly deps: CostReaderDeps;
    private readonly now: () => number;

    constructor(deps: CostReaderDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
    }

    private ledgerPath(): string {
        return join(this.deps.basePath, ".autonomous-dev", "cost-ledger.json");
    }

    /** Returns the full ledger, validated. Missing file → empty ok ledger. */
    async readLedger(): Promise<Result<CostLedger>> {
        const cacheKey = "cost:ledger";
        const cached = await this.deps.cache.get<CostLedger>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const path = this.ledgerPath();
        let raw: string;
        try {
            raw = await fs.readFile(path, "utf8");
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") {
                // Empty-but-valid ledger; do NOT cache so a freshly-written
                // ledger is picked up on the next call without waiting for TTL.
                return {
                    ok: true,
                    value: {
                        version: 1,
                        total_usd: 0,
                        daily_usd: {},
                        per_request: {},
                        entries: [],
                        last_updated: new Date(this.now()).toISOString(),
                    },
                };
            }
            return {
                ok: false,
                error: new Error(`failed to read ${path}: ${(err as Error).message}`),
            };
        }

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(raw);
        } catch (err) {
            // Malformed file MUST NOT cache.
            return {
                ok: false,
                error: new Error(
                    `malformed JSON in ${path}: ${(err as Error).message}`,
                ),
            };
        }

        const result = parseCostLedger(parsedJson);
        if (!result.ok || !result.value) {
            return {
                ok: false,
                error: new Error(
                    `schema violation in ${path}: ${result.error ?? "unknown"}`,
                ),
            };
        }

        await this.deps.cache.set(cacheKey, result.value, LEDGER_TTL_MS);
        return { ok: true, value: result.value };
    }

    /** Cached summary view for dashboards. */
    async getSummary(): Promise<Result<CostSummary>> {
        const cacheKey = "cost:summary";
        const cached = await this.deps.cache.get<CostSummary>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const ledger = await this.readLedger();
        if (!ledger.ok) return ledger;

        const recent_entries = [...ledger.value.entries]
            .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
            .slice(0, DEFAULT_RECENT_LIMIT);

        const per_request_top = Object.entries(ledger.value.per_request)
            .map(([request_id, cost_usd]) => ({ request_id, cost_usd }))
            .sort((a, b) => b.cost_usd - a.cost_usd)
            .slice(0, TOP_REQUEST_LIMIT);

        const summary: CostSummary = {
            total_usd: ledger.value.total_usd,
            daily_usd: { ...ledger.value.daily_usd },
            recent_entries,
            per_request_top,
        };

        await this.deps.cache.set(cacheKey, summary, SUMMARY_TTL_MS);
        return { ok: true, value: summary };
    }

    /** Pre-computed last-N entries by ts desc. Convenience accessor. */
    async getRecentEntries(limit?: number): Promise<Result<CostEntry[]>> {
        const cap = Math.max(1, Math.floor(limit ?? DEFAULT_RECENT_LIMIT));
        const cacheKey = `cost:recent:${String(cap)}`;
        const cached = await this.deps.cache.get<CostEntry[]>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const ledger = await this.readLedger();
        if (!ledger.ok) return ledger;

        const value = [...ledger.value.entries]
            .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
            .slice(0, cap);

        await this.deps.cache.set(cacheKey, value, RECENT_TTL_MS);
        return { ok: true, value };
    }
}
