// Homelab discovery surface — GET /portal/homelab + GET /portal/homelab/api/observations.
//
// DATA SOURCE (read-only):
//   $AUTONOMOUS_DEV_HOMELAB_DATA_DIR  (default: ~/.autonomous-dev-homelab/)
//     inventory.yaml          — { version, platforms: [ { id, type, host, port,
//                                  discovered_at, last_seen, ... } ] }
//     observations/*.json     — { id, platform, pattern, resource, severity,
//                                  discovered_at, details }
//
// Both reads are defensive: missing dir / files yield empty arrays and the
// view renders an honest empty-state rather than crashing.
//
// YAML parsing: the portal has no YAML dependency. We use a minimal parser
// limited to the known flat-scalar + sequence shape of inventory.yaml so no
// new package is required.

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import type { HomelabPlatform, HomelabObservation } from "../types/render";

/**
 * Resolves the homelab data directory.
 * Honours the `AUTONOMOUS_DEV_HOMELAB_DATA_DIR` env var; defaults to
 * `~/.autonomous-dev-homelab`.
 */
function homelabDataDir(): string {
    return (
        process.env["AUTONOMOUS_DEV_HOMELAB_DATA_DIR"] ??
        join(homedir(), ".autonomous-dev-homelab")
    );
}

// ---------------------------------------------------------------------------
// Minimal YAML parser — handles the flat-scalar + list shape of inventory.yaml
// ---------------------------------------------------------------------------

/**
 * Parses a YAML scalar value string into a JS primitive.
 * Handles quoted strings, booleans, null, integers, floats.
 *
 * @param raw - Raw YAML value string (no surrounding whitespace).
 * @returns Parsed JS value.
 */
function parseScalar(raw: string): unknown {
    if (raw === "null" || raw === "~") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^['"]/.test(raw)) return raw.slice(1, -1);
    const n = Number(raw);
    if (!isNaN(n) && raw.length > 0) return n;
    return raw;
}

/**
 * Extracts the key and scalar value from a YAML `key: value` line.
 *
 * @param line - One line of YAML text (with leading whitespace stripped).
 * @returns `[key, value]` tuple or `null` when the line is not a scalar pair.
 */
function parseKeyValue(line: string): [string, unknown] | null {
    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) {
        // key with no value (e.g. `platforms:`)
        const bareColon = line.endsWith(":");
        if (bareColon) return [line.slice(0, -1).trim(), undefined];
        return null;
    }
    const key = line.slice(0, colonIdx).trim();
    const val = parseScalar(line.slice(colonIdx + 2).trim());
    return [key, val];
}

/**
 * Minimal YAML parser for the inventory.yaml shape:
 * ```yaml
 * version: 1
 * platforms:
 *   - id: proxmox-01
 *     type: proxmox
 *     host: 192.168.1.10
 *     port: 8006
 *     discovered_at: 2026-01-01T00:00:00Z
 *     last_seen: 2026-06-01T00:00:00Z
 * ```
 * Returns `{ platforms: HomelabPlatform[] }` or an empty object on error.
 *
 * @param text - Raw YAML text from inventory.yaml.
 * @returns Parsed object with a `platforms` array.
 */
function parseInventoryYaml(text: string): { platforms: HomelabPlatform[] } {
    const lines = text.split("\n");
    const platforms: HomelabPlatform[] = [];
    let inPlatforms = false;
    let current: Record<string, unknown> | null = null;

    for (const rawLine of lines) {
        const stripped = rawLine.trimEnd();
        if (!stripped || stripped.trimStart().startsWith("#")) continue;

        const indent = rawLine.length - rawLine.trimStart().length;

        // Top-level key detection
        if (indent === 0) {
            if (current !== null) {
                platforms.push(current as unknown as HomelabPlatform);
                current = null;
            }
            const kv = parseKeyValue(stripped);
            if (kv && kv[0] === "platforms") {
                inPlatforms = true;
            } else {
                inPlatforms = false;
            }
            continue;
        }

        if (!inPlatforms) continue;

        // List item start
        const trimmed = stripped.trimStart();
        if (trimmed.startsWith("- ")) {
            if (current !== null) {
                platforms.push(current as unknown as HomelabPlatform);
            }
            current = {};
            const rest = trimmed.slice(2);
            const kv = parseKeyValue(rest);
            if (kv) current[kv[0]] = kv[1];
            continue;
        }

        // Continuation key inside a list item
        if (current !== null) {
            const kv = parseKeyValue(trimmed);
            if (kv) current[kv[0]] = kv[1];
        }
    }

    if (current !== null) {
        platforms.push(current as unknown as HomelabPlatform);
    }

    return { platforms };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Reads and parses `inventory.yaml` from the homelab data dir.
 * Returns an empty array when the file is absent or unparseable.
 *
 * @returns Array of discovered platforms.
 */
async function readPlatforms(): Promise<HomelabPlatform[]> {
    try {
        const path = join(homelabDataDir(), "inventory.yaml");
        const text = await readFile(path, "utf-8");
        const { platforms } = parseInventoryYaml(text);
        return platforms.filter(
            (p) => typeof p.id === "string" && typeof p.host === "string",
        );
    } catch {
        return [];
    }
}

/**
 * Reads all `observations/*.json` files from the homelab data dir.
 * Skips any file that is absent, unreadable, or does not parse as a
 * valid observation object — the remaining files are still returned.
 *
 * @returns Array of observation objects, sorted newest-first by discovered_at.
 */
async function readObservations(): Promise<HomelabObservation[]> {
    try {
        const dir = join(homelabDataDir(), "observations");
        const entries = await readdir(dir);
        const jsonFiles = entries.filter((f) => f.endsWith(".json"));

        const results = await Promise.all(
            jsonFiles.map(async (f): Promise<HomelabObservation | null> => {
                try {
                    const raw = await readFile(join(dir, f), "utf-8");
                    const obj = JSON.parse(raw) as Record<string, unknown>;
                    if (
                        typeof obj["id"] === "string" &&
                        typeof obj["platform"] === "string" &&
                        typeof obj["pattern"] === "string"
                    ) {
                        return {
                            id: String(obj["id"]),
                            platform: String(obj["platform"]),
                            pattern: String(obj["pattern"]),
                            resource: typeof obj["resource"] === "string" ? obj["resource"] : "",
                            severity: typeof obj["severity"] === "string" ? obj["severity"] : "info",
                            discovered_at: typeof obj["discovered_at"] === "string" ? obj["discovered_at"] : "",
                            details: typeof obj["details"] === "object" && obj["details"] !== null
                                ? (obj["details"] as Record<string, unknown>)
                                : {},
                        };
                    }
                    return null;
                } catch {
                    return null;
                }
            }),
        );

        const valid = results.filter((r): r is HomelabObservation => r !== null);
        // Sort newest-first by discovered_at.
        valid.sort((a, b) => (b.discovered_at > a.discovered_at ? 1 : -1));
        return valid;
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /portal/homelab — full page render of the homelab discovery surface.
 *
 * @param c - Hono request context.
 * @returns HTML response (full page or fragment depending on HTMX headers).
 */
export const homelabHandler = async (c: Context): Promise<Response> => {
    const [platforms, observations] = await Promise.all([
        readPlatforms(),
        readObservations(),
    ]);
    return renderPage(c, "homelab", { platforms, observations });
};

/**
 * GET /portal/homelab/api/observations — returns observations as JSON.
 *
 * @param c - Hono request context.
 * @returns JSON response with the observations array.
 */
export const homelabObservationsApiHandler = async (c: Context): Promise<Response> => {
    const observations = await readObservations();
    return c.json({ observations });
};

// Export the minimal YAML parser for unit testing.
export { parseInventoryYaml };
