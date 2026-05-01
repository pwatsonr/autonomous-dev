// SPEC-015-2-05 §Suite 1 — Approval gate end-to-end flow.
//
// Boots a real portal test server and a mock intake router, then drives the
// approve / reject / request-changes endpoints through the full pipeline:
//   POST /gate/* → IntakeRouterClient.submitCommand → mock router → assert
//   on the recorded command body.
//
// State.json fixtures are written via createState (mkdtemp-rooted ephemeral
// directories) so suites cannot leak into each other or into the
// developer's repo. PathValidator is reused implicitly through the
// fixture's repoRoot ↔ allowedRoots binding.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockIntakeRouter } from "../fixtures/mock-intake-router";
import {
    createState,
    readState,
} from "../fixtures/state-factory";
import {
    startPortal,
    type PortalHandle,
} from "../fixtures/portal-test-server";
import { ConfirmationTokenStore } from "../../server/lib/confirmation-token-store";

interface Ctx {
    repoRoot: string;
    router: MockIntakeRouter;
    portal: PortalHandle;
}

let ctx: Ctx;

beforeEach(async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "portal-approval-"));
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

async function postGate(
    requestId: string,
    action: string,
    fields: Record<string, string>,
): Promise<Response> {
    const fd = new FormData();
    fd.append("action", action);
    for (const [k, v] of Object.entries(fields)) {
        fd.append(k, v);
    }
    return fetch(
        `${ctx.portal.url}/repo/test-repo/request/${requestId}/gate/${action}`,
        {
            method: "POST",
            body: fd,
        },
    );
}

async function mintConfirmToken(
    requestId: string,
    body: { action: string; cost: number },
): Promise<{ token?: string; status: number; raw: unknown }> {
    const resp = await fetch(
        `${ctx.portal.url}/repo/test-repo/request/${requestId}/gate/confirm-token`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );
    let raw: unknown = null;
    try {
        raw = await resp.json();
    } catch {
        raw = null;
    }
    return {
        token:
            raw !== null &&
            typeof raw === "object" &&
            "token" in raw &&
            typeof (raw as { token: unknown }).token === "string"
                ? (raw as { token: string }).token
                : undefined,
        status: resp.status,
        raw,
    };
}

describe("approval flow — happy paths", () => {
    test("approve low-cost: single intake call with portal-shaped command", async () => {
        await createState(ctx.repoRoot, "REQ-000001", {
            status: "pending-approval",
            cost: 25,
        });
        const resp = await postGate("REQ-000001", "approve", {
            comment: "LGTM",
        });
        expect(resp.status).toBe(200);
        const cmds = ctx.router.getReceivedCommands();
        expect(cmds).toHaveLength(1);
        expect(cmds[0]?.body["command"]).toBe("approve");
        expect(cmds[0]?.body["targetRequestId"]).toBe("REQ-000001");
        expect(cmds[0]?.body["source"]).toBe("portal");
        expect(cmds[0]?.body["comment"]).toBe("LGTM");
    });

    test("request-changes with comment: 200 + comment forwarded", async () => {
        await createState(ctx.repoRoot, "REQ-000002", {
            status: "pending-approval",
        });
        const resp = await postGate("REQ-000002", "request-changes", {
            comment: "Add more tests please",
        });
        expect(resp.status).toBe(200);
        const cmds = ctx.router.getReceivedCommands();
        expect(cmds).toHaveLength(1);
        expect(cmds[0]?.body["command"]).toBe("request-changes");
        expect(cmds[0]?.body["comment"]).toBe("Add more tests please");
    });

    test("reject low-cost: no token required", async () => {
        await createState(ctx.repoRoot, "REQ-000003", {
            status: "pending-approval",
            cost: 25,
        });
        const resp = await postGate("REQ-000003", "reject", {});
        expect(resp.status).toBe(200);
        expect(ctx.router.getReceivedCommands()).toHaveLength(1);
    });
});

describe("approval flow — validation gates", () => {
    test("URL/form action mismatch → 400", async () => {
        await createState(ctx.repoRoot, "REQ-000010", {
            status: "pending-approval",
        });
        const fd = new FormData();
        fd.append("action", "reject"); // mismatched
        const resp = await fetch(
            `${ctx.portal.url}/repo/test-repo/request/REQ-000010/gate/approve`,
            { method: "POST", body: fd },
        );
        expect(resp.status).toBe(400);
        expect(ctx.router.getReceivedCommands()).toHaveLength(0);
    });

    test("request-changes with empty comment → 422", async () => {
        await createState(ctx.repoRoot, "REQ-000011", {
            status: "pending-approval",
        });
        const resp = await postGate("REQ-000011", "request-changes", {
            comment: "",
        });
        expect(resp.status).toBe(422);
        expect(ctx.router.getReceivedCommands()).toHaveLength(0);
    });

    test("request-changes with whitespace-only comment → 422", async () => {
        await createState(ctx.repoRoot, "REQ-000012", {
            status: "pending-approval",
        });
        const resp = await postGate("REQ-000012", "request-changes", {
            comment: "   \t  ",
        });
        expect(resp.status).toBe(422);
    });
});

describe("approval flow — high-cost reject confirmation token", () => {
    test("low-cost token mint → 400 (cost_below_threshold)", async () => {
        const result = await mintConfirmToken("REQ-000020", {
            action: "reject",
            cost: 25,
        });
        expect(result.status).toBe(400);
    });

    test("high-cost mint → token issued, then valid POST consumes it", async () => {
        await createState(ctx.repoRoot, "REQ-000021", {
            status: "pending-approval",
            cost: 100,
        });
        const minted = await mintConfirmToken("REQ-000021", {
            action: "reject",
            cost: 100,
        });
        expect(minted.status).toBe(200);
        expect(typeof minted.token).toBe("string");
        const ok = await postGate("REQ-000021", "reject", {
            confirmationToken: minted.token ?? "",
            comment: "too costly",
        });
        expect(ok.status).toBe(200);
        expect(ctx.router.getReceivedCommands()).toHaveLength(1);
    });

    test("token replay → 422 with already_consumed reason", async () => {
        await createState(ctx.repoRoot, "REQ-000022", {
            status: "pending-approval",
            cost: 100,
        });
        const minted = await mintConfirmToken("REQ-000022", {
            action: "reject",
            cost: 100,
        });
        const first = await postGate("REQ-000022", "reject", {
            confirmationToken: minted.token ?? "",
        });
        expect(first.status).toBe(200);
        const replay = await postGate("REQ-000022", "reject", {
            confirmationToken: minted.token ?? "",
        });
        expect(replay.status).toBe(422);
        expect(ctx.router.getReceivedCommands()).toHaveLength(1);
    });

    test("garbage token → 422 with unknown_token reason", async () => {
        await createState(ctx.repoRoot, "REQ-000023", {
            status: "pending-approval",
            cost: 100,
        });
        const resp = await postGate("REQ-000023", "reject", {
            confirmationToken: "deadbeef".repeat(4),
        });
        expect(resp.status).toBe(422);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toContain("unknown_token");
        expect(ctx.router.getReceivedCommands()).toHaveLength(0);
    });
});

describe("approval flow — intake router failures bubble up", () => {
    test("transient failure → 503 + NETWORK_TRANSIENT errorCode", async () => {
        await createState(ctx.repoRoot, "REQ-000030", {
            status: "pending-approval",
            cost: 10,
        });
        ctx.router.setBehavior("fail-transient");
        const resp = await postGate("REQ-000030", "approve", {});
        expect(resp.status).toBe(503);
        // 3 retries on the client.
        expect(ctx.router.getReceivedCommands()).toHaveLength(3);
        const body = (await resp.json()) as { errorCode?: string };
        expect(body.errorCode).toBe("NETWORK_TRANSIENT");
    });

    test("permanent failure → 422 + INVALID_TRANSITION (no retry)", async () => {
        await createState(ctx.repoRoot, "REQ-000031", {
            status: "pending-approval",
        });
        ctx.router.setBehavior("fail-permanent");
        const resp = await postGate("REQ-000031", "approve", {});
        expect(resp.status).toBe(422);
        expect(ctx.router.getReceivedCommands()).toHaveLength(1);
    });
});

describe("approval flow — state.json visibility", () => {
    test("state file is readable through StateReader-compatible layout", async () => {
        const fixture = await createState(ctx.repoRoot, "REQ-000040", {
            status: "pending-approval",
            cost: 5,
            ageHours: 25,
            escalatedAt: new Date(
                Date.now() - 25 * 3_600_000,
            ).toISOString(),
        });
        // Read it back through the fixture helper to verify on-disk shape.
        const onDisk = await readState(ctx.repoRoot, "REQ-000040");
        expect(onDisk).not.toBeNull();
        expect(onDisk?.["request_id"]).toBe("REQ-000040");
        expect(onDisk?.["escalated_at"]).toBeDefined();
        expect(fixture.path).toContain(".autonomous-dev/requests/REQ-000040");
    });
});

describe("ConfirmationTokenStore unit acceptance (re-exported into suite)", () => {
    test("issue/consume round-trip and TTL+operator+scope guards", () => {
        const store = new ConfirmationTokenStore({ ttlMs: 50 });
        const { token } = store.issue("op-1", "reject_REQ-1");
        expect(store.consume(token, "op-1", "reject_REQ-1").valid).toBe(true);
        expect(store.consume(token, "op-1", "reject_REQ-1").reason).toBe(
            "already_consumed",
        );

        const { token: t2 } = store.issue("op-1", "reject_REQ-1");
        expect(store.consume(t2, "op-2", "reject_REQ-1").reason).toBe(
            "operator_mismatch",
        );
        expect(store.consume(t2, "op-1", "approve_REQ-1").reason).toBe(
            "scope_mismatch",
        );

        const { token: t3 } = store.issue("op-1", "reject_REQ-1");
        // Wait past the TTL.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                expect(
                    store.consume(t3, "op-1", "reject_REQ-1").reason,
                ).toBe("expired");
                resolve();
            }, 80);
        });
    });
});
