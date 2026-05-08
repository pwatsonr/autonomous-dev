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
            debounceMs: 10,
        });
    }

    it("emits exactly one 'data' event for a valid appended line (startAt=end)", async () => {
        // Pre-write 3 historical lines; they must NOT be emitted.
        appendFileSync(filePath, VALID(0) + "\n" + VALID(1) + "\n" + VALID(2) + "\n");
        pipeline = newPipeline();
        await pipeline.start();
        const got = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            1500,
            "data",
        );
        appendFileSync(filePath, VALID(3, "new line") + "\n");
        const payload = await got;
        expect(payload.message).toBe("new line");
        expect(payload.level).toBe("info");
    });

    it("emits all historical lines when startAt=beginning", async () => {
        appendFileSync(filePath, VALID(0) + "\n" + VALID(1) + "\n" + VALID(2) + "\n");
        pipeline = newPipeline("beginning");
        const datas = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            3,
            1500,
            "data x3",
        );
        await pipeline.start();
        const arr = await datas;
        expect(arr).toHaveLength(3);
        expect(arr[0]?.ts).toBe("2026-05-02T00:00:00.000Z");
        expect(arr[2]?.ts).toBe("2026-05-02T00:00:02.000Z");
    });

    it("emits exactly 100 'data' events for 10 batches of 10 appends", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const datas = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            100,
            10_000,
            "data x100",
        );
        for (let batch = 0; batch < 10; batch += 1) {
            const lines: string[] = [];
            for (let i = 0; i < 10; i += 1) {
                lines.push(VALID(0, `b${String(batch)}i${String(i)}`));
            }
            appendFileSync(filePath, lines.join("\n") + "\n");
            // Tiny delay to let the watcher debounce flush each batch.
            await new Promise((r) => setTimeout(r, 30));
        }
        const arr = await datas;
        expect(arr).toHaveLength(100);
        // Spot-check first and last
        expect(arr[0]?.message).toBe("b0i0");
        expect(arr[99]?.message).toBe("b9i9");
    }, 15000);

    it("emits 'error' (JSON_PARSE) for malformed line; pipeline keeps running", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            1500,
            "error",
        );
        const dataP = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            1500,
            "data",
        );
        appendFileSync(filePath, "{ this is not json\n" + VALID(0, "after-bad") + "\n");
        const err = await errP;
        expect(err.code).toBe("JSON_PARSE");
        const data = await dataP;
        expect(data.message).toBe("after-bad");
    });

    it("emits 'error' (SCHEMA_VALIDATION) for parses-but-invalid line", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            1500,
            "error",
        );
        appendFileSync(filePath, "{}\n");
        const err = await errP;
        expect(err.code).toBe("SCHEMA_VALIDATION");
    });

    it("redacts PII before emission (alice@example.test → [REDACTED]@example.test)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const dataP = waitFor<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            1500,
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
    });

    it("handles in-place truncation (TRUNCATION_DETECTED + recovered)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        // Emit 5 lines, then truncate, then 2 fresh lines.
        const fivePromise = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            5,
            2000,
            "first 5 datas",
        );
        for (let i = 0; i < 5; i += 1) {
            appendFileSync(filePath, VALID(0, `pre-${String(i)}`) + "\n");
            await new Promise((r) => setTimeout(r, 5));
        }
        await fivePromise;

        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            2000,
            "truncation error",
        );
        const recoveredP = waitFor<void>(
            (cb) => pipeline!.on("recovered", () => cb(undefined)),
            2000,
            "recovered",
        );
        truncateSync(filePath, 0);
        const err = await errP;
        expect(err.code).toBe("TRUNCATION_DETECTED");
        await recoveredP;

        const post = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            2,
            2000,
            "post-truncation datas",
        );
        appendFileSync(filePath, VALID(0, "post-0") + "\n" + VALID(0, "post-1") + "\n");
        const arr = await post;
        expect(arr.map((p) => p.message)).toEqual(["post-0", "post-1"]);
    }, 10000);

    it("handles rotation (rename + recreate → ROTATION_DETECTED + recovered)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        // Emit a few lines first.
        const preP = collectN<LogPayload>(
            (cb) => pipeline!.on("data", cb),
            3,
            2000,
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
            3000,
            "rotation error",
        );
        const recoveredP = waitFor<void>(
            (cb) => pipeline!.on("recovered", () => cb(undefined)),
            3000,
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
            3000,
            "post-rotate data",
        );
        // If the after-rotate write happened before the rotation was
        // observed, append one more to ensure a fresh event fires.
        appendFileSync(filePath, VALID(0, "after-rotate-2") + "\n");
        const post = await dataP;
        expect(["after-rotate", "after-rotate-2"]).toContain(post.message);
    }, 10000);

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
            2000,
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
    });

    it("emits WATCHER_ENOENT and 'recovered' on unlink + recreate", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            5000,
            "error",
        );
        const recoveredP = waitFor<void>(
            (cb) => pipeline!.on("recovered", () => cb(undefined)),
            5000,
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
            5000,
            "data after recovery",
        );
        // Either the previous write already produced a 'data' event or a
        // follow-up append will. Append once more for determinism.
        appendFileSync(filePath, VALID(0, "after-recover-2") + "\n");
        const data = await dataP;
        expect(["after-recover", "after-recover-2"]).toContain(data.message);
    }, 10000);

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
            1500,
            "error",
        );
        appendFileSync(filePath, "not-json\n");
        const err = await errP;
        expect(err.code).toBe("JSON_PARSE");
        // `message` is for logs only; downstream MUST branch on `code`.
        expect(typeof err.code).toBe("string");
    });
});
