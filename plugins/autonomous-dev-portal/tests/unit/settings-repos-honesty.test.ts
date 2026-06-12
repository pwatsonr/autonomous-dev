// #393 + #395 regression — settings cost-caps must reflect the DAEMON's
// defaults (labeled) when unset, and /repos must count/badge allowlist
// membership truthfully.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    readDaemonDefaultCaps,
    readPortalSettings,
} from "../../server/wiring/settings-reader";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "caps393-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readDaemonDefaultCaps (#393)", () => {
    test("reads the daemon's real defaults from config_defaults.json", async () => {
        const p = join(dir, "config_defaults.json");
        writeFileSync(p, JSON.stringify({
            governance: {
                daily_cost_cap_usd: 100,
                per_request_cost_cap_usd: 50,
                monthly_cost_cap_usd: 2000,
            },
        }));
        const caps = await readDaemonDefaultCaps({ daemonDefaultsPath: p, cacheRootDir: join(dir, "no-cache") });
        expect(caps).toEqual({ daily: 100, perRequest: 50, monthly: 2000 });
    });

    test("shipped fallback constants match the repo's actual config_defaults.json (drift lock)", async () => {
        // Resolve the repo file the same way the reader does in dev layout.
        const repoDefaults = join(
            import.meta.dir, "..", "..", "..", "autonomous-dev", "config_defaults.json",
        );
        const g = (JSON.parse(readFileSync(repoDefaults, "utf-8")) as {
            governance: Record<string, number>;
        }).governance;
        // Force the shipped-constant path with unreadable candidates.
        const caps = await readDaemonDefaultCaps({
            daemonDefaultsPath: join(dir, "nope.json"),
            cacheRootDir: join(dir, "no-cache"),
        });
        expect(caps.daily).toBe(g["daily_cost_cap_usd"]!);
        expect(caps.perRequest).toBe(g["per_request_cost_cap_usd"]!);
        expect(caps.monthly).toBe(g["monthly_cost_cap_usd"]!);
    });
});

describe("readPortalSettings caps honesty (#393)", () => {
    test("config WITHOUT governance → daemon defaults + capsFromConfig=false (never 25/10/500)", async () => {
        const cfg = join(dir, "autonomous-dev.json");
        writeFileSync(cfg, JSON.stringify({ notifications: {} }));
        const s = await readPortalSettings({ configPath: cfg });
        expect(s.capsFromConfig).toBe(false);
        expect(s.dailyCostCap).not.toBe(25);
        expect(s.perRequestCostCap).not.toBe(10);
        expect(s.monthlyCostCap).not.toBe(500);
        expect(s.dailyCostCap).toBe(100);
    });

    test("config WITH governance → its values + capsFromConfig=true", async () => {
        const cfg = join(dir, "autonomous-dev.json");
        writeFileSync(cfg, JSON.stringify({ governance: { daily_cost_cap_usd: 42 } }));
        const s = await readPortalSettings({ configPath: cfg });
        expect(s.capsFromConfig).toBe(true);
        expect(s.dailyCostCap).toBe(42);
    });
});
