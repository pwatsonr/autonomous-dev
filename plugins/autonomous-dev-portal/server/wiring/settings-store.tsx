// PLAN-037-2 — file-backed `SettingsStore` for the action routes.
//
// The user-facing config file is `~/.claude/autonomous-dev.json` (shared
// with the daemon). The portal mutates a narrow subset:
//
//   - General tab form save  → `general.dailyCap`, `general.defaultVariant`,
//                              `general.defaultBackend`, `notifications.*`
//   - Allowlist add          → `repositories.allowlist[]`
//
// All other top-level keys (the daemon's own settings) are preserved
// verbatim under the deep-merge. Writes are atomic.

import { randomBytes } from "node:crypto";
import type { JSX } from "hono/jsx";

import type { AllowlistEntry } from "../types/render";
import type {
    AllowlistAddResult,
    SettingsFormSaveResult,
    SettingsStore,
} from "../routes/settings-actions";

import { readJsonOrNull } from "./atomic-json";
import { userConfigPath } from "./state-paths";
import { writeConfigChangeMarker } from "./config-change-store";

/**
 * The persisted daemon config shape. We use the daemon's nested structure
 * and preserve any other keys via index-signature passthrough so the daemon's
 * own settings survive a portal write.
 */
export interface UserConfigFile {
    governance?: {
        daily_cost_cap_usd?: number;
        monthly_cost_cap_usd?: number;
        per_request_cost_cap_usd?: number;
        max_concurrent_requests?: number;
    };
    trust?: {
        system_default_level?: number;
        per_repo_overrides?: Record<string, string>;
    };
    notifications?: {
        delivery?: {
            discord?: { webhook_url?: string };
            slack?: { webhook_url?: string };
            default_method?: string;
        };
        // Keep legacy flat fields for backward compatibility
        discordWebhook?: string;
        slackWebhook?: string;
        notifyDefault?: string;
        dndEnabled?: boolean;
        dndStart?: string;
        dndEnd?: string;
    };
    repositories?: {
        allowlist?: string[]; // daemon uses string[] not AllowlistEntry[]
    };
    general?: {
        defaultVariant?: string;
        defaultBackend?: string;
    };
    [k: string]: unknown;
}

function parseDailyCap(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
    if (typeof raw === "string" && raw.length > 0) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
}

function settingsSavedFragment(): JSX.Element {
    return (
        <div class="settings-saved" data-result="ok">
            <span class="chip ok">SAVED</span>
            <span class="meta">Settings updated.</span>
        </div>
    );
}

function settingsErrorFragment(message: string, field?: string): JSX.Element {
    return (
        <div class="settings-error" data-result="err" data-field={field ?? ""}>
            <span class="chip err">ERROR</span>
            <span class="meta">{message}</span>
        </div>
    );
}

function allowlistRowFragment(entry: AllowlistEntry): JSX.Element {
    return (
        <tr class="allowlist-row" data-path={entry.path} data-id={entry.id}>
            <td class="mono">{entry.path}</td>
            <td>
                <span class="chip ok">{entry.status}</span>
            </td>
            <td class="mono">{entry.addedAt}</td>
        </tr>
    );
}

/**
 * Atomic-write-backed settings store. Reads the current config, merges
 * the requested change in, and writes a single rename — preserving every
 * key not explicitly mutated.
 */
export class FileSettingsStore implements SettingsStore {
    private writeQueue: Promise<unknown> = Promise.resolve();

    constructor(private readonly path: string = userConfigPath()) {}

    async saveFromForm(
        form: Record<string, unknown>,
        actor: string,
    ): Promise<SettingsFormSaveResult> {
        // Validate numeric constraints - support both field naming patterns
        const dailyField = "dailyCap" in form ? "dailyCap" : "daily";
        const perRequestField = "perRequest" in form ? "perRequest" : "perRequest";
        const monthlyField = "monthly" in form ? "monthly" : "monthly";

        if (dailyField in form) {
            const v = parseDailyCap(form[dailyField]);
            if (v === null) {
                return {
                    ok: false,
                    field: dailyField,
                    fragment: settingsErrorFragment(
                        `${dailyField} must be a non-negative number`,
                        dailyField,
                    ),
                };
            }
        }
        if (perRequestField in form) {
            const v = parseDailyCap(form[perRequestField]);
            if (v === null) {
                return {
                    ok: false,
                    field: perRequestField,
                    fragment: settingsErrorFragment(
                        `${perRequestField} must be a non-negative number`,
                        perRequestField,
                    ),
                };
            }
        }
        if (monthlyField in form) {
            const v = parseDailyCap(form[monthlyField]);
            if (v === null) {
                return {
                    ok: false,
                    field: monthlyField,
                    fragment: settingsErrorFragment(
                        `${monthlyField} must be a non-negative number`,
                        monthlyField,
                    ),
                };
            }
        }

        return await this.serialize(async () => {
            const current = (await this.readCurrent()) ?? {};
            const next: UserConfigFile = { ...current };

            // Governance section
            if (dailyField in form || perRequestField in form || monthlyField in form) {
                next.governance = { ...(current.governance ?? {}) };
                if (dailyField in form) {
                    next.governance.daily_cost_cap_usd = parseDailyCap(form[dailyField]) ?? 25;
                }
                if (perRequestField in form) {
                    next.governance.per_request_cost_cap_usd = parseDailyCap(form[perRequestField]) ?? 10;
                }
                if (monthlyField in form) {
                    next.governance.monthly_cost_cap_usd = parseDailyCap(form[monthlyField]) ?? 500;
                }
            }

            // Trust section
            if ("trust-level" in form) {
                next.trust = { ...(current.trust ?? {}) };
                const trustLevel = form["trust-level"];
                if (typeof trustLevel === "string" && trustLevel.match(/^L\d+$/)) {
                    // Convert "L1" -> 1
                    next.trust.system_default_level = parseInt(trustLevel.slice(1), 10);
                }
            }

            // General section (variants/backends)
            if ("defaultVariant" in form || "defaultBackend" in form) {
                next.general = { ...(current.general ?? {}) };
                if (typeof form["defaultVariant"] === "string") {
                    next.general.defaultVariant = form["defaultVariant"];
                }
                if (typeof form["defaultBackend"] === "string") {
                    next.general.defaultBackend = form["defaultBackend"];
                }
            }

            // Notifications section - use daemon's nested shape
            if (this.hasNotificationFields(form)) {
                next.notifications = { ...(current.notifications ?? {}) };

                // Ensure delivery structure exists
                next.notifications.delivery = { ...(next.notifications.delivery ?? {}) };

                // Handle Discord webhook
                if (typeof form["discordWebhook"] === "string") {
                    next.notifications.delivery.discord = {
                        ...(next.notifications.delivery.discord ?? {}),
                        webhook_url: form["discordWebhook"]
                    };
                    // Also update legacy field for backward compatibility
                    next.notifications.discordWebhook = form["discordWebhook"];
                }

                // Handle Slack webhook
                if (typeof form["slackWebhook"] === "string") {
                    next.notifications.delivery.slack = {
                        ...(next.notifications.delivery.slack ?? {}),
                        webhook_url: form["slackWebhook"]
                    };
                    next.notifications.slackWebhook = form["slackWebhook"];
                }

                // Handle default method
                if (typeof form["defaultMethod"] === "string") {
                    next.notifications.delivery.default_method = form["defaultMethod"];
                    next.notifications.notifyDefault = form["defaultMethod"];
                }

                // Handle DND settings
                for (const k of ["dndStart", "dndEnd"] as const) {
                    if (typeof form[k] === "string") {
                        next.notifications[k] = form[k];
                    }
                }

                if ("dndEnabled" in form) {
                    const v = form["dndEnabled"];
                    next.notifications.dndEnabled =
                        v === true || v === "true" || v === "on" || v === "1";
                }
            }

            try {
                // FR-925: route the change through the daemon (config-change
                // marker), don't mutate the user config directly. Summarize
                // which section(s) the form actually touched for the audit log.
                const sections: string[] = [];
                if (dailyField in form || perRequestField in form || monthlyField in form) {
                    sections.push("cost caps");
                }
                if ("trust-level" in form) sections.push("trust level");
                if ("defaultVariant" in form || "defaultBackend" in form) {
                    sections.push("general");
                }
                if (this.hasNotificationFields(form)) sections.push("notifications");
                await writeConfigChangeMarker({
                    proposed: next,
                    actor,
                    summary: `settings: ${sections.length > 0 ? sections.join(", ") : "update"}`,
                });
            } catch (err) {
                return {
                    ok: false,
                    fragment: settingsErrorFragment(
                        `write failed: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                };
            }
            return { ok: true, fragment: settingsSavedFragment() };
        });
    }

    private hasNotificationFields(form: Record<string, unknown>): boolean {
        const notificationFields = [
            "discordWebhook", "slackWebhook", "defaultMethod",
            "dndEnabled", "dndStart", "dndEnd"
        ];
        return notificationFields.some(field => field in form);
    }

    async addAllowlist(
        realPath: string,
        actor: string,
    ): Promise<AllowlistAddResult> {
        return await this.serialize(async () => {
            const current = (await this.readCurrent()) ?? {};
            const list = current.repositories?.allowlist ?? [];
            if (list.includes(realPath)) {
                return {
                    ok: false,
                    message: "already-on-allowlist",
                };
            }

            // Create entry for UI purposes
            const entry: AllowlistEntry = {
                id: `rep-${randomBytes(4).toString("hex")}`,
                path: realPath,
                status: "ok",
                addedAt: new Date().toISOString(),
            };

            // But store as string[] in daemon format
            const next: UserConfigFile = {
                ...current,
                repositories: {
                    ...(current.repositories ?? {}),
                    allowlist: [...list, realPath],
                },
            };
            try {
                // FR-925: route through the daemon via a config-change marker.
                await writeConfigChangeMarker({
                    proposed: next,
                    actor,
                    summary: `settings: allowlist add ${realPath}`,
                });
            } catch (err) {
                return {
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                };
            }
            return { ok: true, fragment: allowlistRowFragment(entry) };
        });
    }

    private async readCurrent(): Promise<UserConfigFile | null> {
        return await readJsonOrNull<UserConfigFile>(this.path);
    }

    private async serialize<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.writeQueue.then(fn, fn);
        this.writeQueue = run.catch(() => undefined);
        return await run;
    }
}
