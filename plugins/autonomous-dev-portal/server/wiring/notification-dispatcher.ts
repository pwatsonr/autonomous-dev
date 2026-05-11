// PLAN-037-2 — minimal `NotificationDispatcher` for the test-button
// endpoints. Reads the webhook URL from `~/.claude/autonomous-dev.json`
// (via FileSettingsStore's persisted shape) and POSTs the fixed payload
// the route already constructed.
//
// We deliberately do NOT call into `intake/notifications/notification_
// engine.ts` — that engine requires a Repository / per-request context
// the portal does not have. The "test button" semantics are simple:
//   - Resolve the channel's webhook URL from the config file.
//   - POST a fixed JSON payload (no template lookup, no per-request data).
//   - Surface ok / timeout / error to the route.
//
// The `send` channel is intentionally not wired here — there is no
// "default" webhook target for the unspecified `send` verb in the
// existing config shape. The route still mounts (no 503), but every
// invocation returns `{ok:false, reason:"error"}` with a TODO log so
// operators see the gap.

import type {
    NotificationChannel,
    NotificationDispatcher,
    NotificationResult,
} from "../routes/settings-actions";

import { readJsonOrNull } from "./atomic-json";
import { userConfigPath } from "./state-paths";

interface ConfigForNotifications {
    notifications?: {
        discordWebhook?: string;
        slackWebhook?: string;
    };
}

function discordBody(payload: { title: string; body: string }): unknown {
    return {
        username: "autonomous-dev portal",
        content: `**${payload.title}**\n${payload.body}`,
    };
}

function slackBody(payload: { title: string; body: string }): unknown {
    return {
        text: `*${payload.title}*\n${payload.body}`,
    };
}

async function readWebhook(channel: NotificationChannel): Promise<string | null> {
    const cfg = await readJsonOrNull<ConfigForNotifications>(userConfigPath());
    if (cfg === null) return null;
    const n = cfg.notifications;
    if (n === undefined) return null;
    if (channel === "discord") {
        return typeof n.discordWebhook === "string" && n.discordWebhook.length > 0
            ? n.discordWebhook
            : null;
    }
    if (channel === "slack") {
        return typeof n.slackWebhook === "string" && n.slackWebhook.length > 0
            ? n.slackWebhook
            : null;
    }
    return null;
}

/**
 * Build a dispatcher backed by the user-config webhook URLs. Optional
 * `fetchImpl` lets tests inject a deterministic transport.
 */
export function buildFileWebhookDispatcher(
    fetchImpl: typeof fetch = fetch,
): NotificationDispatcher {
    return {
        async send(channel, payload): Promise<NotificationResult> {
            if (channel === "send") {
                // PLAN-037-2 DEFERRED — no `send` channel mapping exists
                // in the config shape. Surface as a soft error rather
                // than a 503 so the route still mounts and the UI gets a
                // sane "not configured" message.
                return {
                    ok: false,
                    reason: "error",
                    message: "send-channel-not-configured",
                };
            }
            const url = await readWebhook(channel);
            if (url === null) {
                return {
                    ok: false,
                    reason: "error",
                    message: `${channel}-webhook-not-configured`,
                };
            }
            const body =
                channel === "discord" ? discordBody(payload) : slackBody(payload);
            try {
                const res = await fetchImpl(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                if (!res.ok) {
                    return {
                        ok: false,
                        reason: "error",
                        message: `webhook-${String(res.status)}`,
                    };
                }
                return { ok: true };
            } catch (err) {
                return {
                    ok: false,
                    reason: "error",
                    message: err instanceof Error ? err.message : String(err),
                };
            }
        },
    };
}
