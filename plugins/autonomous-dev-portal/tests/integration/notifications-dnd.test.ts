// BUG-7 regression test: DND inputs should not be hardcoded disabled.
//
// Design (notifications-card.tsx): DND inputs are disabled ONLY when
// `notifyDefault === "none"` (no delivery method → DND is meaningless).
//
// #396 rewrite: the old test read the REAL ~/.claude/autonomous-dev.json
// (non-hermetic — its result depended on the operator's machine; it had
// been red for weeks) and its conditional had an operator-precedence bug.
// Now hermetic via AUTONOMOUS_DEV_USER_CONFIG, asserting BOTH directions
// of the design.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];
const ORIGINAL_USER_CONFIG = process.env["AUTONOMOUS_DEV_USER_CONFIG"];

let dir: string;

function writeConfig(defaultMethod: string): void {
    const p = join(dir, "autonomous-dev.json");
    writeFileSync(p, JSON.stringify({
        notifications: { delivery: { default_method: defaultMethod } },
    }));
    process.env["AUTONOMOUS_DEV_USER_CONFIG"] = p;
}

beforeAll(() => {
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    dir = mkdtempSync(join(tmpdir(), "bug7-"));
});

afterAll(() => {
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
    if (ORIGINAL_USER_CONFIG === undefined) {
        delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
    } else {
        process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ORIGINAL_USER_CONFIG;
    }
});

function dndInputs(html: string): string[] {
    return ["dnd-enabled", "dnd-start", "dnd-end"].map((id) => {
        const m = html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`));
        expect(m).not.toBeNull();
        return m![0];
    });
}

describe("BUG-7: DND inputs not hardcoded disabled", () => {
    it("should not render DND inputs as disabled when notifications are enabled", async () => {
        writeConfig("discord");
        const app = freshApp();
        const response = await app.request("/settings");
        expect(response.status).toBe(200);
        for (const input of dndInputs(await response.text())) {
            expect(input).not.toMatch(/\bdisabled(=""|\b)/);
        }
    });

    it("renders DND inputs disabled when delivery method is none (designed behavior)", async () => {
        writeConfig("none");
        const app = freshApp();
        const response = await app.request("/settings");
        expect(response.status).toBe(200);
        for (const input of dndInputs(await response.text())) {
            expect(input).toMatch(/\bdisabled(=""|\b)/);
        }
    });
});
