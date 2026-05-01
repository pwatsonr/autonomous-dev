// SPEC-015-1-03 — Wire FileWatcher → AggregationCache → SSEEventBus
// for daemon state.json + events.jsonl files.

import { sep } from "node:path";

import type { AggregationCache } from "../cache/AggregationCache";
import type { FileChangeEvent } from "../watchers/types";
import type { FileWatcher } from "../watchers/FileWatcher";
import type { SSEEventBus } from "../sse/SSEEventBus";
import type { StateReader } from "../readers/StateReader";
import type { RequestState } from "../readers/types";

export interface StatePipelineDeps {
    watcher: FileWatcher;
    cache: AggregationCache;
    bus: SSEEventBus;
    reader: StateReader;
    basePath: string;
    logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

const REQ_ID_RE = /REQ-\d{6}/;

export interface PipelineHandle {
    dispose: () => void;
}

/**
 * Subscribes the watcher to:
 *   - state.json changes → cache invalidate + state-change SSE broadcast
 *   - events.jsonl changes → phase-history pattern invalidation
 * Errors are logged but never propagated to the SSE bus.
 */
export function wireStatePipeline(deps: StatePipelineDeps): PipelineHandle {
    const logger = deps.logger ?? { warn: console.warn.bind(console) };

    const handler = (event: FileChangeEvent): void => {
        if (event.type === "error") {
            logger.warn(
                `state-pipeline: file watcher error on ${event.filePath}: ${event.error?.message ?? "unknown"}`,
            );
            return;
        }
        const filePath = event.filePath;
        const stateMatch = matchStateJson(filePath, deps.basePath);
        if (stateMatch) {
            void handleStateChange(deps, stateMatch);
            return;
        }
        const eventsMatch = matchEventsJsonl(filePath, deps.basePath);
        if (eventsMatch) {
            deps.cache.invalidatePattern(
                new RegExp(`^phase-history:${escapeRegex(eventsMatch)}:`),
            );
        }
    };

    deps.watcher.on("fileChange", handler);

    let disposed = false;
    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            deps.watcher.off("fileChange", handler);
        },
    };
}

async function handleStateChange(
    deps: StatePipelineDeps,
    requestId: string,
): Promise<void> {
    // Snapshot the previous phase BEFORE invalidating the cache so we can
    // include it in the SSE payload as `old_phase`.
    const previous = await deps.cache.get<RequestState>(`state:${requestId}`);
    const oldPhase = previous?.phase ?? null;

    deps.cache.invalidate(`state:${requestId}`);
    deps.cache.invalidatePattern(/^(all-states|state-counts):/);

    const result = await deps.reader.readState(requestId);
    if (!result.ok) {
        (deps.logger ?? console).warn(
            `state-pipeline: re-read failed for ${requestId}: ${result.error.message}`,
        );
        return;
    }
    if (!result.value) {
        // File was deleted — no broadcast in this spec; clients fetch
        // /states on next poll.
        return;
    }

    await deps.bus.broadcast({
        type: "state-change",
        payload: {
            request_id: requestId,
            old_phase: oldPhase,
            new_phase: result.value.phase,
            repository: result.value.repository,
        },
    });
}

function matchStateJson(filePath: string, basePath: string): string | null {
    const prefix = basePath.endsWith(sep) ? basePath : basePath + sep;
    if (!filePath.startsWith(prefix)) return null;
    const rest = filePath.slice(prefix.length);
    // Expect: .autonomous-dev/requests/REQ-NNNNNN/state.json
    const parts = rest.split(sep);
    if (
        parts.length !== 4 ||
        parts[0] !== ".autonomous-dev" ||
        parts[1] !== "requests" ||
        parts[3] !== "state.json"
    ) {
        return null;
    }
    const id = parts[2] ?? "";
    if (!REQ_ID_RE.test(id) || id.length !== 10) return null;
    return id;
}

function matchEventsJsonl(filePath: string, basePath: string): string | null {
    const prefix = basePath.endsWith(sep) ? basePath : basePath + sep;
    if (!filePath.startsWith(prefix)) return null;
    const rest = filePath.slice(prefix.length);
    const parts = rest.split(sep);
    if (
        parts.length !== 4 ||
        parts[0] !== ".autonomous-dev" ||
        parts[1] !== "requests" ||
        parts[3] !== "events.jsonl"
    ) {
        return null;
    }
    const id = parts[2] ?? "";
    if (!REQ_ID_RE.test(id) || id.length !== 10) return null;
    return id;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
