// SPEC-030-2-02 — Heartbeat live-data pipeline.
//
// Source artifact: `<request>/.autonomous-dev/heartbeat.jsonl` (append-only).
// Pattern: FileWatcher → schema-validate → emit. No redaction (per
// TDD-030 §6.2 the heartbeat schema is PII-free).
//
// This pipeline is the pattern lock: cost-pipeline.ts and log-pipeline.ts
// copy the structure verbatim and only change schema + redaction details.

import { EventEmitter } from "node:events";
import { promises as fs, statSync } from "node:fs";

import { FileWatcher } from "../watchers/FileWatcher";
import type { FileChangeEvent } from "../watchers/types";
import { parseHeartbeat } from "../readers/schemas/heartbeat";
import type { Heartbeat } from "../readers/types";

import type { Pipeline, PipelineErrorPayload } from "./pipeline-types";

export type HeartbeatPayload = Heartbeat;

export interface HeartbeatPipelineConfig {
    /** Absolute path to the watched heartbeat.jsonl file. */
    filePath: string;
    /** Test seam: force polling with this interval (ms). */
    pollingIntervalMs?: number;
    /** Test seam: debounce window (default 25ms). */
    debounceMs?: number;
}

const HEARTBEAT_DEBOUNCE_MS = 25;

/**
 * Pipeline implementing `Pipeline<Heartbeat>`. Watches a JSONL file and
 * emits one `'data'` event per valid line appended after `start()`. The
 * starting offset is the file's size at start time so historical lines
 * are not re-emitted.
 */
export class HeartbeatPipeline implements Pipeline<HeartbeatPayload> {
    private readonly emitter = new EventEmitter();
    private watcher?: FileWatcher;
    private offset = 0;
    private buffer = "";
    private fileExists = true;
    private started = false;

    constructor(private readonly cfg: HeartbeatPipelineConfig) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        try {
            const st = statSync(this.cfg.filePath);
            this.offset = st.size;
            this.fileExists = true;
        } catch {
            this.offset = 0;
            this.fileExists = false;
        }

        const watcherOpts: ConstructorParameters<typeof FileWatcher>[1] = {
            debounceDelay: this.cfg.debounceMs ?? HEARTBEAT_DEBOUNCE_MS,
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

    on(event: "data", listener: (p: HeartbeatPayload) => void): void;
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
            this.buffer = "";
            this.emitError("WATCHER_ENOENT");
            return;
        }

        if (event.type === "create" && !this.fileExists) {
            this.fileExists = true;
            this.offset = 0;
            this.buffer = "";
            this.emitter.emit("recovered");
        }

        await this.readNewLines();
    }

    private async readNewLines(): Promise<void> {
        let st: { size: number };
        try {
            st = await fs.stat(this.cfg.filePath);
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === "ENOENT") {
                this.fileExists = false;
                this.offset = 0;
                this.buffer = "";
                this.emitError("WATCHER_ENOENT", err);
                return;
            }
            this.emitError("WATCHER_ERROR", err);
            return;
        }

        if (st.size < this.offset) {
            // Truncation — restart from zero.
            this.offset = 0;
            this.buffer = "";
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
        const result = parseHeartbeat(parsed);
        if (!result.ok || !result.value) {
            this.emitError("SCHEMA_VALIDATION", new Error(result.error ?? "schema invalid"));
            return;
        }
        this.emitter.emit("data", result.value);
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
