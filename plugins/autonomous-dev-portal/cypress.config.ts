// PLAN-021 Phase 1A — Cypress configuration for portal UI coverage.
//
// FR-021-03 enhancement: adds Node.js tasks for filesystem fixture management.
// Configured for baseUrl http://localhost:19282 (matches portal:cypress script),
// viewport 1440x900, defaultCommandTimeout 4000ms.

import { defineConfig } from "cypress";
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export default defineConfig({
    e2e: {
        baseUrl: "http://localhost:19283",
        viewportWidth: 1440,
        viewportHeight: 900,
        defaultCommandTimeout: 4000,
        setupNodeEvents(on, config) {
            // FR-021-03: Add filesystem tasks for fixture management
            on('task', {
                async seedRequests({ stateDir, requests }) {
                    const requestActionsDir = join(stateDir, 'request-actions');

                    // Ensure directory exists
                    if (!existsSync(requestActionsDir)) {
                        await mkdir(requestActionsDir, { recursive: true });
                    }

                    // Write each request to its own JSON file
                    await Promise.all(requests.map(async (request) => {
                        if (!request.id) {
                            throw new Error('Request must have an id to be seeded');
                        }
                        const filePath = join(requestActionsDir, `${request.id}.json`);
                        await writeFile(filePath, JSON.stringify(request, null, 2), 'utf-8');
                    }));

                    return null;
                },
                async cleanStateDir(stateDir) {
                    if (!existsSync(stateDir)) {
                        return null; // Nothing to clean
                    }

                    try {
                        const entries = await readdir(stateDir);
                        await Promise.all(entries.map(async (entry) => {
                            const entryPath = join(stateDir, entry);
                            await rm(entryPath, { recursive: true, force: true });
                        }));
                    } catch (error) {
                        // Log error but don't fail the test - state cleanup is best-effort
                        console.warn(`Failed to clean state directory ${stateDir}:`, error);
                    }

                    return null;
                }
            });
        },
    },
});