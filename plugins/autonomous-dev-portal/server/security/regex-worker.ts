// SPEC-014-3-02 §regex-worker — Worker-thread entrypoint for RegexSandbox.
//
// Loaded by RegexSandbox via `new Worker(import.meta.resolve('./regex-worker.ts'))`
// (Bun ships native TS worker support — no separate compile step needed for
// the portal's runtime). Receives `{pattern, flags, input}` via workerData,
// runs `regex.exec` exactly once, posts back `{matches, groups, executionTime}`.
//
// Hard rules:
//   1. NO project module imports beyond `node:worker_threads`. The worker
//      must have ZERO access to fs, net, or portal state.
//   2. NO worker-side timeout — the regex engine holds the event loop and
//      a setTimeout inside the worker would never fire. The main-thread
//      `worker.terminate()` is the single source of truth.
//   3. NEVER log to stderr — keep the worker silent so a malicious
//      pattern cannot pollute portal logs.

import { parentPort, workerData } from "node:worker_threads";

import type { RegexResult, RegexTask } from "./types";

if (parentPort === null) {
    // Loaded directly (not as a worker) — defensive exit.
    process.exit(1);
}

const task = workerData as RegexTask;

try {
    const regex = new RegExp(task.pattern, task.flags);
    const start = Date.now();
    const result = regex.exec(task.input);
    const executionTime = Date.now() - start;
    const message: RegexResult = {
        matches: result !== null,
        groups: result ? result.slice(1) : [],
        executionTime,
    };
    parentPort.postMessage(message);
} catch (err) {
    const message: RegexResult = {
        matches: false,
        error: err instanceof Error ? err.message : String(err),
    };
    parentPort.postMessage(message);
}
