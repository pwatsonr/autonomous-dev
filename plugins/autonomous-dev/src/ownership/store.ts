/**
 * Ownership store (ONBOARD Phase 0 — #584).
 *
 * Reads/writes the `ownership` tree in the config manifest
 * `~/.claude/autonomous-dev.json`, preserving all other keys. Atomic
 * write-then-rename. IO is injected so the CLI command logic and tests never
 * touch real operator state (NFR-4).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Ownership } from './types';
import { loadOwnershipConfig } from './loader';
import { resolveAbsoluteHome } from '../home';

/** Injectable IO boundary for the manifest (real fs in prod, fake in tests). */
export interface OwnershipStoreIO {
  homedir(): string;
  /** Returns the file contents, or undefined if the file does not exist. */
  readFile(filePath: string): string | undefined;
  /** Atomically write `data` to `filePath` (creating parent dirs). */
  writeFile(filePath: string, data: string): void;
}

export const defaultStoreIO: OwnershipStoreIO = {
  homedir: () => resolveAbsoluteHome(),
  readFile: (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined),
  writeFile: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  },
};

/** Absolute path to the global config manifest. */
export function manifestPath(io: OwnershipStoreIO = defaultStoreIO): string {
  return path.join(io.homedir(), '.claude', 'autonomous-dev.json');
}

/** Read the full manifest object (or {} if missing/invalid). */
function readManifest(io: OwnershipStoreIO): Record<string, unknown> {
  const raw = io.readFile(manifestPath(io));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Load the validated ownership tree from the manifest. */
export function readOwnership(io: OwnershipStoreIO = defaultStoreIO): Ownership {
  return loadOwnershipConfig(readManifest(io).ownership);
}

/**
 * Persist the ownership tree into the manifest, preserving all other keys.
 *
 * NOTE (ONBOARD #584 review): this is a read-modify-write with no cross-process
 * lock. Acceptable today because the manifest is written ONLY by operator CLI
 * commands (this store + `config init`) — the daemon never writes it at runtime
 * — so the only race is two concurrent ownership commands, which is rare and
 * recoverable (re-run). A file lock is tracked as a follow-up (#586) for if the
 * manifest ever gains a runtime writer.
 */
export function writeOwnership(ownership: Ownership, io: OwnershipStoreIO = defaultStoreIO): void {
  const p = manifestPath(io);
  const raw = io.readFile(p);
  let manifest: Record<string, unknown> = {};
  if (raw !== undefined) {
    // The file exists — REFUSE to overwrite it unless it's a valid JSON object,
    // so a corrupt/hand-edited manifest is never silently clobbered (which would
    // wipe repositories/trust/notifications). ONBOARD #584 review round 2.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Refusing to write ownership: ${p} exists but is not valid JSON. Fix or remove it first (writing would clobber other config keys).`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Refusing to write ownership: ${p} is not a JSON object.`);
    }
    manifest = parsed as Record<string, unknown>;
  }
  manifest.ownership = ownership;
  io.writeFile(p, `${JSON.stringify(manifest, null, 2)}\n`);
}
