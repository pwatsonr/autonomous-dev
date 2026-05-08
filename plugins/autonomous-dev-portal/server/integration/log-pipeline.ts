// SPEC-030-2-04 — Log live-data pipeline.
//
// Source artifact: `<request>/log.jsonl` (append-only JSONL stream — NOT a
// rewritable JSON document; this is the key semantic difference from
// cost-pipeline). The pipeline tracks the last-read byte offset, only
// processes new lines on each watcher event, runs every entry through
// `redactLogLine(...)` before emission, and emits one `'data'` event per
// redacted entry.
//
// Two behaviors set log-pipeline apart from heartbeat:
//   1. Offset tracking — only new bytes since the last read are processed.
//   2. Truncation / rotation detection — if file size shrinks or the inode
//      changes, reset offset to 0 and reprocess from the start (after
//      emitting an `'error'` + `'recovered'` pair).

import { EventEmitter } from "node:events";
import { promises as fs, statSync } from "node:fs";

import { FileWatcher } from "../watchers/FileWatcher";
import type { FileChangeEvent } from "../watchers/types";
import { parseStructuredLogLine } from "../readers/schemas/log";
import { redactLogLine } from "../readers/redaction";
import type { LogLine } from "../readers/types";

import type { Pipeline, PipelineErrorPayload } from "./pipeline-types";

export type LogPayload = LogLine;

export interface LogPipelineConfig {
    /** Absolute path to the watched log.jsonl file. */
    filePath: string;
    /**
     * Where to start reading. Default: 'end' — historical lines present at
     * `start()` time are NOT emitted. Set to 'beginning' to backfill the
     * full file on attach.
     */
    startAt?: "beginning" | "end";
    /** Test seam: force polling with this interval (ms). */
    pollingIntervalMs?: number;
    /** Test seam: debounce window (default 25ms). */
    debounceMs?: number;
}

const LOG_DEBOUNCE_MS = 25;

/**
 * Pipeline implementing `Pipeline<LogPayload>`. Watches an append-only
 * JSONL file and emits one `'data'` event per valid line, AFTER the line
 * has been processed through `redactLogLine`. Handles in-place truncation
 * and rotate-and-recreate (inode change) by resetting the offset to 0 and
 * emitting an `'error'` + `'recovered'` pair before continuing.
 *
 * Per AC-5: the only `emitter.emit('data', ...)` call site in this file
 * passes the **redacted** form — never the raw parsed line.
 */
export class LogPipeline implements Pipeline<LogPayload> {
    private readonly emitter = new EventEmitter();
    private watcher?: FileWatcher;
    private offset = 0;
    private inode = 0;
    private buffer = ""; // partial-line buffer across reads
    private fileExists = true;
    private started = false;

    constructor(private readonly cfg: LogPipelineConfig) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        try {
            const st = statSync(this.cfg.filePath);
            this.inode = st.ino;
            this.offset = this.cfg.startAt === "beginning" ? 0 : st.size;
            this.fileExists = true;
        } catch {
            this.inode = 0;
            this.offset = 0;
            this.fileExists = false;
        }

        const watcherOpts: ConstructorParameters<typeof FileWatcher>[1] = {
            debounceDelay: this.cfg.debounceMs ?? LOG_DEBOUNCE_MS,
            logger: { warn: () => undefined },
        };
        if (this.cfg.pollingIntervalMs !== undefined) {
            watcherOpts.polling = true;
            watcherOpts.pollingInterval = this.cfg.pollingIntervalMs;
        }
        this.watcher = new FileWatcher([this.cfg.filePath], watcherOpts);
        this.watcher.on("fileChange", (event: FileChangeEvent) => {
            void this.handleEvent(event);
        });
        await this.watcher.start();

        // If startAt === 'beginning' and the file already exists, drain
        // historical lines now so callers do not need to wait for a
        // watcher event.
        if (this.cfg.startAt === "beginning" && this.fileExists) {
            await this.readNewLines();
        }
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
        this.emitter.removeAllListeners();
    }

    on(event: "data", listener: (p: LogPayload) => void): void;
    on(event: "error", listener: (e: PipelineErrorPayload) => void): void;
    on(event: "recovered", listener: () => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void {
        this.emitter.on(event, listener as (...args: unknown[]) => void);
    }

    private async handleEvent(event: FileChangeEvent): Promise<void> {
        if (event.type === "error") {
            this.emitError("WATCHER_ERROR", event.error);
            return;
        }

        if (event.type === "delete") {
            this.fileExists = false;
            this.offset = 0;
            this.inode = 0;
            this.buffer = "";
            this.emitError("WATCHER_ENOENT");
            return;
        }

        if (
            (event.type === "create" || event.type === "change") &&
            !this.fileExists
        ) {
            // 'create' is the polling backend's recovery signal; native
            // backends sometimes report a 'change' on the recreate path
            // (e.g., when an editor's atomic-replace pattern is observed
            // out-of-order). Treat both as recovery when fileExists is
            // false.
            this.fileExists = true;
            this.offset = 0;
            this.inode = 0;
            this.buffer = "";
            this.emitter.emit("recovered");
        }

        await this.readNewLines();
    }

    private async readNewLines(): Promise<void> {
        let st: { size: number; ino: number };
        try {
            st = await fs.stat(this.cfg.filePath);
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === "ENOENT") {
                this.fileExists = false;
                this.offset = 0;
                this.inode = 0;
                this.buffer = "";
                this.emitError("WATCHER_ENOENT", err);
                return;
            }
            this.emitError("WATCHER_ERROR", err);
            return;
        }

        // Rotation detection: inode changed (Linux/macOS guarantee unique
        // ino per file; on Windows ino may be 0 — fall back to the
        // size<offset sentinel below).
        if (this.inode !== 0 && st.ino !== 0 && st.ino !== this.inode) {
            this.emitError("ROTATION_DETECTED");
            this.offset = 0;
            this.inode = st.ino;
            this.buffer = "";
            this.emitter.emit("recovered");
        } else if (this.inode === 0) {
            // First successful stat — record the inode.
            this.inode = st.ino;
        }

        // In-place truncation: file shrank without a rotation.
        if (st.size < this.offset) {
            this.emitError("TRUNCATION_DETECTED");
            this.offset = 0;
            this.buffer = "";
            this.emitter.emit("recovered");
        }

        if (st.size === this.offset) return;

        let raw: string;
        try {
            const handle = await fs.open(this.cfg.filePath, "r");
            try {
                const length = st.size - this.offset;
                const buf = Buffer.alloc(length);
                await handle.read(buf, 0, length, this.offset);
                raw = buf.toString("utf8");
            } finally {
                await handle.close();
            }
        } catch (err) {
            this.emitError("WATCHER_ERROR", err);
            return;
        }

        this.offset = st.size;
        const combined = this.buffer + raw;
        const parts = combined.split("\n");
        // The last element is the partial trailing fragment (or '' when
        // the buffer ended on a newline). It becomes the next-read prefix.
        this.buffer = parts.pop() ?? "";

        for (const line of parts) {
            if (line.length === 0) continue;
            this.processLine(line);
        }
    }

    private processLine(line: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (err) {
            this.emitError("JSON_PARSE", err);
            return;
        }
        const result = parseStructuredLogLine(parsed);
        if (!result.ok || !result.value) {
            this.emitError(
                "SCHEMA_VALIDATION",
                new Error(result.error ?? "schema invalid"),
            );
            return;
        }
        // AC-5 / AC-6: the redacted form is the ONLY thing emitted on
        // 'data'. Never emit the raw parsed line.
        const redacted = redactLogLine(result.value);
        this.emitter.emit("data", redacted);
    }

    private emitError(code: string, cause?: unknown): void {
        const payload: PipelineErrorPayload = {
            code,
            cause,
            message: cause instanceof Error ? cause.message : undefined,
        };
        this.emitter.emit("error", payload);
    }
}
