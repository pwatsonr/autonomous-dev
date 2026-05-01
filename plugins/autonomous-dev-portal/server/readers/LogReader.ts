// SPEC-015-1-04 — LogReader: reverse-read last N lines from daemon.log.
//
// The daemon log can grow to many MB; the reader walks BACKWARD from
// EOF in 64 KB chunks so peak memory stays bounded regardless of file
// size. JSONL lines parse against StructuredLogLineSchema; plain-text
// legacy lines are returned with `source: 'unknown'` and the original
// text in `raw`. Every line passes through the redaction pipeline
// before leaving the process.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AggregationCache } from "../cache/AggregationCache";
import { redactLogLine } from "./redaction";
import { parseStructuredLogLine } from "./schemas/log";
import type { LogLevel, LogLine, Result } from "./types";

const LOG_TTL_MS = 2_000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
const CHUNK_BYTES = 64 * 1024;

export interface ReadLogOptions {
    /** Default 500, max 5000. */
    limit?: number;
    /** Filter to a level subset. */
    level?: LogLevel[];
    /** Only entries whose ts >= since (ISO string). */
    since?: string;
    /** Case-insensitive substring on message (post-redaction). */
    search?: string;
}

export interface LogReaderDeps {
    /** Repo root. The daemon writes <basePath>/.autonomous-dev/daemon.log. */
    basePath: string;
    cache: AggregationCache;
    logger?: { warn?: (msg: string, ...args: unknown[]) => void };
    /** Inject a clock for tests; used for synthesized plain-text ts. */
    now?: () => number;
}

export class LogReader {
    private readonly deps: LogReaderDeps;
    private readonly now: () => number;

    constructor(deps: LogReaderDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
    }

    private logPath(): string {
        return join(this.deps.basePath, ".autonomous-dev", "daemon.log");
    }

    async readRecent(opts: ReadLogOptions = {}): Promise<Result<LogLine[]>> {
        const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
        const cacheKey = `log:recent:${stableStringify({ ...opts, limit })}`;
        const cached = await this.deps.cache.get<LogLine[]>(cacheKey);
        if (cached !== null) return { ok: true, value: cached };

        const path = this.logPath();
        let stat;
        try {
            stat = await fs.stat(path);
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") {
                // Empty result; cache to suppress repeated stat() noise
                // when no log exists yet.
                await this.deps.cache.set(cacheKey, [], LOG_TTL_MS);
                return { ok: true, value: [] };
            }
            return {
                ok: false,
                error: new Error(`failed to stat ${path}: ${(err as Error).message}`),
            };
        }

        const totalBytes = stat.size;
        if (totalBytes === 0) {
            await this.deps.cache.set(cacheKey, [], LOG_TTL_MS);
            return { ok: true, value: [] };
        }

        let rawLines: string[];
        try {
            rawLines = await readLastLines(path, totalBytes, limit);
        } catch (err) {
            return {
                ok: false,
                error: new Error(
                    `failed to reverse-read ${path}: ${(err as Error).message}`,
                ),
            };
        }

        // rawLines is in chronological order (oldest → newest). Parse,
        // redact, then filter.
        const parsed: LogLine[] = [];
        for (const line of rawLines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            parsed.push(this.toLogLine(trimmed));
        }

        let filtered = parsed.map((l) => redactLogLine(l));

        if (opts.level && opts.level.length > 0) {
            const allowed = new Set<LogLevel>(opts.level);
            filtered = filtered.filter((l) => allowed.has(l.level));
        }
        if (opts.since !== undefined) {
            const since = opts.since;
            filtered = filtered.filter((l) => l.ts >= since);
        }
        if (opts.search !== undefined && opts.search.length > 0) {
            const needle = opts.search.toLowerCase();
            filtered = filtered.filter((l) =>
                l.message.toLowerCase().includes(needle),
            );
        }

        // The reverse-read returned at most `limit` raw lines. After
        // filters we may end up with fewer, which is the intended
        // behavior — operators see exactly the matching window.
        await this.deps.cache.set(cacheKey, filtered, LOG_TTL_MS);
        return { ok: true, value: filtered };
    }

    private toLogLine(line: string): LogLine {
        // Try JSONL first.
        if (line.startsWith("{")) {
            try {
                const obj = JSON.parse(line) as unknown;
                const r = parseStructuredLogLine(obj);
                if (r.ok && r.value) return r.value;
            } catch {
                // fall through to plain-text fallback
            }
        }
        // Plain-text fallback. Synthesize ts/level/source.
        return {
            ts: new Date(this.now()).toISOString(),
            level: "info",
            message: line,
            source: "unknown",
            raw: line,
        };
    }
}

/**
 * Reads up to `limit` complete lines from the END of `path` by walking
 * backward in CHUNK_BYTES windows. Returns lines in chronological order
 * (oldest first). Peak memory ≈ CHUNK_BYTES + sum(line lengths).
 */
async function readLastLines(
    path: string,
    size: number,
    limit: number,
): Promise<string[]> {
    const fh = await fs.open(path, "r");
    try {
        const collected: string[] = [];
        // Buffer holds bytes BEFORE the chunk currently being processed.
        // The first incomplete line on the LEFT edge of a chunk is held
        // until the previous chunk arrives.
        let leftover = "";
        let position = size;

        while (position > 0 && collected.length <= limit) {
            const readSize = Math.min(CHUNK_BYTES, position);
            position -= readSize;
            const buf = Buffer.alloc(readSize);
            await fh.read(buf, 0, readSize, position);
            const text = buf.toString("utf8") + leftover;
            const parts = text.split("\n");
            // The first part is incomplete UNLESS we've reached the
            // start of the file.
            if (position > 0) {
                leftover = parts.shift() ?? "";
            } else {
                leftover = "";
            }
            // Append in reverse so newest-first ordering accumulates
            // until we have `limit` complete lines.
            for (let i = parts.length - 1; i >= 0; i -= 1) {
                const p = parts[i];
                if (p === undefined) continue;
                collected.push(p);
                if (collected.length > limit) break;
            }
        }

        // Drop trailing empties (file ending with \n produces "")
        while (collected.length > 0 && collected[0] === "") collected.shift();
        // Cap and reverse to chronological.
        const tail = collected.slice(0, limit);
        return tail.reverse();
    } finally {
        await fh.close();
    }
}

function stableStringify(obj: Record<string, unknown>): string {
    const entries = Object.entries(obj).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
    );
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of entries) sorted[k] = v;
    return JSON.stringify(sorted);
}
