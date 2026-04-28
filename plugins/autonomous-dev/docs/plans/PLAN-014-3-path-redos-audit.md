# PLAN-014-3: Path Validation + ReDoS Sandbox + Audit Log HMAC Chain

---
**Parent TDD**: TDD-014-portal-security-auth  
**Effort**: 4-5 days  
**Dependencies**: ["PLAN-013-2"]  
**Priority**: P0  
**Author**: Plan Author Agent  
**Date**: 2026-04-17  
**Version**: 1.0  
---

## Plan Metadata

- **Total Estimated Effort**: 36 hours (4.5 days)
- **Critical Path Length**: 24 hours, 8 sequential tasks
- **Number of Parallel Tracks**: 3
- **Security Risk Level**: P0 - Critical security implementation

## Executive Summary

This plan implements three critical security layers for the autonomous-dev portal: path validation with TOCTOU mitigation, ReDoS defense via worker thread sandboxing, and audit log integrity through HMAC chaining. Each component provides defense-in-depth against specific attack vectors: directory traversal, regex denial-of-service, and audit log tampering.

## In-Scope Components

### Path Validation System (§14)
- **Canonical Path Resolution**: `realpath()` canonicalization to resolve all symlinks and relative components
- **Allowed Roots Enforcement**: Policy-driven validation against `portal.path_policy.allowed_roots`
- **Symlink Escape Detection**: Rejection of paths that escape allowed boundaries via symlinks
- **Git Repository Verification**: Subprocess verification with `execFile` (no shell), 2s timeout
- **TOCTOU Mitigation**: File descriptor passing, device-inode verification per §22.4

### ReDoS Defense System (§15)
- **Worker Thread Sandbox**: Isolated regex execution environment
- **Execution Limits**: 100ms timeout cap, 1KB input size limit
- **Termination Enforcement**: `worker.terminate()` on timeout violation
- **Custom Evaluator Sandbox**: Process isolation with memory/network/filesystem restrictions

### Audit Log Integrity (§16)
- **HMAC Chain Structure**: SHA-256 HMAC linking with sequence numbers
- **Append-Only Logging**: `O_APPEND | O_WRONLY | O_CREAT` file modes
- **Key Management**: 32-byte keys from secure storage, 90-day rotation
- **Chain Verification**: CLI tooling for integrity validation

### Secret Handling (§17)
- **Redaction Algorithm**: Length-based redaction with security floors
- **Input Validation**: Rejection of secrets shorter than 8 characters

## Out-of-Scope Components

- Authentication mechanisms (PLAN-014-1)
- CSRF/XSS protection (PLAN-014-2)  
- HTTP routing and middleware (PLAN-013-*)
- Real-time data handling (PLAN-015-*)

## Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Path Validator  │    │ RegEx Sandbox    │    │ Audit Logger    │
│                 │    │                  │    │                 │
│ • realpath()    │    │ • Worker Thread  │    │ • HMAC Chain    │
│ • Policy Check  │    │ • 100ms Timeout  │    │ • Key Rotation  │
│ • TOCTOU Guard  │    │ • 1KB Limit      │    │ • Append-Only   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────────┐
                    │ Secret Redactor     │
                    │                     │
                    │ • Length-based      │
                    │ • Security Floor    │
                    │ • Input Validation  │
                    └─────────────────────┘
```

## Task List

### Track A: Path Validation & TOCTOU Prevention

#### TASK-001: Core Path Validator Implementation
- **ID**: TASK-001
- **Title**: Implement PathValidator class with canonical path resolution
- **Description**: Create the core PathValidator class implementing realpath() canonicalization, policy validation against allowed roots, and symlink escape detection per FR-S20-21.
- **Files**: 
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/path-validator.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/types.ts`
- **Dependencies**: []
- **Acceptance Criteria**:
  - PathValidator.validate() returns canonical paths or throws SecurityError
  - Rejects paths containing `../` after canonicalization that escape allowed roots
  - Supports configurable allowed_roots from portal configuration
  - Handles edge cases: empty paths, non-existent files, permission denied
  - Logs all validation attempts with outcomes
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm test -- --testPathPattern=path-validator
  ```
- **Estimated Effort**: 4 hours
- **Track**: A
- **Risks**: 
  - **Medium**: Platform differences in realpath() behavior between Linux/macOS
  - **Mitigation**: Comprehensive cross-platform testing with Docker containers

#### TASK-002: Git Repository Verification Subprocess
- **ID**: TASK-002  
- **Title**: Implement git repository verification with subprocess isolation
- **Description**: Add git repository verification using secure subprocess execution with execFile (no shell), 2s timeout, and proper error handling.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/git-verifier.ts`
- **Dependencies**: [TASK-001]
- **Acceptance Criteria**:
  - GitVerifier.isValidRepository() uses child_process.execFile exclusively
  - No shell interpretation of arguments
  - 2-second timeout enforced with subprocess termination
  - Validates .git directory presence and basic repository structure
  - Returns boolean result with detailed error logging
- **Lint/Test Commands**:
  ```bash
  npm run lint:security  
  npm test -- --testPathPattern=git-verifier
  ```
- **Estimated Effort**: 2 hours
- **Track**: A
- **Risks**:
  - **Low**: Git command availability on deployment systems
  - **Mitigation**: Fallback to filesystem-only validation when git unavailable

#### TASK-003: TOCTOU File Descriptor Pattern Implementation
- **ID**: TASK-003
- **Title**: Implement TOCTOU mitigation using file descriptors
- **Description**: Implement TOCTOU prevention by opening files with O_NOFOLLOW, passing file descriptors to read operations, and storing device-inode pairs for re-verification per §22.4.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/toctou-guard.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/file-descriptor-cache.ts`
- **Dependencies**: [TASK-001]
- **Acceptance Criteria**:
  - ToctouGuard.openSafe() opens files with O_NOFOLLOW flag
  - File descriptors passed to all subsequent read operations
  - Device-inode pairs cached for verification at consumption time
  - Race condition detection triggers SecurityError
  - Supports file descriptor lifecycle management
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm test -- --testPathPattern=toctou
  ```
- **Estimated Effort**: 3 hours
- **Track**: A  
- **Risks**:
  - **Medium**: Race condition edge cases in high-concurrency scenarios
  - **Mitigation**: Comprehensive race condition test suite with timing manipulation

### Track B: ReDoS Defense & Evaluator Sandbox

#### TASK-004: Worker Thread Regex Sandbox
- **ID**: TASK-004
- **Title**: Implement worker thread regex sandbox with execution limits  
- **Description**: Create RegexSandbox class using worker threads to isolate regex execution with 100ms timeout and 1KB input limits per §22.2.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/regex-sandbox.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/regex-worker.js`
- **Dependencies**: []
- **Acceptance Criteria**:
  - RegexSandbox.test() executes regex in isolated worker thread
  - 100ms timeout enforced with worker.terminate()
  - 1KB input size limit validated before execution
  - Returns match results or timeout error
  - Worker thread cleanup on completion or timeout
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm test -- --testPathPattern=regex-sandbox
  npm run test:redos -- --timeout=5000
  ```
- **Estimated Effort**: 3 hours
- **Track**: B
- **Risks**:
  - **Medium**: Worker thread overhead impacting performance for simple regex
  - **Mitigation**: Fast-path optimization for known-safe patterns

#### TASK-005: Custom Evaluator Subprocess Sandbox  
- **ID**: TASK-005
- **Title**: Implement custom evaluator sandbox with OS-specific restrictions
- **Description**: Create platform-specific sandbox for custom evaluators using Linux unshare/prlimit and macOS sandbox-exec with memory, network, and filesystem restrictions.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/evaluator-sandbox.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/sandbox-linux.ts`  
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/sandbox-macos.ts`
- **Dependencies**: []
- **Acceptance Criteria**:
  - EvaluatorSandbox.execute() runs code in restricted subprocess
  - Linux: unshare namespaces, prlimit memory to 256MB  
  - macOS: sandbox-exec with equivalent restrictions
  - Network access blocked, filesystem read-only mounted
  - 30-second timeout with process termination
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm test -- --testPathPattern=evaluator-sandbox
  npm run test:sandbox-escape
  ```  
- **Estimated Effort**: 5 hours
- **Track**: B
- **Risks**:
  - **High**: Platform-specific sandbox escape vulnerabilities
  - **Mitigation**: Security audit of sandbox configurations, regular CVE monitoring

### Track C: Audit Log & Secret Management

#### TASK-006: Secret Redaction Implementation
- **ID**: TASK-006
- **Title**: Implement secret redaction with security length floors
- **Description**: Create SecretRedactor implementing length-based redaction per §22.5: <8 chars rejected, 8-11 chars → `••••<last-2>`, 12+ chars → `••••<last-4>`.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/secret-redactor.ts`
- **Dependencies**: []
- **Acceptance Criteria**:
  - SecretRedactor.redact() applies length-based algorithm correctly
  - Secrets shorter than 8 characters rejected at input with clear error
  - 8-11 character secrets show last 2 characters: `••••AB`
  - 12+ character secrets show last 4 characters: `••••ABCD`
  - Fixed `••••` output for any rejected secret
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm test -- --testPathPattern=secret-redactor
  ```
- **Estimated Effort**: 2 hours  
- **Track**: C
- **Risks**:
  - **Low**: Edge cases in character counting with Unicode
  - **Mitigation**: Unicode-aware string length calculation

#### TASK-007: HMAC Chain Audit Logger
- **ID**: TASK-007
- **Title**: Implement append-only audit logger with HMAC chaining
- **Description**: Create AuditLogger with append-only file operations and HMAC-SHA256 chaining per §16. Each entry includes sequence number and HMAC of previous_hmac || entry_json.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/audit-logger.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/hmac-chain.ts`
- **Dependencies**: [TASK-006]
- **Acceptance Criteria**:
  - AuditLogger.log() writes entries with O_APPEND | O_WRONLY | O_CREAT
  - HMAC chain links each entry to previous: HMAC(prev_hmac || entry_json)
  - Sequence numbers increment monotonically  
  - Secret redaction applied to all logged data
  - File permissions set to 0600 (owner read/write only)
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm test -- --testPathPattern=audit-logger
  npm test -- --testPathPattern=hmac-chain
  ```
- **Estimated Effort**: 4 hours
- **Track**: C
- **Risks**:
  - **Medium**: File system race conditions in high-concurrency logging
  - **Mitigation**: File locking mechanism and atomic write operations

#### TASK-008: Audit Key Management & Rotation
- **ID**: TASK-008
- **Title**: Implement HMAC key management with 90-day rotation
- **Description**: Create secure key storage and rotation system with 32-byte keys stored in ${CLAUDE_PLUGIN_DATA}/.audit-key or platform keystore per §22.3.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/key-manager.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/keystore-adapter.ts`
- **Dependencies**: [TASK-007]
- **Acceptance Criteria**:
  - KeyManager.getCurrentKey() returns active 32-byte key
  - Automatic 90-day rotation with retention of old keys for verification
  - Platform keystore integration (macOS Keychain, Linux Secret Service)
  - Fallback to filesystem storage with 0600 permissions
  - Key derivation from secure random source
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm test -- --testPathPattern=key-manager
  ```
- **Estimated Effort**: 3 hours
- **Track**: C
- **Risks**:
  - **High**: Key compromise if filesystem permissions fail
  - **Mitigation**: Multiple storage backends, key rotation monitoring

### Track A (Continued): Integration & Testing

#### TASK-009: Audit Chain Verification CLI  
- **ID**: TASK-009
- **Title**: Implement audit verify CLI subcommand
- **Description**: Create CLI subcommand to walk the audit log chain and validate each HMAC for integrity verification.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/cli/audit-verify.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/cli/commands.ts`
- **Dependencies**: [TASK-008]
- **Acceptance Criteria**:
  - `audit verify` command walks entire audit log chain
  - Validates each HMAC against previous entry and current content
  - Reports tampering detection with specific entry details
  - Handles key rotation boundaries correctly
  - Provides summary report of verification results
- **Lint/Test Commands**:
  ```bash
  npm run lint:cli
  npm test -- --testPathPattern=audit-verify
  npm run test:cli -- audit verify
  ```
- **Estimated Effort**: 2 hours
- **Track**: A
- **Risks**:
  - **Low**: Performance issues with large audit logs
  - **Mitigation**: Streaming verification, progress reporting for large files

#### TASK-010: Security Integration Tests
- **ID**: TASK-010
- **Title**: Implement comprehensive security test suite
- **Description**: Create adversarial test suite covering path traversal attempts, ReDoS patterns, TOCTOU races, and audit tampering scenarios.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/tests/security/path-traversal-adversarial.test.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/tests/security/redos-catastrophic.test.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/tests/security/toctou-race.test.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/tests/security/audit-tampering.test.ts`
- **Dependencies**: [TASK-001, TASK-004, TASK-009]
- **Acceptance Criteria**:
  - Path traversal tests: `../../../etc/passwd`, symlink farms, Unicode-encoded paths
  - TOCTOU race tests: symlink swapping between validate and read operations  
  - ReDoS tests: catastrophic backtracking patterns timeout at 100ms
  - Audit tampering tests: modified entries detected, sequence gaps detected
  - All security violations properly logged and blocked
- **Lint/Test Commands**:
  ```bash
  npm run lint:security
  npm run test:security-adversarial
  npm run test:security-integration
  ```
- **Estimated Effort**: 5 hours
- **Track**: A
- **Risks**:
  - **Medium**: Test environment differences masking real vulnerabilities  
  - **Mitigation**: Multi-platform CI testing, security researcher review

#### TASK-011: Performance & Monitoring Integration
- **ID**: TASK-011
- **Title**: Implement security performance monitoring
- **Description**: Add performance monitoring and alerting for security component latency and resource usage to detect DoS attempts.
- **Files**:
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/metrics.ts`
  - `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/security/alerts.ts`
- **Dependencies**: [TASK-010]
- **Acceptance Criteria**:
  - Path validation latency monitoring with P99 alerts
  - Regex sandbox timeout rate tracking
  - Audit log chain verification performance metrics
  - Rate limiting alerts for excessive security violations
  - Integration with existing metrics collection system
- **Lint/Test Commands**:
  ```bash
  npm run lint:monitoring
  npm test -- --testPathPattern=security-metrics
  ```
- **Estimated Effort**: 3 hours
- **Track**: A
- **Risks**:
  - **Low**: Monitoring overhead impacting performance
  - **Mitigation**: Async metrics collection, sampling for high-volume operations

## Implementation Details

### PathValidator Class

```typescript
import { realpath } from 'fs/promises';
import { resolve, relative } from 'path';
import { SecurityError } from './errors';
import { PathPolicy } from './types';

export class PathValidator {
  constructor(private policy: PathPolicy) {}

  async validate(inputPath: string): Promise<string> {
    // Input validation
    if (!inputPath || typeof inputPath !== 'string') {
      throw new SecurityError('Invalid path input');
    }

    try {
      // Canonical path resolution - resolves all symlinks and relative components
      const canonicalPath = await realpath(resolve(inputPath));
      
      // Check against allowed roots
      const isAllowed = this.policy.allowed_roots.some(root => {
        const rootCanonical = resolve(root);
        const relativePath = relative(rootCanonical, canonicalPath);
        
        // Path is allowed if it doesn't start with '..' (no escape)
        return !relativePath.startsWith('..');
      });

      if (!isAllowed) {
        throw new SecurityError(`Path outside allowed roots: ${canonicalPath}`);
      }

      // Additional symlink escape detection
      if (this.hasSymlinkEscape(inputPath, canonicalPath)) {
        throw new SecurityError(`Symlink escape detected: ${inputPath}`);
      }

      return canonicalPath;
    } catch (error) {
      if (error instanceof SecurityError) {
        throw error;
      }
      throw new SecurityError(`Path validation failed: ${error.message}`);
    }
  }

  private hasSymlinkEscape(original: string, canonical: string): boolean {
    // Check for symlinks that resolve outside allowed boundaries
    // This catches cases where realpath might miss certain edge cases
    return this.policy.allowed_roots.every(root => {
      const rootCanonical = resolve(root);
      return !canonical.startsWith(rootCanonical);
    });
  }

  async validateWithGitCheck(inputPath: string): Promise<string> {
    const validPath = await this.validate(inputPath);
    
    // Git repository verification using subprocess
    const gitVerifier = new GitVerifier();
    if (!await gitVerifier.isValidRepository(validPath)) {
      throw new SecurityError(`Invalid git repository: ${validPath}`);
    }

    return validPath;
  }
}
```

### GitVerifier Class

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import { join } from 'path';
import { SecurityError } from './errors';

const execFileAsync = promisify(execFile);

export class GitVerifier {
  private readonly TIMEOUT_MS = 2000;

  async isValidRepository(path: string): Promise<boolean> {
    try {
      // First check for .git directory existence
      await access(join(path, '.git'), constants.F_OK);

      // Use git command for verification with strict subprocess controls
      const { stdout, stderr } = await execFileAsync(
        'git',
        ['rev-parse', '--git-dir'],
        {
          cwd: path,
          timeout: this.TIMEOUT_MS,
          // No shell interpretation - execFile runs directly
          shell: false,
          // Limit environment exposure
          env: { PATH: process.env.PATH }
        }
      );

      // Verify git command succeeded and returned expected output
      return stdout.trim().endsWith('.git') && stderr.length === 0;
      
    } catch (error) {
      // Log error for monitoring but don't throw - return false
      console.warn(`Git verification failed for ${path}:`, error.message);
      return false;
    }
  }

  async getRepositoryInfo(path: string): Promise<{ branch: string; commit: string }> {
    if (!await this.isValidRepository(path)) {
      throw new SecurityError('Invalid git repository');
    }

    try {
      const [branchResult, commitResult] = await Promise.all([
        execFileAsync('git', ['branch', '--show-current'], { 
          cwd: path, 
          timeout: this.TIMEOUT_MS,
          shell: false 
        }),
        execFileAsync('git', ['rev-parse', 'HEAD'], { 
          cwd: path, 
          timeout: this.TIMEOUT_MS,
          shell: false 
        })
      ]);

      return {
        branch: branchResult.stdout.trim(),
        commit: commitResult.stdout.trim()
      };
    } catch (error) {
      throw new SecurityError(`Failed to get repository info: ${error.message}`);
    }
  }
}
```

### ToctouGuard Class

```typescript
import { open, fstat, close, read } from 'fs/promises';
import { constants } from 'fs';
import { SecurityError } from './errors';

interface FileDescriptorInfo {
  fd: number;
  deviceId: number;
  inodeId: number;
  path: string;
  openTime: number;
}

export class ToctouGuard {
  private fdCache = new Map<string, FileDescriptorInfo>();

  async openSafe(path: string): Promise<number> {
    try {
      // Open with O_NOFOLLOW to prevent symlink following
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      
      // Get file stats immediately after opening
      const stats = await fstat(fd);
      
      // Cache file descriptor info for later verification
      const fdInfo: FileDescriptorInfo = {
        fd: fd,
        deviceId: stats.dev,
        inodeId: stats.ino,
        path: path,
        openTime: Date.now()
      };
      
      this.fdCache.set(path, fdInfo);
      return fd;
      
    } catch (error) {
      throw new SecurityError(`Failed to open file safely: ${error.message}`);
    }
  }

  async readSafe(path: string, offset: number = 0, length?: number): Promise<Buffer> {
    const fdInfo = this.fdCache.get(path);
    if (!fdInfo) {
      throw new SecurityError('File not opened safely - call openSafe first');
    }

    try {
      // Re-verify file identity before reading
      await this.verifyFileIdentity(fdInfo);

      // Read using file descriptor (not path)
      const buffer = Buffer.alloc(length || 1024);
      const result = await read(fdInfo.fd, buffer, 0, buffer.length, offset);
      
      return buffer.subarray(0, result.bytesRead);
      
    } catch (error) {
      throw new SecurityError(`Safe read failed: ${error.message}`);
    }
  }

  async closeSafe(path: string): Promise<void> {
    const fdInfo = this.fdCache.get(path);
    if (!fdInfo) {
      return; // Already closed or never opened
    }

    try {
      await close(fdInfo.fd);
      this.fdCache.delete(path);
    } catch (error) {
      // Log but don't throw - cleanup should be best effort
      console.warn(`Failed to close file descriptor for ${path}:`, error.message);
    }
  }

  private async verifyFileIdentity(fdInfo: FileDescriptorInfo): Promise<void> {
    try {
      const currentStats = await fstat(fdInfo.fd);
      
      // Check if file identity changed (TOCTOU attack detection)
      if (currentStats.dev !== fdInfo.deviceId || 
          currentStats.ino !== fdInfo.inodeId) {
        throw new SecurityError(
          `File identity changed - possible TOCTOU attack detected for ${fdInfo.path}`
        );
      }

      // Check for reasonable time bounds (optional hardening)
      const timeSinceOpen = Date.now() - fdInfo.openTime;
      if (timeSinceOpen > 30000) { // 30 second limit
        throw new SecurityError(`File descriptor held too long: ${timeSinceOpen}ms`);
      }
      
    } catch (error) {
      throw new SecurityError(`File identity verification failed: ${error.message}`);
    }
  }

  // Cleanup method for process shutdown
  async cleanup(): Promise<void> {
    const paths = Array.from(this.fdCache.keys());
    await Promise.all(paths.map(path => this.closeSafe(path)));
  }
}
```

### RegexSandbox Class

```typescript
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { SecurityError } from './errors';

interface RegexTask {
  pattern: string;
  flags: string;
  input: string;
  timeout: number;
}

interface RegexResult {
  matches: boolean;
  groups?: string[];
  error?: string;
  timedOut?: boolean;
}

export class RegexSandbox {
  private readonly MAX_INPUT_SIZE = 1024; // 1KB limit
  private readonly DEFAULT_TIMEOUT = 100; // 100ms limit

  async test(pattern: string, input: string, flags: string = ''): Promise<RegexResult> {
    // Input size validation
    if (input.length > this.MAX_INPUT_SIZE) {
      throw new SecurityError(`Input too large: ${input.length} bytes (max: ${this.MAX_INPUT_SIZE})`);
    }

    // Pattern validation - reject obviously malicious patterns
    if (this.isSuspiciousPattern(pattern)) {
      throw new SecurityError(`Suspicious regex pattern detected: ${pattern}`);
    }

    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: {
          pattern,
          flags,
          input,
          timeout: this.DEFAULT_TIMEOUT
        }
      });

      const timeoutId = setTimeout(() => {
        worker.terminate();
        resolve({ 
          matches: false, 
          timedOut: true, 
          error: 'Regex execution timed out' 
        });
      }, this.DEFAULT_TIMEOUT);

      worker.on('message', (result: RegexResult) => {
        clearTimeout(timeoutId);
        worker.terminate();
        resolve(result);
      });

      worker.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new SecurityError(`Worker error: ${error.message}`));
      });

      worker.on('exit', (code) => {
        clearTimeout(timeoutId);
        if (code !== 0) {
          resolve({ 
            matches: false, 
            error: `Worker exited with code ${code}` 
          });
        }
      });
    });
  }

  private isSuspiciousPattern(pattern: string): boolean {
    // Basic heuristics for catastrophic backtracking patterns
    const suspiciousPatterns = [
      // Nested quantifiers
      /\*.*\+/,
      /\+.*\*/,
      // Alternation with overlap
      /\(.*\|.*\)\*/, 
      // Excessive nesting
      /\(.*\(.*\(.*\)/
    ];

    return suspiciousPatterns.some(p => p.test(pattern));
  }
}

// Worker thread execution code
if (!isMainThread) {
  const { pattern, flags, input, timeout } = workerData as RegexTask;
  
  try {
    const regex = new RegExp(pattern, flags);
    const startTime = Date.now();
    
    // Set up timeout within worker
    const timeoutId = setTimeout(() => {
      parentPort?.postMessage({ 
        matches: false, 
        timedOut: true, 
        error: 'Worker timeout' 
      });
      process.exit(1);
    }, timeout);

    const result = regex.exec(input);
    const endTime = Date.now();
    
    clearTimeout(timeoutId);

    parentPort?.postMessage({
      matches: result !== null,
      groups: result?.slice(1) || [],
      executionTime: endTime - startTime
    });

  } catch (error) {
    parentPort?.postMessage({
      matches: false,
      error: error.message
    });
  }
}
```

### EvaluatorSandbox Classes

```typescript
// evaluator-sandbox.ts
import { platform } from 'os';
import { LinuxSandbox } from './sandbox-linux';
import { MacOSSandbox } from './sandbox-macos';
import { SecurityError } from './errors';

export interface SandboxConfig {
  memoryLimitMB: number;
  timeoutSeconds: number;
  allowNetwork: boolean;
  readOnlyPaths: string[];
  workingDirectory: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  memoryUsed: number;
  executionTime: number;
}

export class EvaluatorSandbox {
  private sandbox: LinuxSandbox | MacOSSandbox;

  constructor(private config: SandboxConfig) {
    const currentPlatform = platform();
    
    switch (currentPlatform) {
      case 'linux':
        this.sandbox = new LinuxSandbox(config);
        break;
      case 'darwin':
        this.sandbox = new MacOSSandbox(config);
        break;
      default:
        throw new SecurityError(`Unsupported platform for sandboxing: ${currentPlatform}`);
    }
  }

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    return this.sandbox.execute(command, args);
  }

  static createRestrictive(): EvaluatorSandbox {
    return new EvaluatorSandbox({
      memoryLimitMB: 256,
      timeoutSeconds: 30,
      allowNetwork: false,
      readOnlyPaths: ['/usr', '/lib', '/bin'],
      workingDirectory: '/tmp'
    });
  }
}
```

```typescript
// sandbox-linux.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SandboxConfig, SandboxResult } from './evaluator-sandbox';
import { SecurityError } from './errors';

const execFileAsync = promisify(execFile);

export class LinuxSandbox {
  constructor(private config: SandboxConfig) {}

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const startTime = Date.now();
    
    try {
      // Build unshare command for namespace isolation
      const unshareArgs = [
        '--net',        // Network namespace isolation
        '--pid',        // PID namespace isolation  
        '--mount',      // Mount namespace isolation
        '--fork',       // Fork before exec
        '--'
      ];

      // Build prlimit command for resource limits
      const prlimitArgs = [
        `--as=${this.config.memoryLimitMB * 1024 * 1024}`, // Memory limit
        '--nproc=1',    // Process limit
        '--nofile=64',  // File descriptor limit
        '--'
      ];

      // Combine commands: unshare -> prlimit -> target command
      const sandboxCommand = 'unshare';
      const sandboxArgs = [
        ...unshareArgs,
        'prlimit',
        ...prlimitArgs,
        command,
        ...args
      ];

      const { stdout, stderr } = await execFileAsync(
        sandboxCommand,
        sandboxArgs,
        {
          timeout: this.config.timeoutSeconds * 1000,
          cwd: this.config.workingDirectory,
          shell: false,
          // Minimal environment
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/tmp'
          }
        }
      );

      const endTime = Date.now();

      return {
        stdout: stdout,
        stderr: stderr,
        exitCode: 0,
        timedOut: false,
        memoryUsed: 0, // Would need additional monitoring
        executionTime: endTime - startTime
      };

    } catch (error) {
      const endTime = Date.now();
      
      if (error.code === 'TIMEOUT') {
        return {
          stdout: '',
          stderr: 'Execution timed out',
          exitCode: -1,
          timedOut: true,
          memoryUsed: 0,
          executionTime: endTime - startTime
        };
      }

      throw new SecurityError(`Linux sandbox execution failed: ${error.message}`);
    }
  }

  private async setupReadOnlyMounts(): Promise<void> {
    // Additional filesystem restrictions could be implemented here
    // Using mount --bind with readonly flags for specified paths
  }
}
```

```typescript
// sandbox-macos.ts  
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { SandboxConfig, SandboxResult } from './evaluator-sandbox';
import { SecurityError } from './errors';

const execFileAsync = promisify(execFile);

export class MacOSSandbox {
  constructor(private config: SandboxConfig) {}

  async execute(command: string, args: string[]): Promise<SandboxResult> {
    const startTime = Date.now();
    const profilePath = await this.createSandboxProfile();
    
    try {
      // Use sandbox-exec with custom profile
      const sandboxArgs = [
        '-f', profilePath,  // Profile file
        command,
        ...args
      ];

      const { stdout, stderr } = await execFileAsync(
        'sandbox-exec',
        sandboxArgs,
        {
          timeout: this.config.timeoutSeconds * 1000,
          cwd: this.config.workingDirectory,
          shell: false,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/tmp'
          }
        }
      );

      const endTime = Date.now();

      return {
        stdout: stdout,
        stderr: stderr,
        exitCode: 0,
        timedOut: false,
        memoryUsed: 0,
        executionTime: endTime - startTime
      };

    } catch (error) {
      const endTime = Date.now();
      
      if (error.code === 'TIMEOUT') {
        return {
          stdout: '',
          stderr: 'Execution timed out',
          exitCode: -1,
          timedOut: true,
          memoryUsed: 0,
          executionTime: endTime - startTime
        };
      }

      throw new SecurityError(`macOS sandbox execution failed: ${error.message}`);
    } finally {
      // Cleanup profile file
      try {
        await unlink(profilePath);
      } catch (cleanupError) {
        console.warn('Failed to cleanup sandbox profile:', cleanupError.message);
      }
    }
  }

  private async createSandboxProfile(): Promise<string> {
    const profileContent = `
(version 1)
(deny default)

; Allow basic operations
(allow process-fork)
(allow process-exec 
  (literal "${this.config.workingDirectory}"))

; Network restrictions
${this.config.allowNetwork ? 
  '(allow network*)' : 
  '(deny network*)'}

; File system access
${this.config.readOnlyPaths.map(path => 
  `(allow file-read* (subpath "${path}"))`
).join('\n')}

; Working directory access  
(allow file-read* file-write* 
  (subpath "${this.config.workingDirectory}"))

; Memory and resource limits are handled by ulimit-style restrictions
; macOS sandbox doesn't directly support memory limits like Linux cgroups
`;

    const profilePath = join('/tmp', `sandbox-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.sb`);
    await writeFile(profilePath, profileContent, { mode: 0o600 });
    
    return profilePath;
  }
}
```

### SecretRedactor Class

```typescript
export class SecretRedactor {
  private readonly MIN_SECRET_LENGTH = 8;
  private readonly REDACTION_MARKER = '••••';

  redact(secret: string): string {
    if (typeof secret !== 'string') {
      throw new SecurityError('Invalid secret type - must be string');
    }

    const length = secret.length;

    // Reject secrets that are too short
    if (length < this.MIN_SECRET_LENGTH) {
      throw new SecurityError(
        `Secret too short: ${length} characters (minimum: ${this.MIN_SECRET_LENGTH})`
      );
    }

    // Apply length-based redaction algorithm per §22.5
    if (length >= 8 && length <= 11) {
      // 8-11 characters: show last 2
      const lastTwo = secret.slice(-2);
      return `${this.REDACTION_MARKER}${lastTwo}`;
    } else if (length >= 12) {
      // 12+ characters: show last 4
      const lastFour = secret.slice(-4);
      return `${this.REDACTION_MARKER}${lastFour}`;
    }

    // This case should never be reached due to input validation
    return this.REDACTION_MARKER;
  }

  redactInText(text: string, secrets: string[]): string {
    let redactedText = text;
    
    for (const secret of secrets) {
      if (secret.length >= this.MIN_SECRET_LENGTH) {
        const redacted = this.redact(secret);
        // Use global regex to replace all occurrences
        const regex = new RegExp(this.escapeRegex(secret), 'g');
        redactedText = redactedText.replace(regex, redacted);
      }
    }

    return redactedText;
  }

  private escapeRegex(str: string): string {
    // Escape special regex characters in the secret string
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Utility method for testing redaction patterns
  static getRedactionPattern(length: number): string {
    const redactor = new SecretRedactor();
    const testSecret = 'a'.repeat(length);
    
    try {
      return redactor.redact(testSecret);
    } catch (error) {
      return 'INVALID';
    }
  }
}
```

### AuditLogger & HMAC Chain Implementation

```typescript
import { createHmac, randomBytes } from 'crypto';
import { appendFile, access, constants } from 'fs/promises';
import { join } from 'path';
import { SecurityError } from './errors';
import { SecretRedactor } from './secret-redactor';

export interface AuditEntry {
  timestamp: string;
  sequence: number;
  action: string;
  user: string;
  resource: string;
  details: any;
  previous_hmac: string;
  entry_hmac: string;
}

export class AuditLogger {
  private sequence = 0;
  private lastHmac = '';
  private secretRedactor = new SecretRedactor();
  
  constructor(
    private logPath: string,
    private keyManager: KeyManager
  ) {}

  async log(entry: Omit<AuditEntry, 'timestamp' | 'sequence' | 'previous_hmac' | 'entry_hmac'>): Promise<void> {
    try {
      // Increment sequence number
      this.sequence++;

      // Create entry with metadata
      const auditEntry: AuditEntry = {
        timestamp: new Date().toISOString(),
        sequence: this.sequence,
        action: entry.action,
        user: entry.user, 
        resource: entry.resource,
        details: this.redactSecrets(entry.details),
        previous_hmac: this.lastHmac,
        entry_hmac: '' // Will be calculated
      };

      // Calculate HMAC chain
      auditEntry.entry_hmac = this.calculateEntryHmac(auditEntry);
      this.lastHmac = auditEntry.entry_hmac;

      // Write to append-only log file
      const logLine = JSON.stringify(auditEntry) + '\n';
      await appendFile(this.logPath, logLine, { 
        flag: 'a',  // Append mode
        mode: 0o600 // Owner read/write only
      });

    } catch (error) {
      throw new SecurityError(`Audit logging failed: ${error.message}`);
    }
  }

  private calculateEntryHmac(entry: AuditEntry): string {
    const key = this.keyManager.getCurrentKey();
    
    // Create entry JSON without the entry_hmac field
    const entryForHmac = { ...entry };
    delete entryForHmac.entry_hmac;
    
    // HMAC of previous_hmac || entry_json
    const dataToHmac = entry.previous_hmac + JSON.stringify(entryForHmac);
    
    return createHmac('sha256', key)
      .update(dataToHmac, 'utf8')
      .digest('hex');
  }

  private redactSecrets(details: any): any {
    if (typeof details === 'string') {
      // Look for potential secrets and redact them
      return this.secretRedactor.redactInText(details, this.extractPotentialSecrets(details));
    }

    if (typeof details === 'object' && details !== null) {
      const redacted = { ...details };
      
      // Redact known secret fields
      const secretFields = ['password', 'token', 'key', 'secret', 'credential'];
      
      for (const field of secretFields) {
        if (redacted[field]) {
          redacted[field] = this.secretRedactor.redact(redacted[field]);
        }
      }

      return redacted;
    }

    return details;
  }

  private extractPotentialSecrets(text: string): string[] {
    const secrets: string[] = [];
    
    // Basic patterns for common secret formats
    const patterns = [
      /[A-Za-z0-9]{32,}/g,  // Long alphanumeric strings
      /[A-Z0-9]{20,}/g,     // Upper case tokens
      /sk-[A-Za-z0-9]{32,}/g // API key patterns
    ];

    for (const pattern of patterns) {
      const matches = text.match(pattern) || [];
      secrets.push(...matches);
    }

    return secrets;
  }

  async initialize(): Promise<void> {
    try {
      // Check if log file exists
      await access(this.logPath, constants.F_OK);
      
      // Read last entry to get sequence and HMAC
      await this.loadLastEntry();
      
    } catch (error) {
      // Log file doesn't exist - start fresh
      this.sequence = 0;
      this.lastHmac = '';
      
      // Log initialization entry
      await this.log({
        action: 'audit_log_initialized',
        user: 'system',
        resource: this.logPath,
        details: { version: '1.0' }
      });
    }
  }

  private async loadLastEntry(): Promise<void> {
    // Implementation would read the last line of the log file
    // and extract sequence number and HMAC for chain continuation
    // This is a simplified version
    this.sequence = 0; // Would be loaded from file
    this.lastHmac = ''; // Would be loaded from file
  }
}
```

### KeyManager Implementation

```typescript
import { randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';
import { readFile, writeFile, access, constants } from 'fs/promises';
import { join } from 'path';
import { SecurityError } from './errors';

const scryptAsync = promisify(scrypt);

export interface KeyInfo {
  id: string;
  key: Buffer;
  createdAt: Date;
  expiresAt: Date;
  active: boolean;
}

export class KeyManager {
  private readonly KEY_SIZE = 32; // 256 bits
  private readonly ROTATION_DAYS = 90;
  private keys = new Map<string, KeyInfo>();
  private activeKeyId: string | null = null;

  constructor(private keyStorePath: string) {}

  async initialize(): Promise<void> {
    try {
      await this.loadKeys();
      
      // Check if we need a new key
      if (!this.activeKeyId || this.needsRotation()) {
        await this.rotateKey();
      }
    } catch (error) {
      // No existing keys - create first key
      await this.createInitialKey();
    }
  }

  getCurrentKey(): Buffer {
    if (!this.activeKeyId) {
      throw new SecurityError('No active key available');
    }

    const keyInfo = this.keys.get(this.activeKeyId);
    if (!keyInfo) {
      throw new SecurityError('Active key not found in keystore');
    }

    return keyInfo.key;
  }

  getKey(keyId: string): Buffer {
    const keyInfo = this.keys.get(keyId);
    if (!keyInfo) {
      throw new SecurityError(`Key not found: ${keyId}`);
    }

    return keyInfo.key;
  }

  async rotateKey(): Promise<string> {
    // Mark current key as inactive
    if (this.activeKeyId) {
      const currentKey = this.keys.get(this.activeKeyId);
      if (currentKey) {
        currentKey.active = false;
      }
    }

    // Create new key
    const newKeyId = this.generateKeyId();
    const newKey = randomBytes(this.KEY_SIZE);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (this.ROTATION_DAYS * 24 * 60 * 60 * 1000));

    const keyInfo: KeyInfo = {
      id: newKeyId,
      key: newKey,
      createdAt: now,
      expiresAt: expiresAt,
      active: true
    };

    this.keys.set(newKeyId, keyInfo);
    this.activeKeyId = newKeyId;

    await this.saveKeys();
    return newKeyId;
  }

  private needsRotation(): boolean {
    if (!this.activeKeyId) return true;

    const activeKey = this.keys.get(this.activeKeyId);
    if (!activeKey) return true;

    const now = new Date();
    const daysSinceCreation = (now.getTime() - activeKey.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    
    return daysSinceCreation >= this.ROTATION_DAYS;
  }

  private async createInitialKey(): Promise<void> {
    const keyId = await this.rotateKey();
    console.log(`Created initial audit key: ${keyId}`);
  }

  private generateKeyId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString('hex');
    return `audit-${timestamp}-${random}`;
  }

  private async loadKeys(): Promise<void> {
    try {
      await access(this.keyStorePath, constants.R_OK);
      const encryptedData = await readFile(this.keyStorePath);
      
      // In production, this would use platform keystore
      // For now, using simple encrypted file storage
      const decrypted = await this.decrypt(encryptedData);
      const keyData = JSON.parse(decrypted);

      this.keys.clear();
      for (const item of keyData.keys) {
        const keyInfo: KeyInfo = {
          id: item.id,
          key: Buffer.from(item.key, 'hex'),
          createdAt: new Date(item.createdAt),
          expiresAt: new Date(item.expiresAt),
          active: item.active
        };
        
        this.keys.set(keyInfo.id, keyInfo);
        
        if (keyInfo.active) {
          this.activeKeyId = keyInfo.id;
        }
      }

    } catch (error) {
      throw new SecurityError(`Failed to load keys: ${error.message}`);
    }
  }

  private async saveKeys(): Promise<void> {
    try {
      const keyData = {
        version: '1.0',
        keys: Array.from(this.keys.values()).map(key => ({
          id: key.id,
          key: key.key.toString('hex'),
          createdAt: key.createdAt.toISOString(),
          expiresAt: key.expiresAt.toISOString(),
          active: key.active
        }))
      };

      const encrypted = await this.encrypt(JSON.stringify(keyData));
      await writeFile(this.keyStorePath, encrypted, { mode: 0o600 });

    } catch (error) {
      throw new SecurityError(`Failed to save keys: ${error.message}`);
    }
  }

  private async encrypt(data: string): Promise<Buffer> {
    // Simplified encryption - in production would use proper key derivation
    // and platform keystore integration
    const salt = randomBytes(16);
    const key = await scryptAsync(process.env.CLAUDE_PLUGIN_DATA || 'default', salt, 32) as Buffer;
    
    const cipher = require('crypto').createCipher('aes-256-gcm', key);
    const encrypted = Buffer.concat([
      salt,
      cipher.update(data, 'utf8'),
      cipher.final()
    ]);

    return encrypted;
  }

  private async decrypt(encryptedData: Buffer): Promise<string> {
    // Corresponding decryption logic
    const salt = encryptedData.subarray(0, 16);
    const encrypted = encryptedData.subarray(16);
    
    const key = await scryptAsync(process.env.CLAUDE_PLUGIN_DATA || 'default', salt, 32) as Buffer;
    const decipher = require('crypto').createDecipher('aes-256-gcm', key);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }

  // Cleanup expired keys (retention policy)
  async cleanupExpiredKeys(): Promise<number> {
    const now = new Date();
    let cleaned = 0;

    for (const [keyId, keyInfo] of this.keys) {
      if (!keyInfo.active && now > keyInfo.expiresAt) {
        this.keys.delete(keyId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.saveKeys();
    }

    return cleaned;
  }
}
```

### Audit Verification CLI

```typescript
import { readFileSync } from 'fs';
import { createHmac } from 'crypto';
import { KeyManager } from '../security/key-manager';
import { AuditEntry } from '../security/audit-logger';

export class AuditVerifier {
  constructor(private keyManager: KeyManager) {}

  async verifyLog(logPath: string): Promise<VerificationResult> {
    const result: VerificationResult = {
      totalEntries: 0,
      validEntries: 0,
      invalidEntries: [],
      sequenceGaps: [],
      keyRotations: [],
      verified: false
    };

    try {
      const logContent = readFileSync(logPath, 'utf8');
      const lines = logContent.trim().split('\n').filter(line => line.length > 0);
      
      result.totalEntries = lines.length;
      let expectedSequence = 1;
      let previousHmac = '';

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry: AuditEntry = JSON.parse(lines[i]);
          
          // Verify sequence number
          if (entry.sequence !== expectedSequence) {
            result.sequenceGaps.push({
              line: i + 1,
              expected: expectedSequence,
              actual: entry.sequence
            });
          }

          // Verify HMAC chain
          const calculatedHmac = this.calculateEntryHmac(entry, previousHmac);
          if (calculatedHmac !== entry.entry_hmac) {
            result.invalidEntries.push({
              line: i + 1,
              sequence: entry.sequence,
              error: 'HMAC mismatch',
              expected: calculatedHmac,
              actual: entry.entry_hmac
            });
          } else {
            result.validEntries++;
          }

          // Check for key rotation
          if (entry.action === 'key_rotation') {
            result.keyRotations.push({
              line: i + 1,
              sequence: entry.sequence,
              newKeyId: entry.details?.newKeyId
            });
          }

          expectedSequence = entry.sequence + 1;
          previousHmac = entry.entry_hmac;

        } catch (parseError) {
          result.invalidEntries.push({
            line: i + 1,
            sequence: -1,
            error: `JSON parse error: ${parseError.message}`,
            expected: '',
            actual: lines[i].substring(0, 100)
          });
        }
      }

      result.verified = result.invalidEntries.length === 0 && result.sequenceGaps.length === 0;
      return result;

    } catch (error) {
      throw new Error(`Verification failed: ${error.message}`);
    }
  }

  private calculateEntryHmac(entry: AuditEntry, previousHmac: string): string {
    try {
      // Get the key that was active when this entry was created
      const key = this.keyManager.getKeyForTimestamp(entry.timestamp);
      
      // Recreate the entry without HMAC for calculation
      const entryForHmac = { ...entry };
      delete entryForHmac.entry_hmac;
      entryForHmac.previous_hmac = previousHmac;
      
      const dataToHmac = previousHmac + JSON.stringify(entryForHmac);
      
      return createHmac('sha256', key)
        .update(dataToHmac, 'utf8')
        .digest('hex');

    } catch (error) {
      throw new Error(`HMAC calculation failed: ${error.message}`);
    }
  }
}

export interface VerificationResult {
  totalEntries: number;
  validEntries: number;
  invalidEntries: InvalidEntry[];
  sequenceGaps: SequenceGap[];
  keyRotations: KeyRotation[];
  verified: boolean;
}

export interface InvalidEntry {
  line: number;
  sequence: number;
  error: string;
  expected: string;
  actual: string;
}

export interface SequenceGap {
  line: number;
  expected: number;
  actual: number;
}

export interface KeyRotation {
  line: number;
  sequence: number;
  newKeyId: string;
}

// CLI command implementation
export async function auditVerifyCommand(logPath: string): Promise<void> {
  console.log(`Verifying audit log: ${logPath}`);
  
  try {
    const keyManager = new KeyManager(process.env.AUDIT_KEY_PATH || '/tmp/audit-keys');
    await keyManager.initialize();
    
    const verifier = new AuditVerifier(keyManager);
    const result = await verifier.verifyLog(logPath);
    
    console.log('\n=== Audit Log Verification Results ===');
    console.log(`Total entries: ${result.totalEntries}`);
    console.log(`Valid entries: ${result.validEntries}`);
    console.log(`Invalid entries: ${result.invalidEntries.length}`);
    console.log(`Sequence gaps: ${result.sequenceGaps.length}`);
    console.log(`Key rotations: ${result.keyRotations.length}`);
    console.log(`Overall status: ${result.verified ? 'VERIFIED' : 'FAILED'}`);

    if (!result.verified) {
      console.log('\n=== Issues Found ===');
      
      for (const invalid of result.invalidEntries) {
        console.log(`Line ${invalid.line}, Seq ${invalid.sequence}: ${invalid.error}`);
      }
      
      for (const gap of result.sequenceGaps) {
        console.log(`Line ${gap.line}: Sequence gap - expected ${gap.expected}, got ${gap.actual}`);
      }
      
      process.exit(1);
    }

    console.log('\n✅ Audit log integrity verified successfully');

  } catch (error) {
    console.error(`Verification failed: ${error.message}`);
    process.exit(1);
  }
}
```

## Dependency Graph

```
TASK-001 (PathValidator) ─┬─ TASK-003 (TOCTOU Guard) 
                          └─ TASK-002 (Git Verifier)
                                        │
                                        ▼
TASK-004 (RegexSandbox) ──────────────── TASK-010 (Security Tests)
                                        │
TASK-005 (EvaluatorSandbox) ────────────┘
                                        │
TASK-006 (SecretRedactor) ─── TASK-007 (AuditLogger) ─── TASK-008 (KeyManager) ─── TASK-009 (CLI Verify)
                                        │                           │
                                        └───────────────────────────┼─ TASK-011 (Monitoring)
                                                                    │
                                                              Critical Path
```

**Critical Path**: TASK-006 → TASK-007 → TASK-008 → TASK-009 → TASK-010 → TASK-011 (18 hours)

## Parallel Execution Schedule

### Track A: Path Security (10 hours)
```
Hour 1-4:   TASK-001 (PathValidator)
Hour 5-6:   TASK-002 (Git Verifier)  
Hour 7-9:   TASK-003 (TOCTOU Guard)
Hour 10:    TASK-009 (CLI Verify)
```

### Track B: Regex & Evaluation Security (8 hours)  
```
Hour 1-3:   TASK-004 (RegexSandbox)
Hour 4-8:   TASK-005 (EvaluatorSandbox)
```

### Track C: Audit & Secrets (18 hours - Critical Path)
```
Hour 1-2:   TASK-006 (SecretRedactor)
Hour 3-6:   TASK-007 (AuditLogger)
Hour 7-9:   TASK-008 (KeyManager)
Hour 10-14: TASK-010 (Security Tests)
Hour 15-17: TASK-011 (Monitoring)
```

## Security Test Plan

### Path Traversal Adversarial Tests

```typescript
describe('PathValidator Adversarial Tests', () => {
  const validator = new PathValidator({
    allowed_roots: ['/home/user/project', '/tmp/workspace']
  });

  test('rejects classic directory traversal', async () => {
    const maliciousPaths = [
      '../../../etc/passwd',
      '../../.ssh/id_rsa',
      '/home/user/project/../../../etc/shadow'
    ];

    for (const path of maliciousPaths) {
      await expect(validator.validate(path))
        .rejects.toThrow(SecurityError);
    }
  });

  test('rejects symlink farms', async () => {
    // Create symlink farm: a -> b -> c -> ../../../etc/passwd
    const symlinkFarm = '/tmp/test/a';
    await expect(validator.validate(symlinkFarm))
      .rejects.toThrow('Symlink escape detected');
  });

  test('rejects Unicode-encoded paths', async () => {
    const unicodePaths = [
      '/home/user/project/\u002e\u002e/\u002e\u002e/etc/passwd',  // Unicode ..
      '/home/user/project/%2e%2e/%2e%2e/etc/passwd'              // URL encoded ..
    ];

    for (const path of unicodePaths) {
      await expect(validator.validate(path))
        .rejects.toThrow(SecurityError);
    }
  });
});
```

### TOCTOU Race Condition Tests

```typescript
describe('TOCTOU Race Condition Tests', () => {
  test('detects symlink swap during read', async () => {
    const toctouGuard = new ToctouGuard();
    const testPath = '/tmp/toctou-test';
    
    // Open file normally
    const fd = await toctouGuard.openSafe(testPath);
    
    // Simulate attacker swapping symlink between open and read
    setTimeout(async () => {
      await fs.unlink(testPath);
      await fs.symlink('/etc/passwd', testPath);
    }, 10);
    
    // This should fail with TOCTOU detection
    await expect(toctouGuard.readSafe(testPath))
      .rejects.toThrow('File identity changed');
  });

  test('prevents race condition in file descriptor reuse', async () => {
    const guard = new ToctouGuard();
    
    // Test concurrent access to same path
    const promises = Array.from({length: 10}, () => 
      guard.openSafe('/tmp/race-test')
    );
    
    // Only one should succeed, others should be blocked
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled');
    
    expect(successful.length).toBe(1);
  });
});
```

### ReDoS Catastrophic Backtracking Tests

```typescript
describe('ReDoS Defense Tests', () => {
  test('times out catastrophic backtracking patterns', async () => {
    const sandbox = new RegexSandbox();
    
    const catastrophicPatterns = [
      // Classic exponential backtracking
      { pattern: '(a+)+$', input: 'a'.repeat(100) + 'X' },
      // Nested quantifiers  
      { pattern: '(a*)*$', input: 'a'.repeat(100) + 'X' },
      // Alternation overlap
      { pattern: '(a|a)*$', input: 'a'.repeat(100) + 'X' }
    ];

    for (const test of catastrophicPatterns) {
      const start = Date.now();
      const result = await sandbox.test(test.pattern, test.input);
      const elapsed = Date.now() - start;
      
      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(150); // 100ms + overhead
    }
  });

  test('rejects input over size limit', async () => {
    const sandbox = new RegexSandbox();
    const largeInput = 'a'.repeat(2048); // Over 1KB limit
    
    await expect(sandbox.test('.*', largeInput))
      .rejects.toThrow('Input too large');
  });
});
```

### Audit Log Tampering Detection Tests

```typescript
describe('Audit Log Integrity Tests', () => {
  test('detects modified entries', async () => {
    const logPath = '/tmp/test-audit.log';
    const logger = new AuditLogger(logPath, keyManager);
    
    // Create valid log entries
    await logger.log({ action: 'test1', user: 'alice', resource: '/test', details: {} });
    await logger.log({ action: 'test2', user: 'bob', resource: '/test2', details: {} });
    
    // Tamper with log file
    const logContent = await fs.readFile(logPath, 'utf8');
    const lines = logContent.split('\n');
    const tamperedEntry = JSON.parse(lines[0]);
    tamperedEntry.user = 'eve'; // Change user
    lines[0] = JSON.stringify(tamperedEntry);
    await fs.writeFile(logPath, lines.join('\n'));
    
    // Verification should detect tampering
    const verifier = new AuditVerifier(keyManager);
    const result = await verifier.verifyLog(logPath);
    
    expect(result.verified).toBe(false);
    expect(result.invalidEntries.length).toBeGreaterThan(0);
  });

  test('detects sequence gaps', async () => {
    const logPath = '/tmp/test-sequence.log';
    
    // Create log with missing sequence number
    const entries = [
      { sequence: 1, timestamp: '2026-04-17T10:00:00Z', action: 'test1' },
      { sequence: 3, timestamp: '2026-04-17T10:00:01Z', action: 'test2' } // Gap: missing 2
    ];
    
    const logContent = entries.map(e => JSON.stringify(e)).join('\n');
    await fs.writeFile(logPath, logContent);
    
    const verifier = new AuditVerifier(keyManager);
    const result = await verifier.verifyLog(logPath);
    
    expect(result.sequenceGaps.length).toBe(1);
    expect(result.sequenceGaps[0].expected).toBe(2);
    expect(result.sequenceGaps[0].actual).toBe(3);
  });
});
```

### Key Rotation Tests

```typescript
describe('Key Rotation Tests', () => {
  test('old entries verify after key rotation', async () => {
    const keyManager = new KeyManager('/tmp/test-keys');
    await keyManager.initialize();
    
    const logger = new AuditLogger('/tmp/rotation-test.log', keyManager);
    
    // Log entry with original key
    await logger.log({ action: 'before_rotation', user: 'test', resource: '/test', details: {} });
    
    // Rotate key
    await keyManager.rotateKey();
    
    // Log entry with new key
    await logger.log({ action: 'after_rotation', user: 'test', resource: '/test', details: {} });
    
    // Both entries should verify
    const verifier = new AuditVerifier(keyManager);
    const result = await verifier.verifyLog('/tmp/rotation-test.log');
    
    expect(result.verified).toBe(true);
    expect(result.validEntries).toBe(2);
  });

  test('automatic key rotation after 90 days', async () => {
    const keyManager = new KeyManager('/tmp/test-keys');
    
    // Mock old key creation date
    const oldKeyId = await keyManager.rotateKey();
    const oldKey = keyManager.getKey(oldKeyId);
    oldKey.createdAt = new Date(Date.now() - (91 * 24 * 60 * 60 * 1000)); // 91 days ago
    
    await keyManager.initialize(); // Should trigger rotation
    
    const newActiveKey = keyManager.getCurrentKeyId();
    expect(newActiveKey).not.toBe(oldKeyId);
  });
});
```

## Risk Assessment

### High-Risk Items

1. **TASK-005 (EvaluatorSandbox)** - Platform-specific sandbox escape vulnerabilities
   - **Mitigation**: Security audit of sandbox configurations, regular CVE monitoring
   - **Escalation**: Security team review required before deployment

2. **TASK-008 (KeyManager)** - Key compromise if filesystem permissions fail  
   - **Mitigation**: Multiple storage backends, key rotation monitoring
   - **Escalation**: Implement platform keystore integration as priority

### Medium-Risk Items

1. **TASK-001 (PathValidator)** - Platform differences in realpath() behavior
   - **Mitigation**: Comprehensive cross-platform testing with Docker containers
   
2. **TASK-004 (RegexSandbox)** - Worker thread overhead impacting performance
   - **Mitigation**: Fast-path optimization for known-safe patterns
   
3. **TASK-007 (AuditLogger)** - File system race conditions in high-concurrency logging
   - **Mitigation**: File locking mechanism and atomic write operations

### Low-Risk Items

1. **TASK-002 (GitVerifier)** - Git command availability on deployment systems
   - **Mitigation**: Fallback to filesystem-only validation when git unavailable

2. **TASK-006 (SecretRedactor)** - Edge cases in character counting with Unicode
   - **Mitigation**: Unicode-aware string length calculation

## Performance Considerations

### Path Validation
- **Expected latency**: <5ms per validation for normal paths
- **Bottleneck**: realpath() system call latency
- **Optimization**: LRU cache for recently validated paths

### Regex Sandbox  
- **Worker overhead**: ~10ms per regex execution
- **Fast path**: Skip sandboxing for patterns under 10 characters with no quantifiers
- **Memory**: 50MB per worker thread (4 concurrent max)

### Audit Logging
- **Write latency**: <2ms per entry (append-only)
- **HMAC calculation**: <1ms per entry
- **Bottleneck**: Disk I/O for high-frequency logging

## Monitoring & Alerting

### Security Metrics
- Path validation rejections per minute (alert if >100/min)
- Regex timeout rate (alert if >10% timeouts)  
- Audit log verification failures (alert on any failure)
- Key rotation delays (alert if >7 days overdue)

### Performance Metrics
- Path validation P99 latency (alert if >50ms)
- Regex sandbox queue depth (alert if >10 pending)
- Audit log write latency (alert if >10ms)

## Acceptance Criteria Summary

The implementation is complete when:

1. ✅ All path traversal attack vectors are blocked by PathValidator
2. ✅ TOCTOU race conditions are prevented by file descriptor pattern  
3. ✅ ReDoS attacks timeout within 100ms via worker thread sandbox
4. ✅ Custom evaluators run in OS-appropriate security sandboxes
5. ✅ Secrets are redacted according to length-based algorithm
6. ✅ Audit log maintains unbroken HMAC chain integrity
7. ✅ Key rotation works seamlessly with historical log verification
8. ✅ CLI verification tool validates entire audit log chain
9. ✅ Security test suite passes all adversarial scenarios
10. ✅ Performance monitoring detects DoS attempts and bottlenecks

## Post-Implementation Checklist

- [ ] Security audit by external reviewer
- [ ] Load testing with concurrent path validations
- [ ] Penetration testing of sandbox escape attempts  
- [ ] HMAC chain performance testing with 100K entries
- [ ] Cross-platform validation (Linux, macOS, Windows)
- [ ] Documentation updates for security team
- [ ] Integration with existing monitoring systems
- [ ] Deployment runbook with rollback procedures

---

This implementation plan provides comprehensive security hardening across path validation, regex execution, and audit logging with defense-in-depth principles, extensive testing, and robust monitoring to protect against sophisticated attack vectors.