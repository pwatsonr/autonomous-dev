// SPEC-014-1-04 §Task 4.6 — File-backed session store.
//
// One JSON file per session, written via the rename-after-write atomicity
// trick so a crash mid-write cannot leave a partial record on disk.
//
// Path layout: ${session_dir}/<session_id>.json
//   - session_dir: from config.oauth_auth.session_dir (defaults to
//                  ${CLAUDE_PLUGIN_DATA}/sessions or, in tests,
//                  ${os.tmpdir()}/portal-sessions)
//   - file mode  : 0o600 (owner read/write only)
//   - dir mode   : 0o700 (auto-created if missing)
//
// Path-traversal defense: every public method re-validates the
// session_id against ^[A-Za-z0-9_-]{43}$ BEFORE constructing the path.
// `decodeCookie` already enforces the same regex on the inbound side,
// but defense-in-depth means we re-check inside the store too.

import { mkdir, rename, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";

import { SecurityError } from "../types";
import type { Session, SessionStore } from "./session-manager";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface FileSessionStoreOptions {
    sessionDir: string;
}

/**
 * Reject any session_id that is not 43 chars of URL-safe base64.
 * Throws (rather than returning null) because every caller has already
 * validated the cookie shape; an invalid id at this point is a
 * programmer error.
 */
function assertSessionId(sessionId: string): void {
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
        throw new SecurityError(
            "SESSION_INVALID_ID",
            `session_id must match ${SESSION_ID_RE.source}`,
        );
    }
}

export class FileSessionStore implements SessionStore {
    private readonly sessionDir: string;
    private dirEnsured = false;

    constructor(opts: FileSessionStoreOptions) {
        this.sessionDir = opts.sessionDir;
    }

    /**
     * Ensure the session directory exists with mode 0o700. Idempotent —
     * subsequent calls are a no-op once the directory has been confirmed.
     */
    async ensureDir(): Promise<void> {
        if (this.dirEnsured) return;
        await mkdir(this.sessionDir, { recursive: true, mode: DIR_MODE });
        // mkdir's `mode` is masked by the process umask; chmod is the only
        // portable way to guarantee the final permission bits.
        try {
            await chmod(this.sessionDir, DIR_MODE);
        } catch {
            // Best-effort on platforms where chmod is unsupported.
        }
        this.dirEnsured = true;
    }

    private filePath(sessionId: string): string {
        assertSessionId(sessionId);
        return join(this.sessionDir, `${sessionId}.json`);
    }

    async get(sessionId: string): Promise<Session | null> {
        await this.ensureDir();
        const path = this.filePath(sessionId);
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return null;
            throw err;
        }
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed === null || typeof parsed !== "object") {
                // Corrupt file — treat as missing and remove.
                await this.safeUnlink(path);
                return null;
            }
            return parsed as Session;
        } catch {
            await this.safeUnlink(path);
            return null;
        }
    }

    async put(session: Session): Promise<void> {
        await this.ensureDir();
        const path = this.filePath(session.session_id);
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, JSON.stringify(session), { mode: FILE_MODE });
        try {
            await chmod(tmp, FILE_MODE);
        } catch {
            // best-effort
        }
        // Atomic publish.
        await rename(tmp, path);
    }

    async delete(sessionId: string): Promise<void> {
        await this.ensureDir();
        await this.safeUnlink(this.filePath(sessionId));
    }

    private async safeUnlink(path: string): Promise<void> {
        try {
            await unlink(path);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw err;
        }
    }
}
