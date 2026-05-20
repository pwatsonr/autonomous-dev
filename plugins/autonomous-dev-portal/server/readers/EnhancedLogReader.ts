// REQ-000011 — Enhanced LogReader: multi-source observability with advanced filtering
//
// Supports:
// - Multi-source logs (daemon, portal, audit) merged by timestamp
// - Multi-select level filtering (trace/debug/info/warn/error)
// - Full-text search with highlighting across message + structured fields
// - Time-range picker (relative: 5m/15m/1h/24h; absolute: from/to)
// - Server-side pagination with stable cursor
// - Source filtering with merged timeline view by default
// - Per-line collapsible JSON context trees
// - Click-to-filter on JSON values
// - URL query parameter state preservation

import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AggregationCache } from "../cache/AggregationCache";
import { redactLogLine } from "./redaction";
import { parseStructuredLogLine } from "./schemas/log";
import type { LogLevel, LogLine, Result } from "./types";

const LOG_TTL_MS = 2_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2_000;
const CHUNK_BYTES = 64 * 1024;

// Enhanced log levels including trace
export type EnhancedLogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogSource = "daemon" | "portal" | "audit";

// Enhanced search options with highlighting support
export interface SearchOptions {
    /** Search query string */
    query?: string;
    /** Whether to search in structured context fields */
    includeContext?: boolean;
    /** Case sensitive search */
    caseSensitive?: boolean;
}

// Time range options (relative or absolute)
export interface TimeRangeOptions {
    /** Relative time range */
    relative?: "5m" | "15m" | "1h" | "24h";
    /** Absolute start time (ISO string) */
    from?: string;
    /** Absolute end time (ISO string) */
    to?: string;
}

// Pagination options with stable cursor
export interface PaginationOptions {
    /** Page size (default 100, max 500 per page for performance) */
    limit?: number;
    /** Pagination cursor (timestamp + log ID for stability) */
    cursor?: string;
    /** Direction of pagination */
    direction?: "newer" | "older";
}

// Context filter for click-to-filter functionality
export interface ContextFilter {
    /** JSON path (e.g., "pid", "context.requestId") */
    path: string;
    /** Filter value */
    value: unknown;
    /** Filter operator */
    operator?: "equals" | "contains" | "exists";
}

export interface EnhancedReadLogOptions {
    /** Multi-select level filtering */
    levels?: EnhancedLogLevel[];
    /** Multi-source filtering (default: all sources) */
    sources?: LogSource[];
    /** Time range filtering */
    timeRange?: TimeRangeOptions;
    /** Full-text search options */
    search?: SearchOptions;
    /** Context filters from click-to-filter */
    contextFilters?: ContextFilter[];
    /** Pagination options */
    pagination?: PaginationOptions;
}

// Enhanced log line with highlighting and context support
export interface EnhancedLogLine extends LogLine {
    /** Unique log identifier for stable pagination */
    logId: string;
    /** Log source */
    logSource: LogSource;
    /** Search highlights in message */
    messageHighlights?: Array<{ start: number; end: number; text: string }>;
    /** Search highlights in context */
    contextHighlights?: Record<string, Array<{ start: number; end: number; text: string }>>;
    /** Whether this line has expandable context */
    hasContext: boolean;
    /** Flattened context for search indexing */
    contextText?: string;
}

export interface EnhancedLogReaderDeps {
    /** Base path for log files */
    basePath: string;
    /** Cache instance */
    cache: AggregationCache;
    /** Logger instance */
    logger?: { warn?: (msg: string, ...args: unknown[]) => void };
    /** Clock injection for tests */
    now?: () => number;
}

export interface LogReadResult {
    /** Log entries */
    entries: EnhancedLogLine[];
    /** Next pagination cursor */
    nextCursor?: string;
    /** Previous pagination cursor */
    prevCursor?: string;
    /** Total count estimate (expensive, only computed when requested) */
    totalCount?: number;
    /** Whether more entries are available */
    hasMore: boolean;
}

export class EnhancedLogReader {
    private readonly deps: EnhancedLogReaderDeps;
    private readonly now: () => number;

    constructor(deps: EnhancedLogReaderDeps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
    }

    /**
     * Read logs with enhanced filtering and pagination support
     */
    async readLogs(options: EnhancedReadLogOptions = {}): Promise<Result<LogReadResult>> {
        const limit = Math.min(MAX_LIMIT, Math.max(1, options.pagination?.limit ?? DEFAULT_LIMIT));
        const sources = options.sources ?? ["daemon", "portal", "audit"];

        // Build cache key from all options
        const cacheKey = `enhanced-logs:${this.buildCacheKey(options)}`;
        const cached = await this.deps.cache.get<LogReadResult>(cacheKey);
        if (cached !== null) {
            return { ok: true, value: cached };
        }

        try {
            // Read from all requested sources
            const sourceResults = await Promise.all(
                sources.map(source => this.readFromSource(source, options))
            );

            // Merge and sort by timestamp
            const allEntries: EnhancedLogLine[] = [];
            for (const result of sourceResults) {
                if (result.ok) {
                    allEntries.push(...result.value);
                }
            }

            // Sort by timestamp (newest first for logs)
            allEntries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

            // Apply filters
            let filteredEntries = this.applyFilters(allEntries, options);

            // Apply pagination
            const paginatedResult = this.applyPagination(filteredEntries, options.pagination);

            // Apply search highlighting
            if (options.search?.query) {
                paginatedResult.entries = this.applySearchHighlighting(
                    paginatedResult.entries,
                    options.search
                );
            }

            // Cache result
            await this.deps.cache.set(cacheKey, paginatedResult, LOG_TTL_MS);

            return { ok: true, value: paginatedResult };
        } catch (error) {
            return {
                ok: false,
                error: new Error(`Failed to read enhanced logs: ${(error as Error).message}`)
            };
        }
    }

    /**
     * Read logs from a specific source
     */
    private async readFromSource(
        source: LogSource,
        options: EnhancedReadLogOptions
    ): Promise<Result<EnhancedLogLine[]>> {
        const logPath = this.getLogPath(source);

        try {
            const stat = await fs.stat(logPath);
            if (stat.size === 0) {
                return { ok: true, value: [] };
            }

            const rawLines = await this.readLastLines(logPath, stat.size, MAX_LIMIT);
            const entries: EnhancedLogLine[] = [];

            for (const line of rawLines) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;

                const logLine = this.parseLogLine(trimmed, source);
                const enhanced = this.enhanceLogLine(logLine, source);
                entries.push(enhanced);
            }

            return { ok: true, value: entries };
        } catch (error) {
            const e = error as { code?: string };
            if (e.code === "ENOENT") {
                return { ok: true, value: [] }; // File doesn't exist, return empty
            }
            return {
                ok: false,
                error: new Error(`Failed to read from ${source}: ${(error as Error).message}`)
            };
        }
    }

    /**
     * Get log file path for a source
     */
    private getLogPath(source: LogSource): string {
        const basePath = this.deps.basePath;
        switch (source) {
            case "daemon":
                return join(basePath, ".autonomous-dev", "logs", "daemon.log");
            case "portal":
                return join(basePath, ".autonomous-dev", "portal", "portal.log");
            case "audit":
                return join(basePath, ".autonomous-dev", "logs", "audit.log");
            default:
                throw new Error(`Unknown log source: ${source}`);
        }
    }

    /**
     * Parse a log line with source context
     */
    private parseLogLine(line: string, source: LogSource): LogLine {
        // Try JSONL first
        if (line.startsWith("{")) {
            try {
                const obj = JSON.parse(line) as unknown;
                const result = parseStructuredLogLine(obj);
                if (result.ok && result.value) {
                    // Override source if provided in structured log
                    return { ...result.value, source: result.value.source ?? source };
                }
            } catch {
                // Fall through to plain-text
            }
        }

        // Plain-text fallback
        return {
            ts: new Date(this.now()).toISOString(),
            level: "info",
            message: line,
            source: source as LogLine["source"],
            raw: line,
        };
    }

    /**
     * Enhance log line with additional metadata
     */
    private enhanceLogLine(logLine: LogLine, logSource: LogSource): EnhancedLogLine {
        const logId = this.generateLogId(logLine);
        const hasContext = Boolean(logLine.context && Object.keys(logLine.context).length > 0);
        const contextText = hasContext ? JSON.stringify(logLine.context) : undefined;

        return {
            ...redactLogLine(logLine),
            logId,
            logSource,
            hasContext,
            contextText,
            messageHighlights: [],
            contextHighlights: {},
        };
    }

    /**
     * Generate stable log ID for pagination
     */
    private generateLogId(logLine: LogLine): string {
        const content = `${logLine.ts}-${logLine.level}-${logLine.message.slice(0, 50)}`;
        // Simple hash for stable ID
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return `log-${Math.abs(hash)}`;
    }

    /**
     * Apply all filters to log entries
     */
    private applyFilters(entries: EnhancedLogLine[], options: EnhancedReadLogOptions): EnhancedLogLine[] {
        let filtered = entries;

        // Level filtering
        if (options.levels && options.levels.length > 0) {
            const allowedLevels = new Set(options.levels);
            filtered = filtered.filter(entry => allowedLevels.has(entry.level as EnhancedLogLevel));
        }

        // Time range filtering
        if (options.timeRange) {
            filtered = this.applyTimeRangeFilter(filtered, options.timeRange);
        }

        // Search filtering
        if (options.search?.query) {
            filtered = this.applySearchFilter(filtered, options.search);
        }

        // Context filters (click-to-filter)
        if (options.contextFilters && options.contextFilters.length > 0) {
            filtered = this.applyContextFilters(filtered, options.contextFilters);
        }

        return filtered;
    }

    /**
     * Apply time range filtering
     */
    private applyTimeRangeFilter(entries: EnhancedLogLine[], timeRange: TimeRangeOptions): EnhancedLogLine[] {
        let startTime: Date;
        let endTime: Date;

        if (timeRange.from && timeRange.to) {
            // Absolute time range
            startTime = new Date(timeRange.from);
            endTime = new Date(timeRange.to);
        } else if (timeRange.relative) {
            // Relative time range
            endTime = new Date(this.now());
            const minutes = this.getRelativeMinutes(timeRange.relative);
            startTime = new Date(endTime.getTime() - (minutes * 60 * 1000));
        } else {
            return entries; // No time filtering
        }

        return entries.filter(entry => {
            const entryTime = new Date(entry.ts);
            return entryTime >= startTime && entryTime <= endTime;
        });
    }

    /**
     * Get minutes for relative time range
     */
    private getRelativeMinutes(relative: "5m" | "15m" | "1h" | "24h"): number {
        switch (relative) {
            case "5m": return 5;
            case "15m": return 15;
            case "1h": return 60;
            case "24h": return 24 * 60;
            default: return 60;
        }
    }

    /**
     * Apply full-text search filtering
     */
    private applySearchFilter(entries: EnhancedLogLine[], search: SearchOptions): EnhancedLogLine[] {
        const query = search.caseSensitive ? search.query! : search.query!.toLowerCase();

        return entries.filter(entry => {
            // Search in message
            const message = search.caseSensitive ? entry.message : entry.message.toLowerCase();
            if (message.includes(query)) {
                return true;
            }

            // Search in context if enabled
            if (search.includeContext !== false && entry.contextText) {
                const contextText = search.caseSensitive ? entry.contextText : entry.contextText.toLowerCase();
                if (contextText.includes(query)) {
                    return true;
                }
            }

            // Search in request_id
            if (entry.request_id) {
                const requestId = search.caseSensitive ? entry.request_id : entry.request_id.toLowerCase();
                if (requestId.includes(query)) {
                    return true;
                }
            }

            return false;
        });
    }

    /**
     * Apply context filters (click-to-filter functionality)
     */
    private applyContextFilters(entries: EnhancedLogLine[], filters: ContextFilter[]): EnhancedLogLine[] {
        return entries.filter(entry => {
            for (const filter of filters) {
                if (!this.matchesContextFilter(entry, filter)) {
                    return false;
                }
            }
            return true;
        });
    }

    /**
     * Check if entry matches context filter
     */
    private matchesContextFilter(entry: EnhancedLogLine, filter: ContextFilter): boolean {
        const value = this.getNestedValue(entry, filter.path);

        switch (filter.operator ?? "equals") {
            case "equals":
                return value === filter.value;
            case "contains":
                return String(value).includes(String(filter.value));
            case "exists":
                return value !== undefined && value !== null;
            default:
                return false;
        }
    }

    /**
     * Get nested value from object by path
     */
    private getNestedValue(obj: any, path: string): unknown {
        const parts = path.split(".");
        let current = obj;

        for (const part of parts) {
            if (current == null) return undefined;
            current = current[part];
        }

        return current;
    }

    /**
     * Apply pagination to filtered results
     */
    private applyPagination(entries: EnhancedLogLine[], pagination?: PaginationOptions): LogReadResult {
        const limit = pagination?.limit ?? DEFAULT_LIMIT;
        let startIndex = 0;

        // Handle cursor-based pagination
        if (pagination?.cursor) {
            const cursorIndex = entries.findIndex(entry => entry.logId === pagination.cursor);
            if (cursorIndex !== -1) {
                startIndex = pagination.direction === "older" ? cursorIndex + 1 : Math.max(0, cursorIndex - limit);
            }
        }

        const endIndex = Math.min(startIndex + limit, entries.length);
        const pageEntries = entries.slice(startIndex, endIndex);

        // Determine cursors
        const nextCursor = endIndex < entries.length ? entries[endIndex - 1]?.logId : undefined;
        const prevCursor = startIndex > 0 ? entries[startIndex]?.logId : undefined;
        const hasMore = endIndex < entries.length;

        return {
            entries: pageEntries,
            nextCursor,
            prevCursor,
            hasMore,
        };
    }

    /**
     * Apply search highlighting to results
     */
    private applySearchHighlighting(entries: EnhancedLogLine[], search: SearchOptions): EnhancedLogLine[] {
        if (!search.query) return entries;

        const query = search.caseSensitive ? search.query : search.query.toLowerCase();

        return entries.map(entry => {
            const enhanced = { ...entry };

            // Highlight in message
            enhanced.messageHighlights = this.findHighlights(
                entry.message,
                query,
                search.caseSensitive ?? false
            );

            // Highlight in context if enabled
            if (search.includeContext !== false && entry.context) {
                enhanced.contextHighlights = {};
                for (const [key, value] of Object.entries(entry.context)) {
                    const valueStr = String(value);
                    const highlights = this.findHighlights(valueStr, query, search.caseSensitive ?? false);
                    if (highlights.length > 0) {
                        enhanced.contextHighlights[key] = highlights;
                    }
                }
            }

            return enhanced;
        });
    }

    /**
     * Find highlight positions in text
     */
    private findHighlights(text: string, query: string, caseSensitive: boolean): Array<{ start: number; end: number; text: string }> {
        if (!query || !text) return [];

        const searchText = caseSensitive ? text : text.toLowerCase();
        const searchQuery = caseSensitive ? query : query.toLowerCase();
        const highlights: Array<{ start: number; end: number; text: string }> = [];

        let index = 0;
        while ((index = searchText.indexOf(searchQuery, index)) !== -1) {
            highlights.push({
                start: index,
                end: index + query.length,
                text: text.slice(index, index + query.length),
            });
            index += query.length;
        }

        return highlights;
    }

    /**
     * Read last N lines from file using reverse reading
     */
    private async readLastLines(path: string, size: number, limit: number): Promise<string[]> {
        const fh = await fs.open(path, "r");
        try {
            const collected: string[] = [];
            let leftover = "";
            let position = size;

            while (position > 0 && collected.length <= limit) {
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
                    collected.push(p);
                    if (collected.length > limit) break;
                }
            }

            while (collected.length > 0 && collected[0] === "") collected.shift();
            const tail = collected.slice(0, limit);
            return tail.reverse(); // Chronological order (oldest first)
        } finally {
            await fh.close();
        }
    }

    /**
     * Build cache key from options
     */
    private buildCacheKey(options: EnhancedReadLogOptions): string {
        const keyParts = [
            options.levels?.sort().join(",") ?? "all",
            options.sources?.sort().join(",") ?? "all",
            options.search?.query ?? "",
            options.timeRange?.relative ?? "",
            options.timeRange?.from ?? "",
            options.timeRange?.to ?? "",
            options.pagination?.limit ?? DEFAULT_LIMIT,
            options.pagination?.cursor ?? "",
            options.contextFilters?.length ?? 0,
        ];
        return keyParts.join("|");
    }
}