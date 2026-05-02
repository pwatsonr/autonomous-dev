/**
 * Reviewer-chain resolver (SPEC-020-2-02, Task 3).
 *
 * Reads either the per-repo override at
 *   `<repoPath>/.autonomous-dev/reviewer-chains.json`
 * or the bundled defaults at
 *   `<plugin-root>/config_defaults/reviewer-chains.json`
 * and returns the resolved `ReviewerEntry[]` for `<requestType>.<gate>`.
 *
 * Resolution order (per spec):
 *   1. Repo override file (if it exists and parses).
 *   2. Bundled defaults.
 *   3. Within the chosen config: lookup `request_types[requestType]`;
 *      fall back to `request_types.feature` if absent.
 *   4. Within the request type: lookup `gate`; if absent return `[]`
 *      (calling code skips the gate).
 *   5. Filter `enabled: false` entries.
 *
 * Path-mapping note: SPEC-020-2-02 documents this module at
 * `src/reviewers/chain-resolver.ts`. The plugin uses `intake/reviewers/...`
 * sibling to `aggregate.ts` and `frontend-detection.ts`.
 *
 * @module intake/reviewers/chain-resolver
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ChainConfig, ReviewerEntry } from './types';

/**
 * Typed exception thrown by the resolver on unrecoverable config errors.
 * The CLI (`chains validate` in SPEC-020-2-04) catches this to render
 * structured error output. We deliberately do NOT silently fall back to
 * defaults when the repo-level file is malformed: an operator who placed
 * a file there expected it to take effect, and silent fallback would
 * mask their mistake.
 */
export class ChainConfigError extends Error {
  constructor(
    message: string,
    public readonly filePath?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ChainConfigError';
  }
}

const REPO_OVERRIDE_REL_PATH = '.autonomous-dev/reviewer-chains.json';
const DEFAULTS_REL_PATH = 'config_defaults/reviewer-chains.json';

/**
 * Resolve plugin root for locating the bundled defaults.
 *   1. `process.env.CLAUDE_PLUGIN_ROOT` if set (production wiring).
 *   2. Walk up from this module's directory to the plugin package root
 *      (the directory containing `config_defaults/`). This is the
 *      fallback used by tests and direct CLI invocations.
 */
function resolvePluginRoot(): string {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  if (env && env.length > 0) return env;
  // __dirname is .../plugins/autonomous-dev/intake/reviewers
  // plugin root is two levels up.
  return resolve(__dirname, '..', '..');
}

/**
 * Load and parse a chain-config file. Throws `ChainConfigError` on any
 * I/O or parse failure. Caller is responsible for choosing which file
 * to load (override vs. defaults).
 */
function loadConfigFile(filePath: string): ChainConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ChainConfigError(
      `failed to read reviewer-chains config at ${filePath}: ${(err as Error).message}`,
      filePath,
      err,
    );
  }
  try {
    return JSON.parse(raw) as ChainConfig;
  } catch (err) {
    throw new ChainConfigError(
      `failed to parse reviewer-chains config at ${filePath}: ${(err as Error).message}`,
      filePath,
      err,
    );
  }
}

/**
 * Load the chain config for a repo. Repo override takes precedence over
 * the bundled defaults. A malformed repo override throws — never silently
 * falls back. A missing or malformed default file throws (packaging bug).
 */
export async function loadChainConfig(repoPath: string): Promise<ChainConfig> {
  const repoOverride = join(repoPath, REPO_OVERRIDE_REL_PATH);
  if (existsSync(repoOverride)) {
    return loadConfigFile(repoOverride);
  }
  const defaultsPath = join(resolvePluginRoot(), DEFAULTS_REL_PATH);
  if (!existsSync(defaultsPath)) {
    throw new ChainConfigError(
      `bundled defaults not found at ${defaultsPath} (packaging bug)`,
      defaultsPath,
    );
  }
  return loadConfigFile(defaultsPath);
}

/**
 * Resolve the reviewer chain for `<requestType>.<gate>`. See module
 * docstring for the full resolution order.
 *
 * @param repoPath    Absolute path to the repo root.
 * @param requestType Canonical request type (`feature|bug|infra|refactor|hotfix`).
 *                    Unknown types fall back to `feature`.
 * @param gate        Gate name (e.g., `code_review`). Missing gates
 *                    resolve to `[]`.
 */
export async function resolveChain(
  repoPath: string,
  requestType: string,
  gate: string,
): Promise<ReviewerEntry[]> {
  const config = await loadChainConfig(repoPath);

  let typeBlock = config.request_types[requestType];
  if (typeBlock === undefined) {
    typeBlock = config.request_types['feature'];
    if (typeBlock === undefined) {
      throw new ChainConfigError(
        `chain config missing both '${requestType}' and the 'feature' fallback`,
      );
    }
  }

  const gateChain = typeBlock[gate];
  if (gateChain === undefined) {
    return [];
  }

  // Filter disabled entries here (in the resolver) so debug output
  // (e.g., `chains show`) reflects what will actually run.
  return gateChain.filter((entry) => entry.enabled !== false);
}
