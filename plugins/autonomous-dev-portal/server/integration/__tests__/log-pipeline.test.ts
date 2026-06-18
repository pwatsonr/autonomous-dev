// SPEC-030-2-04 — log pipeline tests.

import {
    appendFileSync,
    mkdtempSync,
    renameSync,
    rmSync,
    truncateSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogPipeline } from "../log-pipeline";
import type { LogPayload } from "../log-pipeline";
import type { PipelineErrorPayload } from "../pipeline-types";

// Generous, uniform bound for every single watcher-driven event wait.
//
// These tests are deterministic — each one awaits the *actual* event
// (never a fixed sleep) and isolates its own temp dir. The historical
// flake (#451) was NOT primarily a too-tight timeout: the polling
// FileWatcher seeded its mtime baseline on its first *async* tick, so a
// write landing in the window between `await start()` resolving and that
// tick was absorbed into the baseline and the first change was lost
// forever — a true hang, not a slow path. That race is fixed at the
// source (FileWatcher.attachPolling now seeds the baseline synchronously)
// and the debounce is disabled below to drop a second starvable timer
// hop. With those in place, detection is bounded by roughly one polling
// interval plus, under heavy parallel load, one event-loop starvation
// window (~1.5s observed worst case). 5s gives ~3x headroom while still
// failing fast when something is genuinely broken (the happy path
// resolves in well under 1s).
const EVENT_TIMEOUT_MS = 5000;

// Per-`it` wall-clock budget. Must exceed the sum of the EVENT_TIMEOUT_MS
// waits a test performs *sequentially* (concurrent waits only cost the
// max, not the sum) so that a genuine hang surfaces as the descriptive
// `TimeoutError` below rather than Bun's bare per-test timeout. Tests
// with multiple sequential phases (truncation / rotation / unlink) get
// MULTI_PHASE_TEST_TIMEOUT_MS instead.
const SINGLE_PHASE_TEST_TIMEOUT_MS = 15_000;
const MULTI_PHASE_TEST_TIMEOUT_MS = 30_000;

const VALID = (sec = 0, message = "hello"): string =>
    JSON.stringify({
        ts: `2026-05-02T00:00:0${String(sec)}.000Z`,
        level: "info",
        message,
        source: "daemon",
    });

class TimeoutError extends Error {
    constructor(public readonly waitedMs: number, public readonly forEvent: string) {
        super(`timed out after ${String(waitedMs)}ms waiting for ${forEvent}`);
    }
}

function waitFor<T>(
    register: (cb: (value: T) => void) => void,
    timeoutMs: number,
    label: string,
): Promise<T> {
    return new Promise<T>((resolveP, rejectP) => {
        const t = setTimeout(() => rejectP(new TimeoutError(timeoutMs, label)), timeoutMs);
        register((v: T) => {
            clearTimeout(t);
            resolveP(v);
        });
    });
}

/** Collect N events of a kind into an array; resolves once N have arrived. */
function collectN<T>(
    register: (cb: (value: T) => void) => void,
    count: number,
    timeoutMs: number,
    label: string,
): Promise<T[]> {
    return new Promise<T[]>((resolveP, rejectP) => {
        const out: T[] = [];
        const t = setTimeout(
            () =>
                rejectP(
                    new TimeoutError(
                        timeoutMs,
                        `${label} (got ${String(out.length)}/${String(count)})`,
                    ),
                ),
            timeoutMs,
        );
        register((v: T) => {
            out.push(v);
            if (out.length >= count) {
                clearTimeout(t);
                resolveP(out);
            }
        });
    });
}

describe("LogPipeline", () => {
    let dir: string;
    let filePath: string;
    let pipeline: LogPipeline | undefined;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "log-pipeline-"));
        filePath = join(dir, "log.jsonl");
        writeFileSync(filePath, "");
    });

    afterEach(async () => {
        await pipeline?.stop();
        pipeline = undefined;
        rmSync(dir, { recursive: true, force: true });
    });

    function newPipeline(startAt?: "beginning" | "end"): LogPipeline {
        return new LogPipeline({
            filePath,
            ...(startAt !== undefined ? { startAt } : {}),
            pollingIntervalMs: 100,
            // Debounce disabled (flush synchronously). In polling mode the
            // poll itself already coalesces writes (one event per interval
            // when mtime advances), so a debounce window adds no value here
            // — it only stacks a SECOND starvable `setTimeout` hop on top
            // of the poll's `setInterval`. Under full-suite load each hop
            // can be deferred by a saturated event loop; removing it
            // roughly halved the worst-case detection latency in load
            // testing (~3.2s → ~1.6s). See #451.
            debounceMs: 0,
        });
    }

    it("emits exactly one 'data' event for a valid appended line (startAt=end)", async () => {
        // Pre-write 3 historical lines; they must NOT be emitted.
        appendFileSync(filePath, VALID(0) + "\n" + VALID(1) + "\n" + VALID(2) + "\n");
        pipeline = newPipeline();
        await pipeline.start();
        const got = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            EVENT_TIMEOUT_MS,
            "data",
        );
        appendFileSync(filePath, VALID(3, "new line") + "\n");
        const payload = await got;
        expect(payload.message).toBe("new line");
        expect(payload.level).toBe("info");
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);

    it("emits all historical lines when startAt=beginning", async () => {
        appendFileSync(filePath, VALID(0) + "\n" + VALID(1) + "\n" + VALID(2) + "\n");
        pipeline = newPipeline("beginning");
        const datas = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            3,
            EVENT_TIMEOUT_MS,
            "data x3",
        );
        await pipeline.start();
        const arr = await datas;
        expect(arr).toHaveLength(3);
        expect(arr[0]?.ts).toBe("2026-05-02T00:00:00.000Z");
        expect(arr[2]?.ts).toBe("2026-05-02T00:00:02.000Z");
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);

    it("emits exactly 100 'data' events for 10 batches of 10 appends", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const datas = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            100,
            EVENT_TIMEOUT_MS,
            "data x100",
        );
        for (let batch = 0; batch < 10; batch += 1) {
            const lines: string[] = [];
            for (let i = 0; i < 10; i += 1) {
                lines.push(VALID(0, `b${String(batch)}i${String(i)}`));
            }
            appendFileSync(filePath, lines.join("\n") + "\n");
            // Tiny delay to let each batch flush as its own watcher event.
            await new Promise((r) => setTimeout(r, 30));
        }
        const arr = await datas;
        expect(arr).toHaveLength(100);
        // Spot-check first and last
        expect(arr[0]?.message).toBe("b0i0");
        expect(arr[99]?.message).toBe("b9i9");
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);

    it("emits 'error' (JSON_PARSE) for malformed line; pipeline keeps running", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            EVENT_TIMEOUT_MS,
            "error",
        );
        const dataP = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            EVENT_TIMEOUT_MS,
            "data",
        );
        appendFileSync(filePath, "{ this is not json\n" + VALID(0, "after-bad") + "\n");
        const err = await errP;
        expect(err.code).toBe("JSON_PARSE");
        const data = await dataP;
        expect(data.message).toBe("after-bad");
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);

    it("emits 'error' (SCHEMA_VALIDATION) for parses-but-invalid line", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            EVENT_TIMEOUT_MS,
            "error",
        );
        appendFileSync(filePath, "{}\n");
        const err = await errP;
        expect(err.code).toBe("SCHEMA_VALIDATION");
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);

    it("redacts PII before emission (alice@example.test → [REDACTED]@example.test)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const dataP = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            EVENT_TIMEOUT_MS,
            "data",
        );
        const piiLine = JSON.stringify({
            ts: "2026-05-02T00:00:00.000Z",
            level: "info",
            message: "login from alice@example.test",
            source: "daemon",
        });
        appendFileSync(filePath, piiLine + "\n");
        const payload = await dataP;
        // Literal PII must not appear in the emitted payload's message.
        expect(payload.message).not.toContain("alice@example.test");
        // The domain is preserved by the redactor's contract.
        expect(payload.message).toContain("[REDACTED]@example.test");
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);

    it("handles in-place truncation (TRUNCATION_DETECTED + recovered)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        // Emit 5 lines, then truncate, then 2 fresh lines.
        const fivePromise = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            5,
            EVENT_TIMEOUT_MS,
            "first 5 datas",
        );
        for (let i = 0; i < 5; i += 1) {
            appendFileSync(filePath, VALID(0, `pre-${String(i)}`) + "\n");
            await new Promise((r) => setTimeout(r, 5));
        }
        await fivePromise;

        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            EVENT_TIMEOUT_MS,
            "truncation error",
        );
        const recoveredP = waitFor<void>(
            (cb) => pipeline!.on("recovered", () => cb(undefined)),
            EVENT_TIMEOUT_MS,
            "recovered",
        );
        truncateSync(filePath, 0);
        const err = await errP;
        expect(err.code).toBe("TRUNCATION_DETECTED");
        await recoveredP;

        const post = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            2,
            EVENT_TIMEOUT_MS,
            "post-truncation datas",
        );
        appendFileSync(filePath, VALID(0, "post-0") + "\n" + VALID(0, "post-1") + "\n");
        const arr = await post;
        expect(arr.map((p) => p.message)).toEqual(["post-0", "post-1"]);
    }, MULTI_PHASE_TEST_TIMEOUT_MS);

    it("handles rotation (rename + recreate → ROTATION_DETECTED + recovered)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        // Emit a few lines first.
        const preP = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            3,
            EVENT_TIMEOUT_MS,
            "pre datas",
        );
        appendFileSync(
            filePath,
            VALID(0, "p0") + "\n" + VALID(0, "p1") + "\n" + VALID(0, "p2") + "\n",
        );
        await preP;

        // Rotation: rename current file out, recreate fresh.
        renameSync(filePath, filePath + ".1");
        writeFileSync(filePath, "");

        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            EVENT_TIMEOUT_MS,
            "rotation error",
        );
        const recoveredP = waitFor<void>(
            (cb) => pipeline!.on("recovered", () => cb(undefined)),
            EVENT_TIMEOUT_MS,
            "recovered",
        );
        // Append a line on the new file to trigger a watcher event.
        appendFileSync(filePath, VALID(0, "after-rotate") + "\n");

        const err = await errP;
        // Either ROTATION_DETECTED (inode change observed) or
        // WATCHER_ENOENT followed by recovery is acceptable on platforms
        // where the rename is observed as delete+create. Accept either
        // recovery path; both end with a 'recovered' + new 'data'.
        expect(["ROTATION_DETECTED", "WATCHER_ENOENT"]).toContain(err.code);
        await recoveredP;

        const dataP = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            EVENT_TIMEOUT_MS,
            "post-rotate data",
        );
        // If the after-rotate write happened before the rotation was
        // observed, append one more to ensure a fresh event fires.
        appendFileSync(filePath, VALID(0, "after-rotate-2") + "\n");
        const post = await dataP;
        expect(["after-rotate", "after-rotate-2"]).toContain(post.message);
    }, MULTI_PHASE_TEST_TIMEOUT_MS);

    it("handles partial-line writes (no JSON_PARSE for the partial bytes)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        // Track all data + error events; assert no JSON_PARSE for the
        // partial bytes that come in across two writes.
        const errors: PipelineErrorPayload[] = [];
        pipeline.on("error", (e) => {
            errors.push(e);
        });
        const dataP = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            EVENT_TIMEOUT_MS,
            "data",
        );

        const full = VALID(0, "split-line");
        const half = full.slice(0, Math.floor(full.length / 2));
        const rest = full.slice(half.length);
        appendFileSync(filePath, half);
        await new Promise((r) => setTimeout(r, 80));
        appendFileSync(filePath, rest + "\n");

        const payload = await dataP;
        expect(payload.message).toBe("split-line");
        const parseErrors = errors.filter((e) => e.code === "JSON_PARSE");
        expect(parseErrors).toHaveLength(0);
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);

    it("emits WATCHER_ENOENT and 'recovered' on unlink + recreate", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            EVENT_TIMEOUT_MS,
            "error",
        );
        const recoveredP = waitFor<void>(
            (cb) => pipeline!.on("recovered", () => cb(undefined)),
            EVENT_TIMEOUT_MS,
            "recovered",
        );
        unlinkSync(filePath);
        const err = await errP;
        expect(err.code).toBe("WATCHER_ENOENT");
        // Recreate the file. The polling backend re-baselines on first
        // sight after a delete (lastMtime===null branch) and suppresses
        // the very first event, so we follow up with a real change to
        // force a 'change' / 'create' event the pipeline can observe.
        writeFileSync(filePath, "");
        await new Promise((r) => setTimeout(r, 200));
        appendFileSync(filePath, VALID(0, "after-recover") + "\n");
        await recoveredP;

        const dataP = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            EVENT_TIMEOUT_MS,
            "data after recovery",
        );
        // Either the previous write already produced a 'data' event or a
        // follow-up append will. Append once more for determinism.
        appendFileSync(filePath, VALID(0, "after-recover-2") + "\n");
        const data = await dataP;
        expect(["after-recover", "after-recover-2"]).toContain(data.message);
    }, MULTI_PHASE_TEST_TIMEOUT_MS);

    it("start() and stop() are idempotent", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        await expect(pipeline.start()).resolves.toBeUndefined();
        await pipeline.stop();
        await expect(pipeline.stop()).resolves.toBeUndefined();
    });

    it("typed error payload uses 'code', not message strings", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            EVENT_TIMEOUT_MS,
            "error",
        );
        appendFileSync(filePath, "not-json\n");
        const err = await errP;
        expect(err.code).toBe("JSON_PARSE");
        // `message` is for logs only; downstream MUST branch on `code`.
        expect(typeof err.code).toBe("string");
    }, SINGLE_PHASE_TEST_TIMEOUT_MS);
});
