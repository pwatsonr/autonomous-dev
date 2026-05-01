// SPEC-015-1-01 — Barrel export for watchers module.
export { FileWatcher } from "./FileWatcher";
export { resolvePatterns } from "./glob-resolver";
export type {
    FileChangeEvent,
    FileEventType,
    FileWatcherLogger,
    FileWatcherOptions,
    WatchMode,
} from "./types";
