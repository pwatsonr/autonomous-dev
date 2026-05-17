// SPEC-037-2-04 — Settings action routes.
//
// Five POST endpoints back the Settings page tabs:
//
//   POST /settings                                      → form save
//   POST /api/settings/allowlist                        → add allowlist path
//   POST /api/settings/notifications/test/{discord,slack,send}
//
// Notes (per spec):
//   - CSRF is enforced upstream. No per-route exemption.
//   - Allowlist add validates the path is a real git repo, lives under the
//     operator's home, and is not a symlink escape. The three guards
//     short-circuit in order; the most specific error wins.
//   - Notification test endpoints send a FIXED payload. The request body
//     never sources the notification content (defense against an operator
//     using the test button to spam a webhook).
//   - Each notification fan-out is timed out at 5_000ms (FR-10). A timeout
//     emits 504 plus an audit entry with `result: "timeout"`.

import { Hono } from "hono";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";

import type {
    ActionLogger,
    AuditAppender,
} from "./_action-deps";
import { noopActionLogger, resolveActor } from "./_action-deps";

const NOTIFICATION_TIMEOUT_MS = 5_000;

export type NotificationChannel = "discord" | "slack" | "send";
export type NotificationResult =
    | { ok: true }
    | { ok: false; reason: "timeout" | "error"; message?: string };

export interface NotificationDispatcher {
    send(
        channel: NotificationChannel,
        payload: { title: string; body: string },
    ): Promise<NotificationResult>;
}

export interface SettingsFormSaveResult {
    ok: boolean;
    /** HTML fragment to swap into the outerHTML target. */
    fragment: JSX.Element;
    /** When ok=false, the offending field for the operator to fix. */
    field?: string;
}

export interface AllowlistAddResult {
    ok: boolean;
    /** HTML row fragment when ok=true. */
    fragment?: JSX.Element;
    message?: string;
}

export interface SettingsStore {
    /**
     * Parse + validate the form body, atomically write the config, and
     * return the updated settings fragment. Validation failures return
     * `ok:false` with the offending field name.
     */
    saveFromForm(
        form: Record<string, unknown>,
        actor: string,
    ): Promise<SettingsFormSaveResult>;
    /**
     * Persist a new allowlist entry. The caller MUST have already
     * validated path safety (real-path under home, is-a-git-repo).
     */
    addAllowlist(realPath: string, actor: string): Promise<AllowlistAddResult>;
}

export interface SettingsActionDeps {
    store: SettingsStore;
    notifications: NotificationDispatcher;
    audit: AuditAppender;
    logger?: ActionLogger;
    /**
     * Optional override for the git "is inside work tree" check. Defaults
     * to spawning `git -C <path> rev-parse --is-inside-work-tree`. Tests
     * inject a deterministic predicate.
     */
    isGitWorkTree?: (realPath: string) => Promise<boolean>;
    /** Override the operator's home root (tests). Defaults to `os.homedir()`. */
    homeDir?: string;
}

interface AllowlistBody {
    path?: unknown;
}

function genericErrorFragment(message: string): JSX.Element {
    return (
        <div class="settings-error">
            <span class="chip err">ERROR</span>
            <span class="meta">{message}</span>
        </div>
    );
}

function allowlistRowFragment(path: string): JSX.Element {
    return (
        <tr class="allowlist-row" data-path={path}>
            <td class="mono">{path}</td>
            <td>
                <span class="chip ok">ok</span>
            </td>
        </tr>
    );
}

async function defaultIsGitWorkTree(realPath: string): Promise<boolean> {
    // Lazy-import to avoid loading child_process when caller supplies a
    // pre-built predicate (the typical test path).
    const { spawn } = await import("node:child_process");
    return await new Promise<boolean>((resolve) => {
        const proc = spawn(
            "git",
            ["-C", realPath, "rev-parse", "--is-inside-work-tree"],
            { stdio: "ignore" },
        );
        proc.on("error", () => resolve(false));
        proc.on("exit", (code) => resolve(code === 0));
    });
}

/** Build the Settings action sub-router. */
export function buildSettingsActionRoutes(
    deps: SettingsActionDeps,
): Hono {
    const logger = deps.logger ?? noopActionLogger();
    const isGitWorkTree = deps.isGitWorkTree ?? defaultIsGitWorkTree;
    const homeRoot = deps.homeDir ?? homedir();
    const router = new Hono();

    // -----------------------------------------------------------------
    // POST /settings — form-encoded save
    // -----------------------------------------------------------------
    router.post("/settings", async (c) => {
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            return c.html(genericErrorFragment("invalid form body"), 422);
        }
        const actor = resolveActor(c.get("auth"));
        let result: SettingsFormSaveResult;
        try {
            result = await deps.store.saveFromForm(form, actor);
        } catch (err) {
            logger.error("settings_save_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return c.html(genericErrorFragment("save failed"), 500);
        }
        if (!result.ok) {
            return c.html(result.fragment, 422);
        }
        await deps.audit.append({
            event: "settings_saved",
            actor,
        });
        return c.html(result.fragment);
    });

    // -----------------------------------------------------------------
    // POST /api/settings/allowlist — add allowlist path
    // -----------------------------------------------------------------
    router.post("/api/settings/allowlist", async (c) => {
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            return c.json({ error: "invalid-body" }, 400);
        }
        if (typeof form.path !== "string" || form.path.length === 0) {
            return c.json({ error: "invalid-body" }, 400);
        }
        const requested = form.path;

        // Guard #1: realpath must resolve and live under the operator's home
        // tree (defeats symlink escapes and absolute paths into /etc).
        let real: string;
        try {
            real = await realpath(requested);
        } catch {
            return c.json({ error: "path-outside-home" }, 403);
        }
        if (!real.startsWith(homeRoot)) {
            return c.json({ error: "path-outside-home" }, 403);
        }
        // Guard #2: must be a real git work tree.
        const isRepo = await isGitWorkTree(real);
        if (!isRepo) {
            return c.json({ error: "not-a-git-repo" }, 422);
        }

        const actor = resolveActor(c.get("auth"));
        let result: AllowlistAddResult;
        try {
            result = await deps.store.addAllowlist(real, actor);
        } catch (err) {
            logger.error("settings_allowlist_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return c.json({ error: "internal" }, 500);
        }
        if (!result.ok) {
            return c.json(
                { error: result.message ?? "allowlist-error" },
                422,
            );
        }
        await deps.audit.append({
            event: "settings_allowlist_added",
            actor,
            path: real,
        });
        return c.html(result.fragment ?? allowlistRowFragment(real));
    });

    // -----------------------------------------------------------------
    // POST /api/settings/notifications — save notifications config
    // -----------------------------------------------------------------
    router.post("/api/settings/notifications", async (c) => {
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            return c.html(genericErrorFragment("invalid form body"), 422);
        }
        const actor = resolveActor(c.get("auth"));

        // Validate webhook URLs
        for (const field of ["discordWebhook", "slackWebhook"]) {
            const value = form[field];
            if (typeof value === "string" && value.length > 0) {
                try {
                    const url = new URL(value);
                    if (field === "discordWebhook" && !url.hostname.includes("discord.com")) {
                        return c.html(genericErrorFragment("Discord webhook must be from discord.com"), 422);
                    }
                    if (field === "slackWebhook" && !url.hostname.includes("slack.com")) {
                        return c.html(genericErrorFragment("Slack webhook must be from slack.com"), 422);
                    }
                } catch {
                    return c.html(genericErrorFragment(`Invalid ${field.replace("Webhook", " webhook")} URL format`), 422);
                }
            }
        }

        // Validate default notification method coherence
        const notifyDefault = form["notifyDefault"] as string;
        const hasDiscord = typeof form["discordWebhook"] === "string" && form["discordWebhook"].length > 0;
        const hasSlack = typeof form["slackWebhook"] === "string" && form["slackWebhook"].length > 0;

        if (notifyDefault === "discord" && !hasDiscord) {
            return c.html(genericErrorFragment("Cannot set Discord as default without a Discord webhook"), 422);
        }
        if (notifyDefault === "slack" && !hasSlack) {
            return c.html(genericErrorFragment("Cannot set Slack as default without a Slack webhook"), 422);
        }
        if (notifyDefault === "both" && (!hasDiscord || !hasSlack)) {
            return c.html(genericErrorFragment("Cannot set both channels as default without both webhook URLs"), 422);
        }

        // Validate DND time format if enabled
        if (form["dndEnabled"]) {
            const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
            if (form["dndStart"] && !timeRegex.test(form["dndStart"] as string)) {
                return c.html(genericErrorFragment("DND start time must be in HH:MM format"), 422);
            }
            if (form["dndEnd"] && !timeRegex.test(form["dndEnd"] as string)) {
                return c.html(genericErrorFragment("DND end time must be in HH:MM format"), 422);
            }
        }

        let result: SettingsFormSaveResult;
        try {
            result = await deps.store.saveFromForm(form, actor);
        } catch (err) {
            logger.error("settings_notifications_save_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return c.html(genericErrorFragment("save failed"), 500);
        }
        if (!result.ok) {
            return c.html(result.fragment, 422);
        }
        await deps.audit.append({
            event: "settings_notifications_saved",
            actor,
        });
        return c.html(result.fragment);
    });

    // -----------------------------------------------------------------
    // POST /api/settings/notifications/test/{channel}
    // -----------------------------------------------------------------
    for (const channel of ["discord", "slack", "send"] as const) {
        router.post(
            `/api/settings/notifications/test/${channel}`,
            async (c) => {
                const actor = resolveActor(c.get("auth"));
                const payload = {
                    title: "Portal test",
                    body: `Triggered by ${actor} at ${new Date().toISOString()}`,
                };
                const result = await sendWithTimeout(
                    deps.notifications,
                    channel,
                    payload,
                    NOTIFICATION_TIMEOUT_MS,
                );
                if (!result.ok && result.reason === "timeout") {
                    await deps.audit.append({
                        event: "notification_test_sent",
                        actor,
                        channel,
                        result: "timeout",
                    });
                    return c.json(
                        { error: "notification-timeout", channel },
                        504,
                    );
                }
                if (!result.ok) {
                    await deps.audit.append({
                        event: "notification_test_sent",
                        actor,
                        channel,
                        result: "error",
                    });
                    return c.json(
                        { error: "notification-failed", channel },
                        502,
                    );
                }
                await deps.audit.append({
                    event: "notification_test_sent",
                    actor,
                    channel,
                    result: "ok",
                });
                return c.json({ sent: true, channel });
            },
        );
    }

    // -----------------------------------------------------------------
    // POST /api/settings/default-variant — set default variant
    // -----------------------------------------------------------------
    router.post("/api/settings/default-variant", async (c) => {
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            // Try parsing as JSON for HTMX hx-vals
            try {
                form = await c.req.json();
            } catch {
                return c.html(genericErrorFragment("invalid form body"), 422);
            }
        }

        if (typeof form.id !== "string" || form.id.length === 0) {
            return c.html(genericErrorFragment("invalid variant id"), 400);
        }

        const actor = resolveActor(c.get("auth"));
        let result: SettingsFormSaveResult;
        try {
            result = await deps.store.saveFromForm({ defaultVariant: form.id }, actor);
        } catch (err) {
            logger.error("settings_default_variant_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return c.html(genericErrorFragment("save failed"), 500);
        }
        if (!result.ok) {
            return c.html(result.fragment, 422);
        }
        await deps.audit.append({
            event: "settings_default_variant_saved",
            actor,
            variantId: form.id,
        });
        return c.html(<div class="chip ok">SAVED</div>);
    });

    // -----------------------------------------------------------------
    // POST /api/settings/default-backend — set default backend
    // -----------------------------------------------------------------
    router.post("/api/settings/default-backend", async (c) => {
        let form: Record<string, unknown> = {};
        try {
            form = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            // Try parsing as JSON for HTMX hx-vals
            try {
                form = await c.req.json();
            } catch {
                return c.html(genericErrorFragment("invalid form body"), 422);
            }
        }

        if (typeof form.id !== "string" || form.id.length === 0) {
            return c.html(genericErrorFragment("invalid backend id"), 400);
        }

        const actor = resolveActor(c.get("auth"));
        let result: SettingsFormSaveResult;
        try {
            result = await deps.store.saveFromForm({ defaultBackend: form.id }, actor);
        } catch (err) {
            logger.error("settings_default_backend_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return c.html(genericErrorFragment("save failed"), 500);
        }
        if (!result.ok) {
            return c.html(result.fragment, 422);
        }
        await deps.audit.append({
            event: "settings_default_backend_saved",
            actor,
            backendId: form.id,
        });
        return c.html(<div class="chip ok">SAVED</div>);
    });

    return router;
}

async function sendWithTimeout(
    dispatcher: NotificationDispatcher,
    channel: NotificationChannel,
    payload: { title: string; body: string },
    timeoutMs: number,
): Promise<NotificationResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise: Promise<NotificationResult> = new Promise(
        (resolve) => {
            timer = setTimeout(() => {
                resolve({ ok: false, reason: "timeout" });
            }, timeoutMs);
        },
    );
    try {
        const result = await Promise.race([
            dispatcher.send(channel, payload),
            timeoutPromise,
        ]);
        return result;
    } catch (err) {
        return {
            ok: false,
            reason: "error",
            message: err instanceof Error ? err.message : String(err),
        };
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}
