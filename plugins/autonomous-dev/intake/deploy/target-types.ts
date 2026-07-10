/**
 * Deploy-target model (issues #658 + #659).
 *
 * A `DeployTarget` is a first-class addressable destination: a specific node,
 * cloud service, or cluster endpoint where a build artifact lands. It is
 * distinct from a `DeploymentBackend`, which is the *mechanism* used to reach
 * a target.
 *
 * **Open strings by design** (invariant #674 — dynamic-first).
 * `kind` and `capabilities` are plain `string`, NOT closed enums. New target
 * kinds (`swarm-node`, `k3s`, `proxmox`, `unraid`, `cloud-run`, ...) and new
 * capability tokens appear without a schema change. Closed-enum additions
 * would require a core PR each time a homelab plugin discovers a new node
 * type, violating the discovery-driven invariant.
 *
 * **Source discrimination.**
 * Targets may be injected at startup from `deploy.yaml` (`source: 'config'`),
 * discovered dynamically by a registered `TargetProvider` (`source:
 * 'discovery'`), or supplied by a plugin that sets its own source label.
 *
 * Cross-reference: issues #658, #659, #674.
 *
 * @module intake/deploy/target-types
 */

import type { BackupClass } from './stateful-contract';

/**
 * A fully-described deploy destination.
 *
 * All fields except `id`, `name`, `kind`, `provider`, `capabilities`, `tags`,
 * and `source` are optional so that callers can build minimal targets and
 * plugins can extend them with domain-specific data via `tags` or by widening
 * `connectionRef`.
 */
export interface DeployTarget {
  /** Unique identifier — lowercase-kebab, stable across restarts. */
  id: string;

  /** Human-readable label shown in CLI / portal. */
  name: string;

  /**
   * Target kind — open string so new kinds appear without a code change.
   * Examples: `'swarm-node'`, `'k3s-cluster'`, `'proxmox-vm'`, `'unraid'`,
   * `'cloud-run-service'`, `'static-site'`, `'local-pr'`.
   */
  kind: string;

  /**
   * Backend name that handles deployments to this target.
   * Corresponds to a `BackendRegistry` entry (e.g., `'docker-local'`, `'local'`).
   */
  provider: string;

  /**
   * Open capability tokens — open string so new capabilities appear without a
   * code change. Examples: `'gpu'`, `'high-memory'`, `'production-tier'`,
   * `'blue-green'`, `'rolling-update'`.
   */
  capabilities: string[];

  /**
   * Optional logical environment the target belongs to
   * (e.g., `'dev'`, `'staging'`, `'prod'`).
   */
  env?: string;

  /**
   * Backup class for stateful targets (issue #666).
   *
   * Declared per-target; consumed by the stateful precondition check in the
   * orchestrator and forwarded to the homelab plugin's approval/backup gate.
   *
   * - `'none'`         — target carries no persistent state.
   * - `'snapshot'`     — filesystem / volume snapshot backup.
   * - `'orchestrated'` — external backup orchestrator (e.g. PBS, database dump).
   *
   * Defaults to `'none'` when omitted (non-stateful targets).
   * Only meaningful when `capabilities` includes `'stateful'`.
   */
  backup_class?: BackupClass;

  /**
   * Optional trust level for this target.
   * Examples: `'untrusted'`, `'internal'`, `'production'`.
   */
  trust?: string;

  /**
   * Arbitrary key/value metadata for matching and classification.
   * Operators express placement intent against tags; `resolve()` filters here.
   * Examples: `{ role: 'media', location: 'rack-2', gpu: 'true' }`.
   */
  tags: Record<string, string>;

  /**
   * Optional backend-specific connection reference (host, address, kubeconfig
   * path, etc.). Typed `unknown` so each backend can narrow it without
   * coupling this module to backend internals.
   */
  connectionRef?: unknown;

  /**
   * Where this target came from.
   * - `'config'`     — declared statically in `deploy.yaml` `targets` array.
   * - `'discovery'`  — emitted by a `TargetProvider` at runtime.
   * - Any other string — a plugin-specific provenance label.
   */
  source: 'config' | 'discovery' | string;
}

/**
 * Selector passed to `DeployTargetRegistry.resolve()`.
 *
 * All fields are optional; an empty selector matches all targets.
 * When multiple fields are set they are ANDed together.
 *
 * Matching semantics:
 * - `id`           — exact equality.
 * - `kind`         — exact equality.
 * - `env`          — exact equality on `DeployTarget.env`.
 * - `tag`          — target's `tags[tag.key] === tag.value`.
 * - `capability`   — target's `capabilities` array includes the value.
 */
export interface TargetSelector {
  /** Match by exact target id. */
  id?: string;
  /** Match by exact kind string (e.g., `'swarm-node'`). */
  kind?: string;
  /** Match by logical env (e.g., `'prod'`). */
  env?: string;
  /** Match targets that carry a specific tag key=value pair. */
  tag?: { key: string; value: string };
  /** Match targets that advertise this capability token. */
  capability?: string;
}
