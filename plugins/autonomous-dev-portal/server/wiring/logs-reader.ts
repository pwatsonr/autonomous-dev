// BUG-14 — LogsReader interface and implementation for live daemon logs.
//
// Reads log lines from ~/.autonomous-dev/logs/daemon.log and ~/.autonomous-dev/portal/portal.log
// using the LogReader class. Provides fallback to stub data when log files are unavailable.
// Supports query parameter filters for level and limit.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LogLine as RenderLogLine } from "../types/render";
import { LogReader } from "../readers/LogReader";
import { AggregationCache } from "../cache/AggregationCache";
import { stateDirRoot } from "./state-paths";

export interface LogsReader {
    readLogs(options?: LogsReadOptions): Promise<RenderLogLine[]>;
}

export interface LogsReadOptions {
    /** Maximum number of logs to return. Default 100, max 500. */
    limit?: number;
    /** Filter logs by level. */
    level?: string;
    /** Only entries since this timestamp (ISO string). */
    since?: string;
}

/**
 * Live logs reader that tails daemon.log and portal.log files.
 * Falls back to stub data when log files are unavailable.
 */
export class FileLogsReader implements LogsReader {
    private readonly cache: AggregationCache;
    private readonly logReader: LogReader;

    constructor() {
        this.cache = new AggregationCache({ defaultTTLMs: 2000 });
        this.logReader = new LogReader({
            basePath: this.getBasePath(),
            cache: this.cache,
        });
    }

    private getBasePath(): string {
        // The LogReader expects <basePath>/.autonomous-dev/daemon.log
        // stateDirRoot() returns ~/.autonomous-dev, so we need the parent
        const stateDir = stateDirRoot(); // ~/.autonomous-dev
        const parentDir = join(stateDir, "..");
        return parentDir;
    }

    private daemonLogPath(): string {
        return join(stateDirRoot(), "daemon.log");
    }

    private portalLogPath(): string {
        return join(stateDirRoot(), "portal", "portal.log");
    }

    async readLogs(options: LogsReadOptions = {}): Promise<RenderLogLine[]> {
        const limit = Math.min(500, Math.max(1, options.limit ?? 100));

        // Try to read from daemon log first using LogReader
        const logResult = await this.logReader.readRecent({
            limit,
            level: options.level ? [options.level as any] : undefined,
            since: options.since,
        });

        if (logResult.ok && logResult.value.length > 0) {
            // Convert from reader LogLine format to render LogLine format
            return logResult.value.map(this.convertLogLine);
        }

        // Fallback: check portal log manually
        try {
            const portalLines = await this.readPortalLog(limit);
            if (portalLines.length > 0) {
                return portalLines;
            }
        } catch {
            // Continue to stub fallback
        }

        // Final fallback: return stub data but with current timestamp
        return this.getStubData();
    }

    private async readPortalLog(limit: number): Promise<RenderLogLine[]> {
        const path = this.portalLogPath();
        try {
            const content = await readFile(path, "utf-8");
            const lines = content.trim().split('\n').slice(-limit);

            return lines
                .filter(line => line.trim())
                .map((line, index) => {
                    try {
                        const parsed = JSON.parse(line);
                        return {
                            ts: parsed.timestamp || parsed.ts || new Date().toISOString(),
                            level: (parsed.level || "info").toLowerCase(),
                            message: parsed.message || line,
                        };
                    } catch {
                        // Plain text line
                        return {
                            ts: new Date().toISOString(),
                            level: "info",
                            message: line,
                        };
                    }
                });
        } catch {
            return [];
        }
    }

    private convertLogLine(logLine: any): RenderLogLine {
        return {
            ts: logLine.ts,
            level: logLine.level,
            message: logLine.message,
        };
    }

    private getStubData(): RenderLogLine[] {
        const now = new Date().toISOString();
        return [
            { ts: now, level: "info", message: "Portal started - no daemon logs found" },
            { ts: now, level: "warn", message: "Daemon log file not available" },
            { ts: now, level: "info", message: "Displaying fallback log entries" },
        ];
    }

    shutdown(): void {
        this.cache.shutdown();
    }
}