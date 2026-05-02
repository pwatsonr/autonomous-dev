/**
 * EvaluatorRegistry (SPEC-021-2-03, Task 8).
 *
 * Single in-process registry mapping evaluator names → handlers. The
 * registry auto-registers the five built-ins at construction time and then
 * loads custom evaluator paths from the operator-controlled allowlist. The
 * registry is reload-safe: the daemon's SIGUSR1 handler calls `reload()`
 * which evicts ALL custom entries and re-reads the allowlist; built-ins are
 * immutable.
 *
 * The constructor takes a `loadAllowlist: () => string[]` thunk rather than
 * reading config directly. Tests inject a stub; the daemon wires it to the
 * real config-loading helper.
 *
 * Custom evaluator naming convention: `basename(path)` with extension
 * stripped. Collisions with built-in names log a warning and are skipped
 * (built-ins win).
 *
 * @module intake/standards/evaluator-registry
 */

import { basename, extname } from 'node:path';

import { EvaluatorNotFoundError } from './errors';
import type { BuiltinEvaluator } from './evaluators/types';
import frameworkDetector from './evaluators/framework-detector';
import endpointScanner from './evaluators/endpoint-scanner';
import sqlInjectionDetector from './evaluators/sql-injection-detector';
import dependencyChecker from './evaluators/dependency-checker';
import patternGrep from './evaluators/pattern-grep';

export type RegisteredEvaluator =
  | { kind: 'builtin'; name: string; handler: BuiltinEvaluator }
  | { kind: 'custom'; name: string; absolutePath: string };

const BUILTINS: Array<[string, BuiltinEvaluator]> = [
  ['framework-detector', frameworkDetector],
  ['endpoint-scanner', endpointScanner],
  ['sql-injection-detector', sqlInjectionDetector],
  ['dependency-checker', dependencyChecker],
  ['pattern-grep', patternGrep],
];

function basenameNoExt(absolutePath: string): string {
  return basename(absolutePath, extname(absolutePath));
}

export class EvaluatorRegistry {
  private map = new Map<string, RegisteredEvaluator>();
  private builtinNames = new Set<string>();

  constructor(private readonly loadAllowlist: () => string[]) {
    this.registerBuiltins();
    this.loadCustomFromAllowlist();
  }

  private registerBuiltins(): void {
    for (const [name, handler] of BUILTINS) {
      this.map.set(name, { kind: 'builtin', name, handler });
      this.builtinNames.add(name);
    }
  }

  private loadCustomFromAllowlist(): void {
    let paths: string[] = [];
    try {
      paths = this.loadAllowlist();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`evaluator allowlist loader threw: ${message}`);
      return;
    }
    for (const absolutePath of paths) {
      const name = basenameNoExt(absolutePath);
      if (this.builtinNames.has(name)) {
        // eslint-disable-next-line no-console
        console.warn(
          `evaluator name "${name}" collides with built-in; ignoring custom path ${absolutePath}`,
        );
        continue;
      }
      this.map.set(name, { kind: 'custom', name, absolutePath });
    }
  }

  list(): RegisteredEvaluator[] {
    return [...this.map.values()];
  }

  get(name: string): RegisteredEvaluator {
    const entry = this.map.get(name);
    if (!entry) throw new EvaluatorNotFoundError(name);
    return entry;
  }

  /**
   * Drop all custom entries and reload from the (possibly updated) allowlist.
   * Built-ins are preserved.
   */
  reload(): void {
    for (const [name, entry] of this.map) {
      if (entry.kind === 'custom') this.map.delete(name);
    }
    this.loadCustomFromAllowlist();
  }
}
