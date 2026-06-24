/**
 * Deterministic artifact safety gate (ONBOARD Phase 2 — #590, P2.4, FR-D1).
 *
 * A NEW single-artifact validator (NOT the agent diff-style `enforceConstraints`,
 * which diffs current↔proposed). Runs BEFORE meta-review and rejects on any
 * violation. No LLM. Checks: (a) no secrets in body, (b) tool allowlist
 * (read-only default), (c) schema completeness, (d) scope exists in ownership,
 * (e) name safety (no traversal), (f) prompt-injection patterns (R7 —
 * memory-borne injection is the likeliest attack: a hostile string in a crawled
 * README/CODEOWNERS → memory → generated body).
 */

import type { Ownership } from '../ownership/types';
import type { GeneratedArtifact } from './types';
import { isArtifactScope } from './parser';

export interface ArtifactConstraintViolation {
  rule: string;
  field: string;
  detail: string;
}

export interface ConstraintOptions {
  /** When present, scope ids are checked for existence. */
  ownership?: Ownership;
  /** Tools the operator explicitly authorized for THIS artifact (accept-time override). */
  toolOverride?: string[];
}

/** The default safe tool surface for a generated skill (FR-D1a). */
export const READONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const SECRET_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    rule: 'assigned_secret',
    re: /\b(api[_-]?key|secret|password|passwd|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9/+_.\-]{12,}/i,
  },
];

const INJECTION_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'ignore_instructions', re: /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i },
  { rule: 'disregard_above', re: /\bdisregard\s+(all\s+)?(the\s+)?(previous|prior|above)\b/i },
  { rule: 'role_injection', re: /<\/?(system|assistant|user)>/i },
  { rule: 'identity_override', re: /\byou are now\b/i },
  {
    rule: 'exfil_directive',
    re: /\b(reveal|print|exfiltrate|leak|send)\b[^.\n]{0,40}\b(secret|password|token|credential|env(?:ironment)?\s*var)/i,
  },
];

/** A tool entry may be "Bash(cmd:*)"; take the base before "(". */
function toolBase(t: string): string {
  return t.split('(')[0].trim();
}

/** Validate a generated artifact. Empty array = passes the deterministic gate. */
export function enforceArtifactConstraints(
  a: GeneratedArtifact,
  opts: ConstraintOptions = {},
): ArtifactConstraintViolation[] {
  const v: ArtifactConstraintViolation[] = [];

  // (c) schema completeness (the parser ensures types; here ensure non-empty semantics + kind)
  if (!a.name || !a.name.trim()) v.push({ rule: 'schema', field: 'name', detail: 'name is empty' });
  if (!a.description || !a.description.trim()) v.push({ rule: 'schema', field: 'description', detail: 'description is empty' });
  if (!a.body || !a.body.trim()) v.push({ rule: 'schema', field: 'body', detail: 'body is empty' });
  if (a.kind !== 'skill') {
    v.push({ rule: 'schema', field: 'kind', detail: `kind "${a.kind}" not implemented in Phase 2 (skills only)` });
  }

  // (e) name safety — kebab, no traversal
  if (a.name && (!NAME_RE.test(a.name) || a.name.includes('..'))) {
    v.push({ rule: 'name_safety', field: 'name', detail: `name "${a.name}" must be kebab [a-z0-9-] with no ".."` });
  }

  // (d) scope sanity + existence
  if (!isArtifactScope(a.scope)) {
    v.push({ rule: 'scope', field: 'scope', detail: `invalid scope "${a.scope}"` });
  } else if (opts.ownership && a.scope !== 'global') {
    const idx = a.scope.indexOf(':');
    const kind = a.scope.slice(0, idx);
    const id = a.scope.slice(idx + 1);
    const exists =
      kind === 'repo'
        ? opts.ownership.repos.some((r) => r.id === id)
        : opts.ownership.projects.some((p) => p.id === id);
    if (!exists) v.push({ rule: 'scope_exists', field: 'scope', detail: `${kind} "${id}" not found in ownership` });
  }

  // (b) tool allowlist — read-only default; operator override widens it explicitly
  const allowed = new Set<string>([...READONLY_TOOLS, ...(opts.toolOverride ?? []).map(toolBase)]);
  for (const t of a.allowedTools.map(toolBase)) {
    if (t && !allowed.has(t)) {
      v.push({ rule: 'tool_allowlist', field: 'allowed-tools', detail: `tool "${t}" not in the read-only allowlist (operator override required)` });
    }
  }

  // (a) no secrets in body
  for (const { rule, re } of SECRET_PATTERNS) {
    if (re.test(a.body)) v.push({ rule: `secret:${rule}`, field: 'body', detail: `possible secret in body (${rule})` });
  }

  // (f) prompt-injection patterns in body (R7)
  for (const { rule, re } of INJECTION_PATTERNS) {
    if (re.test(a.body)) v.push({ rule: `injection:${rule}`, field: 'body', detail: `prompt-injection pattern in body (${rule})` });
  }

  return v;
}
