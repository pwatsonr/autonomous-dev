/**
 * Request-time target resolver (issue #660).
 *
 * Implements a deterministic four-priority chain:
 *
 *   1. `explicit-id`       — caller passed `--target <id>`; look up by exact id.
 *   2. `explicit-selector` — caller passed a `TargetSelector`; delegate to
 *                            `registry.resolve()`. Errors if ambiguous (>1
 *                            match), listing all candidates so the operator
 *                            can narrow the selector. Errors if no match.
 *   3. `config-default`    — no explicit target; use the pre-resolved default
 *                            target id supplied by the caller (e.g. the
 *                            `default_target` from `deploy.yaml`).
 *   4. `fallback`          — nothing was specified and there is no configured
 *                            default; if the registry has exactly one target
 *                            use it, otherwise error with the available list.
 *
 * ## Design constraints (issue #660 + invariant #674)
 *
 * - **Pure async function**: no filesystem I/O, no telemetry, no side
 *   effects. Callers own those responsibilities.
 * - **Backward compatible**: when no `--target` is given AND the caller
 *   supplies a `defaultTargetId`, resolution falls through to that default
 *   without touching registry providers beyond what is needed for lookup.
 * - **Dynamic-first**: every path goes through the live `registry.get()` /
 *   `registry.resolve()` / `registry.list()` calls, so a newly-discovered
 *   homelab node is immediately selectable. No static snapshots are cached
 *   here.
 * - **Actionable errors**: every error message names the bad id / lists
 *   the available/matching ids so the operator can act without reading docs.
 *
 * Cross-reference: issues #658, #659, #660, #661, invariant #674.
 *
 * @module intake/deploy/target-resolver
 */

import type { DeployTarget, TargetSelector } from './target-types';
import type { DeployTargetRegistry } from './target-registry';
import { getDeployTargetRegistry } from './target-registry';

// ---------------------------------------------------------------------------
// Resolution-source discriminator (mirrors SelectionSource in selector.ts)
// ---------------------------------------------------------------------------

/**
 * Where the chosen `DeployTarget` came from (telemetry + logging contract).
 * Locked to these four values; extend here if a new source is added.
 */
export type TargetResolutionSource =
  | 'explicit-id'
  | 'explicit-selector'
  | 'config-default'
  | 'fallback';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `resolveTarget`.
 *
 * Exactly one of `targetId` or `selector` may be set to express an explicit
 * override.  When neither is set, resolution falls back to `defaultTargetId`
 * and then to the single-target fallback.
 */
export interface ResolveTargetOptions {
  /**
   * Explicit target id supplied via `--target <id>`.
   * Takes priority over `selector` when both are set.
   */
  targetId?: string;

  /**
   * Explicit selector supplied via `--target kind=<k>` / tag-based lookup.
   * Used only when `targetId` is not set.
   */
  selector?: TargetSelector;

  /**
   * Pre-resolved default target id from `deploy.yaml` `default_target`.
   * Used when neither `targetId` nor `selector` is set.
   */
  defaultTargetId?: string;

  /**
   * Override the registry used for lookup (tests). Defaults to
   * `getDeployTargetRegistry()`.
   */
  registry?: DeployTargetRegistry;
}

/**
 * Successful outcome of `resolveTarget`.
 *
 * Contains the fully-resolved `DeployTarget` plus metadata for telemetry
 * and the `deploy <svc> --dry-run` plan output.
 */
export interface ResolvedTarget {
  /** The fully-described target that was selected. */
  target: DeployTarget;

  /** Where the selection came from (telemetry contract). */
  source: TargetResolutionSource;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller requests an explicit `--target <id>` that does not
 * exist in the registry at resolution time.
 *
 * The `available` list is populated from `registry.list()` so the operator
 * can pick a valid id.
 */
export class UnknownTargetError extends Error {
  public readonly requested: string;
  public readonly available: readonly string[];

  constructor(requested: string, available: readonly string[]) {
    const list = available.length > 0 ? available.join(', ') : '(none)';
    super(`Unknown target '${requested}'. Available targets: ${list}`);
    this.name = 'UnknownTargetError';
    this.requested = requested;
    this.available = Object.freeze([...available]);
  }
}

/**
 * Thrown when a `TargetSelector` matches more than one target, making the
 * choice ambiguous.
 *
 * The `matches` list names every target that matched so the operator can
 * refine the selector to uniquely identify the desired target.
 */
export class AmbiguousTargetError extends Error {
  public readonly matches: readonly string[];

  constructor(matches: readonly string[]) {
    super(
      `Ambiguous target selector: matched ${matches.length} targets (${matches.join(', ')}). ` +
      'Narrow the selector to match exactly one target.',
    );
    this.name = 'AmbiguousTargetError';
    this.matches = Object.freeze([...matches]);
  }
}

/**
 * Thrown when a `TargetSelector` matches no targets.
 *
 * The `available` list is populated from `registry.list()` so the operator
 * can inspect the current topology.
 */
export class NoMatchingTargetError extends Error {
  public readonly available: readonly string[];

  constructor(available: readonly string[]) {
    const list = available.length > 0 ? available.join(', ') : '(none)';
    super(`No targets matched the selector. Available targets: ${list}`);
    this.name = 'NoMatchingTargetError';
    this.available = Object.freeze([...available]);
  }
}

/**
 * Thrown when no explicit target, no selector, and no configured default was
 * given, AND the registry contains either zero targets or more than one target
 * (making an automatic choice unsafe).
 *
 * Carries `available` so the operator knows what to pass with `--target`.
 */
export class NoDefaultTargetError extends Error {
  public readonly available: readonly string[];

  constructor(available: readonly string[]) {
    const list = available.length > 0 ? available.join(', ') : '(none)';
    const hint =
      available.length === 0
        ? 'No targets are registered. Register a target or add a TargetProvider.'
        : `Multiple targets are registered; pass --target <id>. Available: ${list}`;
    super(hint);
    this.name = 'NoDefaultTargetError';
    this.available = Object.freeze([...available]);
  }
}

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

/**
 * Resolve a `DeployTarget` using a four-priority chain.
 *
 * Priority order:
 *   1. Explicit id (`opts.targetId`) — direct `registry.get(id)`.
 *   2. Explicit selector (`opts.selector`) — `registry.resolve(selector)`.
 *      Errors if ambiguous or no match; lists candidates in the message.
 *   3. Configured default (`opts.defaultTargetId`) — same as (1) but tagged
 *      with source `'config-default'` for telemetry.
 *   4. Automatic fallback — if the registry has exactly one target, select
 *      it. Otherwise error with the full list.
 *
 * @param opts - Resolution options; at minimum an optional `registry`.
 * @returns `ResolvedTarget` with the selected target and its resolution source.
 * @throws `UnknownTargetError`     when an explicit id does not exist.
 * @throws `AmbiguousTargetError`   when a selector matches >1 target.
 * @throws `NoMatchingTargetError`  when a selector matches 0 targets.
 * @throws `NoDefaultTargetError`   when no target can be determined.
 */
export async function resolveTarget(
  opts: ResolveTargetOptions = {},
): Promise<ResolvedTarget> {
  const registry = opts.registry ?? getDeployTargetRegistry();

  // ---- Priority 1: explicit id ----------------------------------------
  if (opts.targetId !== undefined && opts.targetId.length > 0) {
    const found = await registry.get(opts.targetId);
    if (!found) {
      const all = await registry.list();
      throw new UnknownTargetError(
        opts.targetId,
        all.map((t) => t.id).sort(),
      );
    }
    return { target: found, source: 'explicit-id' };
  }

  // ---- Priority 2: explicit selector ----------------------------------
  if (opts.selector !== undefined) {
    const matches = await registry.resolve(opts.selector);
    if (matches.length > 1) {
      throw new AmbiguousTargetError(matches.map((t) => t.id));
    }
    if (matches.length === 0) {
      const all = await registry.list();
      throw new NoMatchingTargetError(all.map((t) => t.id).sort());
    }
    return { target: matches[0], source: 'explicit-selector' };
  }

  // ---- Priority 3: configured default ---------------------------------
  if (opts.defaultTargetId !== undefined && opts.defaultTargetId.length > 0) {
    const found = await registry.get(opts.defaultTargetId);
    if (!found) {
      const all = await registry.list();
      throw new UnknownTargetError(
        opts.defaultTargetId,
        all.map((t) => t.id).sort(),
      );
    }
    return { target: found, source: 'config-default' };
  }

  // ---- Priority 4: automatic fallback ---------------------------------
  const all = await registry.list();
  if (all.length === 1) {
    return { target: all[0], source: 'fallback' };
  }
  throw new NoDefaultTargetError(all.map((t) => t.id).sort());
}
