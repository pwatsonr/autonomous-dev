// SPEC-015-1-01 — FileWatcher: native fs.watch + polling fallback +
// 200ms debounce coalescing.
//
// The watcher is a pure infrastructure primitive. It emits typed
// FileChangeEvent objects to listeners; it does NOT parse files,
// invalidate caches, or speak SSE. SPEC-015-1-03 / SPEC-015-1-04 attach
// downstream wiring.

import { EventEmitter } from "node:events";
import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";

import { resolvePatterns } from "./glob-resolver";
import type {
    FileChangeEvent,
    FileEventType,
    FileWatcherLogger,
    FileWatcherOptions,
    WatchMode,
} from "./types";

const DEFAULTS = {
    polling: false,
    pollingInterval: 1000,
    debounceDelay: 200,
    maxFileDescriptors: 100,
} as const;

interface PendingEvent {
    type: FileEventType;
    error?: Error;
    mode: WatchMode;
    firstSeenAt: number;
}

/**
 * FileWatcher monitors a list of absolute path patterns and emits
 * `'fileChange'` events on a debounce window. See SPEC-015-1-01 for
 * full lifecycle / backend semantics.
 */
export class FileWatcher extends EventEmitter {
    private readonly patterns: readonly string[];
    private readonly opts: Required<Omit<FileWatcherOptions, "logger">> & {
        logger: FileWatcherLogger;
    };

    private nativeWatchers = new Map<string, FSWatcher>();
    private pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
    private pollingMtimes = new Map<string, number | null>(); // null = baseline-not-yet-set
    private pollingExisted = new Map<string, boolean>();

    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingEvents = new Map<string, PendingEvent>();

    private started = false;
    private disposed = false;

    constructor(patterns: readonly string[], options: FileWatcherOptions = {}) {
        super();
        this.patterns = [...patterns];
        this.opts = {
            polling: options.polling ?? DEFAULTS.polling,
            pollingInterval: Math.max(
                100,
                options.pollingInterval ?? DEFAULTS.pollingInterval,
            ),
            debounceDelay: Math.max(0, options.debounceDelay ?? DEFAULTS.debounceDelay),
            maxFileDescriptors:
                options.maxFileDescriptors ?? DEFAULTS.maxFileDescriptors,
            logger: options.logger ?? { warn: console.warn.bind(console) },
        };
    }

    /** Begin watching. Throws on second call or after dispose. */
    async start(): Promise<void> {
        if (this.disposed) {
            throw new Error("FileWatcher has been disposed");
        }
        if (this.started) {
            throw new Error("FileWatcher already started");
        }
        this.started = true;

        const files = await resolvePatterns(this.patterns, this.opts.logger);

        let nativeCount = 0;
        for (const file of files) {
            if (this.opts.polling) {
                this.attachPolling(file);
                continue;
            }

            if (nativeCount >= this.opts.maxFileDescriptors) {
                this.attachPolling(file);
                continue;
            }

            const ok = this.attachNative(file);
            if (ok) {
                nativeCount += 1;
                if (nativeCount === this.opts.maxFileDescriptors) {
                    this.opts.logger.warn(
                        `FileWatcher: native fd budget reached (${String(nativeCount)}); remaining files use polling`,
                    );
                }
            } else {
                // attachNative failed; fall back to polling for this file
                // only. Other native watchers continue.
                this.attachPolling(file);
            }
        }
    }

    /** Idempotent. Closes all watchers and timers; emits no further events. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        for (const w of this.nativeWatchers.values()) {
            try {
                w.close();
            } catch {
                // ignore close errors during disposal
            }
        }
        this.nativeWatchers.clear();

        for (const t of this.pollingTimers.values()) {
            clearInterval(t);
        }
        this.pollingTimers.clear();
        this.pollingMtimes.clear();
        this.pollingExisted.clear();

        for (const t of this.debounceTimers.values()) {
            clearTimeout(t);
        }
        this.debounceTimers.clear();
        this.pendingEvents.clear();

        this.removeAllListeners();
    }

    isWatching(): boolean {
        return this.started && !this.disposed;
    }

    getWatchedFiles(): string[] {
        const set = new Set<string>();
        for (const k of this.nativeWatchers.keys()) set.add(k);
        for (const k of this.pollingTimers.keys()) set.add(k);
        return Array.from(set).sort();
    }

    getMode(): WatchMode | "mixed" {
        const hasNative = this.nativeWatchers.size > 0;
        const hasPolling = this.pollingTimers.size > 0;
        if (hasNative && hasPolling) return "mixed";
        if (hasNative) return "native";
        return "polling";
    }

    // -- internals --

    private attachNative(filePath: string): boolean {
        try {
            const watcher = fsWatch(
                filePath,
                { persistent: false },
                (eventType) => {
                    // Both 'rename' and 'change' map to 'change'. A rename
                    // observed mid-flight may indicate temp+rename atomic
                    // write; treating it as 'change' lines up with the
                    // file content actually changing on disk.
                    const type: FileEventType =
                        eventType === "rename" ? "change" : "change";
                    this.handleRawEvent(filePath, type, "native");
                },
            );
            watcher.on("error", (err) => {
                this.handleRawEvent(filePath, "error", "native", err);
            });
            this.nativeWatchers.set(filePath, watcher);
            return true;
        } catch (err) {
            this.opts.logger.warn(
                `FileWatcher: fs.watch failed for "${filePath}" (${(err as Error).message}); falling back to polling for this file`,
            );
            return false;
        }
    }

    private attachPolling(filePath: string): void {
        // Mark the baseline-not-yet-set sentinel so the first poll is
        // suppressed (no synthetic events on start()).
        this.pollingMtimes.set(filePath, null);
        this.pollingExisted.set(filePath, false);

        const tick = async (): Promise<void> => {
            if (this.disposed) return;
            try {
                const stat = await fs.stat(filePath);
                const mtime = stat.mtimeMs;
                const lastMtime = this.pollingMtimes.get(filePath);
                const existed = this.pollingExisted.get(filePath) ?? false;

                if (lastMtime === null) {
                    // Baseline establishment; suppress emission.
                    this.pollingMtimes.set(filePath, mtime);
                    this.pollingExisted.set(filePath, true);
                    return;
                }

                if (!existed) {
                    // File reappeared after a delete.
                    this.pollingMtimes.set(filePath, mtime);
                    this.pollingExisted.set(filePath, true);
                    this.handleRawEvent(filePath, "create", "polling");
                    return;
                }

                if (mtime > (lastMtime ?? 0)) {
                    this.pollingMtimes.set(filePath, mtime);
                    this.handleRawEvent(filePath, "change", "polling");
                }
            } catch (err) {
                const e = err as { code?: string } & Error;
                const existed = this.pollingExisted.get(filePath) ?? false;
                if (e.code === "ENOENT") {
                    if (existed) {
                        this.pollingExisted.set(filePath, false);
                        this.pollingMtimes.set(filePath, null);
                        this.handleRawEvent(filePath, "delete", "polling");
                    }
                    // If file never existed, emit nothing (silent baseline).
                    return;
                }
                this.handleRawEvent(filePath, "error", "polling", e);
            }
        };

        const timer = setInterval(() => {
            void tick();
        }, this.opts.pollingInterval);
        // Run an immediate poll to establish the baseline ASAP.
        void tick();
        this.pollingTimers.set(filePath, timer);
    }

    private handleRawEvent(
        filePath: string,
        type: FileEventType,
        mode: WatchMode,
        error?: Error,
    ): void {
        if (this.disposed) return;

        // Update / merge the pending event. Errors take precedence and are
        // never overwritten by non-error types.
        const existing = this.pendingEvents.get(filePath);
        let merged: PendingEvent;
        if (existing && existing.type === "error") {
            merged = existing;
        } else {
            merged = {
                type,
                error,
                mode,
                firstSeenAt: existing?.firstSeenAt ?? Date.now(),
            };
        }
        this.pendingEvents.set(filePath, merged);

        if (this.opts.debounceDelay === 0) {
            this.flushPending(filePath);
            return;
        }

        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) clearTimeout(existingTimer);
        const t = setTimeout(() => {
            this.flushPending(filePath);
        }, this.opts.debounceDelay);
        this.debounceTimers.set(filePath, t);
    }

    private flushPending(filePath: string): void {
        const pending = this.pendingEvents.get(filePath);
        this.pendingEvents.delete(filePath);
        const timer = this.debounceTimers.get(filePath);
        if (timer) clearTimeout(timer);
        this.debounceTimers.delete(filePath);

        if (this.disposed || !pending) return;

        const event: FileChangeEvent = {
            type: pending.type,
            filePath,
            timestamp: new Date(),
            mode: pending.mode,
        };
        if (pending.error) event.error = pending.error;

        try {
            this.emit("fileChange", event);
        } catch (err) {
            // A buggy listener must NOT cascade into an event loop. Log
            // and swallow.
            this.opts.logger.warn(
                `FileWatcher: listener for fileChange threw: ${(err as Error).message}`,
            );
        }
    }
}

export type { FileChangeEvent, FileWatcherOptions, WatchMode } from "./types";
