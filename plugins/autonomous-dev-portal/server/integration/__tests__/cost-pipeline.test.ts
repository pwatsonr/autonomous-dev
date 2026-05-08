// SPEC-030-2-03 — cost pipeline tests.

import {
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CostPipeline } from "../cost-pipeline";
import { redactPayloadUrls, stripApiKeyParams } from "../redact-url";
import type { CostLedger } from "../../readers/types";
import type { PipelineErrorPayload } from "../pipeline-types";

const FIXTURES = resolve(__dirname, "fixtures");

function readFixture(name: string): string {
    return readFileSync(join(FIXTURES, name), "utf-8");
}

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
    return new Promise<T>((resolve_, reject) => {
        const t = setTimeout(() => reject(new TimeoutError(timeoutMs, label)), timeoutMs);
        register((v: T) => {
            clearTimeout(t);
            resolve_(v);
        });
    });
}

function collectFor<T>(
    register: (cb: (value: T) => void) => void,
    windowMs: number,
): Promise<T[]> {
    return new Promise<T[]>((resolve_) => {
        const items: T[] = [];
        register((v: T) => items.push(v));
        setTimeout(() => resolve_(items), windowMs);
    });
}

describe("CostPipeline", () => {
    let dir: string;
    let filePath: string;
    let pipeline: CostPipeline | undefined;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "cost-pipeline-"));
        filePath = join(dir, "cost.json");
    });

    afterEach(async () => {
        await pipeline?.stop();
        pipeline = undefined;
        rmSync(dir, { recursive: true, force: true });
    });

    function newPipeline(): CostPipeline {
        return new CostPipeline({
            filePath,
            pollingIntervalMs: 100,
            debounceMs: 10,
        });
    }

    it("emits one 'data' event after a valid cost.json is written", async () => {
        // Pre-create empty file so FileWatcher establishes baseline.
        writeFileSync(filePath, "{}");
        pipeline = newPipeline();
        await pipeline.start();
        const got = waitFor<CostLedger>(
            (cb) => pipeline!.on("data", cb),
            3000,
            "data",
        );
        // Sleep so FileWatcher polling baseline is set before we change.
        await new Promise((r) => setTimeout(r, 150));
        writeFileSync(filePath, readFixture("cost-valid.json"));
        const payload = await got;
        expect(payload.version).toBe(1);
        expect(payload.total_usd).toBeCloseTo(1.2345);
    }, 6000);

    it("re-emits 'data' on rewrite", async () => {
        writeFileSync(filePath, readFixture("cost-valid.json"));
        pipeline = newPipeline();
        await pipeline.start();
        await new Promise((r) => setTimeout(r, 150));

        const second = waitFor<CostLedger>(
            (cb) => pipeline!.on("data", cb),
            3000,
            "data2",
        );
        const ledger = JSON.parse(readFixture("cost-valid.json")) as CostLedger;
        ledger.total_usd = 9.99;
        ledger.daily_usd["2026-05-02"] = 9.99;
        ledger.per_request["REQ-000001"] = 9.99;
        ledger.entries[0]!.delta_usd = 9.99;
        writeFileSync(filePath, JSON.stringify(ledger));
        const payload = await second;
        expect(payload.total_usd).toBeCloseTo(9.99);
    }, 6000);

    it("redacts api_key URL params before emitting", async () => {
        writeFileSync(filePath, "{}");
        pipeline = newPipeline();
        await pipeline.start();
        await new Promise((r) => setTimeout(r, 150));
        const got = waitFor<CostLedger>(
            (cb) => pipeline!.on("data", cb),
            3000,
            "data",
        );
        writeFileSync(filePath, readFixture("cost-with-api-key.json"));
        const payload = await got;
        const stringified = JSON.stringify(payload);
        expect(stringified).not.toContain("SECRETXYZ");
        expect(stringified).toContain("api_key=REDACTED");
    }, 6000);

    it("emits 'error' with code JSON_PARSE for malformed JSON", async () => {
        writeFileSync(filePath, "{}");
        pipeline = newPipeline();
        await pipeline.start();
        await new Promise((r) => setTimeout(r, 150));
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            3000,
            "error",
        );
        writeFileSync(filePath, readFixture("cost-malformed.json"));
        const err = await errP;
        expect(err.code).toBe("JSON_PARSE");
    }, 6000);

    it("emits 'error' with code SCHEMA_VALIDATION for valid-JSON-but-bad-shape", async () => {
        writeFileSync(filePath, '{"v":0}');
        pipeline = newPipeline();
        await pipeline.start();
        await new Promise((r) => setTimeout(r, 150));
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            3000,
            "error",
        );
        writeFileSync(filePath, "{}");
        const err = await errP;
        expect(err.code).toBe("SCHEMA_VALIDATION");
    }, 6000);

    it("emits 'error' with code EMPTY_FILE for an empty cost.json", async () => {
        writeFileSync(filePath, "{}");
        pipeline = newPipeline();
        await pipeline.start();
        await new Promise((r) => setTimeout(r, 150));
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            3000,
            "error",
        );
        writeFileSync(filePath, "");
        const err = await errP;
        expect(err.code).toBe("EMPTY_FILE");
    }, 6000);

    it("emits WATCHER_ENOENT then 'recovered' on unlink+recreate", async () => {
        writeFileSync(filePath, readFixture("cost-valid.json"));
        pipeline = newPipeline();
        await pipeline.start();
        await new Promise((r) => setTimeout(r, 150));

        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            3000,
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
        writeFileSync(filePath, readFixture("cost-valid.json"));
        await recoveredP;
    }, 8000);

    it("coalesces rapid rewrites — emits at most 2 'data' events", async () => {
        writeFileSync(filePath, readFixture("cost-valid.json"));
        pipeline = newPipeline();
        await pipeline.start();

        // Wait for initial settle
        await new Promise((r) => setTimeout(r, 200));

        const events = collectFor<CostLedger>(
            (cb) => pipeline!.on("data", cb),
            500,
        );
        // 5 rapid sync rewrites in the same tick — debouncer + coalescer
        // should produce at most 2 emits.
        for (let i = 0; i < 5; i += 1) {
            const ledger = JSON.parse(readFixture("cost-valid.json")) as CostLedger;
            ledger.total_usd = i;
            ledger.daily_usd["2026-05-02"] = i;
            ledger.per_request["REQ-000001"] = i;
            ledger.entries[0]!.delta_usd = i;
            writeFileSync(filePath, JSON.stringify(ledger));
        }
        const got = await events;
        expect(got.length).toBeLessThanOrEqual(2);
    }, 5000);

    it("start() and stop() are idempotent", async () => {
        pipeline = newPipeline();
        await pipeline.start();
        await expect(pipeline.start()).resolves.toBeUndefined();
        await pipeline.stop();
        await expect(pipeline.stop()).resolves.toBeUndefined();
    });

    it("typed error payloads use 'code' field, not message strings", async () => {
        writeFileSync(filePath, "{}");
        pipeline = newPipeline();
        await pipeline.start();
        await new Promise((r) => setTimeout(r, 150));
        const errP = waitFor<PipelineErrorPayload>(
            (cb) => pipeline!.on("error", cb),
            3000,
            "error",
        );
        writeFileSync(filePath, readFixture("cost-malformed.json"));
        const err = await errP;
        expect(typeof err.code).toBe("string");
        expect(err.code).toBe("JSON_PARSE");
    }, 6000);
});

describe("redact-url helpers", () => {
    it("stripApiKeyParams replaces api_key value with REDACTED", () => {
        const out = stripApiKeyParams(
            "https://api.example.com/v1?api_key=SECRET&q=foo",
        );
        expect(out).toContain("api_key=REDACTED");
        expect(out).toContain("q=foo");
        expect(out).not.toContain("SECRET");
    });

    it("stripApiKeyParams handles case-insensitive Api-Key", () => {
        const out = stripApiKeyParams(
            "https://api.example.com/v1?Api-Key=SECRET",
        );
        expect(out).toContain("REDACTED");
        expect(out).not.toContain("SECRET");
    });

    it("stripApiKeyParams returns input unchanged for non-URL", () => {
        expect(stripApiKeyParams("not-a-url")).toBe("not-a-url");
    });

    it("stripApiKeyParams returns input unchanged for URL without api_key", () => {
        const u = "https://api.example.com/v1";
        expect(stripApiKeyParams(u)).toBe(u);
    });

    it("redactPayloadUrls walks nested objects/arrays", () => {
        const input = {
            outer: {
                arr: ["https://x?api_key=SECRET", "plain"],
                deep: { url: "https://y?api_key=A" },
            },
            num: 1,
            null_field: null,
        };
        const out = redactPayloadUrls(input);
        expect(JSON.stringify(out)).not.toContain("SECRET");
        expect((out as typeof input).num).toBe(1);
        expect((out as typeof input).null_field).toBeNull();
    });
});
