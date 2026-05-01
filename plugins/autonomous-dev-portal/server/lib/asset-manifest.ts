// SPEC-013-4-01 §Asset Manifest.
//
// Read-only manifest that maps logical asset names (e.g. `portal.css`) to
// their hashed counterparts (e.g. `portal-a1b2c3d4.css`). Templates call
// `assetUrl(name)` which delegates to `AssetManifest.resolve(name)`.
//
// Production semantics:
//   - manifest MUST exist; missing entries throw `MissingAssetError`.
//   - resolves to the hashed filename so `Cache-Control: immutable`
//     applies and CDNs can fingerprint correctly.
//
// Development semantics:
//   - manifest is optional; missing names fall back to the logical name
//     (so live-reload doesn't require a hash rebuild).
//
// Refresh contract:
//   - `refresh()` is atomic: parse-then-swap. A partial or invalid JSON
//     read leaves the previous map in place and rethrows. Callers never
//     observe a half-loaded state.

import { readFileSync } from "node:fs";

export class MissingAssetError extends Error {
    public readonly logicalName: string;
    constructor(logicalName: string) {
        super(`Asset not found in manifest: ${logicalName}`);
        this.name = "MissingAssetError";
        this.logicalName = logicalName;
    }
}

function isProductionMode(): boolean {
    return process.env["NODE_ENV"] === "production";
}

export class AssetManifest {
    private readonly manifestPath: string;
    // Read-only after each successful load. Never mutated in place.
    private map: Readonly<Record<string, string>>;

    constructor(manifestPath: string) {
        this.manifestPath = manifestPath;
        this.map = {};
        // Best-effort initial load. In dev the file may not exist; that
        // is fine — `resolve` falls back to the logical name. Errors in
        // production surface lazily on first `resolve` call so the
        // constructor is safe to call from module top-level.
        try {
            this.loadSync();
        } catch {
            // ignore; resolve() handles missing-in-production correctly
        }
    }

    /**
     * Returns the hashed filename for `logicalName` from the manifest.
     * In development mode, missing entries fall back to the logical
     * name. In production mode, they throw `MissingAssetError`.
     */
    public resolve(logicalName: string): string {
        const hashed = this.map[logicalName];
        if (hashed !== undefined) return hashed;
        if (isProductionMode()) {
            throw new MissingAssetError(logicalName);
        }
        return logicalName;
    }

    /**
     * Atomically re-reads the manifest from disk. Parses into a temp
     * object, validates, then swaps. On failure the previous map is
     * preserved and the error is rethrown.
     */
    public async refresh(): Promise<void> {
        const text = await Bun.file(this.manifestPath).text();
        const next = AssetManifest.parse(text);
        // Swap on success only.
        this.map = next;
    }

    private loadSync(): void {
        const text = readFileSync(this.manifestPath, "utf-8");
        this.map = AssetManifest.parse(text);
    }

    private static parse(text: string): Readonly<Record<string, string>> {
        const parsed: unknown = JSON.parse(text);
        if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
        ) {
            throw new Error("Manifest must be a JSON object");
        }
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v !== "string") {
                throw new Error(
                    `Manifest entry '${k}' is not a string: ${String(v)}`,
                );
            }
            next[k] = v;
        }
        return Object.freeze(next);
    }
}

// ---- Singleton accessor ----------------------------------------------------

let singleton: AssetManifest | null = null;

/**
 * Lazily initialised singleton bound to the default manifest path. The
 * production server constructs this once and templates call `assetUrl`
 * (helper) which forwards to `getAssetManifest().resolve(...)`.
 */
export function getAssetManifest(manifestPath?: string): AssetManifest {
    if (singleton === null) {
        const path =
            manifestPath ??
            `${process.cwd()}/static/asset-manifest.json`;
        singleton = new AssetManifest(path);
    }
    return singleton;
}

/**
 * Test helper: clears the singleton so tests can swap manifests between
 * cases. Not exported through the public surface used by templates.
 */
export function _resetAssetManifestForTests(): void {
    singleton = null;
}
