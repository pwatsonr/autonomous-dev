/**
 * `DeployLogger` — per-deploy structured JSONL logger (SPEC-023-3-02).
 *
 * Cross-reference: TDD-023 §13.
 *
 * Layout:
 *   <request>/.autonomous-dev/deploy-logs/<deployId>/{build,deploy,health,monitor}/<comp>.log
 *
 * Each line is single-line JSON `{ts, level, message, fields}`. Concurrent
 * `info`/`warn`/`error` calls within the process are serialized through
 * an internal append queue so byte interleaving cannot tear a line.
 * Rotation is automatic at `rotateAtBytes` (default 100 MiB) and capped
 * at `maxRotations` rotated files (default 10).
 *
 * Failure modes:
 *   - Disk full / EACCES: emit ONE stderr warning per logger lifetime,
 *     drop the offending line, and keep accepting new writes (callers
 *     do not see an exception).
 *   - Rename failure during rotation: same handling; the current file
 *     stays in place and rotation is retried on the next write.
 *
 * @module intake/deploy/logger
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';

import { LoggerClosedError } from './errors';
import {
  DEFAULT_MAX_ROTATIONS,
  DEFAULT_ROTATE_AT_BYTES,
  planRotation,
} from './log-rotation';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogComponent = 'build' | 'deploy' | 'health' | 'monitor';

export interface LogLine {
  ts: string;
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
}

/** Subset of the fs/promises API the logger needs. Injectable for tests. */
export interface FsLike {
  mkdir(
    path: string,
    opts: { recursive: true; mode?: number },
  ): Promise<string | undefined>;
  appendFile(
    path: string,
    data: string,
    opts: { encoding: 'utf8'; mode?: number },
  ): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  rename(src: string, dst: string): Promise<void>;
  rm(path: string, opts: { force: true }): Promise<void>;
}

/** Telemetry adapter — see SPEC-023-3-02 §Telemetry Adapter. */
export interface DeployTelemetryAdapter {
  emit(event: {
    deployId: string;
    env: string;
    backend: string;
    name: string;
    timestamp: string;
    fields: Record<string, unknown>;
  }): void;
}

export interface DeployLoggerOptions {
  requestRoot: string;
  deployId: string;
  component: LogComponent;
  /** Optional contextual env / backend names forwarded to telemetry. */
  env?: string;
  backend?: string;
  fs?: FsLike;
  rotateAtBytes?: number;
  maxRotations?: number;
  telemetry?: DeployTelemetryAdapter;
  /** Test seam — defaults to `() => new Date().toISOString()`. */
  clock?: () => string;
  /** Test seam for the single-shot stderr warning. */
  stderrWrite?: (msg: string) => void;
}

const productionFs: FsLike = {
  mkdir: (path, opts) => fs.mkdir(path, opts),
  appendFile: (path, data, opts) => fs.appendFile(path, data, opts),
  stat: (path) => fs.stat(path).then((s) => ({ size: s.size })),
  rename: (src, dst) => fs.rename(src, dst),
  rm: (path, opts) => fs.rm(path, opts),
};

/** Shared rotation-state object so siblings created with `forComponent()`
 * remain independent counters but use the same configured limits. */
interface SharedConfig {
  requestRoot: string;
  deployId: string;
  rotateAtBytes: number;
  maxRotations: number;
  fs: FsLike;
  telemetry?: DeployTelemetryAdapter;
  clock: () => string;
  env?: string;
  backend?: string;
  stderrWrite: (msg: string) => void;
}

export class DeployLogger {
  private readonly shared: SharedConfig;
  private readonly component: LogComponent;
  /** JS-promise mutex over file appends. Guarantees no within-line interleaving. */
  private mutex: Promise<unknown> = Promise.resolve();
  /** Cached current size to avoid stat() per write. -1 ⇒ unknown (re-stat). */
  private knownSize = -1;
  private dirEnsured = false;
  private closed = false;
  /** Single-shot guard for the stderr warning. */
  private warnedOnce = false;

  constructor(opts: DeployLoggerOptions) {
    this.component = opts.component;
    this.shared = {
      requestRoot: opts.requestRoot,
      deployId: opts.deployId,
      rotateAtBytes: opts.rotateAtBytes ?? DEFAULT_ROTATE_AT_BYTES,
      maxRotations: opts.maxRotations ?? DEFAULT_MAX_ROTATIONS,
      fs: opts.fs ?? productionFs,
      telemetry: opts.telemetry,
      clock: opts.clock ?? (() => new Date().toISOString()),
      env: opts.env,
      backend: opts.backend,
      stderrWrite:
        opts.stderrWrite ?? ((msg: string) => process.stderr.write(msg)),
    };
  }

  // -- Constructor-style helpers ------------------------------------------

  /**
   * Construct a sibling logger for a different component sharing the
   * SAME rotation parameters and telemetry adapter. The two loggers
   * write to disjoint files but share the in-memory single-shot stderr
   * warning so disk-full conditions yield one operator message overall.
   */
  forComponent(component: LogComponent): DeployLogger {
    const sib = new DeployLogger({
      requestRoot: this.shared.requestRoot,
      deployId: this.shared.deployId,
      component,
      env: this.shared.env,
      backend: this.shared.backend,
      fs: this.shared.fs,
      rotateAtBytes: this.shared.rotateAtBytes,
      maxRotations: this.shared.maxRotations,
      telemetry: this.shared.telemetry,
      clock: this.shared.clock,
      stderrWrite: this.shared.stderrWrite,
    });
    return sib;
  }

  // -- Public API ----------------------------------------------------------

  debug(message: string, fields?: Record<string, unknown>): void {
    this.enqueue('DEBUG', message, fields ?? {}, /*forwardTelemetry*/ false);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.enqueue('INFO', message, fields ?? {}, /*forwardTelemetry*/ true);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.enqueue('WARN', message, fields ?? {}, /*forwardTelemetry*/ true);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.enqueue('ERROR', message, fields ?? {}, /*forwardTelemetry*/ true);
  }

  /** Resolve once all queued writes have settled. */
  async flush(): Promise<void> {
    try {
      await this.mutex;
    } catch {
      /* swallow — individual write errors are already routed to stderr */
    }
  }

  /** Flush, then refuse subsequent writes. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  // -- Internal -----------------------------------------------------------

  private logPath(): string {
    return join(
      this.shared.requestRoot,
      '.autonomous-dev',
      'deploy-logs',
      this.shared.deployId,
      this.component,
      `${this.component}.log`,
    );
  }

  private enqueue(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown>,
    forwardTelemetry: boolean,
  ): void {
    if (this.closed) {
      // Surface as a thrown error so callers notice the lifecycle bug.
      throw new LoggerClosedError();
    }
    const ts = this.shared.clock();
    const line: LogLine = { ts, level, message, fields };
    const serialized = JSON.stringify(line) + '\n';
    const next = this.mutex.then(async () => {
      try {
        await this.appendOne(serialized);
        if (forwardTelemetry && this.shared.telemetry) {
          try {
            this.shared.telemetry.emit({
              deployId: this.shared.deployId,
              env: this.shared.env ?? '',
              backend: this.shared.backend ?? '',
              name: message,
              timestamp: ts,
              fields,
            });
          } catch {
            // Telemetry must not poison disk writes.
          }
        }
      } catch (err) {
        this.warnOnce(err as Error, level, message);
      }
    });
    // Swallow rejections on the mutex chain so a single failure does not
    // poison subsequent appends.
    this.mutex = next.catch(() => {
      /* already routed via warnOnce */
    });
  }

  private async appendOne(serialized: string): Promise<void> {
    const path = this.logPath();
    if (!this.dirEnsured) {
      await this.shared.fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      this.dirEnsured = true;
    }
    if (this.knownSize < 0) {
      try {
        const s = await this.shared.fs.stat(path);
        this.knownSize = s.size;
      } catch {
        this.knownSize = 0;
      }
    }
    const pendingBytes = Buffer.byteLength(serialized, 'utf8');
    const plan = planRotation({
      basePath: path,
      currentSize: this.knownSize,
      pendingBytes,
      rotateAtBytes: this.shared.rotateAtBytes,
      maxRotations: this.shared.maxRotations,
    });
    if (plan.shouldRotate) {
      try {
        if (plan.drop) {
          await this.shared.fs.rm(plan.drop, { force: true });
        }
        for (const r of plan.renames) {
          try {
            await this.shared.fs.rename(r.src, r.dst);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') throw err;
          }
        }
        this.knownSize = 0;
      } catch (err) {
        // Rotation rename failure: leave file in place and continue
        // appending. Re-attempt on the next write.
        this.warnOnce(err as Error, 'ROTATION', 'rename_failed');
      }
    }
    await this.shared.fs.appendFile(path, serialized, {
      encoding: 'utf8',
      mode: 0o600,
    });
    this.knownSize += pendingBytes;
  }

  private warnOnce(err: Error, level: LogLevel | 'ROTATION', message: string): void {
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    this.shared.stderrWrite(
      `DeployLogger[${this.shared.deployId}/${this.component}]: write failed at ${level} ${message} — ${err.message}; subsequent failures will be suppressed for the lifetime of this logger\n`,
    );
  }
}
