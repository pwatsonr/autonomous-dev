// PLAN-038 TASK-011 — portal settings reader (lightweight, read-only).
//
// Reads `<state-root>/portal-settings.json`. This is the file the
// `kit-parity` fixture provides; in production the daemon (or operator
// `autonomous-dev configure`) writes the same file. When absent, the
// reader returns an empty allowlist — the honest empty-state per the
// Tenet "Honesty over fidelity".
//
// Distinct from `settings-store.tsx` which is the mutating store (writer)
// for the Settings surface. This file is the read-side composition input.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { stateDirRoot } from "./state-paths";

export interface AllowlistEntry {
    id: string;
    path: string;
}

export interface PortalSettings {
    allowlist: AllowlistEntry[];
    /** Per-repo trust overrides, keyed by repo id. */
    trustOverrides: Record<string, string>;
    /** Global trust default (when no per-repo override). */
    globalTrust: string;
}

interface PortalSettingsFile {
    repositories?: {
        allowlist?: AllowlistEntry[];
    };
    trustLevels?: {
        global?: string;
        perRepo?: Record<string, string>;
    };
}

export interface SettingsReaderOptions {
    /** Override the state-dir root (default: state-paths). */
    stateRoot?: string;
}

export function portalSettingsPath(stateRoot?: string): string {
    return join(stateRoot ?? stateDirRoot(), "portal-settings.json");
}

export async function readPortalSettings(
    opts: SettingsReaderOptions = {},
): Promise<PortalSettings> {
    const path = portalSettingsPath(opts.stateRoot);
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch {
        return { allowlist: [], trustOverrides: {}, globalTrust: "L1" };
    }
    let parsed: PortalSettingsFile;
    try {
        parsed = JSON.parse(raw) as PortalSettingsFile;
    } catch {
        return { allowlist: [], trustOverrides: {}, globalTrust: "L1" };
    }
    return {
        allowlist: parsed.repositories?.allowlist ?? [],
        trustOverrides: parsed.trustLevels?.perRepo ?? {},
        globalTrust: parsed.trustLevels?.global ?? "L1",
    };
}
