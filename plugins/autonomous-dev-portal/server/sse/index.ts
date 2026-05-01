// SPEC-015-1-02 — Barrel export for the SSE module.
export { SSEEventBus } from "./SSEEventBus";
export { Connection } from "./Connection";
export type { WriteResult } from "./Connection";
export {
    formatSSE,
    generateConnectionId,
    generateEventId,
    SequenceCounter,
} from "./EventProtocol";
export { HeartbeatManager } from "./HeartbeatManager";
export type {
    ConnectionState,
    ConnectionStats,
    SSELogger,
    SSEServerOptions,
    SSEStreamLike,
} from "./types";
