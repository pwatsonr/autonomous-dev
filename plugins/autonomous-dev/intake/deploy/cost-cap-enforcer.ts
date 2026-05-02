/**
 * Daily cost-cap enforcement (SPEC-023-3-03).
 *
 * Three thresholds layered atop the per-env cap from
 * `intake/deploy/cost-cap.ts` (PLAN-023-2):
 *
 *   - 80% projected of cap → emit ONE sticky warning escalation per
 *     UTC day per actor, allow the deploy.
 *   - 100% projected → reject with `DailyCostCapExceededError`.
 *   - 110% projected → reject with `AdminOverrideRequiredError`,
 *     unless a single-use override token is present (and consumed).
 *
 * Override tokens live at `~/.autonomous-dev/deploy-cap-overrides.json`
 * and are consumed exactly once per deployId. Sticky-warning state lives
 * at `~/.autonomous-dev/deploy-cap-warnings.json`.
 *
 * @module intake/deploy/cost-cap-enforcer
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AdminOverrideRequiredError,
  DailyCostCapExceededError,
} from './errors';
import type { EscalationMessage } from './monitor-types';
import { CostLedger } from './cost-ledger';
import type { AdminOverrideRecord } from './cost-ledger-types';

export const OVERRIDES_FILE = 'deploy-cap-overrides.json';
export const WARNINGS_FILE = 'deploy-cap-warnings.json';
export const DEFAULT_CAP_USD_PER_DAY = 50.0;
export const DEFAULT_OVERRIDE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const SOFT_THRESHOLD = 0.8;
export const ADMIN_THRESHOLD = 1.1;

/** Operator config block consumed by `CostCapEnforcer`. */
export interface CostCapConfig {
  cost_cap_usd_per_day: number;
  admin_override_window_ms?: number;
}

export interface CostCapEnforcerOptions {
  ledger: CostLedger;
  /** Pulled fresh on every check so operator edits go live without restart. */
  config: () => Promise<CostCapConfig> | CostCapConfig;
  escalate?: (msg: EscalationMessage) => Promise<void> | void;
  /** Directory housing override + warning state. Defaults to `~/.autonomous-dev`. */
  stateDir?: string;
  /** Test seam — defaults to `() => new Date()`. */
  clock?: () => Date;
}

export interface CostCapCheckRequest {
  actor: string;
  estimated_cost_usd: number;
  deployId: string;
  env: string;
  backend: string;
}

export class CostCapEnforcer {
  private readonly ledger: CostLedger;
  private readonly config: () => Promise<CostCapConfig> | CostCapConfig;
  private readonly escalate?: (msg: EscalationMessage) => Promise<void> | void;
  private readonly stateDir: string;
  private readonly clock: () => Date;

  constructor(opts: CostCapEnforcerOptions) {
    this.ledger = opts.ledger;
    this.config = opts.config;
    this.escalate = opts.escalate;
    this.stateDir = opts.stateDir ?? join(homedir(), '.autonomous-dev');
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * Inspect today's spend + the requested deploy's estimate against
   * the configured cap. Returns silently iff the deploy may proceed;
   * throws `DailyCostCapExceededError` or `AdminOverrideRequiredError`
   * otherwise. Any 80% breach emits exactly one warning per UTC day
   * per actor.
   */
  async check(req: CostCapCheckRequest): Promise<void> {
    const cfg = await this.config();
    const cap = cfg.cost_cap_usd_per_day > 0
      ? cfg.cost_cap_usd_per_day
      : DEFAULT_CAP_USD_PER_DAY;

    const asOf = this.clock();
    const agg = await this.ledger.aggregate({ window: 'day', asOf });
    const projected =
      agg.totalActual + agg.openEstimates + req.estimated_cost_usd;
    const pct = projected / cap;

    if (pct >= ADMIN_THRESHOLD) {
      const consumed = await this.consumeOverride(req.deployId, asOf);
      if (!consumed) {
        throw new AdminOverrideRequiredError(projected, cap, ADMIN_THRESHOLD);
      }
      // Override consumed — admit the deploy. Still emit a sticky-info
      // escalation so operators see the override fired.
      await this.maybeEscalate({
        severity: 'critical',
        deployId: req.deployId,
        message: `admin override consumed: projected USD ${projected.toFixed(2)} >= 110% of cap ${cap.toFixed(2)}`,
        details: { actor: req.actor, env: req.env, backend: req.backend },
      });
      return;
    }

    if (pct >= 1.0) {
      throw new DailyCostCapExceededError(projected, cap);
    }

    if (pct >= SOFT_THRESHOLD) {
      await this.maybeStickyWarn(req.actor, asOf, {
        severity: 'warn',
        deployId: req.deployId,
        message: `cost-cap soft warning: projected USD ${projected.toFixed(2)} >= 80% of cap ${cap.toFixed(2)}`,
        details: { actor: req.actor, projected, cap, pct },
      });
    }
  }

  /**
   * Consume a single override matching `deployId` (and not yet expired).
   * Returns `true` iff a token was found AND removed from the file.
   */
  private async consumeOverride(deployId: string, asOf: Date): Promise<boolean> {
    const path = join(this.stateDir, OVERRIDES_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    let parsed: { overrides?: AdminOverrideRecord[] };
    try {
      parsed = JSON.parse(raw) as { overrides?: AdminOverrideRecord[] };
    } catch {
      return false;
    }
    const overrides = parsed.overrides ?? [];
    const nowMs = asOf.getTime();
    const idx = overrides.findIndex(
      (o) =>
        o.deployId === deployId && Date.parse(o.expires_at) > nowMs,
    );
    if (idx === -1) return false;
    overrides.splice(idx, 1);
    const next = JSON.stringify({ overrides }, null, 2);
    await fs.writeFile(path, next, { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  /**
   * Emit ONE 80% warning per UTC day per actor. State is persisted so
   * daemon restarts do not re-fire warnings on the same day.
   */
  private async maybeStickyWarn(
    actor: string,
    asOf: Date,
    msg: EscalationMessage,
  ): Promise<void> {
    const dayKey = utcDayKey(asOf);
    const path = join(this.stateDir, WARNINGS_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      raw = '{}';
    }
    let state: Record<string, string[]>;
    try {
      state = JSON.parse(raw) as Record<string, string[]>;
    } catch {
      state = {};
    }
    const todays = state[dayKey] ?? [];
    if (todays.includes(actor)) return;
    todays.push(actor);
    state[dayKey] = todays;
    // Garbage-collect entries older than 30 days so the file stays small.
    const cutoff = new Date(asOf.getTime() - 30 * 24 * 60 * 60 * 1000);
    const cutoffKey = utcDayKey(cutoff);
    for (const key of Object.keys(state)) {
      if (key < cutoffKey) delete state[key];
    }
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await this.maybeEscalate(msg);
  }

  private async maybeEscalate(msg: EscalationMessage): Promise<void> {
    if (!this.escalate) return;
    try {
      await this.escalate(msg);
    } catch {
      // Escalation failures must never poison the deploy decision.
    }
  }
}

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
