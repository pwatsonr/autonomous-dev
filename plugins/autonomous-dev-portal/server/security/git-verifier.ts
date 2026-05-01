// SPEC-014-3-01 §Task 2 — GitVerifier.
//
// Confirms a canonical path is a valid git working tree using
// `child_process.execFile` with `shell: false`. Never `exec`. Never a
// shell string. The `env` is whitelisted to PATH only — GIT_DIR,
// GIT_WORK_TREE and other git env vars MUST NOT be inherited because
// they could redirect git to an attacker-controlled directory.
//
// Bare repositories are refused — we operate only on working trees with
// a `.git` directory (or file pointer to one). Wall-clock cap is 2s.
//
// Errors are caught and surfaced as structured warnings — the verifier
// itself never throws for runtime failures (caller decides what to do
// with `false`). Pre-flight argument errors and getRepositoryInfo
// failures DO throw SecurityError.

import { execFile, type ExecFileOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { SecurityError } from "./types";

/** Wall-clock cap for any single git invocation. */
const TIMEOUT_MS = 2000;

/** Minimal env passed to git — no GIT_* leakage. */
function safeGitEnv(): NodeJS.ProcessEnv {
    return { PATH: process.env["PATH"] ?? "" };
}

/** Promise wrapper around execFile with the security-required options. */
function runGit(
    args: string[],
    cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const opts: ExecFileOptions = {
            cwd,
            timeout: TIMEOUT_MS,
            env: safeGitEnv(),
            shell: false,
            // Cap output so a malicious repo cannot OOM us.
            maxBuffer: 1024 * 1024,
        };
        execFile("git", args, opts, (err, stdout, stderr) => {
            if (err) {
                // err.code may be exit code, signal, or "ENOENT" when git
                // is not installed. Surface the raw exit status if any,
                // otherwise -1 to denote spawn/timeout failure.
                const rawCode = (err as NodeJS.ErrnoException).code;
                const code = typeof rawCode === "number" ? rawCode : -1;
                resolve({
                    stdout: String(stdout ?? ""),
                    stderr: String(stderr ?? err.message),
                    code,
                });
                return;
            }
            resolve({
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
                code: 0,
            });
        });
    });
}

/**
 * Filesystem + git-binary checks that a canonical path is a working
 * tree. All methods take CANONICAL paths (already through
 * {@link PathValidator}) — passing a raw user path will not be re-validated.
 */
export class GitVerifier {
    /**
     * Returns true iff the path has a `.git` entry AND `git rev-parse`
     * succeeds AND its output names a `.git` directory. Bare repos
     * (where `--git-dir` does not end with `.git`) are rejected.
     *
     * Never throws — runtime failures are logged at warn and false is
     * returned. The 2s timeout is enforced via execFile's `timeout` option.
     */
    async isValidRepository(canonicalPath: string): Promise<boolean> {
        try {
            await fs.access(path.join(canonicalPath, ".git"));
        } catch {
            // Not a security failure — caller may legitimately ask whether
            // some directory happens to be a repo.
            return false;
        }
        const { stdout, stderr, code } = await runGit(
            ["rev-parse", "--git-dir"],
            canonicalPath,
        );
        if (code !== 0 || stderr.length > 0) {
            this.logFailure(canonicalPath, code);
            return false;
        }
        const gitDir = stdout.trim();
        // Refuse to operate on bare repos — they have no working tree
        // and many of our follow-on operations assume one exists.
        if (!gitDir.endsWith(".git")) {
            this.logFailure(canonicalPath, code, "bare_or_unexpected_layout");
            return false;
        }
        return true;
    }

    /**
     * Resolve current branch and HEAD commit. Both git invocations run
     * in parallel — the call wall-clock is capped by the slower one
     * (2s ceiling each). Throws SecurityError on any failure.
     */
    async getRepositoryInfo(
        canonicalPath: string,
    ): Promise<{ branch: string; commit: string }> {
        const [branch, commit] = await Promise.all([
            runGit(["rev-parse", "--abbrev-ref", "HEAD"], canonicalPath),
            runGit(["rev-parse", "HEAD"], canonicalPath),
        ]);
        if (
            branch.code !== 0 ||
            commit.code !== 0 ||
            branch.stderr.length > 0 ||
            commit.stderr.length > 0
        ) {
            throw new SecurityError(
                "GIT_INFO_FAILED",
                "Failed to read git repository info",
            );
        }
        return {
            branch: branch.stdout.trim(),
            commit: commit.stdout.trim(),
        };
    }

    private logFailure(
        canonicalPath: string,
        code: number,
        reason?: string,
    ): void {
        console.warn(
            JSON.stringify({
                event: "git_verification_failed",
                path: canonicalPath,
                code,
                ...(reason ? { reason } : {}),
            }),
        );
    }
}
