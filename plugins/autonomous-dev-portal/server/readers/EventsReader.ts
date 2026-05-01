// SPEC-015-1-03 — EventsReader: read events.jsonl phase-transition history.
//
// Reads JSONL line-by-line and maintains a sliding window of size
// `limit` so unbounded files are processed in constant memory. Non-
// phase-transition lines are silently skipped (cost / log events live
// in their own readers).

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AggregationCache } from "../cache/AggregationCache";
import { isValidRequestId } from "./schemas/state";
import { parsePhaseEvent } from "./schemas/events";
import type { PhaseEvent, Result } from "./types";

const PHASE_HISTORY_TTL_MS = 5_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export interface EventsReaderDeps {
    basePath: string;
    cache: AggregationCache;
    logger?: { debug?: (msg: string, ...args: unknown[]) => void };
}

export interface ReadPhaseHistoryOptions {
    limit?: number;
}

export class EventsReader {
    private readonly deps: EventsReaderDeps;

    constructor(deps: EventsReaderDeps) {
        this.deps = deps;
    }

    async readPhaseHistory(
        requestId: string,
        opts: ReadPhaseHistoryOptions = {},
    ): Promise<Result<PhaseEvent[]>> {
        if (!isValidRequestId(requestId)) {
            return {
                ok: false,
                error: new Error(
                    `invalid request_id format '${requestId}': expected REQ-NNNNNN`,
                ),
            };
        }
        const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
        const cacheKey = `phase-history:${requestId}:${String(limit)}`;
        const cached = await this.deps.cache.get<PhaseEvent[]>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const path = join(
            this.deps.basePath,
            ".autonomous-dev",
            "requests",
            requestId,
            "events.jsonl",
        );

        let raw: string;
        try {
            raw = await fs.readFile(path, "utf8");
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") {
                await this.deps.cache.set(cacheKey, [], PHASE_HISTORY_TTL_MS);
                return { ok: true, value: [] };
            }
            return {
                ok: false,
                error: new Error(`failed to read ${path}: ${(err as Error).message}`),
            };
        }

        const window: PhaseEvent[] = [];
        let parseErrors = 0;
        const lines = raw.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                parseErrors += 1;
                continue;
            }
            const result = parsePhaseEvent(parsed);
            if (!result.ok || !result.value) continue; // silently skip non-phase
            window.push(result.value);
            if (window.length > limit) window.shift();
        }
        if (parseErrors > 0 && this.deps.logger?.debug) {
            this.deps.logger.debug(
                `EventsReader: skipped ${String(parseErrors)} malformed lines in ${path}`,
            );
        }

        await this.deps.cache.set(cacheKey, window, PHASE_HISTORY_TTL_MS);
        return { ok: true, value: window };
    }
}
