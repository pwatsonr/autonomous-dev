/**
 * TASK-001 — Config reader for the self-improvement loop.
 *
 * Parses all `AUTONOMOUS_DEV_SELF_IMPROVE_*` environment variables with
 * fail-safe defaults. Never throws. Malformed values produce a `ConfigWarning`
 * and fall back to the documented default.
 *
 * @module intake/triggers/self_improve/config
 */

/** A deferred emission for an invalid env-var value. */
export interface ConfigWarning {
  envVar: string;
  raw: string;
  fallback: string;
}

/** Full configuration for the self-improvement loop. */
export interface SelfImproveConfig {
  enabled: boolean;
  maxAttemptsPerIssue: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerRepo: number;
  maxCostUsdPerDay: number;
  maxCostUsdPerWeek: number;
  backoffBaseMinutes: number;
  fnRegistryPath: string | null;
  maxIssuesPerTick: number;
  evidenceTimeoutMs: number;
  botLogin: string;
  bodyTruncateBytes: number;
  addInProgressLabel: boolean;
  configWarnings: ConfigWarning[];
}

/** Defaults table (mirrors the spec §1.1 table). */
const DEFAULTS = {
  enabled: false,
  maxAttemptsPerIssue: 3,
  maxConcurrentGlobal: 2,
  maxConcurrentPerRepo: 1,
  maxCostUsdPerDay: 5.0,
  maxCostUsdPerWeek: 25.0,
  backoffBaseMinutes: 60,
  fnRegistryPath: null as string | null,
  maxIssuesPerTick: 5,
  evidenceTimeoutMs: 500,
  botLogin: '',
  bodyTruncateBytes: 32768,
  addInProgressLabel: false,
} as const;

/**
 * Parse a boolean env var. Only `'1'` returns `true`; any other value
 * (including `'true'`, `'yes'`) returns `false`. A warning is emitted
 * when the var is present AND not `'0'` AND not `'1'`.
 */
function parseBool(
  key: string,
  env: NodeJS.ProcessEnv,
  warnings: ConfigWarning[],
): boolean {
  const raw = env[key];
  if (raw === undefined) return false;
  if (raw === '1') return true;
  if (raw === '0') return false;
  // Present but not 0/1 — warn
  warnings.push({ envVar: key, raw, fallback: 'false' });
  return false;
}

/**
 * Parse a positive integer env var. NaN, negative, non-integer, or zero →
 * fallback + warning.
 */
function parsePosInt(
  key: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
  warnings: ConfigWarning[],
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    warnings.push({ envVar: key, raw, fallback: String(fallback) });
    return fallback;
  }
  return n;
}

/**
 * Parse a non-negative float env var. Negative or non-finite → fallback + warning.
 */
function parseNonNegFloat(
  key: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
  warnings: ConfigWarning[],
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    warnings.push({ envVar: key, raw, fallback: String(fallback) });
    return fallback;
  }
  return n;
}

/**
 * Read and validate all self-improvement config from the environment.
 *
 * Never throws. All invalid values fall back to documented defaults and
 * accumulate in `configWarnings` for later event emission.
 *
 * @param env - The environment object to read from (usually `process.env`).
 * @returns A fully-populated `SelfImproveConfig`.
 */
export function readSelfImproveConfig(env: NodeJS.ProcessEnv): SelfImproveConfig {
  const warnings: ConfigWarning[] = [];

  const enabled = parseBool('AUTONOMOUS_DEV_SELF_IMPROVE', env, warnings);
  const addInProgressLabel = parseBool(
    'AUTONOMOUS_DEV_SELF_IMPROVE_ADD_INPROGRESS_LABEL',
    env,
    warnings,
  );

  const maxAttemptsPerIssue = parsePosInt(
    'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ATTEMPTS',
    env,
    DEFAULTS.maxAttemptsPerIssue,
    warnings,
  );
  const maxConcurrentGlobal = parsePosInt(
    'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_CONCURRENT',
    env,
    DEFAULTS.maxConcurrentGlobal,
    warnings,
  );
  const maxConcurrentPerRepo = parsePosInt(
    'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_CONCURRENT_PER_REPO',
    env,
    DEFAULTS.maxConcurrentPerRepo,
    warnings,
  );
  const backoffBaseMinutes = parsePosInt(
    'AUTONOMOUS_DEV_SELF_IMPROVE_BACKOFF_BASE_MINUTES',
    env,
    DEFAULTS.backoffBaseMinutes,
    warnings,
  );
  const maxIssuesPerTick = parsePosInt(
    'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ISSUES_PER_TICK',
    env,
    DEFAULTS.maxIssuesPerTick,
    warnings,
  );
  const evidenceTimeoutMs = parsePosInt(
    'AUTONOMOUS_DEV_SELF_IMPROVE_EVIDENCE_TIMEOUT_MS',
    env,
    DEFAULTS.evidenceTimeoutMs,
    warnings,
  );
  const bodyTruncateBytes = parsePosInt(
    'AUTONOMOUS_DEV_SELF_IMPROVE_BODY_TRUNCATE_BYTES',
    env,
    DEFAULTS.bodyTruncateBytes,
    warnings,
  );

  const maxCostUsdPerDay = parseNonNegFloat(
    'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_COST_USD_PER_DAY',
    env,
    DEFAULTS.maxCostUsdPerDay,
    warnings,
  );
  const maxCostUsdPerWeek = parseNonNegFloat(
    'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_COST_USD_PER_WEEK',
    env,
    DEFAULTS.maxCostUsdPerWeek,
    warnings,
  );

  const fnRegistryPathRaw = env['AUTONOMOUS_DEV_SELF_IMPROVE_FN_REGISTRY_PATH'];
  const fnRegistryPath = fnRegistryPathRaw !== undefined ? fnRegistryPathRaw : DEFAULTS.fnRegistryPath;

  const botLogin = env['AUTONOMOUS_DEV_BOT_LOGIN'] ?? DEFAULTS.botLogin;

  return {
    enabled,
    maxAttemptsPerIssue,
    maxConcurrentGlobal,
    maxConcurrentPerRepo,
    maxCostUsdPerDay,
    maxCostUsdPerWeek,
    backoffBaseMinutes,
    fnRegistryPath,
    maxIssuesPerTick,
    evidenceTimeoutMs,
    botLogin,
    bodyTruncateBytes,
    addInProgressLabel,
    configWarnings: warnings,
  };
}
