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
}

const DEFAULTS: NotifyDefault[] = ["discord", "slack", "both", "none"];

const TONE: Record<WebhookTestStatus, "ok" | "warn" | "err" | "muted"> = {
    ok: "ok",
    warn: "warn",
    err: "err",
    muted: "muted",
};

export const NotificationsCard: FC<Props> = ({ config, canSendTest }) => {
    const dndDisabled = config.notifyDefault === "none";
    return (
        <section class="card" aria-labelledby="notifications-heading">
            <h3 id="notifications-heading">Notifications</h3>
            <p class="meta">
                Send approval / failure pings to Discord or Slack. Tokens
                are sent server-side only — never from the browser.
            </p>

            {/* Discord webhook --------------------------------------- */}
            <div class="field" data-channel="discord">
                <label for="discord-webhook">Discord webhook URL</label>
                <input
                    type="url"
                    id="discord-webhook"
                    name="discordWebhook"
                    class="input"
                    value={config.discordWebhook}
                    placeholder="https://discord.com/api/webhooks/..."
                    data-validate="webhook-url"
                />
                <span class="webhook-status">
                    <Chip variant="status" tone={TONE[config.discordStatus]}>
                        {config.discordStatus}
                    </Chip>
                </span>
                <Btn
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
            <div class="field" data-channel="slack">
                <label for="slack-webhook">Slack webhook URL</label>
                <input
                    type="url"
                    id="slack-webhook"
                    name="slackWebhook"
                    class="input"
                    value={config.slackWebhook}
                    placeholder="https://hooks.slack.com/services/..."
                    data-validate="webhook-url"
                />
                <span class="webhook-status">
                    <Chip variant="status" tone={TONE[config.slackStatus]}>
                        {config.slackStatus}
                    </Chip>
                </span>
                <Btn
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
            <fieldset class="field" data-field="notify-default">
                <legend>Default notification method</legend>
                {DEFAULTS.map((opt) => (
                    <label class="radio">
                        <input
                            type="radio"
                            name="notify-default"
                            value={opt}
                            checked={config.notifyDefault === opt}
                            data-validate="notify-default"
                        />
                        <span>{opt}</span>
                    </label>
                ))}
            </fieldset>

            {/* DND hours -------------------------------------------- */}
            <fieldset class="field" data-field="dnd-hours">
                <legend>Do-Not-Disturb hours</legend>
                <label class="checkbox">
                    <input
                        type="checkbox"
                        id="dnd-enabled"
                        name="dndEnabled"
                        checked={config.dndEnabled}
                        disabled={dndDisabled}
                    />
                    <span>Enable DND</span>
                </label>
                <label for="dnd-start">Start</label>
                <input
                    type="time"
                    id="dnd-start"
                    name="dndStart"
                    class="input"
                    value={config.dndStart}
                    disabled={dndDisabled}
                    data-validate="dnd-time"
                />
                <label for="dnd-end">End</label>
                <input
                    type="time"
                    id="dnd-end"
                    name="dndEnd"
                    class="input"
                    value={config.dndEnd}
                    disabled={dndDisabled}
                    data-validate="dnd-time"
                />
                {dndDisabled ? (
                    <p class="meta">
                        DND has no effect when notifications are off.
                    </p>
                ) : null}
            </fieldset>

            <div class="form-actions">
                <Btn
                    kind="primary"
                    disabled={!canSendTest}
                    hx-post="/api/settings/notifications/test/send"
                    hx-target="closest .card"
                    hx-swap="outerHTML"
                >
                    Send test notification now
                </Btn>
            </div>
        </section>
    );
};
