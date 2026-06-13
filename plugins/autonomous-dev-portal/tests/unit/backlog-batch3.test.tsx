// #396 batch 3 — phase-vocabulary normalization, audit config-change
// section, honest error-banner copy (no fabricated "cached snapshot").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizePhase, readRequestLedger } from "../../server/wiring/request-ledger-reader";
import { groupRequestsByPhase } from "../../server/wiring/dashboard-readers";
import { readAppliedConfigChanges } from "../../server/wiring/config-change-store";
import { AuditView } from "../../server/templates/views/audit";

async function render(node: unknown): Promise<string> {
    return await Promise.resolve(node).then(String);
}

let dir: string;
const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "batch3-")); });
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_STATE_DIR === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
    else process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
});

describe("normalizePhase (#396)", () => {
    test("maps the daemon's uppercase/wide vocabulary onto lane keys", () => {
        expect(normalizePhase("CODE")).toBe("code");
        expect(normalizePhase("SPEC_REVIEW")).toBe("review");
        expect(normalizePhase("INTEGRATION")).toBe("deploy");
        expect(normalizePhase("MONITOR")).toBe("observe");
        expect(normalizePhase("prd")).toBe("prd");
        expect(normalizePhase(null)).toBe("prd");
    });

    test("live cards land in their REAL lanes, not all in prd", async () => {
        const actions = join(dir, "request-actions");
        const decisions = join(dir, "gate-decisions");
        mkdirSync(actions, { recursive: true });
        mkdirSync(decisions, { recursive: true });
        writeFileSync(join(actions, "REQ-000050.json"), JSON.stringify({
            id: "REQ-000050", repo: "r", status: "running", phase: "CODE",
        }));
        const rows = await readRequestLedger({ actionsDir: actions, decisionsDir: decisions });
        const lanes = groupRequestsByPhase(rows);
        const codeLane = lanes.find((l) => l.phase === "code")!;
        const prdLane = lanes.find((l) => l.phase === "prd")!;
        expect(codeLane.cards).toHaveLength(1);
        expect(prdLane.cards).toHaveLength(0);
    });
});

describe("audit config-changes section (#396)", () => {
    test("reader lists applied markers newest-first", async () => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = dir;
        const applied = join(dir, "config-changes", "applied");
        mkdirSync(applied, { recursive: true });
        writeFileSync(join(applied, "a.json"), JSON.stringify({
            id: "aaa", actor: "op", ts: "2026-06-10T10:00:00Z", summary: "older",
        }));
        writeFileSync(join(applied, "b.json"), JSON.stringify({
            id: "bbb", actor: "op", ts: "2026-06-11T10:00:00Z", summary: "newer",
        }));
        const changes = await readAppliedConfigChanges();
        expect(changes).toHaveLength(2);
        expect(changes[0]!.summary).toBe("newer");
    });

    test("AuditView renders the section when changes exist", async () => {
        const html = await render(AuditView({
            rows: [],
            configChanges: [{ id: "verify-386-x", actor: "verify", ts: "t", summary: "s" }],
        } as any));
        expect(html).toContain("Config changes");
        expect(html).toContain("daemon-applied · outside the HMAC chain");
        expect(html).toContain("verify-3");
    });

    test("AuditView omits the section when empty", async () => {
        const html = await render(AuditView({ rows: [], configChanges: [] } as any));
        expect(html).not.toContain("Config changes");
    });
});
