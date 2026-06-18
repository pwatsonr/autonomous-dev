// Issue #507 — Trust-level setting must persist end-to-end.
//
// This is the FAITHFUL round-trip test: settings change -> real config-change
// marker -> daemon-equivalent DEEP merge -> read back through the route.
//
// Why a separate test from bug-1-settings-persist.test.ts: that suite's
// `applyPendingMarkers()` helper *overwrites* the config file with
// `marker.proposed` wholesale. The real daemon (consume_config_changes in
// bin/supervisor-loop.sh) instead DEEP-merges `.proposed` over the existing
// config (`jq -s '.[0] * .[1].proposed'`). The overwrite shortcut hid the
// nested-merge drop this issue is about, so here we apply markers with the
// exact jq expression the daemon uses (shelling out to the same `jq`), which
// is what makes this a true regression test for #507.
//
// State isolation: AUTONOMOUS_DEV_STATE_DIR + AUTONOMOUS_DEV_USER_CONFIG are
// redirected to a per-test temp dir (the bunfig preload guard plus the
// per-test overrides below). No real marker is ever written to the operator's
// ~/.autonomous-dev or ~/.claude/autonomous-dev.json.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { FileSettingsStore } from "../../server/wiring/settings-store";
import { buildFileWebhookDispatcher } from "../../server/wiring/notification-dispatcher";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";
import type { AuditAppender } from "../../server/routes/_action-deps";

let TEST_DIR: string;
let TEST_CONFIG_PATH: string;

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];
const ORIGINAL_USER_CONFIG = process.env["AUTONOMOUS_DEV_USER_CONFIG"];

function freshApp(): Hono {
    const app = new Hono();
    const audit: AuditAppender = { async append() {} };
    registerRoutes(app, {
        settingsActions: {
            store: new FileSettingsStore(TEST_CONFIG_PATH),
            notifications: buildFileWebhookDispatcher(fetch, TEST_CONFIG_PATH),
            audit,
        },
    });
    return app;
}

/**
 * Apply pending markers using the EXACT merge the daemon performs in
 * consume_config_changes(): chronological order by `.ts`, then
 * `jq -s '.[0] * .[1].proposed'` (deep merge; arrays/scalars replace, nested
 * objects merge). Returns the number applied.
 */
function applyPendingMarkersLikeDaemon(): number {
    const ccDir = join(TEST_DIR, "config-changes");
    let files: string[];
    try {
        files = readdirSync(ccDir).filter((f) => f.endsWith(".json"));
    } catch {
        return 0;
    }
    // Sort by the marker's ts (daemon applies oldest-first so newest wins).
    const withTs = files.map((f) => {
        let ts = "";
        try {
            ts = JSON.parse(readFileSync(join(ccDir, f), "utf-8")).ts ?? "";
        } catch {
            /* corrupt markers sort first; the daemon would reject them */
        }
        return { f, ts };
    });
    withTs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    let applied = 0;
    for (const { f } of withTs) {
        const markerPath = join(ccDir, f);
        const res = spawnSync(
            "jq",
            ["-s", ".[0] * .[1].proposed", TEST_CONFIG_PATH, markerPath],
            { encoding: "utf-8" },
        );
        if (res.status === 0 && res.stdout.trim().length > 0) {
            writeFileSync(TEST_CONFIG_PATH, res.stdout, "utf-8");
            applied += 1;
        }
    }
    return applied;
}

describe("#507 trust level persists end-to-end (faithful deep-merge)", () => {
    beforeEach(() => {
        TEST_DIR = mkdtempSync(join(tmpdir(), "issue-507-"));
        TEST_CONFIG_PATH = join(TEST_DIR, "autonomous-dev.json");
        process.env["AUTONOMOUS_DEV_USER_CONFIG"] = TEST_CONFIG_PATH;
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = TEST_DIR;
    });

    afterAll(() => {
        if (ORIGINAL_STATE_DIR === undefined) {
            delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        } else {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        }
        if (ORIGINAL_USER_CONFIG === undefined) {
            delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
        } else {
            process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ORIGINAL_USER_CONFIG;
        }
    });

    test("setting trust level writes a marker, applies, and reads back as set", async () => {
        // The variants/agents reads on GET /settings resolve the daemon
        // manifest from the kit-parity fixtures; point the state dir there
        // only for the read (markers were already applied to the config file).
        writeFileSync(TEST_CONFIG_PATH, "{}", "utf-8");
        const app = freshApp();

        // 1. Operator changes the trust level (autosave posts the form).
        const saveRes = await app.request("/settings", {
            method: "POST",
            headers: { "HX-Request": "true" },
            body: new URLSearchParams({ "trust-level": "L3" }),
        });
        expect(saveRes.status).toBe(200);
        expect(await saveRes.text()).toContain("SAVED");

        // A real marker must have been written under the isolated state dir.
        const ccDir = join(TEST_DIR, "config-changes");
        const markers = readdirSync(ccDir).filter((f) => f.endsWith(".json"));
        expect(markers.length).toBe(1);
        const marker = JSON.parse(
            readFileSync(join(ccDir, markers[0]!), "utf-8"),
        );
        expect(marker.source).toBe("portal");
        // The trust field must be present under `.proposed`.
        expect(marker.proposed.trust.system_default_level).toBe(3);

        // 2. Daemon applies the marker (deep merge).
        expect(applyPendingMarkersLikeDaemon()).toBe(1);
        const onDisk = JSON.parse(readFileSync(TEST_CONFIG_PATH, "utf-8"));
        expect(onDisk.trust.system_default_level).toBe(3);

        // 3. Reload: the settings reader must reflect the saved level.
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
        try {
            const loadRes = await app.request("/settings");
            expect(loadRes.status).toBe(200);
            const html = await loadRes.text();
            expect(html).toMatch(/value="L3"[^>]*selected/s);
        } finally {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = TEST_DIR;
        }
    });

    test("trust-level change preserves an existing per-repo override (#507 nested merge)", async () => {
        // Seed a config that already has a per-repo override AND a global L1.
        // The shallow `+` merge dropped per_repo_overrides on a trust-only
        // proposal; the deep `*` merge keeps it.
        writeFileSync(
            TEST_CONFIG_PATH,
            JSON.stringify({
                trust: {
                    system_default_level: 1,
                    per_repo_overrides: { "acme/widgets": "L2" },
                },
                governance: { daily_cost_cap_usd: 100 },
            }),
            "utf-8",
        );
        const app = freshApp();

        const saveRes = await app.request("/settings", {
            method: "POST",
            headers: { "HX-Request": "true" },
            body: new URLSearchParams({ "trust-level": "L3" }),
        });
        expect(saveRes.status).toBe(200);

        expect(applyPendingMarkersLikeDaemon()).toBe(1);

        const onDisk = JSON.parse(readFileSync(TEST_CONFIG_PATH, "utf-8"));
        // New level applied...
        expect(onDisk.trust.system_default_level).toBe(3);
        // ...sibling override survived the merge...
        expect(onDisk.trust.per_repo_overrides).toEqual({
            "acme/widgets": "L2",
        });
        // ...and the unrelated top-level governance key is intact.
        expect(onDisk.governance.daily_cost_cap_usd).toBe(100);

        // Read-back: both the global level and the override render.
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
        try {
            const html = await (await app.request("/settings")).text();
            expect(html).toMatch(/value="L3"[^>]*selected/s);
            expect(html).toContain('data-repo="acme/widgets"');
        } finally {
            process.env["AUTONOMOUS_DEV_STATE_DIR"] = TEST_DIR;
        }
    });
});
