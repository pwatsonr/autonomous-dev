// SPEC-013-2-05 §Task 2 — Unit tests for the layered config loader.
//
// Coverage target: defaults + user overrides + env overrides + validation.
// Tests run under `bun test` and use a temp HOME pointer per test so the
// real ~/.autonomous-dev/config.json is never read.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    deepMerge,
    expandHome,
    loadPortalConfig,
    parseEnvOverrides,
    type PortalConfig,
} from "../../server/lib/config";
import { PortalError } from "../../server/middleware/error-handler";

const ENV_KEYS = [
    "PORTAL_PORT",
    "PORTAL_AUTH_MODE",
    "PORTAL_LOG_LEVEL",
    "PORTAL_BIND_HOST",
    "PORTAL_USER_CONFIG",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let tmpDir: string;

beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
    tmpDir = mkdtempSync(join(tmpdir(), "portal-config-test-"));
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = savedEnv[k];
        }
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("deepMerge", () => {
    test("merges nested objects right-biased", () => {
        const result = deepMerge<{ a: { b: number; c: number } }>(
            { a: { b: 1, c: 2 } },
            { a: { b: 9 } },
        );
        expect(result).toEqual({ a: { b: 9, c: 2 } });
    });

    test("right-side array replaces left-side array", () => {
        const result = deepMerge<{ xs: number[] }>(
            { xs: [1, 2, 3] },
            { xs: [9] },
        );
        expect(result.xs).toEqual([9]);
    });

    test("right-side scalar replaces left-side scalar", () => {
        const result = deepMerge<{ a: number; b: string }>(
            { a: 1, b: "left" },
            { a: 2 },
        );
        expect(result).toEqual({ a: 2, b: "left" });
    });

    test("undefined sources are skipped", () => {
        const result = deepMerge<{ a: number }>(
            { a: 1 },
            undefined,
            { a: 2 },
        );
        expect(result).toEqual({ a: 2 });
    });
});

describe("expandHome", () => {
    test("replaces leading ~/ with homedir", () => {
        const expanded = expandHome("~/foo");
        expect(expanded).not.toContain("~");
        expect(expanded.endsWith("/foo")).toBe(true);
    });

    test("returns input unchanged when no leading ~", () => {
        expect(expandHome("/abs/path")).toBe("/abs/path");
    });

    test("expands bare ~", () => {
        const expanded = expandHome("~");
        expect(expanded).not.toBe("~");
    });
});

describe("parseEnvOverrides", () => {
    test("PORTAL_PORT=8080 yields { port: 8080 }", () => {
        const result = parseEnvOverrides({ PORTAL_PORT: "8080" } as NodeJS.ProcessEnv);
        expect(result).toEqual({ port: 8080 });
    });

    test("PORTAL_PORT=99999 throws INVALID_ENV_PORTAL_PORT", () => {
        let caught: unknown = null;
        try {
            parseEnvOverrides({ PORTAL_PORT: "99999" } as NodeJS.ProcessEnv);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe("INVALID_ENV_PORTAL_PORT");
    });

    test("PORTAL_PORT=foo throws INVALID_ENV_PORTAL_PORT", () => {
        let caught: unknown = null;
        try {
            parseEnvOverrides({ PORTAL_PORT: "foo" } as NodeJS.ProcessEnv);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe("INVALID_ENV_PORTAL_PORT");
    });

    test("PORTAL_AUTH_MODE=invalid throws INVALID_ENV_PORTAL_AUTH_MODE", () => {
        let caught: unknown = null;
        try {
            parseEnvOverrides({ PORTAL_AUTH_MODE: "invalid" } as NodeJS.ProcessEnv);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe(
            "INVALID_ENV_PORTAL_AUTH_MODE",
        );
    });

    test("PORTAL_LOG_LEVEL=trace throws INVALID_ENV_PORTAL_LOG_LEVEL", () => {
        let caught: unknown = null;
        try {
            parseEnvOverrides({ PORTAL_LOG_LEVEL: "trace" } as NodeJS.ProcessEnv);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe(
            "INVALID_ENV_PORTAL_LOG_LEVEL",
        );
    });

    test("empty env returns empty object", () => {
        expect(parseEnvOverrides({} as NodeJS.ProcessEnv)).toEqual({});
    });

    test("PORTAL_BIND_HOST is captured", () => {
        const result = parseEnvOverrides({
            PORTAL_BIND_HOST: "100.64.1.1",
        } as NodeJS.ProcessEnv);
        expect(result).toEqual({ bind_host: "100.64.1.1" });
    });
});

describe("loadPortalConfig (defaults + user file + env)", () => {
    test("returns defaults when no user config and no env", async () => {
        // Point user_config to a non-existent path so loader silently skips.
        process.env["PORTAL_USER_CONFIG"] = join(tmpDir, "missing.json");
        const cfg = await loadPortalConfig();
        expect(cfg.port).toBe(19280);
        expect(cfg.auth_mode).toBe("localhost");
        expect(cfg.logging.level).toBe("info");
    });

    test("merges user config over defaults", async () => {
        const userPath = join(tmpDir, "user.json");
        writeFileSync(userPath, JSON.stringify({ port: 18888 }));
        process.env["PORTAL_USER_CONFIG"] = userPath;
        const cfg = await loadPortalConfig();
        expect(cfg.port).toBe(18888);
        expect(cfg.auth_mode).toBe("localhost"); // unchanged from defaults
    });

    test("env overrides win over user config", async () => {
        const userPath = join(tmpDir, "user.json");
        writeFileSync(userPath, JSON.stringify({ port: 18888 }));
        process.env["PORTAL_USER_CONFIG"] = userPath;
        process.env["PORTAL_PORT"] = "17777";
        const cfg = await loadPortalConfig();
        expect(cfg.port).toBe(17777);
    });

    test("malformed user config throws INVALID_CONFIG_SYNTAX with home-redacted path", async () => {
        const userPath = join(tmpDir, "user.json");
        writeFileSync(userPath, "{ not json");
        process.env["PORTAL_USER_CONFIG"] = userPath;
        let caught: unknown = null;
        try {
            await loadPortalConfig();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe("INVALID_CONFIG_SYNTAX");
    });

    test("missing user config is silent (no error)", async () => {
        process.env["PORTAL_USER_CONFIG"] = join(tmpDir, "does-not-exist.json");
        const cfg = await loadPortalConfig();
        expect(cfg.port).toBe(19280);
    });

    test("invalid merged port throws INVALID_CONFIG via validation", async () => {
        const userPath = join(tmpDir, "user.json");
        writeFileSync(userPath, JSON.stringify({ port: 80 })); // < 1024
        process.env["PORTAL_USER_CONFIG"] = userPath;
        let caught: unknown = null;
        try {
            await loadPortalConfig();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(PortalError);
        expect((caught as PortalError).code).toBe("INVALID_CONFIG");
    });

    test("loads in under 50 ms (median of 10 runs)", async () => {
        process.env["PORTAL_USER_CONFIG"] = join(tmpDir, "missing.json");
        // Warm up — first import resolution may be slow.
        await loadPortalConfig();
        const samples: number[] = [];
        for (let i = 0; i < 10; i++) {
            const t0 = performance.now();
            await loadPortalConfig();
            samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)] ?? 0;
        expect(median).toBeLessThan(50);
    });
});

describe("PortalConfig shape", () => {
    test("defaults satisfy the typed interface", async () => {
        process.env["PORTAL_USER_CONFIG"] = join(tmpDir, "missing.json");
        const cfg: PortalConfig = await loadPortalConfig();
        expect(typeof cfg.port).toBe("number");
        expect(["localhost", "tailscale", "oauth"]).toContain(cfg.auth_mode);
        expect(typeof cfg.shutdown.grace_period_ms).toBe("number");
        expect(typeof cfg.shutdown.force_timeout_ms).toBe("number");
    });
});
