/**
 * TypeScript types mirroring `schemas/standards-v1.json` (SPEC-021-1-01).
 *
 * Field-for-field mapping of the standards DSL described in TDD-021 §5.
 * Consumed by the loader (SPEC-021-1-02), resolver, scanner, CLI, and the
 * downstream PLAN-021-2 / PLAN-021-3 / PLAN-020-1 plans.
 *
 * No runtime code lives here — these are pure type declarations. The schema
 * is the runtime source of truth; these types are the compile-time mirror.
 *
 * @module intake/standards/types
 */

/**
 * Severity levels per TDD-021 §5.
 * - `advisory` — informational; never blocks.
 * - `warn`     — surfaces a warning but does not block merge.
 * - `blocking` — must be satisfied before merge.
 */
export type Severity = 'advisory' | 'warn' | 'blocking';

/**
 * Service types eligible for predicate matching per TDD-021 §5.
 *
 * The closed enum lets the schema reject typos like `service_type: "apii"`
 * at validation time rather than silently failing to match anything.
 */
export type ServiceType = 'api' | 'worker' | 'cli' | 'library' | 'frontend';

/**
 * Predicate: matches a target before evaluating `requires` (TDD-021 §5).
 *
 * All keys are optional. When multiple keys are present, they AND together —
 * for example `{ language: "python", service_type: "api" }` matches only
 * Python API services. At least one key is required (enforced by the schema's
 * `minProperties: 1`).
 */
export interface Predicate {
  /** Source language (e.g., `python`, `typescript`, `go`). */
  language?: string;
  /** Service classification. */
  service_type?: ServiceType;
  /** Framework label (e.g., `fastapi`, `express`). */
  framework?: string;
  /** Interfaces / capabilities the target implements. */
  implements?: string[];
  /** Regex matched against repo-relative file paths. */
  path_pattern?: string;
}

/**
 * Assertion: what the rule requires when the predicate matches (TDD-021 §5).
 *
 * All keys are optional but at least one is required (schema `minProperties: 1`).
 * The PLAN-021-2 evaluator catalog interprets these fields by name.
 */
export interface Assertion {
  /** Required framework name (paired with `evaluator: framework-detector`). */
  framework_match?: string;
  /** Endpoint that must be exposed (method + path regex). */
  exposes_endpoint?: { method: string; path_pattern: string };
  /** Regex that target source MUST match. */
  uses_pattern?: string;
  /** Regex that target source MUST NOT match. */
  excludes_pattern?: string;
  /** Dependency name that MUST be present. */
  dependency_present?: string;
  /** Free-form arguments forwarded to a custom evaluator (PLAN-021-2 §4). */
  custom_evaluator_args?: Record<string, unknown>;
}

/**
 * A single standards rule (TDD-021 §5).
 *
 * The `id` field uses the namespaced format `<plugin>:<id>`, restricted by
 * the schema to the kebab-case pattern `^[a-z0-9-]+:[a-z0-9-]+$`. The
 * restriction is intentional — v1 forbids dots so future schema versions
 * can introduce them as a separate scoping mechanism without ambiguity.
 *
 * The `evaluator` field references the catalog populated by PLAN-021-2; v1
 * leaves it as a free-form string so this plan can ship without blocking
 * on the catalog schema.
 */
export interface Rule {
  /** Matches `/^[a-z0-9-]+:[a-z0-9-]+$/`. */
  id: string;
  severity: Severity;
  /** Defaults to `false` when omitted. Only meaningful at the org level. */
  immutable?: boolean;
  description: string;
  applies_to: Predicate;
  requires: Assertion;
  /** References the PLAN-021-2 evaluator catalog. */
  evaluator: string;
}

/**
 * Author / provenance metadata for a standards artifact (TDD-021 §5).
 *
 * `last_updated` is a date-only ISO 8601 string (`YYYY-MM-DD`); times are
 * deliberately excluded so two same-day edits produce stable diffs.
 */
export interface Metadata {
  name: string;
  description: string;
  owner: string;
  /** ISO 8601 date (`YYYY-MM-DD`). */
  last_updated: string;
}

/**
 * Top-level structure of a standards.yaml file (TDD-021 §5).
 *
 * The literal `version: "1"` discriminator is what lets the loader detect
 * unknown future versions before validating against the schema.
 */
export interface StandardsArtifact {
  version: '1';
  metadata: Metadata;
  rules: Rule[];
}

/**
 * Source attribution for a resolved rule (TDD-021 §8).
 *
 * Returned by the InheritanceResolver in `resolver.ts`. Author agents
 * (PLAN-021-3) and reviewers (PLAN-020-1) read source attribution to decide
 * whether a rule violation is the operator's responsibility (`org`/`repo`)
 * or the platform's (`default`).
 */
export type RuleSource = 'default' | 'org' | 'repo' | 'request';
