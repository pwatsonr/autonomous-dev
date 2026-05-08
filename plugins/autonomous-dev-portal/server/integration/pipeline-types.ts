/**
 * Public surface implemented by the live-data pipelines under
 * server/integration/{cost,heartbeat,log}-pipeline.ts.
 *
 * See TDD-030 §6.3. This is an interface, not a base class — see
 * NG-3004 for why no abstraction is extracted from state-pipeline.ts.
 */
export type PipelineEvent = "data" | "error" | "recovered";

export interface PipelineErrorPayload {
    /** Categorical failure mode; assert on this, NEVER on the message string. */
    readonly code: string;
    /** Optional underlying cause (e.g., a watcher error). */
    readonly cause?: unknown;
    /** Human-readable description; for logs only, not for branching. */
    readonly message?: string;
}

export interface Pipeline<E> {
    /**
     * Begin watching the source artifact. Resolves once the watcher is
     * attached and the pipeline is ready to emit. Idempotent: a second
     * start() while already running is a no-op (NOT an error).
     */
    start(): Promise<void>;

    /**
     * Stop watching and release resources. Resolves after the watcher is
     * fully detached. Idempotent: a second stop() while already stopped
     * is a no-op.
     */
    stop(): Promise<void>;

    /**
     * Subscribe to a pipeline lifecycle event.
     *  - 'data'      → listener receives a typed E payload
     *  - 'error'     → listener receives a PipelineErrorPayload
     *  - 'recovered' → listener receives nothing (void)
     *
     * Multiple listeners per event are permitted (registered in order).
     * No 'off' / 'removeListener' API is required by this contract — the
     * pipeline is single-process, single-consumer in production.
     */
    on(event: "data", listener: (payload: E) => void): void;
    on(event: "error", listener: (err: PipelineErrorPayload) => void): void;
    on(event: "recovered", listener: () => void): void;
}
