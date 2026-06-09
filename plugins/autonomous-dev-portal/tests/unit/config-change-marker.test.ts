// #353 — FileSettingsStore writes a config-change marker (FR-925), not the
// live config directly.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSettingsStore } from "../../server/wiring/settings-store";

let DIR: string;
let CONFIG_PATH: string;
const ORIG_STATE = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("#353 config-change marker", () => {
    beforeEach(() => {
        DIR = mkdtempSync(join(tmpdir(), "cc-marker-"));
        CONFIG_PATH = join(DIR, "autonomous-dev.json");
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = DIR;
    });
    afterEach(() => {
        if (ORIG_STATE === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        else process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIG_STATE;
        rmSync(DIR, { recursive: true, force: true });
    });

    test("addAllowlist writes a portal marker, not the live config", async () => {
        const store = new FileSettingsStore(CONFIG_PATH);
        const res = await store.addAllowlist("/Users/op/projects/x", "operator-1");
        expect(res.ok).toBe(true);

        // The live config file must NOT have been written directly.
        expect(existsSync(CONFIG_PATH)).toBe(false);

        // A config-change marker must exist with the proposed change + provenance.
        const ccDir = join(DIR, "config-changes");
        const files = readdirSync(ccDir).filter((f) => f.endsWith(".json"));
        expect(files.length).toBe(1);
        const marker = JSON.parse(readFileSync(join(ccDir, files[0]!), "utf-8"));
        expect(marker.source).toBe("portal");
        expect(marker.actor).toBe("operator-1");
        expect(marker.proposed.repositories.allowlist).toContain("/Users/op/projects/x");
        expect(marker.summary).toContain("allowlist add");
    });
});
