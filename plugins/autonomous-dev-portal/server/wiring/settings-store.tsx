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

import { atomicWriteJson, readJsonOrNull } from "./atomic-json";
import { userConfigPath } from "./state-paths";

/**
 * The persisted shape. Only the keys the portal mutates are typed; we
 * preserve any other keys via index-signature passthrough so the daemon's
 * own settings survive a portal write.
 */
interface UserConfigFile {
    general?: {
        dailyCap?: number;
        defaultVariant?: string;
        defaultBackend?: string;
    };
    notifications?: {
        discordWebhook?: string;
        slackWebhook?: string;
        notifyDefault?: string;
        dndEnabled?: boolean;
        dndStart?: string;
        dndEnd?: string;
    };
    repositories?: {
        allowlist?: AllowlistEntry[];
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
        _actor: string,
    ): Promise<SettingsFormSaveResult> {
        // Validate the only field that has a numeric constraint. The
        // remaining fields are free-form strings (variant id, backend id,
        // notification settings) — the daemon validates them on read.
        if ("dailyCap" in form) {
            const v = parseDailyCap(form["dailyCap"]);
            if (v === null) {
                return {
                    ok: false,
                    field: "dailyCap",
                    fragment: settingsErrorFragment(
                        "dailyCap must be a non-negative number",
                        "dailyCap",
                    ),
                };
            }
        }
        return await this.serialize(async () => {
            const current = (await this.readCurrent()) ?? {};
            const next: UserConfigFile = { ...current };
            next.general = { ...(current.general ?? {}) };
            if ("dailyCap" in form) {
                next.general.dailyCap = parseDailyCap(form["dailyCap"]) ?? 0;
            }
            if (typeof form["defaultVariant"] === "string") {
                next.general.defaultVariant = form["defaultVariant"];
            }
            if (typeof form["defaultBackend"] === "string") {
                next.general.defaultBackend = form["defaultBackend"];
            }
            next.notifications = { ...(current.notifications ?? {}) };
            for (const k of [
                "discordWebhook",
                "slackWebhook",
                "notifyDefault",
                "dndStart",
                "dndEnd",
            ] as const) {
                if (typeof form[k] === "string") {
                    (next.notifications as Record<string, unknown>)[k] = form[k];
                }
            }
            if ("dndEnabled" in form) {
                const v = form["dndEnabled"];
                next.notifications.dndEnabled =
                    v === true || v === "true" || v === "on" || v === "1";
            }
            try {
                await atomicWriteJson(this.path, next);
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

    async addAllowlist(
        realPath: string,
        _actor: string,
    ): Promise<AllowlistAddResult> {
        return await this.serialize(async () => {
            const current = (await this.readCurrent()) ?? {};
            const list = current.repositories?.allowlist ?? [];
            if (list.some((e) => e.path === realPath)) {
                return {
                    ok: false,
                    message: "already-on-allowlist",
                };
            }
            const entry: AllowlistEntry = {
                id: `rep-${randomBytes(4).toString("hex")}`,
                path: realPath,
                status: "ok",
                addedAt: new Date().toISOString(),
            };
            const next: UserConfigFile = {
                ...current,
                repositories: {
                    ...(current.repositories ?? {}),
                    allowlist: [...list, entry],
                },
            };
            try {
                await atomicWriteJson(this.path, next);
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
