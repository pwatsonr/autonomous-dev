// SPEC-036-4-06 §Notifications card — Discord/Slack webhooks, default
// notification method, DND hours.
//
// Validation is bidirectional:
//   - Server (`POST /api/settings/notifications`) — authoritative,
//     URL-host check + default-method coherence + DND format.
//   - Client (`form-validation.js`) — `input`-event UX gate; mirrors
//     the server contract but never substitutes for it.

import type { FC } from "hono/jsx";

import { Btn, Chip } from "../../components/primitives";
import type {
    NotificationsConfig,
    NotifyDefault,
    WebhookTestStatus,
} from "../../types/render";

interface Props {
    config: NotificationsConfig;
    /** Server-side derived: the saved configuration is valid. Drives the
     *  "Send test notification now" Btn enabled state. */
    canSendTest: boolean;
    /** CSRF token for form submissions */
    csrfToken?: string;
}

const DEFAULTS: NotifyDefault[] = ["discord", "slack", "both", "none"];

const TONE: Record<WebhookTestStatus, "ok" | "warn" | "err" | "muted"> = {
    ok: "ok",
    warn: "warn",
    err: "err",
    muted: "muted",
};

/** "configured — ends …Ca21 (enter…)" -> "ends …Ca21" (display short). */
function maskShort(masked: string): string {
    const m = masked.match(/ends …\S+/);
    return m ? m[0] : "";
}

export const NotificationsCard: FC<Props> = ({ config, canSendTest, csrfToken }) => {
    const dndDisabled = config.notifyDefault === "none";
    return (
        <section class="sec" aria-labelledby="notifications-heading">
            <div class="sec-head">
                <h2 id="notifications-heading">Notifications</h2>
            </div>
            <p class="dim">
                Send approval / failure pings to Discord or Slack. Tokens
                are sent server-side only — never from the browser.
            </p>

            {/* crawl p9: real <form> with optimistic auto-save — changes
                submit on blur/toggle (settings-autosave.js); failures
                surface via the global error banner. Test buttons carry
                type="button" so they never trigger the form. */}
            <form
                data-autosave
                hx-post="/api/settings/notifications"
                hx-target="closest .sec"
                hx-swap="outerHTML"
            >
            {/* Hidden CSRF token for form submissions */}
            {csrfToken && csrfToken.length > 0 && (
                <input type="hidden" name="_csrf" value={csrfToken} />
            )}

            {/* Discord webhook --------------------------------------- */}
            <div class="field stacked-field" data-channel="discord">
                <label for="discord-webhook">Discord webhook URL</label>
                {/* #392: the saved secret is never rendered — config.discordWebhook
                    carries a masked display string, used only as placeholder.
                    Empty submit preserves the saved value; Clear removes it. */}
                <input
                    type="url"
                    id="discord-webhook"
                    name="discordWebhook"
                    class="input"
                    value=""
                    placeholder={
                        config.discordWebhook !== ""
                            ? config.discordWebhook
                            : "https://discord.com/api/webhooks/..."
                    }
                    data-validate="webhook-url"
                />
                {config.discordWebhook !== "" && (
                    <label class="dim webhook-clear">
                        <input type="checkbox" name="discordWebhookClear" value="1" />
                        {" "}Clear saved webhook
                    </label>
                )}
                {/* crawl p9 follow-up: configured-ness was invisible —
                    it lived only in the dim placeholder while this chip
                    said "unknown" (the untested delivery status), so a
                    saved webhook LOOKED absent. Configured-ness is now
                    the primary signal; test status stays secondary. */}
                <span class="webhook-status">
                    {config.discordWebhook !== "" ? (
                        <>
                            <Chip variant="status" tone="ok">
                                CONFIGURED
                            </Chip>
                            <span class="mono dim webhook-ends">
                                {maskShort(config.discordWebhook)}
                            </span>
                        </>
                    ) : (
                        <Chip variant="status" tone="muted">
                            NOT SET
                        </Chip>
                    )}
                </span>
                <Btn
                    type="button"
                    kind="ghost"
                    size="sm"
                    hx-post="/api/settings/notifications/test/discord"
                    hx-target="closest [data-channel='discord']"
                    hx-swap="outerHTML"
                >
                    Test
                </Btn>
            </div>

            {/* Slack webhook ----------------------------------------- */}
            <div class="field stacked-field" data-channel="slack">
                <label for="slack-webhook">Slack webhook URL</label>
                <input
                    type="url"
                    id="slack-webhook"
                    name="slackWebhook"
                    class="input"
                    value=""
                    placeholder={
                        config.slackWebhook !== ""
                            ? config.slackWebhook
                            : "https://hooks.slack.com/services/..."
                    }
                    data-validate="webhook-url"
                />
                {config.slackWebhook !== "" && (
                    <label class="dim webhook-clear">
                        <input type="checkbox" name="slackWebhookClear" value="1" />
                        {" "}Clear saved webhook
                    </label>
                )}
                {/* crawl p9 follow-up: configured-ness was invisible —
                    it lived only in the dim placeholder while this chip
                    said "unknown" (the untested delivery status), so a
                    saved webhook LOOKED absent. Configured-ness is now
                    the primary signal; test status stays secondary. */}
                <span class="webhook-status">
                    {config.slackWebhook !== "" ? (
                        <>
                            <Chip variant="status" tone="ok">
                                CONFIGURED
                            </Chip>
                            <span class="mono dim webhook-ends">
                                {maskShort(config.slackWebhook)}
                            </span>
                        </>
                    ) : (
                        <Chip variant="status" tone="muted">
                            NOT SET
                        </Chip>
                    )}
                </span>
                <Btn
                    type="button"
                    kind="ghost"
                    size="sm"
                    hx-post="/api/settings/notifications/test/slack"
                    hx-target="closest [data-channel='slack']"
                    hx-swap="outerHTML"
                >
                    Test
                </Btn>
            </div>

            {/* Default method --------------------------------------- */}
            <div class="field stacked-field" data-field="notify-default">
                <label class="sub-label">Default notification method</label>
                <select
                    class="input"
                    name="notifyDefault"
                    data-validate="notify-default"
                >
                    {DEFAULTS.map((opt) => (
                        <option value={opt} selected={config.notifyDefault === opt}>
                            {opt}
                        </option>
                    ))}
                </select>
            </div>

            {/* DND hours -------------------------------------------- */}
            <div class="field stacked-field" data-field="dnd-hours">
                <label class="sub-label">Do-Not-Disturb hours</label>
                <div class="dnd-row">
                    <label class="checkbox dnd-toggle">
                        <input
                            type="checkbox"
                            id="dnd-enabled"
                            name="dndEnabled"
                            checked={config.dndEnabled}
                            {...(dndDisabled ? { disabled: true } : {})}
                        />
                        <span>Enable DND</span>
                    </label>
                    <label class="dnd-time-label" for="dnd-start">Start</label>
                    <input
                        type="time"
                        id="dnd-start"
                        name="dndStart"
                        class="input dnd-time"
                        value={config.dndStart}
                        {...(dndDisabled ? { disabled: true } : {})}
                        data-validate="dnd-time"
                    />
                    <label class="dnd-time-label" for="dnd-end">End</label>
                    <input
                        type="time"
                        id="dnd-end"
                        name="dndEnd"
                        class="input dnd-time"
                        value={config.dndEnd}
                        {...(dndDisabled ? { disabled: true } : {})}
                        data-validate="dnd-time"
                    />
                </div>
                {dndDisabled ? (
                    <p class="dim small">
                        DND has no effect when notifications are off.
                    </p>
                ) : null}
            </div>

            <div class="form-actions">
                <span class="meta-mono dim">auto-saves on change</span>
                <Btn
                    type="button"
                    kind="secondary"
                    disabled={!canSendTest}
                    hx-post="/api/settings/notifications/test/send"
                    hx-target="closest .sec"
                    hx-swap="outerHTML"
                >
                    Send test notification now
                </Btn>
            </div>
            </form>
        </section>
    );
};
