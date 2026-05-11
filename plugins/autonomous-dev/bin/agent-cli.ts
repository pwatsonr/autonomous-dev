#!/usr/bin/env bun
// Bun-executable CLI for the agent-factory.
//
// Exposes the in-process command* functions from src/agent-factory/cli.ts
// as `autonomous-dev agent <verb> <name>` so the portal (and any other
// external caller) can spawn them via the existing `autonomous-dev`
// dispatcher rather than importing the daemon's TypeScript build.
//
// Verbs supported (all in-process):
//   - inspect  → commandInspect
//   - freeze   → commandFreeze
//   - unfreeze → commandUnfreeze
//   - promote  → commandPromote (async)
//
// Exits 0 on success, 1 on error. Output is the function's return string
// printed to stdout; errors go to stderr.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    commandFreeze,
    commandInspect,
    commandPromote,
    commandUnfreeze,
} from "../src/agent-factory/cli";
import { AgentRegistry } from "../src/agent-factory/registry";

async function main(): Promise<number> {
    const [verb, name, ...rest] = process.argv.slice(2);

    if (!verb || verb === "--help" || verb === "-h") {
        console.error(
            "Usage: autonomous-dev agent <inspect|freeze|unfreeze|promote> <name> [version]",
        );
        return verb && verb !== "--help" && verb !== "-h" ? 1 : 0;
    }

    if (!name) {
        console.error(`Error: 'autonomous-dev agent ${verb}' requires <name>`);
        return 1;
    }

    // Locate the agents directory: same package as this script.
    const here = dirname(fileURLToPath(import.meta.url));
    const agentsDir = resolve(here, "..", "agents");

    const registry = new AgentRegistry();
    const loadResult = await registry.load(agentsDir);

    if (loadResult.loaded === 0) {
        console.error(
            `Error: no agents loaded from ${agentsDir} (rejected=${loadResult.rejected})`,
        );
        return 1;
    }

    let output: string;
    try {
        switch (verb) {
            case "inspect":
                output = commandInspect(registry, name);
                break;
            case "freeze":
                output = commandFreeze(registry, name);
                break;
            case "unfreeze":
                output = commandUnfreeze(registry, name);
                break;
            case "promote": {
                const version = rest[0];
                if (!version) {
                    console.error(
                        "Error: 'agent promote' requires <name> <version>",
                    );
                    return 1;
                }
                output = await commandPromote(registry, name, version, {});
                break;
            }
            default:
                console.error(
                    `Error: unknown verb '${verb}'. Use inspect|freeze|unfreeze|promote.`,
                );
                return 1;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        return 1;
    }

    console.log(output);

    // Heuristic: command* functions return "Error: ..." prefixes on
    // logical failures (per the source). Honour the convention.
    return output.startsWith("Error:") ? 1 : 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
    });
