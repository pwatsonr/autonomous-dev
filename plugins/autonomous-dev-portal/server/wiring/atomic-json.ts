// PLAN-037-2 — atomic JSON read/write helpers used by all action-route
// backing stores.
//
// The portal cannot reach across to `plugins/autonomous-dev/src/pipeline/
// storage/atomic-io.ts` (cross-plugin import boundary), so we duplicate
// the algorithm here. Same contract:
//
//   tmp = `${path}.${Date.now()}.${rand}.tmp`
//   open(tmp, 'wx', 0o600); writeFile(text); fsync; close
//   rename(tmp, path)               // POSIX atomic
//   chmod(path, 0o600)              // re-assert if rename inherited umask
//
// On failure the temp file is best-effort unlinked.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export async function atomicWriteJson(
    targetPath: string,
    value: unknown,
): Promise<void> {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const dir = dirname(targetPath);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${targetPath}.${String(Date.now())}.${randomBytes(6).toString("hex")}.tmp`;
    let handle: import("node:fs/promises").FileHandle | null = null;
    try {
        handle = await fs.open(tmp, "wx", FILE_MODE);
        await handle.writeFile(text, "utf8");
        await handle.sync();
    } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
    } finally {
        if (handle !== null) await handle.close();
    }
    try {
        await fs.rename(tmp, targetPath);
    } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
    }
    // appendFile / rename may have inherited a permissive umask on macOS.
    await fs.chmod(targetPath, FILE_MODE).catch(() => undefined);
}

/**
 * Read a JSON file. Returns `null` when the file does not exist (vs.
 * throwing) so callers can distinguish "never written" from "read failed".
 * Throws on parse errors so callers do not silently absorb corruption.
 */
export async function readJsonOrNull<T>(path: string): Promise<T | null> {
    let text: string;
    try {
        text = await fs.readFile(path, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
    return JSON.parse(text) as T;
}
