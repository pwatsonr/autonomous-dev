// SPEC-013-2-03 §Task 6 — Startup self-check.
//
// Verifies the runtime version and that the configured state/log paths
// exist as accessible directories. Invoked from startServer() AFTER
// loadPortalConfig and BEFORE validateBindingConfig so we fail fast
// before touching the network.

import { stat } from "node:fs/promises";

import { PortalError } from "../middleware/error-handler";
import { expandHome } from "./config";
import type { PortalConfig } from "./config";

const MIN_BUN = "1.0.0";

/** Compare two semver-shaped strings. Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map((n) => Number(n));
    const pb = b.split(".").map((n) => Number(n));
    for (let i = 0; i < 3; i++) {
        const ai = pa[i] ?? 0;
        const bi = pb[i] ?? 0;
        if (ai > bi) return 1;
        if (ai < bi) return -1;
    }
    return 0;
}

interface BunGlobal {
    version: string;
}

function readBunVersion(): string | null {
    // `Bun` is a global only when running under bun. Outside bun (e.g.
    // npx tsc, plain node), the runtime check is skipped — the standalone
    // launcher script enforces Bun presence at the process boundary.
    const g = globalThis as unknown as { Bun?: BunGlobal };
    return g.Bun?.version ?? null;
}

export async function validateStartupConditions(
    config: PortalConfig,
): Promise<void> {
    // 1. Bun version (only when running under Bun).
    const v = readBunVersion();
    if (v !== null && compareSemver(v, MIN_BUN) < 0) {
        throw new PortalError(
            "INCOMPATIBLE_RUNTIME",
            `Bun ${v} < required ${MIN_BUN}`,
            500,
        );
    }

    // 2. State + logs dirs exist and are accessible.
    for (const p of [config.paths.state_dir, config.paths.logs_dir]) {
        const expanded = expandHome(p);
        try {
            const s = await stat(expanded);
            if (!s.isDirectory()) {
                throw new PortalError(
                    "INVALID_STATE_PATH",
                    `${expanded} exists but is not a directory`,
                    500,
                );
            }
        } catch (err) {
            if (err instanceof PortalError) throw err;
            const e = err as { code?: string };
            if (e.code === "ENOENT") {
                throw new PortalError(
                    "MISSING_STATE_PATH",
                    `${expanded} does not exist; run autonomous-dev install-daemon first`,
                    500,
                );
            }
            if (e.code === "EACCES") {
                throw new PortalError(
                    "STATE_PATH_ACCESS_DENIED",
                    `Cannot access ${expanded}; check permissions`,
                    500,
                );
            }
            throw err;
        }
    }
}
