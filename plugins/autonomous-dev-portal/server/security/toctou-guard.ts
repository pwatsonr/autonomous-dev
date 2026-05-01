// SPEC-014-3-01 §Task 3 — ToctouGuard.
//
// Time-of-Check-to-Time-of-Use (TOCTOU) mitigation. Between the moment a
// path is canonicalized via PathValidator and the moment we read it,
// an attacker with write access to the parent directory can replace a
// regular file with a symlink targeting somewhere else. `O_NOFOLLOW`
// blocks the swap at the open() syscall; `(dev, ino)` re-checks on
// every read catch any post-open swap.
//
// Per spec §Task 3:
// - openSafe: open with O_RDONLY|O_NOFOLLOW, capture (dev, ino, openTime).
// - readSafe: re-fstat the cached fd, compare identity, then read.
// - 30s hard cap on fd lifetime (defence-in-depth against forgotten fds).
// - cleanup(): close every cached fd, e.g. on portal shutdown.
//
// The cache is keyed by canonical path. Re-opening the same path closes
// the prior fd before storing the new one — by design.

import { promises as fs, constants as fsConstants } from "node:fs";

import type { FileDescriptorInfo } from "./types";
import { SecurityError } from "./types";

/** Hard cap on how long an fd may sit in the cache before reads fail. */
const MAX_FD_LIFETIME_MS = 30_000;

/** Default per-read length when caller does not specify one. */
const DEFAULT_READ_LENGTH = 4096;

/**
 * File-descriptor based TOCTOU guard. Wraps node's fs/promises so the
 * security-critical open + re-stat sequence cannot be skipped by
 * accident. Callers MUST go through this guard for any read of an
 * operator-supplied path.
 */
export class ToctouGuard {
    private readonly fdCache = new Map<string, FileDescriptorInfo>();

    /**
     * Open `canonicalPath` with `O_RDONLY|O_NOFOLLOW` and cache its
     * (dev, ino) identity. If the path itself is a symlink, the kernel
     * returns ELOOP — surfaced as SecurityError. Re-opening an already-
     * cached path closes the previous fd first.
     */
    async openSafe(canonicalPath: string): Promise<number> {
        // O_NOFOLLOW: refuse to open if the FINAL component is a symlink.
        // Combined with PathValidator (which canonicalizes intermediate
        // components), this closes the symlink-swap window.
        const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
        let handle: import("node:fs/promises").FileHandle;
        try {
            handle = await fs.open(canonicalPath, flags);
        } catch (err) {
            const code =
                typeof err === "object" && err && "code" in err
                    ? String((err as { code: unknown }).code)
                    : "UNKNOWN";
            if (code === "ELOOP") {
                throw new SecurityError(
                    "TOCTOU_SYMLINK_REJECTED",
                    "Symlink at path - O_NOFOLLOW rejected",
                );
            }
            throw new SecurityError(
                "TOCTOU_OPEN_FAILED",
                `Failed to open file: ${code}`,
            );
        }
        const stat = await handle.stat({ bigint: false });
        const info: FileDescriptorInfo = {
            fd: handle.fd,
            deviceId: stat.dev,
            inodeId: Number(stat.ino),
            path: canonicalPath,
            openTime: Date.now(),
        };
        // If a prior entry exists, close its fd first to avoid leaks.
        const prior = this.fdCache.get(canonicalPath);
        if (prior) {
            await this.closeFd(prior.fd);
        }
        this.fdCache.set(canonicalPath, info);
        // Stash the FileHandle on the info so closeSafe can call .close()
        // (Node's FileHandle wraps the fd and prevents double-close).
        // We use Object.defineProperty to avoid widening the public type.
        Object.defineProperty(info, "_handle", {
            value: handle,
            enumerable: false,
            writable: false,
            configurable: false,
        });
        return info.fd;
    }

    /**
     * Read up to `length` bytes from `canonicalPath`. Re-stats the
     * cached fd before reading and throws if (dev, ino) drift — any
     * change indicates a post-open swap.
     */
    async readSafe(
        canonicalPath: string,
        offset = 0,
        length = DEFAULT_READ_LENGTH,
    ): Promise<Buffer> {
        const info = this.fdCache.get(canonicalPath);
        if (!info) {
            throw new SecurityError(
                "TOCTOU_NOT_OPENED",
                "File not opened safely",
            );
        }
        if (Date.now() - info.openTime > MAX_FD_LIFETIME_MS) {
            await this.closeAndForget(canonicalPath);
            throw new SecurityError(
                "TOCTOU_FD_LIFETIME_EXCEEDED",
                "File descriptor held too long",
            );
        }
        // Re-stat via FD (fstat) so we are guaranteed to look at the
        // file the fd actually points to — not whatever lives at
        // canonicalPath right now.
        const handle = (info as unknown as { _handle: import("node:fs/promises").FileHandle })
            ._handle;
        const stat = await handle.stat({ bigint: false });
        if (
            stat.dev !== info.deviceId ||
            Number(stat.ino) !== info.inodeId
        ) {
            await this.closeAndForget(canonicalPath);
            throw new SecurityError(
                "TOCTOU_IDENTITY_CHANGED",
                "File identity changed - possible TOCTOU attack",
            );
        }
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.slice(0, bytesRead);
    }

    /** Close and forget a single cached fd. Best-effort, never throws. */
    async closeSafe(canonicalPath: string): Promise<void> {
        await this.closeAndForget(canonicalPath);
    }

    /** Close every cached fd. Called on portal shutdown. */
    async cleanup(): Promise<void> {
        const paths = Array.from(this.fdCache.keys());
        for (const p of paths) {
            await this.closeAndForget(p);
        }
    }

    /** Diagnostic — count of currently-open fds. */
    size(): number {
        return this.fdCache.size;
    }

    /** Diagnostic — whether a path is currently cached. */
    has(canonicalPath: string): boolean {
        return this.fdCache.has(canonicalPath);
    }

    private async closeAndForget(canonicalPath: string): Promise<void> {
        const info = this.fdCache.get(canonicalPath);
        if (!info) return;
        this.fdCache.delete(canonicalPath);
        const handle = (info as unknown as { _handle?: import("node:fs/promises").FileHandle })
            ._handle;
        if (handle) {
            try {
                await handle.close();
            } catch (err) {
                console.warn(
                    JSON.stringify({
                        event: "toctou_close_failed",
                        path: canonicalPath,
                        message:
                            err instanceof Error ? err.message : String(err),
                    }),
                );
            }
        } else {
            await this.closeFd(info.fd);
        }
    }

    private async closeFd(fd: number): Promise<void> {
        try {
            // We don't have a FileHandle reference for this fd path
            // (shouldn't happen given openSafe stashes one). Fall back to
            // raw close via fs/promises.constants — best effort.
            const close = (
                await import("node:fs")
            ).close;
            await new Promise<void>((resolve) => {
                close(fd, () => resolve());
            });
        } catch {
            /* swallow per spec — best-effort */
        }
    }
}
