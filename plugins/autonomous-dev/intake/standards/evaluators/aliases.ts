/**
 * Framework alias map for the `framework-detector` built-in (SPEC-021-2-01).
 *
 * `FRAMEWORK_ALIASES` maps the canonical framework name (used as
 * `framework_match` in rule args) to the list of dependency names that, when
 * present in a manifest, satisfy the rule.
 *
 * `FRAMEWORK_IMPLIES` captures the directional "is built on" relationships
 * (e.g. `nextjs` implies `react`). When a rule asks for `react` and the
 * manifest declares `next`, the detector first resolves `next` → `nextjs`,
 * then walks `FRAMEWORK_IMPLIES['nextjs']` to discover that `react` is
 * implied → match.
 *
 * The map is intentionally small. Future additions are PR-reviewed; an
 * open-ended contribution mechanism is deferred until evaluator versioning
 * is designed (TDD-021 §18).
 *
 * @module intake/standards/evaluators/aliases
 */

/** canonical name → accepted dependency names that satisfy it */
export const FRAMEWORK_ALIASES: Record<string, string[]> = {
  nextjs: ['next', 'next.js'],
  react: ['react', 'react-dom'],
  vue: ['vue', 'vuejs'],
  fastapi: ['fastapi'],
  flask: ['flask'],
  django: ['django'],
  express: ['express'],
  nestjs: ['nest', '@nestjs/core'],
};

/** canonical name → list of canonical names it implies */
export const FRAMEWORK_IMPLIES: Record<string, string[]> = {
  nextjs: ['react'],
};

/**
 * Resolve a framework_match argument to the set of dependency names that
 * would satisfy it, including transitively-implied frameworks.
 *
 * Example: `resolveAcceptedNames('react')` returns
 *   `['react', 'react-dom', 'next', 'next.js']`
 * because `nextjs` implies `react` and `nextjs`'s dependency aliases are
 * `next` and `next.js`.
 */
export function resolveAcceptedNames(framework: string): Set<string> {
  const accepted = new Set<string>();
  const canonical = canonicalize(framework);
  const queue: string[] = [canonical];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (visited.has(cur)) continue;
    visited.add(cur);
    // Direct aliases for the canonical name.
    const aliases = FRAMEWORK_ALIASES[cur] ?? [cur];
    for (const a of aliases) accepted.add(a.toLowerCase());
    // Walk reverse implications: if canonical X is implied BY some Y, then a
    // manifest that declares Y satisfies a request for X.
    for (const [parent, implied] of Object.entries(FRAMEWORK_IMPLIES)) {
      if (implied.includes(cur)) queue.push(parent);
    }
  }
  return accepted;
}

/**
 * Canonicalize a user-provided framework token.
 *
 * Looks up the exact name in `FRAMEWORK_ALIASES` (case-insensitive) and, if
 * the token matches one of the alias values, returns the canonical key.
 * Otherwise returns the token unchanged.
 */
export function canonicalize(name: string): string {
  const lc = name.toLowerCase();
  if (FRAMEWORK_ALIASES[lc]) return lc;
  for (const [canonical, aliases] of Object.entries(FRAMEWORK_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === lc)) return canonical;
  }
  return lc;
}
