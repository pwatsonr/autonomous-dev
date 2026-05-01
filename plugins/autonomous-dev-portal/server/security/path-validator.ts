// SPEC-014-3-01 §Task 1 — PathValidator.
//
// Canonicalizes every operator-supplied path through `fs.promises.realpath`
// and verifies the canonical result is contained within one of the
// configured `allowed_roots`. The naive `startsWith(root)` check is
// forbidden because `/var/data2` would match root `/var/data` — we
// always check for an exact root match OR a `root + path.sep` prefix.
//
// Logging discipline (per spec §Notes): always pair the original input
// with the canonical result so investigators can correlate. Never log
// file contents. Never echo the original input alone on rejection.
//
// Cross-platform: Linux/macOS only. Windows is out of scope and the
// constructor throws on win32 to make this explicit.

import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";

import type { PathPolicy } from "./types";
import { SecurityError } from "./types";

/** POSIX PATH_MAX upper bound. Reject inputs longer than this outright. */
const MAX_PATH_BYTES = 4096;

/** Returns true if any UTF-16 unit of `s` is U+0000. */
function containsNullByte(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 0) return true;
    }
    return false;
}

/**
 * Validates operator-supplied paths against an allow-list of canonical
 * roots. All file system calls happen during {@link validate}, never in
 * the constructor (other than one-time root canonicalization).
 */
export class PathValidator {
    private readonly canonicalRoots: string[];

    constructor(policy: PathPolicy) {
        if (process.platform === "win32") {
            throw new SecurityError(
                "PATH_PLATFORM_UNSUPPORTED",
                "PathValidator does not support Windows",
            );
        }
        if (!Array.isArray(policy.allowed_roots)) {
            throw new SecurityError(
                "PATH_POLICY_INVALID",
                "allowed_roots must be an array",
            );
        }
        if (policy.allowed_roots.length === 0) {
            throw new SecurityError(
                "PATH_POLICY_INVALID",
                "allowed_roots must be non-empty",
            );
        }
        // Canonicalize each root once. Sync variant keeps the constructor
        // synchronous — failures here are configuration errors that should
        // fail fast at startup, not at first request.
        this.canonicalRoots = policy.allowed_roots.map((root) => {
            try {
                return realpathSync(path.resolve(root));
            } catch (err) {
                const code =
                    typeof err === "object" && err && "code" in err
                        ? String((err as { code: unknown }).code)
                        : "UNKNOWN";
                throw new SecurityError(
                    "PATH_ROOT_CANONICALIZE_FAILED",
                    `Allowed root canonicalization failed: ${code}`,
                );
            }
        });
    }

    /**
     * Resolve `inputPath` to its canonical absolute form and verify it
     * falls inside one of the allowed roots. Throws SecurityError on
     * any rejection — never returns a value outside an allowed root.
     */
    async validate(inputPath: unknown): Promise<string> {
        if (typeof inputPath !== "string" || inputPath.length === 0) {
            this.logRejection(String(inputPath), "invalid_input_type");
            throw new SecurityError(
                "PATH_INVALID_INPUT",
                "Invalid path input",
            );
        }
        if (Buffer.byteLength(inputPath, "utf8") > MAX_PATH_BYTES) {
            this.logRejection(inputPath, "input_too_long");
            throw new SecurityError(
                "PATH_INVALID_INPUT",
                "Invalid path input",
            );
        }
        // POSIX file APIs treat NUL bytes as terminators — attackers can
        // use this to smuggle suffixes past length-based checks.
        if (containsNullByte(inputPath)) {
            this.logRejection(inputPath, "null_byte");
            throw new SecurityError(
                "PATH_INVALID_INPUT",
                "Invalid path input",
            );
        }

        let canonical: string;
        try {
            canonical = await fs.realpath(path.resolve(inputPath));
        } catch (err) {
            const code =
                typeof err === "object" && err && "code" in err
                    ? String((err as { code: unknown }).code)
                    : "UNKNOWN";
            // Never leak the raw filesystem error message — it can echo
            // the canonical resolved path of intermediate symlinks.
            const message =
                code === "ENOENT"
                    ? "Path does not exist"
                    : code === "EACCES"
                      ? "Permission denied"
                      : `Path validation failed: ${code}`;
            this.logRejection(inputPath, code);
            throw new SecurityError("PATH_VALIDATION_FAILED", message);
        }

        const allowed = this.canonicalRoots.find((root) => {
            if (canonical === root) return true;
            return canonical.startsWith(root + path.sep);
        });
        if (!allowed) {
            // Per spec §Logging: do NOT echo the original input alone on
            // rejection — always pair with canonical for correlation.
            this.logRejection(inputPath, "outside_allowed_roots", canonical);
            throw new SecurityError(
                "PATH_OUTSIDE_ROOT",
                `Path outside allowed roots: ${canonical}`,
            );
        }
        this.logAccept(inputPath, canonical);
        return canonical;
    }

    /**
     * Convenience: validate then assert the canonical path is a git
     * working tree (has a `.git` entry). Returns the canonical path on
     * success; throws SecurityError if not a repository.
     *
     * Full repository verification (git rev-parse) lives in
     * {@link GitVerifier} — here we only check `.git` existence so this
     * class stays free of child_process dependencies.
     */
    async validateWithGitCheck(inputPath: unknown): Promise<string> {
        const canonical = await this.validate(inputPath);
        try {
            await fs.access(path.join(canonical, ".git"));
        } catch {
            throw new SecurityError(
                "PATH_NOT_REPOSITORY",
                "Path is not a git repository",
            );
        }
        return canonical;
    }

    /** Read-only view of the canonical roots, for diagnostics/tests. */
    getRoots(): string[] {
        return [...this.canonicalRoots];
    }

    private logAccept(original: string, canonical: string): void {
        // Structured single-line JSON, info level. Stays in sync with
        // existing portal logger conventions (see middleware/structured-logger).
        const line = JSON.stringify({
            event: "path_validated",
            original,
            canonical,
            allowed: true,
        });
        console.log(line);
    }

    private logRejection(
        original: string,
        reason: string,
        canonical?: string,
    ): void {
        const payload: Record<string, unknown> = {
            event: "path_validated",
            original,
            allowed: false,
            reason,
        };
        if (canonical !== undefined) payload["canonical"] = canonical;
        console.warn(JSON.stringify(payload));
    }
}
