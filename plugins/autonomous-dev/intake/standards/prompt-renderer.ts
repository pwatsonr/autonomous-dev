/**
 * Standards prompt renderer (SPEC-021-3-01).
 *
 * Takes a `ResolvedStandards` map (from PLAN-021-1's `InheritanceResolver`)
 * and produces the markdown section that will be substituted into the
 * `{{STANDARDS_SECTION}}` placeholder of author-agent system prompts at
 * session-spawn time.
 *
 * Behavior:
 *   - Empty resolved set → returns the literal sentinel `"No standards apply."`
 *     with no template wrapping. Callers can compare on equality.
 *   - Non-empty set → loads the canonical wrapping template, renders one
 *     block per rule (sorted blocking → warn → advisory; ascending id within
 *     each severity), and substitutes into `{{rules}}`.
 *   - Enforces a 2KB byte cap (configurable) by dropping ADVISORY rules from
 *     the alpha-descending tail when over budget. Blocking and warn rules
 *     are never dropped; if they alone exceed the cap, the renderer returns
 *     them anyway with a TODO for future operator monitoring.
 *
 * Per-rule "Do this" derivation (TDD-021 §11) is keyed off the assertion's
 * non-empty fields. Unknown shapes fall through to the safe default
 * "see standards.yaml rule <id> for the full requirement."
 *
 * @module intake/standards/prompt-renderer
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Rule } from './types';
import type { ResolvedStandards } from './resolver';

/** Hard-byte cap default for the rendered section (TDD-021 §11 mitigation). */
export const DEFAULT_MAX_BYTES = 2048;

/** Sentinel emitted when no rules apply. Compared on equality by callers. */
export const EMPTY_SENTINEL = 'No standards apply.';

/**
 * Render options.
 */
export interface RenderOptions {
  /** Hard byte cap before summary fallback. Default: 2048. */
  maxBytes?: number;
}

const SEVERITY_ORDER: Record<Rule['severity'], number> = {
  blocking: 0,
  warn: 1,
  advisory: 2,
};

/**
 * Resolve the path to the canonical template, relative to this file's
 * compiled location. The template lives at `<plugin-root>/templates/`.
 *
 * Compiled JS sits at `<plugin>/intake/standards/prompt-renderer.js`, so
 * the template is two directories up. The TS source resolves identically
 * because ts-jest preserves directory structure.
 */
function resolveTemplatePath(): string {
  return path.join(__dirname, '..', '..', 'templates', 'standards-prompt-section.md');
}

/**
 * Build the per-rule "Do this:" instruction.
 *
 * Derivation table per SPEC-021-3-01:
 *   - exposes_endpoint     → "ensure the application exposes the <path> endpoint with method <method>."
 *   - framework_match      → "use the <framework> framework for this work."
 *   - uses_pattern         → "use the pattern matching <pattern> in qualifying code."
 *   - excludes_pattern     → "do not introduce code matching <pattern>."
 *   - dependency_present   → "ensure dependency <name> is declared."
 *   - custom_evaluator_args / unknown → "see standards.yaml rule <id> for the full requirement."
 */
export function deriveDoThis(rule: Rule): string {
  const a = rule.requires;
  if (a.exposes_endpoint) {
    return `Do this: ensure the application exposes the ${a.exposes_endpoint.path_pattern} endpoint with method ${a.exposes_endpoint.method}.`;
  }
  if (a.framework_match) {
    return `Do this: use the ${a.framework_match} framework for this work.`;
  }
  if (a.uses_pattern) {
    return `Do this: use the pattern matching ${a.uses_pattern} in qualifying code.`;
  }
  if (a.excludes_pattern) {
    return `Do this: do not introduce code matching ${a.excludes_pattern}.`;
  }
  if (a.dependency_present) {
    return `Do this: ensure dependency ${a.dependency_present} is declared.`;
  }
  // custom_evaluator_args, or any unknown / future kind:
  return `Do this: see standards.yaml rule ${rule.id} for the full requirement.`;
}

/** Format a single rule as a Markdown block. */
function renderRuleBlock(rule: Rule): string {
  return `### [${rule.severity}] ${rule.id}\n${rule.description}\n**${deriveDoThis(rule)}**`;
}

/** Sort comparator: severity asc (blocking < warn < advisory), then id asc. */
function compareRules(a: Rule, b: Rule): number {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compose the rendered section by joining per-severity rule blocks with
 * a single blank line, optionally appending the "N additional advisory
 * rules apply" summary line when the cap forces dropping advisory rules.
 */
function composeBody(blocking: Rule[], warn: Rule[], advisory: Rule[], droppedAdvisory: number): string {
  const blocks: string[] = [];
  for (const r of blocking) blocks.push(renderRuleBlock(r));
  for (const r of warn) blocks.push(renderRuleBlock(r));
  for (const r of advisory) blocks.push(renderRuleBlock(r));
  if (droppedAdvisory > 0) {
    blocks.push(`_${droppedAdvisory} additional advisory rules apply; see standards.yaml for full list._`);
  }
  return blocks.join('\n\n');
}

/**
 * Substitute `{{rules}}` in the template with the rendered body.
 */
function fillTemplate(template: string, body: string): string {
  return template.replace('{{rules}}', body);
}

/**
 * Compute UTF-8 byte length (multi-byte safe; do NOT use `.length`).
 */
function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Render a `ResolvedStandards` map into the standards prompt section markdown.
 *
 * - Empty resolver → `"No standards apply."` (no wrapping).
 * - Sorted blocking → warn → advisory; ascending id within severity.
 * - Enforces `maxBytes` (default 2048): when over budget, advisory rules
 *   are dropped from the alpha-descending tail and replaced by a summary
 *   line. Blocking/warn rules are NEVER dropped.
 * - If blocking+warn alone exceed the cap, the renderer returns them as-is.
 *   TODO: emit a monitoring metric here once the daemon's metrics surface
 *   lands; for now this signals operator misconfiguration silently.
 */
export function renderStandardsSection(
  resolved: ResolvedStandards,
  opts?: RenderOptions,
): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const allRules = Array.from(resolved.rules.values());
  if (allRules.length === 0) {
    return EMPTY_SENTINEL;
  }

  // Sort once.
  allRules.sort(compareRules);

  // Partition by severity. Rules within each partition retain the sort order.
  const blocking: Rule[] = [];
  const warn: Rule[] = [];
  const advisory: Rule[] = [];
  for (const r of allRules) {
    if (r.severity === 'blocking') blocking.push(r);
    else if (r.severity === 'warn') warn.push(r);
    else advisory.push(r);
  }

  const template = fs.readFileSync(resolveTemplatePath(), 'utf8');

  // Try the full rendering first.
  let dropped = 0;
  let keptAdvisory = advisory.slice();
  let body = composeBody(blocking, warn, keptAdvisory, dropped);
  let rendered = fillTemplate(template, body);

  if (utf8Bytes(rendered) <= maxBytes) {
    return rendered;
  }

  // Over budget. Drop advisory rules from the alpha-descending tail
  // (i.e., remove the last entries of `keptAdvisory`, since the array
  // is already sorted ascending by id).
  while (utf8Bytes(rendered) > maxBytes && keptAdvisory.length > 0) {
    keptAdvisory.pop();
    dropped += 1;
    body = composeBody(blocking, warn, keptAdvisory, dropped);
    rendered = fillTemplate(template, body);
  }

  // If still over the cap, blocking+warn alone exceed it. Return as-is.
  // TODO: emit operator-misconfiguration metric (see spec note §195).
  return rendered;
}
