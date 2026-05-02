/**
 * Standards module barrel — re-exports the public API of the standards
 * substrate (PLAN-021-1).
 *
 * v1 surface (per SPEC-021-1-01):
 *   - Type aliases:          Severity, ServiceType, RuleSource
 *   - Interfaces:            Predicate, Assertion, Rule, Metadata, StandardsArtifact
 *
 * Subsequent specs in PLAN-021-1 expand this barrel with the loader,
 * resolver, and auto-detection scanner.
 *
 * @module intake/standards
 */

export type {
  Severity,
  ServiceType,
  RuleSource,
  Predicate,
  Assertion,
  Rule,
  Metadata,
  StandardsArtifact,
} from './types';
