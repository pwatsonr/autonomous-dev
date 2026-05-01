// SPEC-015-2-05 §Suite 2 — Settings editor round-trip + daemon-reload
// signaling. Covers the full path from POSTed form data through:
//   parseFormDataToConfig → ConfigurationValidator → IntakeRouterClient
//     .submitCommand('config-set') → optional signalDaemonReload.
//
// The portal test server's /settings handler in portal-test-server.ts
// glues the production primitives together so we exercise the same code
// paths the eventual production handler will. PathValidator is exercised
// indirectly through ConfigurationValidator's ruleAllowlist, scoped to
// the ephemeral mkdtempSync repoRoot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockIntakeRouter } from "../fixtures/mock-intake-router";
import {
    startPortal,
    type PortalHandle,
} from "../fixtures/portal-test-server";
import {
    requiresDaemonReload,
    RELOAD_TRIGGER_PREFIXES,
} from "../../server/lib/daemon-reload";

interface Ctx {
    repoRoot: string;
    router: MockIntakeRouter;
    portal: PortalHandle;
}

let ctx: Ctx;

beforeEach(async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "portal-settings-"));
    const router = new MockIntakeRouter();
    await router.start();
    const portal = await startPortal({
        intakePort: router.port,
        repoRoot,
    });
    ctx = { repoRoot, router, portal };
});

afterEach(async () => {
    await ctx.portal.stop();
    await ctx.router.stop();
    rmSync(ctx.repoRoot, { recursive: true, force: true });
});

async function postSettings(
    fields: Array<[string, string]>,
): Promise<Response> {
    const fd = new FormData();
    for (const [k, v] of fields) {
        fd.append(k, v);
    }
    return fetch(`${ctx.portal.url}/settings`, {
        method: "POST",
        body: fd,
    });
}

describe("settings save — happy path with daemon reload", () => {
    test("valid cost-cap change → config-set + daemon-reload commands", async () => {
        const resp = await postSettings([
            ["costCaps.daily", "25"],
            ["costCaps.monthly", "700"],
        ]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            ok: boolean;
            reloadSignaled: boolean;
        };
        expect(body.ok).toBe(true);
        expect(body.reloadSignaled).toBe(true);

        const cmds = ctx.router.getReceivedCommands();
        const setCmd = cmds.find((c) => c.body["command"] === "config-set");
        const reloadCmd = cmds.find(
            (c) => c.body["command"] === "daemon-reload",
        );
        expect(setCmd).toBeDefined();
        expect(reloadCmd).toBeDefined();
        // sanitized: the submitted change shape made the round-trip
        expect(
            (setCmd?.body["configChanges"] as Record<string, unknown>)?.[
                "costCaps"
            ],
        ).toBeDefined();
    });

    test("notifications-only change does NOT trigger daemon-reload", async () => {
        const resp = await postSettings([
            ["notifications.email.to", "ops@example.com"],
        ]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { reloadSignaled: boolean };
        expect(body.reloadSignaled).toBe(false);

        const cmds = ctx.router.getReceivedCommands();
        const reloads = cmds.filter(
            (c) => c.body["command"] === "daemon-reload",
        );
        expect(reloads).toHaveLength(0);
        const sets = cmds.filter((c) => c.body["command"] === "config-set");
        expect(sets).toHaveLength(1);
    });
});

describe("settings save — validation errors render inline", () => {
    test("zero daily cap → 422 with field-level error", async () => {
        const resp = await postSettings([
            ["costCaps.daily", "0"],
            ["costCaps.monthly", "300"],
        ]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as {
            ok: boolean;
            fieldErrors: Record<string, string>;
            proposed: Record<string, unknown>;
        };
        expect(body.ok).toBe(false);
        expect(body.fieldErrors["costCaps.daily"]).toBeDefined();
        // sticky values: the submitted 0 is echoed back so the editor can
        // re-render with the user's typed value, not a silent reset.
        const costCaps = body.proposed["costCaps"] as {
            daily?: number;
            monthly?: number;
        };
        expect(costCaps.daily).toBe(0);
        expect(ctx.router.getReceivedCommands()).toHaveLength(0);
    });

    test("non-git allowlist path → 422 (validator rejects)", async () => {
        // ctx.repoRoot is in allowedRoots but lacks a .git, so it should
        // be flagged as "not a git repository".
        const resp = await postSettings([["allowlist[]", ctx.repoRoot]]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as {
            fieldErrors: Record<string, string>;
        };
        expect(body.fieldErrors["allowlist[0]"]).toMatch(
            /not a git repository/i,
        );
    });

    test("path outside allowed roots → 422", async () => {
        const resp = await postSettings([["allowlist[]", "/etc/passwd"]]);
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as {
            fieldErrors: Record<string, string>;
        };
        expect(body.fieldErrors["allowlist[0]"]).toMatch(
            /not in an allowed root/i,
        );
        expect(ctx.router.getReceivedCommands()).toHaveLength(0);
    });

    test("git directory inside allowed root → accepted", async () => {
        // Make ctx.repoRoot a git repo by creating a .git directory.
        mkdirSync(join(ctx.repoRoot, ".git"), { recursive: true });
        const resp = await postSettings([
            ["allowlist[]", ctx.repoRoot],
        ]);
        expect(resp.status).toBe(200);
        // No daemon-reload prefix matched, so just a config-set.
        const cmds = ctx.router.getReceivedCommands();
        expect(cmds.find((c) => c.body["command"] === "config-set")).toBeDefined();
    });
});

describe("settings save — intake failures bubble", () => {
    test("transient intake failure → 503", async () => {
        ctx.router.setBehavior("fail-transient");
        const resp = await postSettings([["costCaps.daily", "10"]]);
        expect(resp.status).toBe(503);
    });

    test("permanent intake failure → 422", async () => {
        ctx.router.setBehavior("fail-permanent");
        const resp = await postSettings([["costCaps.daily", "10"]]);
        expect(resp.status).toBe(422);
    });
});

describe("requiresDaemonReload coverage", () => {
    test("each trigger prefix forces a reload", () => {
        for (const prefix of RELOAD_TRIGGER_PREFIXES) {
            const key = `${prefix}some-leaf`;
            const obj: Record<string, unknown> = {};
            // build the nested object dynamically
            const segments = key.split(".");
            let cursor: Record<string, unknown> = obj;
            for (let i = 0; i < segments.length - 1; i++) {
                const seg = segments[i] as string;
                const next: Record<string, unknown> = {};
                cursor[seg] = next;
                cursor = next;
            }
            cursor[segments[segments.length - 1] as string] = "x";
            expect(requiresDaemonReload(obj)).toBe(true);
        }
    });

    test("notification-only and empty inputs do not force a reload", () => {
        expect(
            requiresDaemonReload({
                notifications: { email: { to: "x@y.com" } },
            }),
        ).toBe(false);
        expect(requiresDaemonReload({})).toBe(false);
        expect(requiresDaemonReload(null)).toBe(false);
        expect(requiresDaemonReload(undefined)).toBe(false);
    });
});
