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
import { homedir } from "node:os";
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
    /** Override the manifest directory (skips resolution entirely). */
    manifestDir?: string;
    /** Override the installed-plugin cache root (tests). Default:
     *  ~/.claude/plugins/cache/autonomous-dev/autonomous-dev */
    cacheRootDir?: string;
}

/** True when `path` is a readable directory. */
async function dirExists(path: string): Promise<boolean> {
    try {
        await readdir(path);
        return true;
    } catch {
        return false;
    }
}

/** Sort semver-ish version strings descending ("0.3.11" before "0.3.9"). */
function compareSemverDesc(a: string, b: string): number {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * Resolve the agent-manifest directory (#394). The old default climbed
 * `../../../autonomous-dev/agents` from this file — correct in the repo
 * checkout but nonexistent in the INSTALLED layout, where each plugin
 * lives under its own version dir in the cache
 * (`~/.claude/plugins/cache/autonomous-dev/<plugin>/<version>/...`), so
 * /agents rendered 0 agents on every real install. Resolution order:
 *   1. repo layout relative to this file (dev checkouts)
 *   2. installed cache: highest version of autonomous-dev with an agents/ dir
 */
export async function resolveManifestDir(
    cacheRootDir?: string,
    repoDirOverride?: string,
): Promise<string | null> {
    const repoDir = repoDirOverride ??
        join(import.meta.dir, "..", "..", "..", "autonomous-dev", "agents");
    if (await dirExists(repoDir)) return repoDir;

    const cacheRoot = cacheRootDir ??
        join(homedir(), ".claude", "plugins", "cache", "autonomous-dev", "autonomous-dev");
    try {
        const versions = (await readdir(cacheRoot))
            .filter((v) => /^\d+\.\d+/.test(v))
            .sort(compareSemverDesc);
        for (const v of versions) {
            const d = join(cacheRoot, v, "agents");
            if (await dirExists(d)) return d;
        }
    } catch {
        /* no cache root — fall through */
    }
    return null;
}

export async function readAgentStates(
    opts: AgentStatesReaderOptions = {},
): Promise<AgentRow[]> {
    const manifestRoot =
        opts.manifestDir ?? (await resolveManifestDir(opts.cacheRootDir));
    const statesFile = opts.statesPath ?? agentStatesPath();

    // ---------- 1. Manifest scan ----------
    let manifestFiles: string[] = [];
    if (manifestRoot !== null) {
        try {
            manifestFiles = (await readdir(manifestRoot)).filter((f) =>
                f.endsWith(".md"),
            );
        } catch {
            manifestFiles = [];
        }
    }

    const manifestEntries = manifestRoot !== null
        ? await Promise.all(
              manifestFiles.map((f) => readAgentManifest(join(manifestRoot, f))),
          )
        : [];

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

    // #394: agents named in the lifecycle overlay must surface even when
    // the manifest scan finds nothing (degraded install) — a shadowed
    // code-executor disappearing entirely is worse than a row with an
    // unknown version.
    const known = new Set(rows.map((r) => r.name));
    for (const name of frozen) {
        if (known.has(name)) continue;
        known.add(name);
        rows.push({
            name, version: "0.0.0", status: "frozen", mode: "active",
            lastDispatchAt: null, runs30d: null, fpRate: null,
        });
    }
    for (const name of shadowed) {
        if (known.has(name)) continue;
        known.add(name);
        rows.push({
            name, version: "0.0.0", status: "shadow", mode: "active",
            lastDispatchAt: null, runs30d: null, fpRate: null,
        });
    }

    // Stable order: alphabetical by name (deterministic for tests + UI).
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}
