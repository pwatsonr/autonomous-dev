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
export * from './registry';
export * from './executor';
export * from './reload-controller';
export * from './ipc-server';
export * from './ipc-client';
export * from './validation-pipeline';
export * from './formats';
export * from './keywords';
export * from './validation-stats';
