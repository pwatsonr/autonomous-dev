// SPEC-015-3-03 — Log tailing types.
//
// LogEntry mirrors the daemon's NDJSON log line shape. Filter criteria
// are URL-serializable via LogFilter so /logs links are shareable.

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

export const LOG_LEVELS: ReadonlyArray<LogLevel> = [
    "ERROR",
    "WARN",
    "INFO",
    "DEBUG",
];

export interface LogEntry {
    timestamp: string; // ISO-8601 UTC
    level: LogLevel;
    pid: number;
    iteration?: number;
    message: string;
    request_id?: string; // optional REQ-NNNNNN
    context?: Record<string, unknown>;
}

export type TimeRange = "1h" | "4h" | "24h";

export interface LogFilterCriteria {
    level?: LogLevel;
    request_id?: string;
    time_range?: TimeRange;
    start_time?: string; // ISO-8601, overrides time_range when both set
    end_time?: string;
}

export interface LogStreamFrame {
    event: "log-line" | "heartbeat" | "truncated";
    data: LogEntry | { reason: string };
    id?: string;
}

export const TIME_RANGE_MS: Readonly<Record<TimeRange, number>> = {
    "1h": 3_600_000,
    "4h": 14_400_000,
    "24h": 86_400_000,
};

export const REQUEST_ID_PATTERN: RegExp = /^REQ-[0-9]{6}$/;
