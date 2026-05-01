// SPEC-015-3-03 — NDJSON LogParser with malformed-line recovery.
//
// parseLine returns null on any error so the caller can increment a
// skip counter without try/catch noise. parseFile performs a tail read
// using LogReader-style reverse chunking; streamFile is line-by-line
// for the gzip download endpoint.

import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { LOG_LEVELS, type LogEntry, type LogLevel } from "./types";

const LEVEL_SET: ReadonlySet<string> = new Set(LOG_LEVELS);
const CHUNK_BYTES = 8 * 1024;

export class LogParser {
    parseLine(line: string): LogEntry | null {
        const trimmed = line.trim();
        if (trimmed.length === 0) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            return null;
        }
        if (!parsed || typeof parsed !== "object") return null;
        const o = parsed as Record<string, unknown>;
        if (typeof o.timestamp !== "string") return null;
        if (typeof o.message !== "string") return null;
        if (typeof o.pid !== "number" || !Number.isFinite(o.pid)) return null;
        const lvlRaw = o.level;
        if (typeof lvlRaw !== "string") return null;
        const level = lvlRaw.toUpperCase();
        if (!LEVEL_SET.has(level)) return null;

        const entry: LogEntry = {
            timestamp: o.timestamp,
            level: level as LogLevel,
            pid: o.pid,
            message: o.message,
        };
        if (typeof o.iteration === "number" && Number.isFinite(o.iteration)) {
            entry.iteration = o.iteration;
        }
        if (typeof o.request_id === "string") {
            entry.request_id = o.request_id;
        }
        if (o.context && typeof o.context === "object") {
            entry.context = o.context as Record<string, unknown>;
        }
        return entry;
    }

    /**
     * Tail behaviour: returns the most recent `max` valid entries in
     * chronological order (oldest first). Reverse-reads in 8KB chunks
     * so peak memory stays bounded regardless of file size.
     */
    async parseFile(path: string, max = 500): Promise<LogEntry[]> {
        let stat;
        try {
            stat = await fs.stat(path);
        } catch (err) {
            const e = err as { code?: string };
            if (e.code === "ENOENT") return [];
            throw err;
        }
        if (stat.size === 0) return [];

        const fh = await fs.open(path, "r");
        try {
            const collected: LogEntry[] = [];
            let leftover = "";
            let position = stat.size;
            while (position > 0 && collected.length < max) {
                const readSize = Math.min(CHUNK_BYTES, position);
                position -= readSize;
                const buf = Buffer.alloc(readSize);
                await fh.read(buf, 0, readSize, position);
                const text = buf.toString("utf8") + leftover;
                const parts = text.split("\n");
                if (position > 0) {
                    leftover = parts.shift() ?? "";
                } else {
                    leftover = "";
                }
                for (let i = parts.length - 1; i >= 0; i -= 1) {
                    const p = parts[i];
                    if (p === undefined) continue;
                    const entry = this.parseLine(p);
                    if (entry) {
                        collected.push(entry);
                        if (collected.length >= max) break;
                    }
                }
            }
            // collected is newest-first; reverse to chronological.
            return collected.reverse();
        } finally {
            await fh.close();
        }
    }

    async *streamFile(path: string): AsyncIterable<LogEntry> {
        let exists = true;
        try {
            await fs.stat(path);
        } catch {
            exists = false;
        }
        if (!exists) return;
        const rl = createInterface({
            input: createReadStream(path, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            const entry = this.parseLine(line);
            if (entry) yield entry;
        }
    }
}
