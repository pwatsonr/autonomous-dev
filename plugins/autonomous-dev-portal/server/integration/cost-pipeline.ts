// SPEC-030-2-03 — Cost live-data pipeline.
//
// Source artifact: `<request>/.autonomous-dev/cost.json` (rewritable
// JSON document — NOT append-only). On each watcher event the entire
// file is re-read, schema-validated via `parseCostLedger`, URL
// `?api_key=` query parameters are redacted via the local
// `redact-url.ts` helper (TDD-030 OQ-30-07: do NOT modify
// `redaction.ts`), and exactly one `data` event is emitted per change.

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";

import { FileWatcher } from "../watchers/FileWatcher";
import type { FileChangeEvent } from "../watchers/types";
import { parseCostLedger } from "../readers/schemas/cost";
import type { CostLedger } from "../readers/types";

import type { Pipeline, PipelineErrorPayload } from "./pipeline-types";
import { redactPayloadUrls } from "./redact-url";

export type CostPayload = CostLedger;

export interface CostPipelineConfig {
    /** Absolute path to the watched cost.json file. */
    filePath: string;
    /** Test seam: force polling with this interval (ms). */
    pollingIntervalMs?: number;
    /** Test seam: debounce window (default 25ms). */
    debounceMs?: number;
}

const COST_DEBOUNCE_MS = 25;

/**
 * Pipeline implementing `Pipeline<CostPayload>`. Watches a JSON file
 * and emits one `'data'` event per successful read of the rewritten
 * document. Coalesces rapid-fire watcher events: at most one read is
 * in-flight at any time, with at most one further re-run scheduled.
 */
export class CostPipeline implements Pipeline<CostPayload> {
    private readonly emitter = new EventEmitter();
    private watcher?: FileWatcher;
    private started = false;
    private fileExists = true;

    /** Coalescing: a single in-flight read + at-most-one rerun pending. */
    private inflight: Promise<void> | null = null;
    private rerunPending = false;

    constructor(private readonly cfg: CostPipelineConfig) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        const watcherOpts: ConstructorParameters<typeof FileWatcher>[1] = {
            debounceDelay: this.cfg.debounceMs ?? COST_DEBOUNCE_MS,
            logger: { warn: () => undefined },
        };
        if (this.cfg.pollingIntervalMs !== undefined) {
            watcherOpts.polling = true;
            watcherOpts.pollingInterval = this.cfg.pollingIntervalMs;
        }
        this.watcher = new FileWatcher([this.cfg.filePath], watcherOpts);
        this.watcher.on("fileChange", (event: FileChangeEvent) => {
            this.scheduleRead(event);
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

    on(event: "data", listener: (p: CostPayload) => void): void;
    on(event: "error", listener: (e: PipelineErrorPayload) => void): void;
    on(event: "recovered", listener: () => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void {
        this.emitter.on(event, listener as (...args: unknown[]) => void);
    }

    private scheduleRead(event: FileChangeEvent): void {
        if (event.type === "error") {
            this.emitError("WATCHER_ERROR", event.error);
            return;
        }

        if (event.type === "delete") {
            this.fileExists = false;
            this.emitError("WATCHER_ENOENT");
            return;
        }

        if (event.type === "create" && !this.fileExists) {
            this.fileExists = true;
            this.emitter.emit("recovered");
        } else {
            this.fileExists = true;
        }

        if (this.inflight) {
            this.rerunPending = true;
            return;
        }
        this.inflight = this.runRead().finally(() => {
            this.inflight = null;
            if (this.rerunPending) {
                this.rerunPending = false;
                // Schedule one more read; not awaited to keep the
                // event-loop hop tight.
                this.inflight = this.runRead().finally(() => {
                    this.inflight = null;
                });
            }
        });
    }

    private async runRead(): Promise<void> {
        let raw: string;
        try {
            raw = await fs.readFile(this.cfg.filePath, "utf-8");
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === "ENOENT") {
                this.fileExists = false;
                this.emitError("WATCHER_ENOENT", err);
                return;
            }
            this.emitError("WATCHER_ERROR", err);
            return;
        }

        if (raw.length === 0) {
            this.emitError("EMPTY_FILE");
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            this.emitError("JSON_PARSE", err);
            return;
        }

        const result = parseCostLedger(parsed);
        if (!result.ok || !result.value) {
            this.emitError(
                "SCHEMA_VALIDATION",
                new Error(result.error ?? "schema invalid"),
            );
            return;
        }

        const redacted = redactPayloadUrls(result.value);
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
