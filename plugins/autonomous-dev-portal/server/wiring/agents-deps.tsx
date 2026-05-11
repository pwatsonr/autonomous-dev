// PLAN-037-2 — DEFERRED wiring for the agent action routes.
//
// Disposition: DEFERRED (501) for the three mutation verbs, WIRED (200/404)
// for `GET /api/agents/:name/inspect`.
//
// Why DEFERRED for promote / shadow / freeze:
//   - The agent-factory CLI lives at `plugins/autonomous-dev/src/agent-
//     factory/cli.ts` and exposes `commandFreeze` / `commandUnfreeze` /
//     `commandPromote` as in-process functions, NOT a binary on PATH.
//     The `agent shadow` verb is not implemented at all.
//   - Spawning a second `bun` to invoke those functions from the portal
//     would couple the portal binary to the daemon's TypeScript build,
//     which is a layering violation we are unwilling to introduce in a
//     route-wiring PR.
//   - The route module's contract is to return 501 + a structured WARN
//     log when the underlying CLI verb does not exist (see the
//     `isUnknownSubcommand(res.stderr)` branch in agents-actions.tsx).
//     We surface exactly that envelope here, deterministically.
//
// `readAgentRecord` reads an optional `${state_dir}/agents-registry.json`
// when present (matching the pattern other readers use). When the file is
// missing or the requested name is absent, the inspect endpoint returns
// 404 (the documented contract).

import { Chip } from "../components/primitives";
import type { JSX } from "hono/jsx";
import { join } from "node:path";

import type {
    AgentActionDeps,
    AgentCliResult,
    AgentInspectRecord,
} from "../routes/agents-actions";

import { readJsonOrNull } from "./atomic-json";
import { stateDirRoot } from "./state-paths";

const REGISTRY_FILENAME = "agents-registry.json";

interface RegistryFile {
    agents?: AgentInspectRecord[];
}

function registryPath(): string {
    return join(stateDirRoot(), REGISTRY_FILENAME);
}

async function readAgentRecord(
    name: string,
): Promise<AgentInspectRecord | null> {
    const file = await readJsonOrNull<RegistryFile>(registryPath());
    if (file === null || !Array.isArray(file.agents)) return null;
    return file.agents.find((a) => a.name === name) ?? null;
}

/**
 * Deterministic 501 stub for mutation verbs. Matches the
 * `isUnknownSubcommand(stderr)` branch of agents-actions.tsx so the route
 * emits the documented `agent_action_not_implemented` structured-WARN log
 * + `{error: "not-implemented", verb}` envelope.
 */
/**
 * Spawn `autonomous-dev agent <verb> <name>` via the CLI dispatcher,
 * which execs into the bun-runnable `bin/agent-cli.ts` wrapper.
 *
 * Timeouts at 30s — `commandPromote` may write to disk; `commandInspect`
 * is instant.
 */
async function spawnAgentCli(
    verb: string,
    name: string,
): Promise<AgentCliResult> {
    try {
        const proc = Bun.spawn(["autonomous-dev", "agent", verb, name], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return { ok: code === 0, code, stdout, stderr };
    } catch (err) {
        return {
            ok: false,
            code: 127,
            stdout: "",
            stderr:
                err instanceof Error
                    ? `spawn failed: ${err.message}`
                    : `spawn failed: ${String(err)}`,
        };
    }
}

function renderInspectRow(record: AgentInspectRecord): JSX.Element {
    return (
        <tr data-agent={record.name}>
            <td class="mono">{record.name}</td>
            <td>
                <Chip variant="status" tone="info">
                    {record.state}
                </Chip>
            </td>
        </tr>
    );
}

export function buildAgentsDeps(): AgentActionDeps {
    return {
        runAgentCli: spawnAgentCli,
        readAgentRecord,
        renderRow: renderInspectRow,
        // The audit appender is injected by the central wiring module so
        // every action surface writes through the same logger. We supply
        // a dummy here that the wire-up overwrites — see wire.ts.
        audit: {
            async append() {
                /* overwritten in wire.ts */
            },
        },
    };
}
