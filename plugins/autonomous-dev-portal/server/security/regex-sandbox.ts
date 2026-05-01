// SPEC-014-3-02 §RegexSandbox — main-thread API.
//
// Runs every user-supplied `regex.test()` in a worker thread with a hard
// 100ms wall-clock timeout enforced by `worker.terminate()`. Pre-flight
// validates pattern size (≤ 512B), input size (≤ 10KB), and flag chars
// before the worker is even spawned — those checks throw SecurityError.
//
// Three observable outcomes for callers:
//   - { matches: true|false, groups, executionTime }   normal return
//   - { matches: false, timedOut: true, error: ... }   pattern killed
//   - { matches: false, error: <regex compile error> } worker-side throw
//
// Pre-flight throws are SecurityError (HTTP 4xx); all other outcomes
// resolve normally so the caller has a single result-shape to handle.

import { Worker } from "node:worker_threads";

import type { RegexResult } from "./types";
import { SecurityError } from "./types";

/** Per-call wall-clock cap enforced via worker.terminate(). */
const DEFAULT_TIMEOUT_MS = 100;

/** Grace window after terminate() to allow late `exit` cleanup. */
const HARD_KILL_GRACE_MS = 50;

/** Maximum pattern size (chars). Larger patterns reject pre-spawn. */
const MAX_PATTERN_SIZE = 512;

/** Maximum input size (UTF-16 code units). Larger reject pre-spawn. */
const MAX_INPUT_SIZE = 10 * 1024;

/** Allowed regex flag set (RegExp constructor accepts a strict subset). */
const VALID_FLAGS_RE = /^[gimsuy]*$/;

/**
 * Worker-isolated regex executor. A single instance is safe to share
 * across the process — `test()` holds no per-call state.
 */
export class RegexSandbox {
    private readonly workerScriptUrl: string;

    constructor(workerScriptUrl?: string) {
        // Allow injection so tests can point at the same worker file
        // from a different relative path. Default uses import.meta.resolve
        // which Bun honors directly for TS files at runtime.
        this.workerScriptUrl =
            workerScriptUrl ??
            new URL("./regex-worker.ts", import.meta.url).href;
    }

    /**
     * Run `pattern` against `input` in a worker thread. Pre-flight
     * validation rejects oversized inputs and bad flag strings before
     * any worker is spawned.
     */
    async test(
        pattern: string,
        input: string,
        flags = "",
    ): Promise<RegexResult> {
        if (typeof pattern !== "string" || pattern.length > MAX_PATTERN_SIZE) {
            throw new SecurityError("REGEX_PATTERN_TOO_LONG", "Pattern too long");
        }
        if (typeof input !== "string") {
            throw new SecurityError(
                "REGEX_INVALID_INPUT",
                "Input must be a string",
            );
        }
        if (input.length > MAX_INPUT_SIZE) {
            throw new SecurityError(
                "REGEX_INPUT_TOO_LARGE",
                `Input too large: ${String(input.length)} bytes (max: ${String(MAX_INPUT_SIZE)})`,
            );
        }
        if (typeof flags !== "string" || !VALID_FLAGS_RE.test(flags)) {
            throw new SecurityError(
                "REGEX_INVALID_FLAGS",
                "Invalid regex flags",
            );
        }

        return await this.runInWorker(pattern, input, flags);
    }

    private runInWorker(
        pattern: string,
        input: string,
        flags: string,
    ): Promise<RegexResult> {
        return new Promise<RegexResult>((resolve, reject) => {
            const worker = new Worker(new URL(this.workerScriptUrl), {
                workerData: { pattern, flags, input },
            });

            // Single-resolve guard — guarantees we never resolve twice
            // even if `message` and `exit` race after terminate().
            let settled = false;
            const settle = (
                kind: "resolve" | "reject",
                value: RegexResult | Error,
            ): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // terminate() is idempotent and async; we don't await
                // because the message we already received is what we
                // care about — the worker process can clean up async.
                void worker.terminate();
                if (kind === "resolve") resolve(value as RegexResult);
                else reject(value as Error);
            };

            const timer = setTimeout(() => {
                settle("resolve", {
                    matches: false,
                    timedOut: true,
                    error: `Regex execution timed out (>${String(DEFAULT_TIMEOUT_MS)}ms)`,
                });
            }, DEFAULT_TIMEOUT_MS);

            worker.on("message", (msg: RegexResult) => {
                settle("resolve", msg);
            });
            worker.on("error", (err: Error) => {
                settle(
                    "reject",
                    new SecurityError(
                        "REGEX_WORKER_ERROR",
                        `Worker error: ${err.message}`,
                    ),
                );
            });
            worker.on("exit", (code) => {
                if (settled) return;
                if (code === 0) {
                    // Exit 0 with no message — should not happen normally,
                    // but we treat it as a no-match rather than throw.
                    settle("resolve", { matches: false });
                } else {
                    settle("resolve", {
                        matches: false,
                        error: `Worker exited code ${String(code)}`,
                    });
                }
            });

            // Defensive: if the worker is still alive after the timeout
            // grace window, force-resolve. terminate() is async and may
            // queue events; the grace window keeps the API honest.
            setTimeout(() => {
                if (!settled) {
                    settle("resolve", {
                        matches: false,
                        timedOut: true,
                        error: `Regex execution timed out (>${String(DEFAULT_TIMEOUT_MS)}ms)`,
                    });
                }
            }, DEFAULT_TIMEOUT_MS + HARD_KILL_GRACE_MS).unref?.();
        });
    }
}
