/**
 * Barrel re-exports for the hook engine.
 *
 * Downstream consumers (daemon, CLI, tests) import everything from here so
 * we can reorganize internals without breaking import sites.
 *
 * @module intake/hooks
 */

export * from './types';
export * from './discovery';
