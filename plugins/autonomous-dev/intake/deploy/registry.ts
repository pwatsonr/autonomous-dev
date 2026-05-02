/**
 * Singleton `BackendRegistry` (SPEC-023-1-04, Task 9).
 *
 * Tracks every registered `DeploymentBackend` plus a per-entry
 * availability flag. At registration time the registry runs a
 * `<tool> --version` probe for each declared `requiredTool`; missing
 * tools mark the backend `available: false` but DO NOT prevent
 * registration (so unit tests with mocked tools still resolve via
 * `get(name)`).
 *
 * The static class shape is deliberate: existing CLI commands call
 * `BackendRegistry.get(...)` without threading a registry instance.
 *
 * @module intake/deploy/registry
 */

import { BackendNotFoundError } from './errors';
import { runTool } from './exec';
import type { DeploymentBackend } from './types';

export interface RegisteredBackend {
  backend: DeploymentBackend;
  available: boolean;
  unavailableReason?: string;
}

export interface RegistryRegisterOptions {
  /** Test seam — defaults to the production `runTool`. */
  runTool?: typeof runTool;
  /** Synchronous variant for tests where the tool probe should be skipped. */
  skipToolProbe?: boolean;
  /** Logger. Defaults to console.warn. */
  logger?: { warn: (msg: string) => void };
}

const entries = new Map<string, RegisteredBackend>();

export class BackendRegistry {
  /**
   * Register `backend` under its `metadata.name`. Probes each
   * `metadata.requiredTools` entry; if any probe fails, the entry is
   * still registered with `available: false` and a reason string.
   *
   * Async because the tool probes invoke `runTool` (which is async).
   */
  static async register(
    backend: DeploymentBackend,
    opts: RegistryRegisterOptions = {},
  ): Promise<RegisteredBackend> {
    const run = opts.runTool ?? runTool;
    const logger = opts.logger ?? { warn: (m: string) => console.warn(m) };
    let available = true;
    let unavailableReason: string | undefined;

    if (!opts.skipToolProbe) {
      for (const tool of backend.metadata.requiredTools) {
        try {
          await run(tool, ['--version'], { cwd: process.cwd(), timeoutMs: 5_000 });
        } catch {
          available = false;
          unavailableReason = `${tool} not on PATH or unresponsive`;
          logger.warn(
            `BackendRegistry: backend '${backend.metadata.name}' marked unavailable (${unavailableReason})`,
          );
          break;
        }
      }
    }

    const entry: RegisteredBackend = { backend, available, unavailableReason };
    entries.set(backend.metadata.name, entry);
    return entry;
  }

  /** Synchronous register — skips the tool probe. Test convenience. */
  static registerSync(backend: DeploymentBackend): RegisteredBackend {
    const entry: RegisteredBackend = { backend, available: true };
    entries.set(backend.metadata.name, entry);
    return entry;
  }

  /** Look up a backend by `metadata.name`. */
  static get(name: string): DeploymentBackend {
    const entry = entries.get(name);
    if (!entry) throw new BackendNotFoundError(name);
    return entry.backend;
  }

  /** Look up the full registration entry (incl. availability). */
  static getEntry(name: string): RegisteredBackend {
    const entry = entries.get(name);
    if (!entry) throw new BackendNotFoundError(name);
    return entry;
  }

  /** Sorted list of every registered backend. Stable for snapshot tests. */
  static list(): RegisteredBackend[] {
    return [...entries.values()].sort((a, b) =>
      a.backend.metadata.name.localeCompare(b.backend.metadata.name),
    );
  }

  /** TEST ONLY — clear the registry. Production code MUST NOT call this. */
  static clear(): void {
    entries.clear();
  }
}
