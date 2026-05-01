// SPEC-015-1-03 — StateReader: read daemon state.json files.
//
// Never throws. Missing files → ok+null (legitimate empty state).
// Malformed files → not-ok (UI surfaces a banner; cache NOT populated).

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AggregationCache } from "../cache/AggregationCache";
import { isValidRequestId, parseRequestState } from "./schemas/state";
import {
    REQUEST_PHASES,
    TERMINAL_PHASES,
    type RequestPhase,
    type RequestSource,
    type RequestState,
    type Result,
} from "./types";

export interface ReadAllStatesOptions {
    /** When false (default), excludes completed/failed/cancelled. */
    includeTerminal?: boolean;
    phase?: RequestPhase[];
    repository?: string;
    source?: RequestSource;
    limit?: number;
    offset?: number;
}

export interface StateReaderDeps {
    /** Repo root; the daemon writes under <basePath>/.autonomous-dev/. */
    basePath: string;
    cache: AggregationCache;
    logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

const ALL_STATES_TTL_MS = 2_000;
const STATE_TTL_MS = 5_000;
const STATE_COUNTS_TTL_MS = 5_000;

export class StateReader {
    private readonly deps: StateReaderDeps;

    constructor(deps: StateReaderDeps) {
        this.deps = deps;
    }

    async readState(requestId: string): Promise<Result<RequestState | null>> {
        if (!isValidRequestId(requestId)) {
            return {
                ok: false,
                error: new Error(
                    `invalid request_id format '${requestId}': expected REQ-NNNNNN`,
                ),
            };
        }
        const cacheKey = `state:${requestId}`;
        const cached = await this.deps.cache.get<RequestState>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const path = join(
            this.deps.basePath,
            ".autonomous-dev",
            "requests",
            requestId,
            "state.json",
        );

        let raw: string;
        try {
            raw = await fs.readFile(path, "utf8");
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") return { ok: true, value: null };
            return {
                ok: false,
                error: new Error(`failed to read ${path}: ${(err as Error).message}`),
            };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            return {
                ok: false,
                error: new Error(
                    `malformed JSON in ${path}: ${(err as Error).message}`,
                ),
            };
        }

        const result = parseRequestState(parsed);
        if (!result.ok || !result.value) {
            return {
                ok: false,
                error: new Error(`schema violation in ${path}: ${result.error ?? "unknown"}`),
            };
        }

        await this.deps.cache.set(cacheKey, result.value, STATE_TTL_MS);
        return { ok: true, value: result.value };
    }

    async readAllStates(
        opts: ReadAllStatesOptions = {},
    ): Promise<Result<RequestState[]>> {
        const cacheKey = `all-states:${stableStringify(opts)}`;
        const cached = await this.deps.cache.get<RequestState[]>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const requestsDir = join(this.deps.basePath, ".autonomous-dev", "requests");
        let entries: string[];
        try {
            entries = await fs.readdir(requestsDir);
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") {
                await this.deps.cache.set(cacheKey, [], ALL_STATES_TTL_MS);
                return { ok: true, value: [] };
            }
            return {
                ok: false,
                error: new Error(
                    `failed to read ${requestsDir}: ${(err as Error).message}`,
                ),
            };
        }

        const candidates = entries.filter((e) => isValidRequestId(e));
        const states: RequestState[] = [];
        for (const id of candidates) {
            const r = await this.readState(id);
            if (r.ok && r.value !== null) states.push(r.value);
        }

        let filtered = states;
        if (!opts.includeTerminal) {
            const terminal = new Set<string>(TERMINAL_PHASES);
            filtered = filtered.filter((s) => !terminal.has(s.phase));
        }
        if (opts.phase && opts.phase.length > 0) {
            const allowed = new Set<string>(opts.phase);
            filtered = filtered.filter((s) => allowed.has(s.phase));
        }
        if (opts.repository !== undefined) {
            filtered = filtered.filter((s) => s.repository === opts.repository);
        }
        if (opts.source !== undefined) {
            filtered = filtered.filter((s) => s.source === opts.source);
        }

        filtered.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

        if (opts.offset !== undefined && opts.offset > 0) {
            filtered = filtered.slice(opts.offset);
        }
        if (opts.limit !== undefined && opts.limit >= 0) {
            filtered = filtered.slice(0, opts.limit);
        }

        await this.deps.cache.set(cacheKey, filtered, ALL_STATES_TTL_MS);
        return { ok: true, value: filtered };
    }

    async getStateCounts(): Promise<Result<Record<RequestPhase, number>>> {
        const cacheKey = "state-counts:default";
        const cached = await this.deps.cache.get<Record<RequestPhase, number>>(
            cacheKey,
        );
        if (cached !== null) return { ok: true, value: cached };

        const all = await this.readAllStates({ includeTerminal: true });
        if (!all.ok) return all;

        const counts: Record<RequestPhase, number> = {} as Record<RequestPhase, number>;
        for (const phase of REQUEST_PHASES) counts[phase] = 0;
        for (const s of all.value) {
            counts[s.phase] = (counts[s.phase] ?? 0) + 1;
        }
        await this.deps.cache.set(cacheKey, counts, STATE_COUNTS_TTL_MS);
        return { ok: true, value: counts };
    }
}

/** Deterministic JSON.stringify ordering for cache-key stability. */
function stableStringify(obj: ReadAllStatesOptions): string {
    const entries = Object.entries(obj as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of entries) sorted[k] = v;
    return JSON.stringify(sorted);
}
