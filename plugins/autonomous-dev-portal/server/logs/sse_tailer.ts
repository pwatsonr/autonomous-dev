// SPEC-015-3-03 — SSE wiring for log tailing.
//
// Glue between an external file watcher (PLAN-015-1 owns the
// file-watch primitive), the parser/filter/redact pipeline, and a
// per-client RingBuffer. The route handler instantiates one LogTailer
// per SSE connection; the tailer subscribes to line events, applies
// filter+redact+buffer, and emits frames via the supplied broadcaster.

import { LogFilter } from "./filter";
import { LogParser } from "./parser";
import { redactSecrets } from "./redact";
import { RingBuffer } from "./ring_buffer";
import type { LogEntry, LogFilterCriteria, LogStreamFrame } from "./types";

const COALESCE_MS = 1_000;

export interface FileLineSource {
    /**
     * Subscribe to newly-appended raw lines from the watched log file.
     * Returns an unsubscribe function. The line emitter MUST be a
     * fully-formed NDJSON line (no partial chunks).
     */
    subscribe(handler: (line: string) => void): () => void;
}

export interface FrameEmitter {
    emit(frame: LogStreamFrame): void;
}

export interface LogTailerDeps {
    parser?: LogParser;
    filter?: LogFilter;
    bufferBytes?: number;
    coalesceMs?: number;
    now?: () => Date;
}

/**
 * Per-connection log tailer. Wires up a file watcher to a filter +
 * redactor + ring buffer + frame emitter. Truncated events are
 * coalesced within `coalesceMs` so a flood of evictions never floods
 * the client.
 */
export class LogTailer {
    private readonly parser: LogParser;
    private readonly filter: LogFilter;
    private readonly buffer: RingBuffer<LogEntry>;
    private readonly coalesceMs: number;
    private readonly now: () => Date;
    private unsubscribe: (() => void) | null = null;
    private pendingTruncated = 0;
    private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastEmittedTimestamp: string | undefined;

    constructor(
        private readonly source: FileLineSource,
        private readonly emitter: FrameEmitter,
        private readonly criteria: LogFilterCriteria,
        deps: LogTailerDeps = {},
    ) {
        this.parser = deps.parser ?? new LogParser();
        this.filter = deps.filter ?? new LogFilter();
        this.buffer = new RingBuffer<LogEntry>(deps.bufferBytes);
        this.coalesceMs = deps.coalesceMs ?? COALESCE_MS;
        this.now = deps.now ?? ((): Date => new Date());
    }

    /** Subscribe to the source; idempotent. */
    start(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = this.source.subscribe((line) => this.onLine(line));
    }

    /** Replay a snapshot to the client (e.g. on connect). */
    replaySnapshot(): void {
        for (const entry of this.buffer.snapshot()) {
            if (!this.filter.matches(entry, this.criteria, this.now)) continue;
            this.emitFrame(entry);
        }
    }

    /** Replay only entries newer than the supplied Last-Event-ID. */
    replaySince(lastEventId: string | undefined): void {
        for (const entry of this.buffer.takeSince(lastEventId)) {
            if (!this.filter.matches(entry, this.criteria, this.now)) continue;
            this.emitFrame(entry);
        }
    }

    /** Emit a heartbeat frame. */
    heartbeat(): void {
        this.emitter.emit({ event: "heartbeat", data: { reason: "ping" } });
    }

    /** Tear down: unsubscribe and clear buffer. */
    stop(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        if (this.coalesceTimer) {
            clearTimeout(this.coalesceTimer);
            this.coalesceTimer = null;
        }
        this.buffer.clear();
    }

    /** Visible to tests. */
    getBufferSize(): { count: number; bytes: number } {
        return this.buffer.size();
    }

    private onLine(line: string): void {
        const entry = this.parser.parseLine(line);
        if (!entry) return;
        const { evicted } = this.buffer.push(entry);
        if (evicted > 0) this.scheduleTruncated(evicted);
        if (!this.filter.matches(entry, this.criteria, this.now)) return;
        this.emitFrame(entry);
    }

    private emitFrame(entry: LogEntry): void {
        const redacted = redactSecrets(entry);
        this.lastEmittedTimestamp = redacted.timestamp;
        this.emitter.emit({
            event: "log-line",
            data: redacted,
            id: redacted.timestamp,
        });
    }

    private scheduleTruncated(evicted: number): void {
        this.pendingTruncated += evicted;
        if (this.coalesceTimer) return;
        this.coalesceTimer = setTimeout(() => {
            const total = this.pendingTruncated;
            this.pendingTruncated = 0;
            this.coalesceTimer = null;
            this.emitter.emit({
                event: "truncated",
                data: {
                    reason: `ring buffer overflow; evicted ${String(total)} entries`,
                },
            });
        }, this.coalesceMs);
    }

    /** For symmetry with route handlers reading Last-Event-ID. */
    getLastEmittedTimestamp(): string | undefined {
        return this.lastEmittedTimestamp;
    }
}
