// #390 regression — stale "pending" gate-decision files must never
// resurrect terminal requests, and schema-incomplete action markers must
// be surfaced (repo "unknown") instead of silently dropped.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRequestLedger } from "../../server/wiring/request-ledger-reader";

let root: string;
let actionsDir: string;
let decisionsDir: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ledger390-"));
    actionsDir = join(root, "request-actions");
    decisionsDir = join(root, "gate-decisions");
    mkdirSync(actionsDir, { recursive: true });
    mkdirSync(decisionsDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeAction(id: string, body: Record<string, unknown>): void {
    writeFileSync(join(actionsDir, `${id}.json`), JSON.stringify({ id, ...body }));
}
function writeDecision(file: string, body: Record<string, unknown>): void {
    writeFileSync(join(decisionsDir, `${file}.json`), JSON.stringify(body));
}

async function ledger() {
    return readRequestLedger({ actionsDir, decisionsDir });
}

describe("readRequestLedger terminal-status authority (#390)", () => {
    test("pending gate does NOT resurrect a failed request", async () => {
        writeAction("REQ-000017", { repo: "sandbox", status: "failed", completedAt: "2026-06-11T00:00:00Z" });
        writeDecision("sandbox__REQ-000017", { id: "REQ-000017", state: "pending", waitedMin: 180 });
        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("failed");
    });

    test("pending gate does NOT resurrect a cancelled request", async () => {
        writeAction("REQ-000016", { repo: "sandbox", status: "cancelled" });
        writeDecision("sandbox__REQ-000016", { id: "REQ-000016", state: "pending" });
        const rows = await ledger();
        expect(rows[0]!.status).toBe("cancelled");
    });

    test("pending gate does NOT resurrect a done request (completedAt only)", async () => {
        writeAction("REQ-000012", { repo: "r", status: "done", completedAt: "2026-05-20T00:00:00Z" });
        writeDecision("r__REQ-000012", { id: "REQ-000012", state: "pending" });
        const rows = await ledger();
        expect(rows[0]!.status).toBe("done");
    });

    test("pending gate STILL applies to a live (running) request", async () => {
        writeAction("REQ-000020", { repo: "r", status: "running" });
        writeDecision("r__REQ-000020", { id: "REQ-000020", state: "pending", waitedMin: 7 });
        const rows = await ledger();
        expect(rows[0]!.status).toBe("gate");
        expect(rows[0]!.waitedMin).toBe(7);
    });

    test("rejected gate does not relabel a failed request as done", async () => {
        writeAction("REQ-000021", { repo: "r", status: "failed" });
        writeDecision("r__REQ-000021", { id: "REQ-000021", state: "rejected" });
        const rows = await ledger();
        expect(rows[0]!.status).toBe("failed");
    });
});

describe("readRequestLedger no-silent-drop (#390)", () => {
    test("action file without repo renders as repo 'unknown' instead of vanishing", async () => {
        writeAction("REQ-000008", { status: "cancelled", completedAt: "2026-05-17T00:00:00Z" });
        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe("REQ-000008");
        expect(rows[0]!.repo).toBe("unknown");
        expect(rows[0]!.status).toBe("cancelled");
    });

    test("action file without id is still skipped (no identity)", async () => {
        writeFileSync(join(actionsDir, "noid.json"), JSON.stringify({ repo: "r", status: "running" }));
        const rows = await ledger();
        expect(rows).toHaveLength(0);
    });
});
