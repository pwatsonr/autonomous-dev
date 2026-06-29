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

// ---------------------------------------------------------------------------
// Telemetry (fire-and-forget, imported lazily to avoid circular deps)
// ---------------------------------------------------------------------------

/** Emit a telemetry event from the resolver. Never throws. */
function safeEmitResolverEvent(payload: Record<string, unknown>): void {
  try {
    // Use the module-level telemetry emitter from telemetry.ts when
    // available. We import it dynamically to avoid a circular dependency
    // (telemetry.ts → types.ts; chain-resolver.ts → types.ts is fine, but
    // chain-resolver.ts → telemetry.ts → chain-resolver.ts would not be).
    // In tests, the import resolves to the same module instance, so mocks
    // installed via setReviewerMetricsClient apply here too.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getReviewerMetricsClient } = require('./telemetry') as {
      getReviewerMetricsClient: () => { emit?: (ch: string, p: unknown) => void } | undefined;
    };
    const client = getReviewerMetricsClient();
    if (client?.emit) {
      void Promise.resolve(client.emit('reviewer.chain_resolver', payload)).catch(() => {
        // Swallow: telemetry must not affect resolver output.
      });
    }
  } catch {
    // Swallow: telemetry must not affect resolver output.
  }
}

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

// ---------------------------------------------------------------------------
// Timeout constants (mirrored from invoke-reviewer.ts to avoid a circular import)
// ---------------------------------------------------------------------------

const RESOLVER_TIMEOUT_MIN = 30_000;
const RESOLVER_TIMEOUT_MAX = 3_600_000;
const RESOLVER_TIMEOUT_DEFAULT = 900_000;

/**
 * Parse an environment-variable integer string. Returns the integer when
 * the string is a non-empty, finite integer; otherwise returns undefined.
 * Note: `Number.parseInt('500000ms', 10)` returns 500000 — lenient JS
 * behaviour is accepted intentionally (mirrors resolveReviewerTimeoutMs).
 */
function parseEnvInt(s: string | undefined): number | undefined {
  if (s === undefined || s === '') return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && Number.isInteger(n) ? n : undefined;
}

/**
 * Resolve the effective timeout for a single entry, applying the full
 * four-level precedence chain:
 *   1. entry.timeout_ms
 *   2. gate_defaults[gate].timeout_ms
 *   3. config.defaults.timeout_ms
 *   4. process.env.REVIEWER_TIMEOUT_MS
 *   5. Built-in default 900_000
 * Result is clamped to [30_000, 3_600_000]. When the raw candidate was
 * outside the range, a telemetry event is emitted.
 */
function resolveEntryTimeout(
  entry: ReviewerEntry,
  gateDefaultTimeout: number | undefined,
  configDefaultTimeout: number | undefined,
  envTimeout: number | undefined,
  entryName: string,
): number {
  const candidate: number =
    entry.timeout_ms ??
    gateDefaultTimeout ??
    configDefaultTimeout ??
    envTimeout ??
    RESOLVER_TIMEOUT_DEFAULT;

  // Guard against NaN before Math.trunc.
  const safe = Number.isFinite(candidate) ? Math.trunc(candidate) : RESOLVER_TIMEOUT_DEFAULT;
  const clamped = Math.min(RESOLVER_TIMEOUT_MAX, Math.max(RESOLVER_TIMEOUT_MIN, safe));

  if (clamped !== safe) {
    safeEmitResolverEvent({
      event: 'reviewer.timeout_clamped',
      reviewer: entryName,
      from_ms: candidate,
      to_ms: clamped,
    });
  }

  return clamped;
}

/**
 * Resolve the reviewer chain for `<requestType>.<gate>`. See module
 * docstring for the full resolution order.
 *
 * Postcondition (SPEC-REQ-000050): every returned entry has a populated,
 * clamped `timeout_ms: number` in [30_000, 3_600_000].
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

  // gate_defaults is a sibling of gate arrays — NOT a chain entry.
  // Read it by key before iterating the gate array.
  const gateDefaultTimeout = typeBlock.gate_defaults?.[gate]?.timeout_ms;
  const configDefaultTimeout = config.defaults?.timeout_ms;
  const envTimeout = parseEnvInt(process.env.REVIEWER_TIMEOUT_MS);

  // Read the gate by string key and verify it is an array.
  // This defends against naively iterating typeBlock's values, which would
  // accidentally treat gate_defaults (an object, not an array) as a chain.
  const gateChain = typeBlock[gate];
  if (gateChain === undefined || !Array.isArray(gateChain)) {
    return [];
  }

  const out: ReviewerEntry[] = [];
  for (const entry of gateChain) {
    if (entry.enabled === false) continue;

    const timeout_ms = resolveEntryTimeout(
      entry,
      gateDefaultTimeout,
      configDefaultTimeout,
      envTimeout,
      entry.name,
    );

    out.push({ ...entry, timeout_ms });
  }
  return out;
}
