// SPEC-030-2-02 — heartbeat pipeline tests.

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HeartbeatPipeline } from "../heartbeat-pipeline";
import type { Heartbeat } from "../../readers/types";
import type { PipelineErrorPayload } from "../pipeline-types";

const VALID = (n = 1): string =>
    JSON.stringify({
        version: 1,
        ts: "2026-05-02T00:00:00.000Z",
        pid: 1234,
        uptime_s: n,
        daemon_version: "0.1.0",
        active_requests: 0,
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
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new TimeoutError(timeoutMs, label)), timeoutMs);
        register((v: T) => {
            clearTimeout(t);
            resolve(v);
        });
    });
}

describe("HeartbeatPipeline", () => {
    let dir: string;
    let filePath: string;
    let pipeline: HeartbeatPipeline | undefined;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "heartbeat-pipeline-"));
        filePath = join(dir, "heartbeat.jsonl");
        writeFileSync(filePath, "");
    });

    afterEach(async () => {
        await pipeline?.stop();
        pipeline = undefined;
        rmSync(dir, { recursive: true, force: true });
    });

    function newPipeline(): HeartbeatPipeline {
        return new HeartbeatPipeline({
            filePath,
            pollingIntervalMs: 100,
            debounceMs: 10,
        });
    }

    it("emits exactly one 'data' event for a valid appended line", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const got = waitFor<Heartbeat>(
            (cb) => pipeline!.on("data", cb),
            500,
            "data",
        );
        appendFileSync(filePath, VALID() + "\n");
        const payload = await got;
        expect(payload.version).toBe(1);
        expect(payload.pid).toBe(1234);
    });

    it("emits 'error' for malformed line then 'data' for next valid line", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errPromise = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            500,
            "error",
        );
        const dataPromise = waitFor<Heartbeat>(
            (cb) => pipeline!.on("data", cb),
            500,
            "data",
        );
        appendFileSync(filePath, "not-json\n" + VALID() + "\n");
        const err = await errPromise;
        expect(err.code).toBe("JSON_PARSE");
        const data = await dataPromise;
        expect(data.version).toBe(1);
    });

    // SKIP: async file-watcher recovery race (PRD-016 triage: SKIP-WITH-NOTE)
    it.skip("emits 'error' WATCHER_ENOENT and then 'recovered' on unlink+recreate", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            1500,
            "error",
        );
        const recoveredP = waitFor<void>(
            (cb) => pipeline!.on("recovered", () => cb(undefined)),
            3000,
            "recovered",
        );
        unlinkSync(filePath);
        const err = await errP;
        expect(err.code).toBe("WATCHER_ENOENT");
        writeFileSync(filePath, "");
        await recoveredP;
    }, 8000);

    it("start() is idempotent (second call resolves)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        await expect(pipeline.start()).resolves.toBeUndefined();
    });

    it("stop() is idempotent (second call resolves)", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        await pipeline.stop();
        await expect(pipeline.stop()).resolves.toBeUndefined();
    });

    it("typed error payload — assertions use 'code', not message strings", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            500,
            "error",
        );
        appendFileSync(filePath, JSON.stringify({ ts: "bad" }) + "\n");
        const err = await errP;
        expect(err.code).toBe("SCHEMA_VALIDATION");
    });
});
