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
} from "node:fs";
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
            });
        },
    },
});
