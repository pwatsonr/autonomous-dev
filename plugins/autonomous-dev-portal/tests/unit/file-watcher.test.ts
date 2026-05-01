// SPEC-015-1-05 — FileWatcher: debounce, coalesce, polling fallback,
// lifecycle.
//
// Each test uses an ephemeral tmp dir created via `mkdtempSync` so
// concurrent test workers do not collide. `afterEach` calls
// `dispose()` and removes the tmp dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileWatcher } from "../../server/watchers/FileWatcher";
import type { FileChangeEvent } from "../../server/watchers/types";

interface Ctx {
    dir: string;
    watcher: FileWatcher | null;
    events: FileChangeEvent[];
}

const ctx: Ctx = { dir: "", watcher: null, events: [] };

function recordEvents(w: FileWatcher): FileChangeEvent[] {
    const acc: FileChangeEvent[] = [];
    w.on("fileChange", (ev: FileChangeEvent) => acc.push(ev));
    return acc;
}

beforeEach(() => {
    ctx.dir = mkdtempSync(join(tmpdir(), "fw-test-"));
    ctx.watcher = null;
    ctx.events = [];
});

afterEach(() => {
    if (ctx.watcher) {
        try {
            ctx.watcher.dispose();
        } catch {
            // already disposed
        }
        ctx.watcher = null;
    }
    rmSync(ctx.dir, { recursive: true, force: true });
});

async function wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

describe("FileWatcher", () => {
    test("start() resolves; pre-existing files emit zero events at baseline", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w = new FileWatcher([file], { debounceDelay: 50 });
        ctx.watcher = w;
        ctx.events = recordEvents(w);
        await w.start();
        await wait(120);
        expect(ctx.events.length).toBe(0);
    });

    test("atomic write to a watched file emits one debounced change event", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w = new FileWatcher([file], { debounceDelay: 80 });
        ctx.watcher = w;
        ctx.events = recordEvents(w);
        await w.start();
        await wait(50);
        await fs.writeFile(file, '{"phase":"executing"}');
        await wait(250);
        // At least 1 event; coalesce keeps it small.
        expect(ctx.events.length).toBeGreaterThanOrEqual(1);
        expect(ctx.events.length).toBeLessThanOrEqual(2);
        expect(["change", "create"]).toContain(ctx.events[0]!.type);
    });

    test("rapid burst of writes coalesces to ≤ small N events", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w = new FileWatcher([file], { debounceDelay: 100 });
        ctx.watcher = w;
        ctx.events = recordEvents(w);
        await w.start();
        await wait(50);
        // 20 writes within ~80ms → debounce should produce 1–2 emits
        for (let i = 0; i < 20; i += 1) {
            await fs.writeFile(file, `{"i":${String(i)}}`);
        }
        await wait(300);
        expect(ctx.events.length).toBeGreaterThanOrEqual(1);
        // Allow generous upper bound; spec target is ≤ 5/100 events.
        expect(ctx.events.length).toBeLessThanOrEqual(5);
    });

    test("polling-only mode reports getMode() === 'polling'", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w = new FileWatcher([file], {
            polling: true,
            pollingInterval: 100,
            debounceDelay: 50,
        });
        ctx.watcher = w;
        await w.start();
        expect(w.getMode()).toBe("polling");
        ctx.events = recordEvents(w);
        await wait(50);
        await fs.writeFile(file, '{"x":1}');
        await wait(400);
        expect(ctx.events.length).toBeGreaterThanOrEqual(1);
    });

    test("dispose() is idempotent and closes cleanly", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w = new FileWatcher([file], { debounceDelay: 50 });
        ctx.watcher = w;
        await w.start();
        w.dispose();
        // Second dispose must not throw.
        w.dispose();
        ctx.watcher = null;
    });

    test("start() after dispose() rejects", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w = new FileWatcher([file]);
        await w.start();
        w.dispose();
        await expect(w.start()).rejects.toThrow(/disposed/i);
    });

    test("double start() rejects", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w = new FileWatcher([file]);
        ctx.watcher = w;
        await w.start();
        await expect(w.start()).rejects.toThrow(/already started/i);
    });

    test("patterns matching zero files succeed and emit nothing", async () => {
        const ghost = join(ctx.dir, "does-not-exist", "*.json");
        const w = new FileWatcher([ghost], { debounceDelay: 50 });
        ctx.watcher = w;
        ctx.events = recordEvents(w);
        await w.start();
        await wait(120);
        expect(ctx.events.length).toBe(0);
    });

    test("close + reopen lifecycle: dispose then construct fresh", async () => {
        const file = join(ctx.dir, "state.json");
        writeFileSync(file, "{}");
        const w1 = new FileWatcher([file], { debounceDelay: 60 });
        await w1.start();
        await fs.writeFile(file, '{"a":1}');
        await wait(150);
        w1.dispose();

        // Fresh watcher on the same path resumes cleanly.
        const w2 = new FileWatcher([file], { debounceDelay: 60 });
        ctx.watcher = w2;
        const events2 = recordEvents(w2);
        await w2.start();
        await wait(50);
        await fs.writeFile(file, '{"a":2}');
        await wait(200);
        expect(events2.length).toBeGreaterThanOrEqual(1);
    });
});
