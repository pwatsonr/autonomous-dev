// SPEC-015-2-02 §Settings page — full editor.
//
// The page renders four sections, each as its own <SettingsSection>:
//   1. Cost Management   — daily / monthly cap (numeric, validated server-side)
//   2. Trust Levels      — per-repo enum (untrusted | basic | trusted)
//   3. Repository Allowlist — array of git repo paths (canonicalized + checked)
//   4. Notifications     — slack webhook + notification email
//
// HTMX-first: the form has `hx-target="this"` and `hx-swap="outerHTML"`; on
// validation errors the server re-renders the same view with `fieldErrors`
// populated, and each section drops a <FieldError> below the offending input.
//
// Sticky values come from the user's submitted (potentially invalid) form
// data, NOT the on-disk config — a user who typed `0` for daily cap should
// see `0` after the 422, not a silent reset.
//
// Backward compatibility: the existing dispatcher in templates/index.tsx
// passes `{ config: SettingsView }`. The full-editor entry points
// (`SettingsEditor`, `SettingsPage`) are exported separately and consumed
// by the new POST /settings handler in routes/settings.ts.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { FieldError } from "../fragments/field-error";
import { SettingsSection } from "../fragments/settings-section";

// ---- Legacy view (kept for the existing dispatcher) ------------------------

export const SettingsView: FC<RenderProps["settings"]> = ({ config }) => (
    <section class="settings">
        <h1>Settings</h1>
        <dl>
            <dt>Authentication mode</dt>
            <dd>{config.auth_mode}</dd>
            <dt>Port</dt>
            <dd>{String(config.port)}</dd>
            <dt>Log level</dt>
            <dd>{config.log_level}</dd>
        </dl>
    </section>
);

// ---- Full editor (SPEC-015-2-02) -------------------------------------------

export interface RepositorySummary {
    /** URL-safe slug used as the form key suffix (`trustLevels.<slug>`). */
    slug: string;
    /** Display name. */
    name: string;
}

export type TrustLevel = "untrusted" | "basic" | "trusted";

export interface SettingsEditorProps {
    /** Current proposed (sticky) values. Numbers may legitimately be 0
     *  (e.g., the user just typed it; validator catches it). */
    settings: {
        costCaps?: { daily?: number | null; monthly?: number | null };
        trustLevels?: Record<string, string>;
        allowlist?: string[];
        notifications?: {
            slack?: { webhook?: string };
            email?: { to?: string };
        };
    };
    repositories: RepositorySummary[];
    fieldErrors?: Record<string, string>;
    warnings?: string[];
    successMessage?: string;
    serviceError?: string;
    /** CSRF token; injected by the route handler. */
    csrfToken?: string;
}

const TRUST_OPTIONS: readonly TrustLevel[] = ["untrusted", "basic", "trusted"];

function fieldClass(
    base: string,
    fieldErrors: Record<string, string> | undefined,
    field: string,
): string {
    if (fieldErrors && fieldErrors[field]) return `${base} error`;
    return base;
}

function valueOrEmpty(v: unknown): string {
    if (v === null || v === undefined) return "";
    return String(v);
}

export const SettingsEditor: FC<SettingsEditorProps> = ({
    settings,
    repositories,
    fieldErrors,
    warnings,
    successMessage,
    serviceError,
    csrfToken,
}) => {
    const fe = fieldErrors ?? {};
    return (
        <form
            id="settings-form"
            class="settings-editor"
            method="post"
            action="/settings"
            hx-post="/settings"
            hx-target="this"
            hx-swap="outerHTML"
        >
            <h1>Settings</h1>

            <input type="hidden" name="csrfToken" value={csrfToken ?? ""} />

            {successMessage ? (
                <div
                    class="success-message"
                    role="status"
                    data-kind="success"
                >
                    {successMessage}
                </div>
            ) : null}
            {serviceError ? (
                <div class="service-error" role="alert" data-kind="service">
                    {serviceError}
                </div>
            ) : null}
            {warnings && warnings.length > 0 ? (
                <ul class="warnings" role="status" aria-label="Warnings">
                    {warnings.map((w) => (
                        <li class="warning">{w}</li>
                    ))}
                </ul>
            ) : null}

            {/* Cost Management ----------------------------------------- */}
            <SettingsSection id="cost" title="Cost Management">
                <div class="field">
                    <label for="cost-daily">Daily cap (USD)</label>
                    <input
                        type="number"
                        id="cost-daily"
                        name="costCaps.daily"
                        min="0"
                        step="1"
                        value={valueOrEmpty(settings.costCaps?.daily)}
                        class={fieldClass("input", fe, "costCaps.daily")}
                    />
                    <FieldError
                        field="costCaps.daily"
                        message={fe["costCaps.daily"]}
                    />
                </div>
                <div class="field">
                    <label for="cost-monthly">Monthly cap (USD)</label>
                    <input
                        type="number"
                        id="cost-monthly"
                        name="costCaps.monthly"
                        min="0"
                        step="1"
                        value={valueOrEmpty(settings.costCaps?.monthly)}
                        class={fieldClass("input", fe, "costCaps.monthly")}
                    />
                    <FieldError
                        field="costCaps.monthly"
                        message={fe["costCaps.monthly"]}
                    />
                </div>
            </SettingsSection>

            {/* Trust Levels -------------------------------------------- */}
            <SettingsSection id="trust" title="Trust Levels">
                {repositories.length === 0 ? (
                    <p class="empty">No repositories registered.</p>
                ) : (
                    repositories.map((repo) => {
                        const fieldKey = `trustLevels.${repo.slug}`;
                        const current =
                            settings.trustLevels?.[repo.slug] ?? "untrusted";
                        return (
                            <div class="field">
                                <label for={`trust-${repo.slug}`}>
                                    {repo.name}
                                </label>
                                <select
                                    id={`trust-${repo.slug}`}
                                    name={fieldKey}
                                    class={fieldClass("input", fe, fieldKey)}
                                >
                                    {TRUST_OPTIONS.map((opt) => (
                                        <option
                                            value={opt}
                                            selected={current === opt}
                                        >
                                            {opt}
                                        </option>
                                    ))}
                                </select>
                                <FieldError
                                    field={fieldKey}
                                    message={fe[fieldKey]}
                                />
                            </div>
                        );
                    })
                )}
            </SettingsSection>

            {/* Allowlist ----------------------------------------------- */}
            <SettingsSection id="allowlist" title="Repository Allowlist">
                <p class="settings-section__description">
                    One git repository path per line.
                </p>
                {(settings.allowlist ?? []).map((p, i) => (
                    <div class="field">
                        <label for={`allowlist-${i}`}>
                            Path {i + 1}
                        </label>
                        <input
                            type="text"
                            id={`allowlist-${i}`}
                            name="allowlist[]"
                            value={p}
                            class={fieldClass(
                                "input",
                                fe,
                                `allowlist[${i}]`,
                            )}
                        />
                        <FieldError
                            field={`allowlist[${i}]`}
                            message={fe[`allowlist[${i}]`]}
                        />
                    </div>
                ))}
                <div class="field">
                    <label for="allowlist-new">Add path</label>
                    <input
                        type="text"
                        id="allowlist-new"
                        name="allowlist[]"
                        value=""
                        class="input"
                    />
                </div>
            </SettingsSection>

            {/* Notifications ------------------------------------------- */}
            <SettingsSection id="notifications" title="Notifications">
                <div class="field">
                    <label for="slack-webhook">Slack webhook URL</label>
                    <input
                        type="url"
                        id="slack-webhook"
                        name="notifications.slack.webhook"
                        value={valueOrEmpty(
                            settings.notifications?.slack?.webhook,
                        )}
                        class={fieldClass(
                            "input",
                            fe,
                            "notifications.slack.webhook",
                        )}
                    />
                    <FieldError
                        field="notifications.slack.webhook"
                        message={fe["notifications.slack.webhook"]}
                    />
                </div>
                <div class="field">
                    <label for="notify-email">Notification email</label>
                    <input
                        type="email"
                        id="notify-email"
                        name="notifications.email.to"
                        value={valueOrEmpty(
                            settings.notifications?.email?.to,
                        )}
                        class={fieldClass(
                            "input",
                            fe,
                            "notifications.email.to",
                        )}
                    />
                    <FieldError
                        field="notifications.email.to"
                        message={fe["notifications.email.to"]}
                    />
                </div>
            </SettingsSection>

            <div class="form-actions">
                <button type="submit" class="btn-primary">
                    Save settings
                </button>
            </div>
        </form>
    );
};
