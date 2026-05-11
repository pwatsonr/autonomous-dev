// PLAN-038 TASK-010 — agent-states reader.
//
// Composes two sources to produce the canonical agent list:
//
//   1. **Manifest scan** — lists `<plugin-root>/agents/*.md`. Each file's
//      basename is the agent name; YAML frontmatter (lines between the
//      first two `---` markers) provides `version`. Defaults: name from
//      filename, version "0.0.0" if frontmatter missing or malformed.
//
//   2. **State overlay** — reads `agentStatesPath()` which the CLI bridge
//      writes (`plugins/autonomous-dev/bin/agent-cli.ts`). Real shape on
//      this machine: `{v, frozen: string[], shadowed: string[], updatedAt}`.
//      Agents present in `frozen` get `status: "frozen"`; in `shadowed`
//      → `"shadow"`; default → `"baseline"`.
//
// The rich kit-screenshot fields (`runs30d`, `fpRate`, `lastDispatchAt`)
// are NOT tracked by the daemon. The reader returns `null` for those
// (PLAN-038 O.Q. #3); the view renders `—`.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRow } from "../types/render";

import { agentStatesPath } from "./state-paths";

interface AgentStatesFile {
    v?: number;
    frozen?: string[];
    shadowed?: string[];
    updatedAt?: string;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** Parse a single agent .md file. Returns name + version (no full body). */
async function readAgentManifest(
    path: string,
): Promise<{ name: string; version: string } | null> {
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch {
        return null;
    }
    // Filename without `.md`.
    const filename = path.split("/").pop() ?? "";
    const name = filename.replace(/\.md$/, "");
    if (name === "") return null;

    // Cheap frontmatter parse: take everything between the first two
    // `---` lines and look for `version:` or `version: "x"`.
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    let version = "0.0.0";
    if (fmMatch !== null) {
        const versionLine = fmMatch[1]?.match(/^version:\s*"?([^"\s]+)"?/m);
        if (versionLine !== null && versionLine !== undefined) {
            const v = versionLine[1];
            if (typeof v === "string" && v.length > 0) version = v;
        }
    }
    return { name, version };
}

export interface AgentStatesReaderOptions {
    /** Override the agent-states.json path (default: state-paths). */
    statesPath?: string;
    /** Override the manifest directory (default: ../../autonomous-dev/agents). */
    manifestDir?: string;
}

/** Default manifest directory: `plugins/autonomous-dev/agents` relative
 *  to this file's location (server/wiring → ../../../autonomous-dev/agents). */
function defaultManifestDir(): string {
    return join(import.meta.dir, "..", "..", "..", "autonomous-dev", "agents");
}

export async function readAgentStates(
    opts: AgentStatesReaderOptions = {},
): Promise<AgentRow[]> {
    const manifestRoot = opts.manifestDir ?? defaultManifestDir();
    const statesFile = opts.statesPath ?? agentStatesPath();

    // ---------- 1. Manifest scan ----------
    let manifestFiles: string[];
    try {
        manifestFiles = (await readdir(manifestRoot)).filter((f) =>
            f.endsWith(".md"),
        );
    } catch {
        manifestFiles = [];
    }

    const manifestEntries = await Promise.all(
        manifestFiles.map((f) => readAgentManifest(join(manifestRoot, f))),
    );

    // ---------- 2. State overlay ----------
    const states = (await readJsonOrNull<AgentStatesFile>(statesFile)) ?? {};
    const frozen = new Set(states.frozen ?? []);
    const shadowed = new Set(states.shadowed ?? []);

    // ---------- 3. Project to AgentRow[] ----------
    const rows: AgentRow[] = [];
    for (const m of manifestEntries) {
        if (m === null) continue;
        let status: AgentRow["status"];
        if (frozen.has(m.name)) status = "frozen";
        else if (shadowed.has(m.name)) status = "shadow";
        else status = "baseline";
        rows.push({
            name: m.name,
            version: m.version,
            status,
            mode: "active",
            // Daemon does not track these — render as `—` in the view.
            lastDispatchAt: null,
            runs30d: null,
            fpRate: null,
        });
    }

    // Stable order: alphabetical by name (deterministic for tests + UI).
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}
