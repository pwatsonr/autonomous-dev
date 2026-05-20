// REQ-000011 — Enhanced logs route with observability features
//
// Supports:
// - Multi-select level filtering via query params
// - Full-text search with highlighting
// - Time-range picker (relative/absolute)
// - Server-side pagination with stable cursor
// - Multi-source log filtering
// - Context-based filtering (click-to-filter)
// - URL state preservation

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadLogsStub } from "../stubs/logs";
import { EnhancedLogReader, type EnhancedReadLogOptions, type EnhancedLogLine } from "../readers/EnhancedLogReader";
import { AggregationCache } from "../cache/AggregationCache";

// Enhanced logs reader instance - initialized by server
let activeEnhancedLogsReader: EnhancedLogReader | null = null;

export function setEnhancedLogsReader(reader: EnhancedLogReader): void {
    activeEnhancedLogsReader = reader;
}

// Parse comma-separated list with validation
function parseCommaSeparatedList<T>(value: string | undefined, validValues: readonly T[]): T[] {
    if (!value) return [];

    const items = value.split(',').map(item => item.trim());
    return items.filter(item => validValues.includes(item as T)) as T[];
}

// Parse boolean query parameter
function parseBoolean(value: string | undefined, defaultValue: boolean = false): boolean {
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}

// Parse context filters from query params
function parseContextFilters(query: Record<string, string | undefined>): Array<{ path: string; value: unknown; operator?: string }> {
    const filters: Array<{ path: string; value: unknown; operator?: string }> = [];

    // Look for filter_* parameters
    Object.entries(query).forEach(([key, value]) => {
        if (key.startsWith('filter_') && value) {
            const path = key.substring(7); // Remove 'filter_' prefix
            const [filterValue, operator] = value.includes('|')
                ? value.split('|', 2)
                : [value, undefined];

            filters.push({
                path,
                value: filterValue,
                operator: operator as any,
            });
        }
    });

    return filters;
}

// Handler that redirects to enhanced-logs view
export const enhancedLogsHandler = async (c: Context): Promise<Response> => {
    try {
        // Parse query parameters
        const query = Object.fromEntries(
            Object.entries(c.req.query()).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
        );

        // Level filtering (multi-select)
        const levels = parseCommaSeparatedList(query.level, ["trace", "debug", "info", "warn", "error"] as const);

        // Source filtering (multi-select, default to all)
        const sources = parseCommaSeparatedList(query.source, ["daemon", "portal", "audit"] as const);

        // Search options
        const searchQuery = query.search?.trim();
        const includeContext = parseBoolean(query.includeContext, true);
        const caseSensitive = parseBoolean(query.caseSensitive, false);

        // Time range options
        const timeRangeRelative = query.range as "5m" | "15m" | "1h" | "24h" | undefined;
        const timeRangeFrom = query.from;
        const timeRangeTo = query.to;

        // Pagination options
        const limit = query.limit ? Math.min(500, Math.max(1, parseInt(query.limit, 10))) : undefined;
        const cursor = query.cursor;
        const direction = query.direction as "newer" | "older" | undefined;

        // Context filters (click-to-filter)
        const contextFilters = parseContextFilters(query);

        // Build options object
        const options: EnhancedReadLogOptions = {
            levels: levels.length > 0 ? levels : undefined,
            sources: sources.length > 0 ? sources : undefined,
            search: searchQuery ? {
                query: searchQuery,
                includeContext,
                caseSensitive,
            } : undefined,
            timeRange: timeRangeRelative ? { relative: timeRangeRelative }
                     : (timeRangeFrom || timeRangeTo) ? { from: timeRangeFrom, to: timeRangeTo }
                     : undefined,
            pagination: {
                limit,
                cursor,
                direction,
            },
            contextFilters: contextFilters.length > 0 ? contextFilters : undefined,
        };

        // Use enhanced reader if available
        if (activeEnhancedLogsReader) {
            const result = await activeEnhancedLogsReader.readLogs(options);

            if (result.ok) {
                return renderPage(c, "enhanced-logs", {
                    logResult: result.value,
                    filters: {
                        levels,
                        sources,
                        search: searchQuery,
                        timeRange: {
                            relative: timeRangeRelative,
                            from: timeRangeFrom,
                            to: timeRangeTo,
                        },
                        contextFilters,
                    },
                    options: {
                        includeContext,
                        caseSensitive,
                    },
                });
            } else {
                // Log error but continue to fallback
                console.warn("Enhanced LogReader failed:", result.error);
            }
        }

        // Fallback to stub data
        const lines = await loadLogsStub();
        const enhancedLines: EnhancedLogLine[] = lines.map((line, index) => ({
            ...line,
            logId: `stub-${index}`,
            logSource: "daemon" as const,
            hasContext: false,
            source: "daemon" as const,
        }));

        return renderPage(c, "enhanced-logs", {
            logResult: {
                entries: enhancedLines,
                hasMore: false,
            },
            filters: {
                levels,
                sources,
                search: searchQuery,
                timeRange: {
                    relative: timeRangeRelative,
                    from: timeRangeFrom,
                    to: timeRangeTo,
                },
                contextFilters: [],
            },
            options: {
                includeContext,
                caseSensitive,
            },
        });

    } catch (error) {
        console.error("Enhanced logs handler error:", error);

        // Return error-safe fallback
        const lines = await loadLogsStub();
        const enhancedLines: EnhancedLogLine[] = lines.map((line, index) => ({
            ...line,
            logId: `stub-${index}`,
            logSource: "daemon" as const,
            hasContext: false,
            source: "daemon" as const,
        }));

        return renderPage(c, "enhanced-logs", {
            logResult: {
                entries: enhancedLines,
                hasMore: false,
            },
            filters: {
                levels: [],
                sources: [],
                search: undefined,
                timeRange: {},
                contextFilters: [],
            },
            options: {
                includeContext: true,
                caseSensitive: false,
            },
        });
    }
};

// Helper function to build URL with current filters (for pagination, etc.)
export function buildLogsUrl(baseUrl: string, filters: any, options: any, overrides: Record<string, string> = {}): string {
    const params = new URLSearchParams();

    // Apply current filters
    if (filters.levels?.length > 0) {
        params.set('level', filters.levels.join(','));
    }
    if (filters.sources?.length > 0) {
        params.set('source', filters.sources.join(','));
    }
    if (filters.search) {
        params.set('search', filters.search);
    }
    if (filters.timeRange?.relative) {
        params.set('range', filters.timeRange.relative);
    }
    if (filters.timeRange?.from) {
        params.set('from', filters.timeRange.from);
    }
    if (filters.timeRange?.to) {
        params.set('to', filters.timeRange.to);
    }

    // Apply options
    if (!options.includeContext) {
        params.set('includeContext', 'false');
    }
    if (options.caseSensitive) {
        params.set('caseSensitive', 'true');
    }

    // Apply overrides
    Object.entries(overrides).forEach(([key, value]) => {
        if (value) {
            params.set(key, value);
        } else {
            params.delete(key);
        }
    });

    const queryString = params.toString();
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}