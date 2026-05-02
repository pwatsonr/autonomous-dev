/**
 * PluginDiscovery — boot-time scan of `<rootDir>/<plugin>/hooks.json`
 * (SPEC-019-1-02, Task 3).
 *
 * Walks one level deep, parses each manifest, and validates structurally
 * via an INJECTED schema validator. Trust enforcement, signature verification,
 * and AJV wiring are layered on by sibling plans (PLAN-019-2/3); this spec
 * is structural validation only.
 *
 * Defensive rules:
 *   - Path canonicalization: candidates whose canonical path escapes
 *     `rootDir` are rejected with `IO_ERROR`.
 *   - Hidden directories (name starts with `.`) are skipped silently.
 *   - Files (not directories) at the top level are skipped silently.
 *   - The scanner does NOT load, require, or execute any plugin code.
 *
 * Logging: `console.info` placeholders, swapped for the real logger when
 * PLAN-001-3 lands.
 *
 * @module intake/hooks/discovery
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HookManifest } from './types';

/** Discovery error. One of these is produced per failure encountered. */
export interface DiscoveryError {
  /** Absolute path to the offending manifest. */
  manifestPath: string;
  /** Machine-readable error code. */
  code: 'PARSE_ERROR' | 'SCHEMA_ERROR' | 'IO_ERROR';
  /** Human-readable message. */
  message: string;
  /** Optional JSON Pointer into the manifest (e.g. `/hooks/0/priority`). */
  pointer?: string;
}

/** Result of attempting to discover one plugin. */
export interface DiscoveryResult {
  manifestPath: string;
  /** Populated only when `errors.length === 0`. */
  manifest?: HookManifest;
  errors: DiscoveryError[];
}

/**
 * Schema validator signature. PLAN-019-1 injects either a hand-rolled
 * minimal validator (in tests) or the AJV-backed one (PLAN-019-2 onwards).
 */
export type SchemaValidator = (raw: unknown, manifestPath: string) => DiscoveryError[];

export class PluginDiscovery {
  constructor(private readonly schemaValidator: SchemaValidator) {}

  /**
   * Walk `<rootDir>/<plugin>/hooks.json`, one level deep.
   *
   * Returns one `DiscoveryResult` per candidate manifest, in lexicographic
   * order of plugin directory name. A non-existent `rootDir` resolves to `[]`
   * (not a thrown error). Manifest reads are performed concurrently via
   * `Promise.all` to keep the 50-plugin scan under the 100ms budget.
   */
  async scan(rootDir: string): Promise<DiscoveryResult[]> {
    const resolvedRoot = path.resolve(rootDir);

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
        // eslint-disable-next-line no-console
        console.info(`discovery: rootDir missing or not a directory: ${resolvedRoot}`);
        return [];
      }
      throw err;
    }

    // Stable lex order by directory name.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    const tasks: Array<Promise<DiscoveryResult | null>> = [];
    for (const ent of sorted) {
      // Skip hidden entries.
      if (ent.name.startsWith('.')) continue;
      // Skip files; only directories or symlinks (which we'll stat below).
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;

      const candidateDir = path.join(resolvedRoot, ent.name);
      const manifestPath = path.join(candidateDir, 'hooks.json');

      tasks.push(this.processCandidate(resolvedRoot, candidateDir, manifestPath, ent.isSymbolicLink()));
    }

    const settled = await Promise.all(tasks);
    return settled.filter((r): r is DiscoveryResult => r !== null);
  }

  private async processCandidate(
    resolvedRoot: string,
    candidateDir: string,
    manifestPath: string,
    isSymlink: boolean,
  ): Promise<DiscoveryResult | null> {
    // Path canonicalization: real path of the candidate must remain a child
    // of the resolved root. Defends against symlink-to-`..` escapes.
    let realDir: string;
    try {
      realDir = await fs.realpath(candidateDir);
    } catch (err) {
      // Broken symlink or stat failure — skip silently (broken symlinks are
      // not "discovered plugins", they are filesystem noise).
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      return {
        manifestPath,
        errors: [
          {
            manifestPath,
            code: 'IO_ERROR',
            message: `realpath failed: ${(err as Error).message}`,
          },
        ],
      };
    }

    const realRoot = await fs.realpath(resolvedRoot).catch(() => resolvedRoot);
    const rel = path.relative(realRoot, realDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      // Symlink that points outside the rootDir — defense in depth.
      return {
        manifestPath,
        errors: [
          {
            manifestPath,
            code: 'IO_ERROR',
            message: `candidate path escapes rootDir: ${realDir}`,
          },
        ],
      };
    }

    // Stat manifest file — silently skip directories without hooks.json.
    try {
      const st = await fs.stat(manifestPath);
      if (!st.isFile()) return null;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      return {
        manifestPath,
        errors: [
          {
            manifestPath,
            code: 'IO_ERROR',
            message: `stat failed: ${(err as Error).message}`,
          },
        ],
      };
    }

    const result = await this.parseManifest(manifestPath);
    const tag = result.manifest?.id ?? 'UNKNOWN';
    const status = result.errors.length === 0 ? 'ok' : `${result.errors.length} errors`;
    // eslint-disable-next-line no-console
    console.info(`discovery: ${tag} @ ${manifestPath} -> ${status}${isSymlink ? ' (via symlink)' : ''}`);
    return result;
  }

  /**
   * Read + parse + validate a single manifest file.
   *
   * Returns a result whose `manifest` is populated only on schema success.
   */
  async parseManifest(manifestPath: string): Promise<DiscoveryResult> {
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf-8');
    } catch (err) {
      return {
        manifestPath,
        errors: [
          {
            manifestPath,
            code: 'IO_ERROR',
            message: `read failed: ${(err as Error).message}`,
          },
        ],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        manifestPath,
        errors: [
          {
            manifestPath,
            code: 'PARSE_ERROR',
            message: (err as Error).message,
          },
        ],
      };
    }

    const errors = this.validateManifest(parsed, manifestPath);
    if (errors.length > 0) {
      return { manifestPath, errors };
    }
    return { manifestPath, manifest: parsed as HookManifest, errors: [] };
  }

  /**
   * Delegate to the injected schema validator. This indirection keeps
   * SPEC-019-1-02 independent of AJV; PLAN-019-2 wires AJV in.
   */
  validateManifest(raw: unknown, manifestPath: string): DiscoveryError[] {
    return this.schemaValidator(raw, manifestPath);
  }
}
