// SPEC-015-1-01 — Public types for the FileWatcher.
//
// Backends:
//   - 'native'  : node:fs.watch (preferred; backed by FSEvents on macOS,
//                  inotify on Linux).
//   - 'polling' : per-file setInterval + stat comparison fallback.
// 'mixed' is reported by FileWatcher.getMode() when both backends are
// active simultaneously (e.g. EMFILE on a subset of paths).

export type WatchMode = "native" | "polling";

export type FileEventType = "change" | "create" | "delete" | "error";

export interface FileChangeEvent {
    type: FileEventType;
    /** Absolute, canonical (post-realpath) path. */
    filePath: string;
    /** Event emit time, AFTER debounce. */
    timestamp: Date;
    /** Which backend produced the underlying signal. */
    mode: WatchMode;
    /** Populated only when type === 'error'. */
    error?: Error;
}

export interface FileWatcherLogger {
    warn: (msg: string, ...args: unknown[]) => void;
}

export interface FileWatcherOptions {
    /** Force polling mode regardless of native availability. Default: false. */
    polling?: boolean;
    /** Polling interval in ms. Default: 1000. Must be >= 100. */
    pollingInterval?: number;
    /** Debounce window in ms. Default: 200. Set to 0 to disable. */
    debounceDelay?: number;
    /** Max native watchers before forcing polling mode. Default: 100. */
    maxFileDescriptors?: number;
    /** Optional logger for diagnostic output (defaults to console.warn). */
    logger?: FileWatcherLogger;
}
