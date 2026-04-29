# SPEC-014-3-01: Path Canonicalization & Safe-Path Validators

## Metadata
- **Parent Plan**: PLAN-014-3
- **Tasks Covered**: TASK-001 (PathValidator), TASK-002 (GitVerifier), TASK-003 (TOCTOU Guard)
- **Estimated effort**: 9 hours

## Description
Implement the portal's first line of defense against directory traversal and symlink-escape attacks. The `PathValidator` resolves every operator-supplied path through `fs.promises.realpath()` (canonicalization, all symlinks dereferenced), then verifies the result is contained within `portal.path_policy.allowed_roots`. The `GitVerifier` confirms that a canonical path is a valid git repository using `child_process.execFile` with `shell: false` and a 2s wall-clock cap — never `exec` or shell strings. The `ToctouGuard` prevents Time-of-Check-to-Time-of-Use races by opening files once with `O_NOFOLLOW`, caching `(dev, ino)`, and re-stating via the file descriptor before every read. Together these three components guarantee that no portal request operates on a path that escapes its declared workspace, even under symlink-swap attacks.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/security/path-validator.ts` | Create | PathValidator class + canonical resolution |
| `src/security/git-verifier.ts` | Create | GitVerifier with execFile, no shell |
| `src/security/toctou-guard.ts` | Create | File-descriptor-based TOCTOU mitigation |
| `src/security/file-descriptor-cache.ts` | Create | Map<path, FdInfo> with TTL eviction |
| `src/security/types.ts` | Create | `PathPolicy`, `FileDescriptorInfo`, shared types |
| `src/security/errors.ts` | Modify | Add `SecurityError` if not present |

## Implementation Details

### Task 1: `PathValidator` Class

```
class PathValidator {
  constructor(policy: PathPolicy)
  validate(inputPath: string): Promise<string>
  validateWithGitCheck(inputPath: string): Promise<string>
}
```

- `policy.allowed_roots` is a non-empty `string[]`. Each root is canonicalized once at construction time via `realpath(resolve(root))`; constructor throws `SecurityError` if any root fails canonicalization.
- `validate(inputPath)` behavior:
  1. Reject if `inputPath` is not a string, is empty, or exceeds 4096 bytes (POSIX PATH_MAX): throw `SecurityError("Invalid path input")`.
  2. Compute `canonical = await realpath(resolve(inputPath))`. Wrap thrown filesystem errors as `SecurityError(\`Path validation failed: ${err.code}\`)` — never leak raw error messages.
  3. Containment check: path is allowed iff there exists a canonical root `R` such that `canonical === R` OR `canonical.startsWith(R + path.sep)`. The naive `startsWith(R)` check is forbidden because `/var/data2` would match root `/var/data`.
  4. If no root contains the canonical path, throw `SecurityError(\`Path outside allowed roots: ${canonical}\`)`. Do NOT echo the original input.
  5. Emit a structured log line at info level: `{event: "path_validated", original: inputPath, canonical, allowed: true}`. On rejection log `allowed: false, reason: ...` at warn level.
  6. Return `canonical`.
- Edge cases:
  - Non-existent path → `realpath` throws `ENOENT`; wrap as `SecurityError("Path does not exist")`.
  - Permission denied during canonicalization → wrap as `SecurityError("Permission denied")`.
  - Empty `allowed_roots` array → constructor throws `SecurityError("allowed_roots must be non-empty")`.

### Task 2: `GitVerifier` Class

```
class GitVerifier {
  isValidRepository(canonicalPath: string): Promise<boolean>
  getRepositoryInfo(canonicalPath: string): Promise<{branch: string, commit: string}>
}
```

- `TIMEOUT_MS = 2000` constant.
- `isValidRepository(p)`:
  1. Verify `.git` exists via `fs.access(join(p, '.git'), F_OK)`. If absent, return `false` (not a security failure — caller decides).
  2. Run `execFile('git', ['rev-parse', '--git-dir'], { cwd: p, timeout: 2000, shell: false, env: { PATH: process.env.PATH } })`.
  3. Trim stdout. Return `true` iff exit was 0 AND stdout endsWith `.git` AND stderr length is 0.
  4. Catch all errors: log at warn level with `{event: "git_verification_failed", path: p, code: err.code}`, return `false`. Never throw.
- `getRepositoryInfo(p)` runs the two `execFile` calls in parallel with the same options. Throws `SecurityError` if either fails.
- The `env` is whitelisted to `{ PATH }` only. `GIT_DIR`, `GIT_WORK_TREE`, and other git env vars MUST NOT be inherited — they could redirect git to an attacker-controlled directory.
- `shell: false` is mandatory on every call; reviewers should grep for `shell:\s*true` and fail the PR if found in this file.

### Task 3: `ToctouGuard` Class

```
interface FileDescriptorInfo {
  fd: number
  deviceId: number
  inodeId: number
  path: string
  openTime: number   // ms since epoch
}

class ToctouGuard {
  openSafe(canonicalPath: string): Promise<number>
  readSafe(canonicalPath: string, offset?: number, length?: number): Promise<Buffer>
  closeSafe(canonicalPath: string): Promise<void>
  cleanup(): Promise<void>
}
```

- `openSafe(p)`:
  1. Call `fs.open(p, O_RDONLY | O_NOFOLLOW)`. If the path itself is a symlink the kernel returns `ELOOP` — surface as `SecurityError("Symlink at path - O_NOFOLLOW rejected")`.
  2. Immediately `fstat(fd)`; capture `dev`, `ino`, `Date.now()`.
  3. Store in `fdCache: Map<string, FileDescriptorInfo>`. If a prior entry exists for `p`, close the old fd first.
  4. Return the new `fd`.
- `readSafe(p, offset=0, length=4096)`:
  1. Look up `fdInfo` in cache; if absent throw `SecurityError("File not opened safely")`.
  2. Re-`fstat(fdInfo.fd)`. If `dev` or `ino` differ from the cached values, throw `SecurityError("File identity changed - possible TOCTOU attack")` and close the fd.
  3. If `Date.now() - fdInfo.openTime > 30000`, throw `SecurityError("File descriptor held too long")` and close the fd.
  4. Use `fs.read(fdInfo.fd, buffer, 0, length, offset)` and return the slice of `bytesRead`.
- `closeSafe(p)` is best-effort: close the fd, delete the cache entry, log warnings on failure but never throw.
- `cleanup()` closes all cached fds; called by the portal on shutdown via a `process.on('beforeExit')` handler installed by the consumer.

## Acceptance Criteria

- [ ] `PathValidator.validate("../../../etc/passwd")` rejects with `SecurityError` whose message starts with `"Path outside allowed roots"`
- [ ] `PathValidator.validate("/allowed/root/sub/file")` returns the canonicalized absolute path
- [ ] `PathValidator` rejects `/var/data2/file` when only `/var/data` is in `allowed_roots` (path-separator boundary check)
- [ ] `PathValidator` rejects an input string longer than 4096 bytes with `SecurityError("Invalid path input")`
- [ ] `PathValidator` constructor throws `SecurityError("allowed_roots must be non-empty")` when given `[]`
- [ ] `GitVerifier.isValidRepository("/non/git/dir")` returns `false` without throwing
- [ ] `GitVerifier` calls `execFile` with `shell: false` and a whitelisted `env` containing only `PATH`
- [ ] `GitVerifier` enforces the 2000ms timeout — verified by stubbing `execFile` to delay 3000ms and asserting the call returns `false` within 2200ms
- [ ] `ToctouGuard.openSafe(symlinkPath)` rejects with `SecurityError` when the path is a symlink (O_NOFOLLOW behavior)
- [ ] `ToctouGuard` returns `SecurityError("File identity changed...")` when the underlying inode changes between `openSafe` and `readSafe`
- [ ] `ToctouGuard.cleanup()` closes every open fd and empties the cache
- [ ] All new files pass `npm run lint:security` with zero warnings
- [ ] `npm test -- --testPathPattern='(path-validator|git-verifier|toctou)'` passes

## Dependencies

- Node.js `fs/promises`, `child_process`, `path`, `os` standard libraries (no new npm dependencies).
- `SecurityError` class from `src/security/errors.ts` — extend `Error` with a `code` field set to `'SECURITY_ERROR'`.
- The `PathPolicy` type defined in this spec is consumed by SPEC-014-3-04 adversarial tests.

## Notes

- **Cross-platform realpath behavior**: Linux and macOS resolve symlinks identically; Windows is out of scope for this plan. Add a `process.platform === 'win32'` early-throw to make this explicit.
- **Why `O_NOFOLLOW` and not just `realpath`**: Canonicalization happens at validation time. Between validation and `fs.open`, an attacker with write access to the parent directory can replace a normal file with a symlink. `O_NOFOLLOW` blocks that race at the open syscall.
- **Logging discipline**: Never log the original (un-canonicalized) input alone — always pair it with the canonical result so investigators can correlate. Never log the contents of files referenced by paths.
- **Performance**: Expected p99 < 5ms per `validate` call for paths under 256 bytes. The plan's optional LRU cache is deferred to a follow-up — do not implement caching in this spec.
- **No `path.normalize` shortcuts**: `normalize` collapses `..` lexically without consulting the filesystem and CAN be bypassed by symlinks. Always go through `realpath`.
