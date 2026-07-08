/**
 * Shared `DeployTargetRegistry` contract + default in-memory implementation
 * (issues #658 + #659).
 *
 * ## Design rationale — dynamic-first (#674)
 *
 * The registry has two target sources:
 *
 * 1. **Static targets** — individually `register()`'d from `deploy.yaml` config.
 * 2. **Dynamic providers** — `TargetProvider` instances whose `listTargets()`
 *    is called on every `list()` / `get()` / `resolve()` invocation, so a
 *    homelab plugin (or any future plugin) can return a live view derived from
 *    discovery APIs (Docker, Portainer, Proxmox, Kubernetes …). When a node
 *    is added or removed from the homelab the next `list()` call reflects the
 *    change with no code change to core.
 *
 * Crucially, core never hard-codes a node list. Plugins call
 * `registry.registerProvider(provider)` at `activate()` time; the provider's
 * `listTargets()` supplies the current topology.
 *
 * ## Concurrent list() semantics
 *
 * All provider `listTargets()` calls are dispatched concurrently via
 * `Promise.allSettled`. A provider failure marks its targets as unavailable
 * but does not block the rest — callers still see the healthy providers' view.
 *
 * Cross-reference: issues #658, #659, #674.
 *
 * @module intake/deploy/target-registry
 */

import type { DeployTarget, TargetSelector } from './target-types';

// ---------------------------------------------------------------------------
// TargetProvider contract
// ---------------------------------------------------------------------------

/**
 * A plugin-supplied source of `DeployTarget` objects.
 *
 * Implementations query a live API (Docker, Portainer, Proxmox, k8s, …) and
 * return the current set of targets. Each `list()` call re-queries, so the
 * registry always reflects the most recent topology without a restart.
 *
 * The `id` must be stable across restarts so callers can reference a provider
 * by name (e.g., for deregistration or logging).
 */
export interface TargetProvider {
  /** Stable identifier for this provider (e.g., `'homelab-docker'`). */
  readonly id: string;

  /**
   * Return the current set of targets this provider can see.
   *
   * Called on every `DeployTargetRegistry.list()` / `get()` / `resolve()`
   * invocation; implementations should cache internally if the underlying
   * API is slow. Throwing rejects the provider's contribution for that call
   * (other providers' targets are unaffected).
   */
  listTargets(): Promise<DeployTarget[]>;
}

// ---------------------------------------------------------------------------
// DeployTargetRegistry interface
// ---------------------------------------------------------------------------

/**
 * Contract for the shared deploy-target registry.
 *
 * The interface is separated from the in-memory implementation so tests can
 * inject stubs and plugins can provide alternate implementations.
 *
 * Lifecycle:
 *   - Core bootstraps with an `InMemoryDeployTargetRegistry` singleton.
 *   - Config-defined targets are registered via `register()`.
 *   - Plugins call `registerProvider()` from their `activate()` hook.
 *   - The deploy path calls `list()` / `get()` / `resolve()` at request time.
 *
 * All read methods are `async` because providers involve I/O.
 */
export interface DeployTargetRegistry {
  /**
   * Register a single `DeployTarget` (typically sourced from config).
   *
   * Registering a target whose `id` matches an existing static entry
   * overwrites it. Provider-supplied targets are never stored as statics.
   *
   * @param target - The target to register.
   */
  register(target: DeployTarget): void;

  /**
   * Register a `TargetProvider` that supplies targets dynamically.
   *
   * Re-registering a provider with the same `id` replaces the previous one
   * (idempotent, consistent with `BackendRegistry` convention).
   *
   * @param provider - The provider to register.
   */
  registerProvider(provider: TargetProvider): void;

  /**
   * Return all known targets: static entries first, then all provider targets
   * (in provider-registration order). Providers are queried concurrently;
   * failures are silently omitted (no throw).
   *
   * @returns Resolved array of all current targets.
   */
  list(): Promise<DeployTarget[]>;

  /**
   * Look up a target by its exact `id`.
   *
   * Searches static targets first, then providers (in registration order).
   *
   * @param id - Target id to look up.
   * @returns The matching `DeployTarget`, or `undefined` if not found.
   */
  get(id: string): Promise<DeployTarget | undefined>;

  /**
   * Return the subset of targets matching ALL non-undefined selector fields.
   *
   * An empty / all-undefined selector returns everything (same as `list()`).
   * Provider targets are included in the candidate set.
   *
   * @param selector - Filter criteria.
   * @returns Matching targets in deterministic order (statics first).
   */
  resolve(selector: TargetSelector): Promise<DeployTarget[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Default in-memory `DeployTargetRegistry` implementation.
 *
 * Suitable for production and tests. Static targets live in a `Map` keyed by
 * `id`. Providers live in an insertion-ordered `Map` keyed by `provider.id`.
 * `list()` aggregates both; `get()` and `resolve()` delegate to `list()`.
 */
export class InMemoryDeployTargetRegistry implements DeployTargetRegistry {
  private readonly statics = new Map<string, DeployTarget>();
  private readonly providers = new Map<string, TargetProvider>();

  /** @inheritdoc */
  register(target: DeployTarget): void {
    this.statics.set(target.id, target);
  }

  /** @inheritdoc */
  registerProvider(provider: TargetProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Aggregate static targets with all provider targets.
   *
   * Provider `listTargets()` calls are dispatched concurrently via
   * `Promise.allSettled` so a single slow/failing provider does not block
   * the rest. Rejected providers contribute an empty array; warnings are
   * emitted to `stderr` with the provider id and error message so operators
   * can diagnose issues without the registry throwing.
   *
   * @returns Combined list: statics in insertion order, then providers in
   *   registration order (each provider's targets in the order returned by
   *   its `listTargets()`).
   */
  async list(): Promise<DeployTarget[]> {
    const result: DeployTarget[] = [...this.statics.values()];

    if (this.providers.size === 0) return result;

    const providerList = [...this.providers.values()];
    const settled = await Promise.allSettled(providerList.map((p) => p.listTargets()));

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        result.push(...outcome.value);
      } else {
        // Surface the error without crashing the registry call.
        const provider = providerList[i];
        const reason =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        console.warn(
          `DeployTargetRegistry: provider '${provider.id}' failed to list targets: ${reason}`,
        );
      }
    }

    return result;
  }

  /**
   * Look up a target by exact `id`. Aggregates via `list()` so both static
   * and provider targets are searched.
   *
   * @param id - Target id to look up.
   * @returns The first matching target, or `undefined`.
   */
  async get(id: string): Promise<DeployTarget | undefined> {
    const all = await this.list();
    return all.find((t) => t.id === id);
  }

  /**
   * Filter the full target list against a `TargetSelector`.
   *
   * All non-undefined selector fields must match (logical AND). An empty
   * selector returns the full list unchanged.
   *
   * @param selector - Filter criteria.
   * @returns Matching targets in `list()` order.
   */
  async resolve(selector: TargetSelector): Promise<DeployTarget[]> {
    const all = await this.list();
    return all.filter((t) => matchesSelector(t, selector));
  }

  /**
   * TEST ONLY — clear all statics and providers. Production code must not
   * call this; it breaks plugin registrations across tests.
   */
  clear(): void {
    this.statics.clear();
    this.providers.clear();
  }
}

// ---------------------------------------------------------------------------
// Matching logic (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Return `true` iff `target` satisfies every non-undefined field in
 * `selector`. All conditions are ANDed.
 *
 * Exported so callers can unit-test matching rules without constructing a
 * registry instance.
 *
 * @param target   - Candidate target.
 * @param selector - Filter; undefined fields are ignored.
 */
export function matchesSelector(target: DeployTarget, selector: TargetSelector): boolean {
  if (selector.id !== undefined && target.id !== selector.id) return false;
  if (selector.kind !== undefined && target.kind !== selector.kind) return false;
  if (selector.env !== undefined && target.env !== selector.env) return false;
  if (
    selector.tag !== undefined &&
    target.tags[selector.tag.key] !== selector.tag.value
  ) {
    return false;
  }
  if (
    selector.capability !== undefined &&
    !target.capabilities.includes(selector.capability)
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Singleton + bootstrap helpers
// ---------------------------------------------------------------------------

/**
 * The process-wide `DeployTargetRegistry` singleton, shared by the
 * orchestrator and any plugin that calls `getDeployTargetRegistry()`.
 *
 * Replaced only by `setDeployTargetRegistry()` — used in tests.
 */
let singleton: DeployTargetRegistry = new InMemoryDeployTargetRegistry();

/**
 * Retrieve the process-wide `DeployTargetRegistry`.
 *
 * The orchestrator calls this to get the default target when routing deploy
 * requests (see issue #660 for the full resolver; this is the minimal hook
 * that makes the registry accessible without behaviour change today).
 *
 * @returns The current singleton registry.
 */
export function getDeployTargetRegistry(): DeployTargetRegistry {
  return singleton;
}

/**
 * Replace the process-wide registry. TEST ONLY — production code must not
 * call this. The only legitimate production caller is bootstrapping code that
 * needs to pre-populate the registry before the first deploy.
 *
 * @param registry - Replacement registry instance.
 */
export function setDeployTargetRegistry(registry: DeployTargetRegistry): void {
  singleton = registry;
}

/**
 * Reset the singleton to a fresh `InMemoryDeployTargetRegistry`.
 *
 * TEST ONLY — call in `afterEach` to isolate test registrations.
 */
export function resetDeployTargetRegistry(): void {
  singleton = new InMemoryDeployTargetRegistry();
}
