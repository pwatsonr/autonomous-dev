// PLAN-021 Phase 1A — Cypress configuration for portal UI coverage.
//
// FR-021-03 added Node.js tasks for filesystem fixture management
// (`seedRequests`, `cleanStateDir`). FR-021-04 adds a parallel set with
// per-request semantics (`writeRequestAction`, `writeGateDecision`,
// `clearStateDir`). Both APIs coexist — different specs picked different
// shapes early on.

import { defineConfig } from "cypress";
import { existsSync } from "node:fs";
import {
    mkdir,
    writeFile,
    rm,
    readdir,
} from "node:fs/promises";
import {
    writeFileSync,
    mkdirSync,
    rmSync,
    readFileSync,
    copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default defineConfig({
    e2e: {
        baseUrl: "http://localhost:19283",
        viewportWidth: 1440,
        viewportHeight: 900,
        defaultCommandTimeout: 4000,
        setupNodeEvents(on) {
            const STATE_DIR =
                process.env["AUTONOMOUS_DEV_STATE_DIR"] || "/tmp/cypress-state";

            on("task", {
                // FR-021-03 API: bulk seed by stateDir + array.
                async seedRequests({
                    stateDir,
                    requests,
                }: {
                    stateDir: string;
                    requests: Array<{ id?: string } & Record<string, unknown>>;
                }) {
                    const requestActionsDir = join(stateDir, "request-actions");
                    if (!existsSync(requestActionsDir)) {
                        await mkdir(requestActionsDir, { recursive: true });
                    }
                    await Promise.all(
                        requests.map(async (request) => {
                            if (!request.id) {
                                throw new Error(
                                    "Request must have an id to be seeded",
                                );
                            }
                            const filePath = join(
                                requestActionsDir,
                                `${request.id}.json`,
                            );
                            await writeFile(
                                filePath,
                                JSON.stringify(request, null, 2),
                                "utf-8",
                            );
                        }),
                    );
                    return null;
                },
                async cleanStateDir(stateDir: string) {
                    if (!existsSync(stateDir)) return null;
                    try {
                        const entries = await readdir(stateDir);
                        await Promise.all(
                            entries.map(async (entry) =>
                                rm(join(stateDir, entry), {
                                    recursive: true,
                                    force: true,
                                }),
                            ),
                        );
                    } catch (error) {
                        console.warn(
                            `Failed to clean state directory ${stateDir}:`,
                            error,
                        );
                    }
                    return null;
                },

                // FR-021-04 API: write a single request-action JSON by id.
                writeRequestAction({
                    id,
                    content,
                }: {
                    id: string;
                    content: object;
                }) {
                    const dir = join(STATE_DIR, "request-actions");
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(
                        join(dir, `${id}.json`),
                        JSON.stringify(content, null, 2),
                    );
                    return null;
                },
                writeGateDecision({
                    repo,
                    id,
                    content,
                }: {
                    repo: string;
                    id: string;
                    content: object;
                }) {
                    const dir = join(STATE_DIR, "gate-decisions");
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(
                        join(dir, `${repo}__${id}.json`),
                        JSON.stringify(content, null, 2),
                    );
                    return null;
                },
                clearStateDir() {
                    try {
                        rmSync(STATE_DIR, { recursive: true, force: true });
                        mkdirSync(STATE_DIR, { recursive: true });
                    } catch (err) {
                        console.warn("clearStateDir failed:", err);
                    }
                    return null;
                },

                // FR-021-07 follow-up — cost-ledger fixture for MTD-spend
                // cross-page consistency. The portal's `readMtdSpend()`
                // (server/wiring/daemon-readers.ts) reads:
                //   ${state_dir}/cost-ledger.json
                // with shape:
                //   { "daily": { "YYYY-MM-DD": { "total_usd": number, ... } } }
                // MTD is the sum of `total_usd` for keys starting with the
                // current UTC month (`YYYY-MM`). We write a single entry
                // pinned to today's UTC date so the seeded value IS the MTD.
                //
                // Cache caveat: `readMtdSpend` caches the last-good value
                // for 5s. Specs that seed a new value should either accept
                // a settle window or simply visit the page after the seed
                // — the test process starts cold so the first read populates
                // the cache from the just-written file.
                seedCostLedger({ usd }: { usd: number }) {
                    const path = join(STATE_DIR, "cost-ledger.json");
                    mkdirSync(STATE_DIR, { recursive: true });
                    const now = new Date();
                    const y = now.getUTCFullYear();
                    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
                    const d = String(now.getUTCDate()).padStart(2, "0");
                    const today = `${String(y)}-${m}-${d}`;
                    const payload = {
                        daily: {
                            [today]: {
                                total_usd: usd,
                                sessions: [
                                    {
                                        request_id: "REQ-CYPRESS-MTD",
                                        cost_usd: usd,
                                        timestamp: now.toISOString(),
                                    },
                                ],
                            },
                        },
                    };
                    writeFileSync(
                        path,
                        JSON.stringify(payload, null, 2),
                        "utf-8",
                    );
                    return null;
                },

                // The operator's real cost-ledger lives at
                // `~/.autonomous-dev/cost-ledger.json`. Cypress runs against
                // a separate STATE_DIR so we should NOT touch the operator
                // file — but defensively snapshot it before any spec that
                // might write near it. Backup/restore is keyed by a caller-
                // supplied path so each spec owns its own snapshot.
                backupCostLedger({ backupPath }: { backupPath: string }) {
                    const realPath = join(
                        homedir(),
                        ".autonomous-dev",
                        "cost-ledger.json",
                    );
                    try {
                        if (existsSync(realPath)) {
                            copyFileSync(realPath, backupPath);
                            return { backedUp: true, source: realPath };
                        }
                    } catch (err) {
                        console.warn("backupCostLedger failed:", err);
                    }
                    return { backedUp: false, source: realPath };
                },

                restoreCostLedger({
                    backupPath,
                }: {
                    backupPath: string;
                }) {
                    const realPath = join(
                        homedir(),
                        ".autonomous-dev",
                        "cost-ledger.json",
                    );
                    try {
                        if (existsSync(backupPath)) {
                            copyFileSync(backupPath, realPath);
                            rmSync(backupPath, { force: true });
                            return { restored: true };
                        }
                    } catch (err) {
                        console.warn("restoreCostLedger failed:", err);
                    }
                    return { restored: false };
                },

                // Read the seeded cost-ledger back so specs can verify
                // their own seed landed where the portal will read it.
                readCostLedger() {
                    const path = join(STATE_DIR, "cost-ledger.json");
                    try {
                        if (!existsSync(path)) return null;
                        return JSON.parse(readFileSync(path, "utf-8"));
                    } catch (err) {
                        console.warn("readCostLedger failed:", err);
                        return null;
                    }
                },
            });
        },
    },
});
