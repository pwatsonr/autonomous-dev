// Global test preload — STATE ISOLATION GUARD.
//
// Incident (2026-06-12, crawl p9): settings-form-encoding.test.ts
// isolated the config FILE but not AUTONOMOUS_DEV_STATE_DIR, so every
// full-suite run POSTed an empty-notifications form through the REAL
// store, writing a real marker into ~/.autonomous-dev/config-changes/.
// The daemon then applied it — repeatedly wiping the operator's saved
// Discord webhook. Tests must NEVER touch the operator's live state.
//
// This preload redirects both env roots to fresh temp dirs before any
// test module loads. Tests that need specific fixtures still override
// per-suite (their beforeAll/beforeEach runs later and wins).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (
    process.env["AUTONOMOUS_DEV_STATE_DIR"] === undefined ||
    process.env["AUTONOMOUS_DEV_STATE_DIR"]!.length === 0
) {
    process.env["AUTONOMOUS_DEV_STATE_DIR"] = mkdtempSync(
        join(tmpdir(), "portal-test-state-"),
    );
}

if (
    process.env["AUTONOMOUS_DEV_USER_CONFIG"] === undefined ||
    process.env["AUTONOMOUS_DEV_USER_CONFIG"]!.length === 0
) {
    const dir = mkdtempSync(join(tmpdir(), "portal-test-config-"));
    const path = join(dir, "autonomous-dev.json");
    writeFileSync(path, "{}", "utf-8");
    process.env["AUTONOMOUS_DEV_USER_CONFIG"] = path;
}
