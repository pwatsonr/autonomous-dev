// REQ-000011 — Enhanced logs view with observability features
//
// Features:
// - Multi-select level filtering
// - Full-text search with highlighting
// - Time-range picker (relative/absolute)
// - Server-side pagination
// - Multi-source filtering with merged timeline
// - Collapsible JSON context trees
// - Click-to-filter functionality
// - Level-based color coding
// - URL state preservation
// - HTMX auto-refresh (5s when visible)

import type { FC } from "hono/jsx";
import type { EnhancedLogLine } from "../../readers/EnhancedLogReader";

// Enhanced render props interface
export interface EnhancedLogsProps {
    logResult: {
        entries: EnhancedLogLine[];
        nextCursor?: string;
        prevCursor?: string;
        hasMore: boolean;
        totalCount?: number;
    };
    filters: {
        levels: string[];
        sources: string[];
        search?: string;
        timeRange: {
            relative?: string;
            from?: string;
            to?: string;
        };
        contextFilters: Array<{ path: string; value: unknown; operator?: string }>;
    };
    options: {
        includeContext: boolean;
        caseSensitive: boolean;
    };
}

// HTMX polling configuration - only when document is visible
const LOGS_POLLING_TRIGGER = 'every 5s [document.visibilityState === "visible"]';

/**
 * Format timestamp in compact ISO format for logs
 */
function formatTimestampCompact(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/**
 * Highlight search matches in text
 */
function highlightText(text: string, highlights: Array<{ start: number; end: number; text: string }> = []): any {
    if (!highlights.length) return text;

    const parts = [];
    let lastIndex = 0;

    highlights.forEach(({ start, end }, index) => {
        // Add text before highlight
        if (start > lastIndex) {
            parts.push(text.slice(lastIndex, start));
        }

        // Add highlighted text
        parts.push(
            <mark key={`highlight-${index}`} class="search-highlight">
                {text.slice(start, end)}
            </mark>
        );

        lastIndex = end;
    });

    // Add remaining text
    if (lastIndex < text.length) {
        parts.push(text.slice(lastIndex));
    }

    return parts;
}

/**
 * Render JSON context tree with click-to-filter
 */
function renderJsonContext(
    context: Record<string, unknown>,
    highlights: Record<string, Array<{ start: number; end: number; text: string }>> = {},
    logId: string
): any {
    const renderValue = (key: string, value: unknown, path: string): any => {
        const valueHighlights = highlights[key] || [];
        const valueStr = String(value);

        if (typeof value === 'object' && value !== null) {
            // Nested object
            return (
                <details class="json-object">
                    <summary class="json-key">{key}: {Array.isArray(value) ? '[...]' : '{...}'}</summary>
                    <div class="json-nested">
                        {Object.entries(value as Record<string, unknown>).map(([nestedKey, nestedValue]) =>
                            renderValue(nestedKey, nestedValue, `${path}.${nestedKey}`)
                        )}
                    </div>
                </details>
            );
        }

        return (
            <div class="json-item">
                <span class="json-key">{key}:</span>
                <span
                    class="json-value clickable-value"
                    data-filter-path={path}
                    data-filter-value={valueStr}
                    data-log-id={logId}
                    title="Click to filter by this value"
                >
                    {highlightText(valueStr, valueHighlights)}
                </span>
            </div>
        );
    };

    return (
        <div class="context-tree">
            {Object.entries(context).map(([key, value]) => renderValue(key, value, key))}
        </div>
    );
}

/**
 * Render level badge with appropriate styling
 */
function renderLevelBadge(level: string): any {
    const levelClass = `level level-${level.toLowerCase()}`;
    return <code class={levelClass}>{level.toUpperCase()}</code>;
}

/**
 * Render source badge
 */
function renderSourceBadge(source: string): any {
    return <span class={`source-badge source-${source}`}>{source}</span>;
}

/**
 * Render log line with all features
 */
function renderLogLine(entry: EnhancedLogLine): any {
    const lineClass = `log-line level-${entry.level} source-${entry.logSource}`;

    return (
        <li
            key={entry.logId}
            class={lineClass}
            data-log-id={entry.logId}
            data-source={entry.logSource}
            data-has-context={entry.hasContext}
        >
            <div class="log-line-main">
                {/* Timestamp */}
                <time datetime={entry.ts} class="timestamp mono">
                    {formatTimestampCompact(entry.ts)}
                </time>

                {/* Level badge */}
                {renderLevelBadge(entry.level)}

                {/* Source badge */}
                {renderSourceBadge(entry.logSource)}

                {/* Request ID (if present) */}
                {entry.request_id && (
                    <span
                        class="request-id clickable-value"
                        data-filter-path="request_id"
                        data-filter-value={entry.request_id}
                        title="Click to filter by request ID"
                    >
                        {entry.request_id}
                    </span>
                )}

                {/* Message with highlights */}
                <span class="message">
                    {highlightText(entry.message, entry.messageHighlights)}
                </span>

                {/* Context expand button */}
                {entry.hasContext && (
                    <button
                        class="expand-context"
                        type="button"
                        aria-expanded="false"
                        data-log-id={entry.logId}
                        title="Show context"
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 4l4 4H4z"/>
                        </svg>
                    </button>
                )}
            </div>

            {/* Collapsible context tree */}
            {entry.hasContext && entry.context && (
                <div
                    class="log-line-context"
                    id={`context-${entry.logId}`}
                    aria-hidden="true"
                >
                    {renderJsonContext(entry.context, entry.contextHighlights, entry.logId)}
                </div>
            )}
        </li>
    );
}

export const EnhancedLogsView: FC<EnhancedLogsProps> = ({ logResult, filters, options }) => (
    <section
        id="logs-container"
        class="enhanced-logs"
        hx-get="/logs"
        hx-trigger={LOGS_POLLING_TRIGGER}
        hx-target="this"
        hx-swap="outerHTML"
        hx-select="#logs-container"
        hx-include=".filter-form"
        hx-vals='js:{preserveFilters: true}'
    >
        <header class="logs-header">
            <h1>System Logs</h1>
            <div class="logs-controls">
                {/* Search */}
                <form class="search-form filter-form" hx-get="/logs" hx-target="#logs-container" hx-swap="outerHTML">
                    <input
                        type="text"
                        name="search"
                        class="search-input"
                        placeholder="Search logs..."
                        value={filters.search || ""}
                        data-testid="search-input"
                    />
                    <button type="submit" class="search-button" data-testid="search-button">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM13 11l3 3-2 2-3-3v-.5l-.5-.5a5.5 5.5 0 1 1 1.5-1.5l.5.5H13z"/>
                        </svg>
                        Search
                    </button>

                    {/* Hidden fields to preserve other filters */}
                    {filters.levels.length > 0 && <input type="hidden" name="level" value={filters.levels.join(',')} />}
                    {filters.sources.length > 0 && <input type="hidden" name="source" value={filters.sources.join(',')} />}
                    {filters.timeRange.relative && <input type="hidden" name="range" value={filters.timeRange.relative} />}
                    {filters.timeRange.from && <input type="hidden" name="from" value={filters.timeRange.from} />}
                    {filters.timeRange.to && <input type="hidden" name="to" value={filters.timeRange.to} />}
                    {!options.includeContext && <input type="hidden" name="includeContext" value="false" />}
                    {options.caseSensitive && <input type="hidden" name="caseSensitive" value="true" />}
                </form>

                <button type="button" class="refresh-logs" data-testid="refresh-logs" title="Refresh logs">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0zM8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/>
                    </svg>
                </button>
            </div>
        </header>

        {/* Filter controls */}
        <div class="filter-controls">
            {/* Level filter */}
            <div class="filter-group">
                <label>Level:</label>
                <details class="filter-dropdown" data-testid="level-filter">
                    <summary class="filter-summary">
                        {filters.levels.length > 0
                            ? filters.levels.map(l => l.charAt(0).toUpperCase() + l.slice(1)).join(', ')
                            : 'All Levels'
                        }
                    </summary>
                    <form class="filter-form" hx-get="/logs" hx-target="#logs-container" hx-swap="outerHTML">
                        <div class="checkbox-group">
                            {['trace', 'debug', 'info', 'warn', 'error'].map(level => (
                                <label class="checkbox-label">
                                    <input
                                        type="checkbox"
                                        name="level-checkbox"
                                        value={level}
                                        checked={filters.levels.includes(level)}
                                        data-testid={`level-checkbox-${level}`}
                                    />
                                    {level.charAt(0).toUpperCase() + level.slice(1)}
                                </label>
                            ))}
                        </div>
                        <button type="submit" class="apply-filter" data-testid="apply-level-filter">Apply</button>

                        {/* Preserve other filters */}
                        {filters.search && <input type="hidden" name="search" value={filters.search} />}
                        {filters.sources.length > 0 && <input type="hidden" name="source" value={filters.sources.join(',')} />}
                        {filters.timeRange.relative && <input type="hidden" name="range" value={filters.timeRange.relative} />}
                        {filters.timeRange.from && <input type="hidden" name="from" value={filters.timeRange.from} />}
                        {filters.timeRange.to && <input type="hidden" name="to" value={filters.timeRange.to} />}
                    </form>
                </details>
            </div>

            {/* Source filter */}
            <div class="filter-group">
                <label>Source:</label>
                <details class="filter-dropdown" data-testid="source-filter">
                    <summary class="filter-summary">
                        {filters.sources.length > 0
                            ? filters.sources.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ')
                            : 'All Sources'
                        }
                    </summary>
                    <form class="filter-form" hx-get="/logs" hx-target="#logs-container" hx-swap="outerHTML">
                        <div class="checkbox-group">
                            {['daemon', 'portal', 'audit'].map(source => (
                                <label class="checkbox-label">
                                    <input
                                        type="checkbox"
                                        name="source-checkbox"
                                        value={source}
                                        checked={filters.sources.length === 0 || filters.sources.includes(source)}
                                        data-testid={`source-${source}`}
                                    />
                                    {source.charAt(0).toUpperCase() + source.slice(1)}
                                </label>
                            ))}
                        </div>
                        <button type="submit" class="apply-filter" data-testid="apply-source-filter">Apply</button>
                    </form>
                </details>
            </div>

            {/* Time range filter */}
            <div class="filter-group">
                <label>Time Range:</label>
                <details class="filter-dropdown" data-testid="time-range-picker">
                    <summary class="filter-summary">
                        {filters.timeRange.relative ||
                         (filters.timeRange.from || filters.timeRange.to) ? 'Custom' :
                         'All Time'
                        }
                    </summary>
                    <div class="time-range-tabs">
                        <button type="button" class="tab-button active" data-tab="relative" data-testid="relative-tab">
                            Relative
                        </button>
                        <button type="button" class="tab-button" data-tab="absolute" data-testid="absolute-tab">
                            Absolute
                        </button>
                    </div>
                    <form class="filter-form time-range-form" hx-get="/logs" hx-target="#logs-container" hx-swap="outerHTML">
                        <div class="tab-content active" data-tab-content="relative">
                            <div class="radio-group">
                                {[
                                    { value: '5m', label: 'Last 5 minutes' },
                                    { value: '15m', label: 'Last 15 minutes' },
                                    { value: '1h', label: 'Last hour' },
                                    { value: '24h', label: 'Last 24 hours' },
                                ].map(({ value, label }) => (
                                    <label class="radio-label">
                                        <input
                                            type="radio"
                                            name="range"
                                            value={value}
                                            checked={filters.timeRange.relative === value}
                                            data-testid={`relative-${value}`}
                                        />
                                        {label}
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div class="tab-content" data-tab-content="absolute">
                            <div class="date-range">
                                <label>
                                    From:
                                    <input
                                        type="datetime-local"
                                        name="from"
                                        value={filters.timeRange.from?.slice(0, 16) || ''}
                                        data-testid="from-date"
                                    />
                                </label>
                                <label>
                                    To:
                                    <input
                                        type="datetime-local"
                                        name="to"
                                        value={filters.timeRange.to?.slice(0, 16) || ''}
                                        data-testid="to-date"
                                    />
                                </label>
                            </div>
                        </div>
                        <button type="submit" class="apply-filter" data-testid="apply-time-range">Apply</button>
                    </form>
                </details>
            </div>
        </div>

        {/* Active filters display */}
        {(filters.levels.length > 0 || filters.sources.length > 0 || filters.search || filters.contextFilters.length > 0) && (
            <div class="active-filters">
                <span class="active-filters-label">Active Filters:</span>

                {filters.levels.length > 0 && (
                    <span class="filter-chip">
                        Levels: {filters.levels.join(', ')}
                        <button class="remove-filter" data-clear="level">×</button>
                    </span>
                )}

                {filters.sources.length > 0 && filters.sources.length < 3 && (
                    <span class="filter-chip">
                        Sources: {filters.sources.join(', ')}
                        <button class="remove-filter" data-clear="source">×</button>
                    </span>
                )}

                {filters.search && (
                    <span class="filter-chip">
                        Search: "{filters.search}"
                        <button class="remove-filter" data-clear="search">×</button>
                    </span>
                )}

                {filters.contextFilters.map((filter, index) => (
                    <span key={index} class="filter-chip">
                        {filter.path} = {String(filter.value)}
                        <button class="remove-filter" data-clear={`filter_${filter.path}`}>×</button>
                    </span>
                ))}

                <button class="clear-all-filters" data-clear="all">Clear All</button>
            </div>
        )}

        {/* Log entries */}
        {logResult.entries.length === 0 ? (
            <div class="empty-state" data-testid="empty-state">
                <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1 2v8h8V4H4z"/>
                </svg>
                <h3>No logs found</h3>
                <p>Try adjusting your filters or time range</p>
            </div>
        ) : (
            <>
                <ul class="log-lines" role="log" aria-live="polite" aria-label="System log entries">
                    {logResult.entries.map(renderLogLine)}
                </ul>

                {/* Pagination controls */}
                {(logResult.hasMore || logResult.prevCursor) && (
                    <div class="pagination-controls">
                        {logResult.prevCursor && (
                            <button
                                class="load-prev"
                                hx-get={`/logs?cursor=${logResult.prevCursor}&direction=newer`}
                                hx-target="#logs-container"
                                hx-swap="outerHTML"
                            >
                                ← Newer
                            </button>
                        )}

                        {logResult.hasMore && (
                            <button
                                class="load-more"
                                data-testid="load-more"
                                hx-get={`/logs?cursor=${logResult.nextCursor}&direction=older`}
                                hx-target="#logs-container"
                                hx-swap="outerHTML"
                            >
                                Older →
                            </button>
                        )}
                    </div>
                )}
            </>
        )}

        {/* Client-side JavaScript for interactivity */}
        <script dangerouslySetInnerHTML={{
            __html: `
                // Handle context expansion
                document.addEventListener('click', (e) => {
                    if (e.target.closest('.expand-context')) {
                        const button = e.target.closest('.expand-context');
                        const logId = button.dataset.logId;
                        const context = document.getElementById('context-' + logId);
                        const isExpanded = button.getAttribute('aria-expanded') === 'true';

                        button.setAttribute('aria-expanded', !isExpanded);
                        context.setAttribute('aria-hidden', isExpanded);
                        button.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(180deg)';
                    }
                });

                // Handle click-to-filter
                document.addEventListener('click', (e) => {
                    if (e.target.closest('.clickable-value')) {
                        const element = e.target.closest('.clickable-value');
                        const path = element.dataset.filterPath;
                        const value = element.dataset.filterValue;

                        // Add filter to URL
                        const url = new URL(window.location);
                        url.searchParams.set('filter_' + path, value);
                        window.location.href = url.toString();
                    }
                });

                // Handle filter removal
                document.addEventListener('click', (e) => {
                    if (e.target.closest('.remove-filter, .clear-all-filters')) {
                        const button = e.target.closest('.remove-filter, .clear-all-filters');
                        const clearType = button.dataset.clear;
                        const url = new URL(window.location);

                        if (clearType === 'all') {
                            // Clear all filters
                            ['level', 'source', 'search', 'range', 'from', 'to'].forEach(param => {
                                url.searchParams.delete(param);
                            });
                            // Clear context filters
                            [...url.searchParams.keys()].forEach(key => {
                                if (key.startsWith('filter_')) {
                                    url.searchParams.delete(key);
                                }
                            });
                        } else {
                            url.searchParams.delete(clearType);
                        }

                        window.location.href = url.toString();
                        e.preventDefault();
                    }
                });

                // Handle tab switching in time range picker
                document.addEventListener('click', (e) => {
                    if (e.target.closest('.tab-button')) {
                        const button = e.target.closest('.tab-button');
                        const tabName = button.dataset.tab;
                        const container = button.closest('.filter-dropdown');

                        // Update tab buttons
                        container.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
                        button.classList.add('active');

                        // Update tab content
                        container.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                        container.querySelector('[data-tab-content="' + tabName + '"]').classList.add('active');
                    }
                });

                // Handle form submissions with checkbox groups
                document.addEventListener('submit', (e) => {
                    const form = e.target;
                    if (!form.matches('.filter-form')) return;

                    // Handle level checkboxes
                    const levelCheckboxes = form.querySelectorAll('input[name="level-checkbox"]:checked');
                    if (levelCheckboxes.length > 0) {
                        const levels = Array.from(levelCheckboxes).map(cb => cb.value).join(',');
                        const levelInput = document.createElement('input');
                        levelInput.type = 'hidden';
                        levelInput.name = 'level';
                        levelInput.value = levels;
                        form.appendChild(levelInput);
                    }

                    // Handle source checkboxes
                    const sourceCheckboxes = form.querySelectorAll('input[name="source-checkbox"]:checked');
                    if (sourceCheckboxes.length > 0 && sourceCheckboxes.length < 3) {
                        const sources = Array.from(sourceCheckboxes).map(cb => cb.value).join(',');
                        const sourceInput = document.createElement('input');
                        sourceInput.type = 'hidden';
                        sourceInput.name = 'source';
                        sourceInput.value = sources;
                        form.appendChild(sourceInput);
                    }
                });
            `
        }} />
    </section>
);