#!/usr/bin/env bun
// Bun-executable CLI for the agent-factory.
//
// Exposes the in-process command* functions from src/agent-factory/cli.ts
// as `autonomous-dev agent <verb> <name>` so the portal (and any other
// external caller) can spawn them via the existing `autonomous-dev`
// dispatcher rather than importing the daemon's TypeScript build.
//
// Verbs:
//   - inspect            → commandInspect (human text) or JSON with --json
//   - freeze   <name>    → commandFreeze + persist state
//   - unfreeze <name>    → commandUnfreeze + persist state
//   - promote  <name> <version>  → commandPromote (async)
//   - list               → JSON list of {name, state} when --json, else text
//
// Persistence:
//   freeze/unfreeze persist the FROZEN-name set to
//   `${AUTONOMOUS_DEV_STATE_DIR ?? ~/.autonomous-dev}/agent-states.json`.
//   Subsequent invocations apply that overlay after registry.load() so the
//   user-visible state survives process exits.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    commandFreeze,
    commandInspect,
    commandPromote,
    commandUnfreeze,
} from "../src/agent-factory/cli";
import { AgentRegistry } from "../src/agent-factory/registry";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersistedState {
    /** Schema version, in case the shape evolves. */
    v: 1;
    /** Set of agent names currently FROZEN. */
    frozen: string[];
    /** ISO timestamp of the last mutation. */
    updatedAt: string;
}

function stateFilePath(): string {
    const override = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    if (override !== undefined && override.length > 0) {
        return join(override, "agent-states.json");
    }
    return join(homedir(), ".autonomous-dev", "agent-states.json");
}

async function readPersistedState(): Promise<PersistedState> {
    const path = stateFilePath();
    if (!existsSync(path)) {
        return { v: 1, frozen: [], updatedAt: new Date(0).toISOString() };
    }
    try {
        const raw = await fs.readFile(path, "utf-8");
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        return {
            v: 1,
            frozen: Array.isArray(parsed.frozen) ? parsed.frozen.filter(
                (n): n is string => typeof n === "string",
            ) : [],
            updatedAt:
                typeof parsed.updatedAt === "string"
                    ? parsed.updatedAt
                    : new Date(0).toISOString(),
        };
    } catch {
        return { v: 1, frozen: [], updatedAt: new Date(0).toISOString() };
    }
}

async function writePersistedState(state: PersistedState): Promise<void> {
    const path = stateFilePath();
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
    });
    await fs.rename(tmp, path);
}

/** Apply persisted FROZEN overlay onto a freshly-loaded registry. */
function applyOverlay(registry: AgentRegistry, frozen: string[]): void {
    for (const name of frozen) {
        try {
            registry.freeze(name);
        } catch {
            // Agent may have been removed from disk while frozen. Silently
            // skip — the persisted entry becomes a no-op on the next write.
        }
    }
}

// ---------------------------------------------------------------------------
// JSON envelope for inspect/list (consumed by the portal)
// ---------------------------------------------------------------------------

interface InspectJson {
    name: string;
    version: string;
    role: string;
    model: string;
    state: string;
    description: string;
    frozen: boolean;
    riskTier?: string;
}

function recordToJson(record: ReturnType<AgentRegistry["get"]>): InspectJson | null {
    if (!record) return null;
    // AgentRecord = {agent: ParsedAgent, state, loadedAt, diskHash, filePath}
    const a = record.agent;
    return {
        name: a.name,
        version: a.version ?? "",
        role: a.role ?? "",
        model: a.model ?? "",
        state: record.state,
        description: a.description ?? "",
        frozen: record.state === "FROZEN",
        riskTier: (a as Record<string, unknown>)["risk_tier"] as string | undefined,
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const jsonMode = argv.includes("--json");
    const positional = argv.filter((a) => a !== "--json");
    const [verb, name, ...rest] = positional;

    if (!verb || verb === "--help" || verb === "-h") {
        console.error(
            "Usage: autonomous-dev agent <inspect|freeze|unfreeze|promote|list> <name> [version] [--json]",
        );
        return verb && verb !== "--help" && verb !== "-h" ? 1 : 0;
    }

    const here = dirname(fileURLToPath(import.meta.url));
    const agentsDir = resolve(here, "..", "agents");

    const registry = new AgentRegistry();
    const loadResult = await registry.load(agentsDir);

    if (loadResult.loaded === 0) {
        const msg = `no agents loaded from ${agentsDir} (rejected=${loadResult.rejected})`;
        if (jsonMode) {
            console.log(JSON.stringify({ error: msg }));
        } else {
            console.error(`Error: ${msg}`);
        }
        return 1;
    }

    // Apply persisted FROZEN overlay before any verb-specific logic runs.
    const persisted = await readPersistedState();
    applyOverlay(registry, persisted.frozen);

    if (verb === "list") {
        const records = registry.list();
        if (jsonMode) {
            console.log(
                JSON.stringify(
                    records
                        .map(recordToJson)
                        .filter((r): r is InspectJson => r !== null),
                    null,
                    2,
                ),
            );
        } else {
            for (const r of records) {
                console.log(`${r.name}\t${r.state}`);
            }
        }
        return 0;
    }

    if (!name) {
        const msg = `'autonomous-dev agent ${verb}' requires <name>`;
        if (jsonMode) {
            console.log(JSON.stringify({ error: msg }));
        } else {
            console.error(`Error: ${msg}`);
        }
        return 1;
    }

    let output: string;
    let mutated = false;
    try {
        switch (verb) {
            case "inspect": {
                if (jsonMode) {
                    const json = recordToJson(registry.get(name));
                    if (!json) {
                        console.log(JSON.stringify({ error: "not-found", name }));
                        return 1;
                    }
                    console.log(JSON.stringify(json, null, 2));
                    return 0;
                }
                output = commandInspect(registry, name);
                break;
            }
            case "freeze":
                output = commandFreeze(registry, name);
                if (!output.startsWith("Error:")) {
                    mutated = true;
                    if (!persisted.frozen.includes(name)) {
                        persisted.frozen.push(name);
                    }
                }
                break;
            case "unfreeze":
                output = commandUnfreeze(registry, name);
                if (!output.startsWith("Error:")) {
                    mutated = true;
                    persisted.frozen = persisted.frozen.filter(
                        (n) => n !== name,
                    );
                }
                break;
            case "promote": {
                const version = rest[0];
                if (!version) {
                    const msg = "'agent promote' requires <name> <version>";
                    if (jsonMode) {
                        console.log(JSON.stringify({ error: msg }));
                    } else {
                        console.error(`Error: ${msg}`);
                    }
                    return 1;
                }
                output = await commandPromote(registry, name, version, {});
                break;
            }
            default: {
                const msg = `unknown verb '${verb}'. Use inspect|freeze|unfreeze|promote|list.`;
                if (jsonMode) {
                    console.log(JSON.stringify({ error: msg }));
                } else {
                    console.error(`Error: ${msg}`);
                }
                return 1;
            }
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
            console.log(JSON.stringify({ error: message }));
        } else {
            console.error(`Error: ${message}`);
        }
        return 1;
    }

    if (mutated) {
        persisted.updatedAt = new Date().toISOString();
        await writePersistedState(persisted);
    }

    if (jsonMode) {
        // Wrap human text in a uniform envelope so callers can rely on shape.
        const ok = !output.startsWith("Error:");
        console.log(JSON.stringify({ ok, message: output }));
    } else {
        console.log(output);
    }

    return output.startsWith("Error:") ? 1 : 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
    });
