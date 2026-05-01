// SPEC-015-2-05 §Portal Test Server — Boots a minimal Hono app on an
// ephemeral port that wires the real production building blocks
// (IntakeRouterClient, ConfirmationTokenStore, ConfigurationValidator,
// parseFormDataToConfig, signalDaemonReload) to a mock intake router.
//
// We do NOT spin up the full PLAN-013 server because:
//   1. `loadPortalConfig` reads ~/.claude/autonomous-dev.json by default;
//      tests would either pollute or be polluted by the real file.
//   2. Authentication wiring is gated by the real config; tests need a
//      direct route surface they control.
//
// Instead we construct the same client + token-store instances the real
// portal would, and expose them on the test app. This keeps the
// integration tests honest about the production code paths while letting
// us inject the mock router port without env-var games.
//
// CSRF is intentionally bypassed in this fixture (the gate-action handlers
// the production routes will eventually wire up sit BEHIND csrfProtection;
// the security suite covers that contract directly in tests/security/).

import { serve, type Server } from "bun";
import { Hono } from "hono";

import {
    ConfigurationValidator,
    type ValidationContext,
} from "../../server/lib/config-validator";
import { ConfirmationTokenStore } from "../../server/lib/confirmation-token-store";
import {
    parseFormDataToConfig,
    type FormSource,
} from "../../server/lib/form-parser";

type AnyServer = Server<unknown>;

/**
 * Coerce a `FormData` (whose values may include `File`) to the string-only
 * FormSource shape `parseFormDataToConfig` expects. The form-parser is
 * used in production with URL-encoded bodies, so test fixtures must hand it
 * stringified entries to keep the contract honest.
 */
function asFormSource(fd: FormData): FormSource {
    return {
        getAll(key: string): string[] {
            return fd
                .getAll(key)
                .map((v) => (typeof v === "string" ? v : ""));
        },
        keys(): IterableIterator<string> {
            return fd.keys();
        },
    };
}
import { IntakeRouterClient } from "../../server/lib/intake-router-client";
import {
    requiresDaemonReload,
    signalDaemonReload,
} from "../../server/lib/daemon-reload";

export interface StartPortalOptions {
    /** Port the mock intake router is listening on. */
    intakePort: number;
    /** Repo root used for state files / allowlist canonicalisation. */
    repoRoot: string;
    /** Operator id surfaced as `sourceUserId` in commands. Default: 'op-test'. */
    operatorId?: string;
}

export interface PortalHandle {
    /** Base URL like `http://127.0.0.1:54321`. */
    url: string;
    /** The IntakeRouterClient bound to the mock router. */
    intakeClient: IntakeRouterClient;
    /** The token store the modal flow consumes. */
    tokenStore: ConfirmationTokenStore;
    stop(): Promise<void>;
}

interface GateActionForm {
    action: string;
    comment?: string;
    confirmationToken?: string;
}

/**
 * Start the test portal server. Returns when the underlying socket is
 * accepting connections.
 */
export async function startPortal(
    opts: StartPortalOptions,
): Promise<PortalHandle> {
    const operatorId = opts.operatorId ?? "op-test";
    const intakeClient = new IntakeRouterClient({ port: opts.intakePort });
    const tokenStore = new ConfirmationTokenStore();
    const validator = new ConfigurationValidator();

    const app = new Hono();

    // POST /repo/:repo/request/:id/gate/confirm-token — mint a token for
    // high-cost reject. Cost threshold check is server-authoritative.
    app.post(
        "/repo/:repo/request/:id/gate/confirm-token",
        async (c) => {
            const requestId = c.req.param("id");
            let body: { action?: string; cost?: number } = {};
            try {
                body = (await c.req.json()) as typeof body;
            } catch {
                body = {};
            }
            const action = body.action ?? "reject";
            const cost = typeof body.cost === "number" ? body.cost : 0;
            if (cost <= 50) {
                return c.json({ error: "cost_below_threshold" }, 400);
            }
            const issued = tokenStore.issue(
                operatorId,
                `${action}_${requestId}`,
            );
            return c.json({
                token: issued.token,
                expiresAt: issued.expiresAt,
                scope: `${action}_${requestId}`,
                requiresType: "REJECT",
            });
        },
    );

    // POST /repo/:repo/request/:id/gate/:action — exercises the full
    // submitCommand → mock router round-trip with token consumption.
    app.post(
        "/repo/:repo/request/:id/gate/:action",
        async (c) => {
            const repo = c.req.param("repo");
            const requestId = c.req.param("id");
            const action = c.req.param("action");
            const formData = await c.req.formData();
            const submitted: GateActionForm = {
                action: (formData.get("action") ?? "").toString(),
                comment: (formData.get("comment") ?? "").toString().trim(),
                confirmationToken:
                    (formData.get("confirmationToken") ?? "")
                        .toString() || undefined,
            };

            if (submitted.action !== action) {
                return c.json({ error: "action_mismatch" }, 400);
            }
            if (action === "request-changes" && !submitted.comment) {
                return c.json({ error: "comment_required" }, 422);
            }

            // Consume the token if one was provided. Reject if invalid.
            if (submitted.confirmationToken !== undefined) {
                const result = tokenStore.consume(
                    submitted.confirmationToken,
                    operatorId,
                    `${action}_${requestId}`,
                );
                if (!result.valid) {
                    return c.json(
                        {
                            error: `confirmation_invalid:${result.reason ?? "unknown"}`,
                        },
                        422,
                    );
                }
            }

            const intakeResp = await intakeClient.submitCommand({
                command: action as "approve" | "reject" | "request-changes",
                requestId: crypto.randomUUID(),
                targetRequestId: requestId,
                comment: submitted.comment || undefined,
                source: "portal",
                sourceUserId: operatorId,
                confirmationToken: submitted.confirmationToken,
            });
            // Repo only used for echo / logging context.
            void repo;

            if (!intakeResp.success) {
                const status =
                    intakeResp.errorCode === "NETWORK_TRANSIENT" ? 503 : 422;
                return c.json(
                    {
                        error: intakeResp.error,
                        errorCode: intakeResp.errorCode,
                    },
                    status,
                );
            }
            return c.json({
                ok: true,
                commandId: intakeResp.commandId,
                action,
            });
        },
    );

    // POST /settings — exercises validator + form-parser + reload signaling.
    app.post("/settings", async (c) => {
        const formData = await c.req.formData();
        const proposed = parseFormDataToConfig(asFormSource(formData));
        const ctx: ValidationContext = {
            fullConfig: proposed,
            userHomeDir: opts.repoRoot,
            allowedRoots: [opts.repoRoot],
            operatorId,
        };
        const summary = await validator.validateConfiguration(
            proposed,
            ctx,
        );
        if (!summary.valid) {
            return c.json(
                {
                    ok: false,
                    fieldErrors: summary.fieldErrors,
                    proposed,
                },
                422,
            );
        }
        const setResp = await intakeClient.submitCommand({
            command: "config-set",
            requestId: crypto.randomUUID(),
            source: "portal",
            sourceUserId: operatorId,
            configChanges: proposed,
        });
        if (!setResp.success) {
            return c.json(
                { ok: false, error: setResp.error },
                setResp.errorCode === "NETWORK_TRANSIENT" ? 503 : 422,
            );
        }
        let reloadOk: boolean | undefined;
        if (requiresDaemonReload(proposed)) {
            const reload = await signalDaemonReload(
                intakeClient,
                "settings_save",
                operatorId,
            );
            reloadOk = reload.ok;
        }
        return c.json({
            ok: true,
            reloadSignaled: reloadOk === true,
            warnings: summary.warnings,
        });
    });

    const server = serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const port = (server as unknown as { port: number }).port;

    return {
        url: `http://127.0.0.1:${String(port)}`,
        intakeClient,
        tokenStore,
        async stop() {
            (server as unknown as AnyServer).stop();
        },
    };
}
