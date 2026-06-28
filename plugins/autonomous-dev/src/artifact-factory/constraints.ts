/**
 * Deterministic artifact safety gate (ONBOARD Phase 2 — #590, P2.4, FR-D1).
 *
 * A NEW single-artifact validator (NOT the agent diff-style `enforceConstraints`).
 * Runs BEFORE meta-review and rejects on any violation. No LLM. Checks both the
 * `description` AND `body` (the description goes into frontmatter + is the
 * load-trigger, so it is an injection/secret channel too): (a) no secrets,
 * (b) read-only tool allowlist, (c) schema completeness incl. body must not start
 * with a `---` delimiter, (d) scope is safe + exists in ownership, (e) name
 * safety, (f) prompt-injection patterns (R7) over Unicode-normalized text.
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
  ownership?: Ownership;
  toolOverride?: string[];
}

/** The default safe tool surface for a generated skill (FR-D1a). */
export const READONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCOPE_ID_RE = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/i;

/**
 * Windows reserved device names — invalid as a file stem on NTFS even though they
 * pass NAME_RE. The artifact name becomes `<name>.md` on disk, so `con` → `con.md`
 * would still resolve to the CON device on Windows. POSIX-safe today, but rejecting
 * here keeps the scoped store portable. (Issue #591 — filename safety.)
 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Cyrillic/Greek lookalikes that NFKC does NOT fold — fold them to their Latin
 * equivalent so a homoglyph-spoofed injection/secret can't slip past the patterns.
 * (Issue #591 — injection homoglyph coverage.)
 */
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic lowercase
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l', 'ԝ': 'w', 'ԛ': 'q',
  // Cyrillic uppercase
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
  'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  // Greek lowercase
  'ο': 'o', 'α': 'a', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ε': 'e',
  // Greek uppercase
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
  'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

/** A scope id safe to use as a filesystem path segment (mirrors memory/store isSafeScope). */
export function isSafeScopeId(id: string): boolean {
  return SCOPE_ID_RE.test(id) && !id.includes('..') && !id.includes('//');
}

/** Strip zero-width/soft-hyphen, fold Cyrillic/Greek homoglyphs, then NFKC so evasions don't slip past the patterns. */
function normalizeForScan(s: string): string {
  const stripped = s.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
  const folded = stripped.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch] ?? ch);
  return folded.normalize('NFKC');
}

const SECRET_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { rule: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { rule: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { rule: 'sk_token', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ }, // OpenAI / Anthropic
  { rule: 'stripe_key', re: /\b[srp]k_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { rule: 'twilio_sid', re: /\bAC[0-9a-fA-F]{32}\b/ }, // Twilio Account SID
  { rule: 'gcp_service_account', re: /"type"\s*:\s*"service_account"/ }, // GCP service-account JSON
  // DSN / connection URI carrying inline `user:password@host` credentials.
  { rule: 'dsn_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]/i },
];

const INJECTION_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'ignore_instructions', re: /\bignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|context|prompts?|rules?)\b/i },
  { rule: 'disregard_override', re: /\b(disregard|forget|discard|override|replace)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier|preceding|your)\b/i },
  { rule: 'new_instructions', re: /\b(new|updated|revised|real)\s+instructions?\s*[:.]/i },
  // "from now on" only flags when followed by an imperative (avoids benign "from now on we use X").
  { rule: 'from_now_on', re: /\bfrom\s+now\s+on\b[,:]?\s+(you|ignore|disregard|always|never|do\s+not|respond|reply|act|treat|forget|output|print)\b/i },
  { rule: 'identity_override', re: /\b(you\s+are\s+now|you\s+must\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as)\b/i },
  { rule: 'role_marker', re: /<\/?(system|assistant|user)>|<\|im_(start|end)\|>|(?:^|\n)\s*(System|Assistant|Human)\s*:/i },
  {
    rule: 'exfil_directive',
    re: /\b(reveal|exfiltrate|leak|disclose|dump|send|output|echo)\b[\s\S]{0,60}?\b(secret|password|passwd|token|credential|api[_\s-]?key|bearer|cookie|private\s*key|\.env|env(?:ironment)?\s*(?:var|vars|variable)|auth\s*header)/i,
  },
];

/** Detect an assigned secret value, skipping obvious placeholders/env refs (reduces false positives). */
function hasAssignedSecret(text: string): boolean {
  const re = /\b(api[_-]?key|secret|password|passwd|access[_-]?token|client[_-]?secret|bearer)\b\s*[:=]\s*['"]?([A-Za-z0-9/+_.\-]{12,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const val = m[2];
    if (/^[A-Z0-9_]+$/.test(val)) continue; // ALL-CAPS placeholder (YOUR_API_KEY_HERE)
    if (/^process\.env\./i.test(val)) continue; // env reference
    if (/^(your|my|the|some|example|changeme|placeholder|redacted|xxx+|todo|none|null)/i.test(val)) continue;
    return true;
  }
  return false;
}

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

  // (c) schema completeness
  if (!a.name || !a.name.trim()) v.push({ rule: 'schema', field: 'name', detail: 'name is empty' });
  if (!a.description || !a.description.trim()) v.push({ rule: 'schema', field: 'description', detail: 'description is empty' });
  if (!a.body || !a.body.trim()) v.push({ rule: 'schema', field: 'body', detail: 'body is empty' });
  if (a.kind !== 'skill') v.push({ rule: 'schema', field: 'kind', detail: `kind "${a.kind}" not implemented in Phase 2 (skills only)` });
  // body must not start with a `---` delimiter line (would corrupt the frontmatter round-trip).
  const firstBodyLine = (a.body ?? '').split('\n').find((l) => l.trim() !== '');
  if (firstBodyLine && firstBodyLine.trim() === '---') {
    v.push({ rule: 'schema', field: 'body', detail: 'body must not start with a "---" delimiter line' });
  }

  // (e) name safety — kebab, no traversal, no Windows reserved device name
  if (a.name && (!NAME_RE.test(a.name) || a.name.includes('..'))) {
    v.push({ rule: 'name_safety', field: 'name', detail: `name "${a.name}" must be kebab [a-z0-9-] with no ".."` });
  } else if (a.name && WINDOWS_RESERVED_NAMES.has(a.name)) {
    v.push({ rule: 'name_safety', field: 'name', detail: `name "${a.name}" is a reserved device name (invalid as a file stem on Windows)` });
  }

  // (d) scope sanity (safe id) + existence
  if (!isArtifactScope(a.scope)) {
    v.push({ rule: 'scope', field: 'scope', detail: `invalid scope "${a.scope}"` });
  } else if (a.scope !== 'global') {
    const idx = a.scope.indexOf(':');
    const kind = a.scope.slice(0, idx);
    const id = a.scope.slice(idx + 1);
    if (!isSafeScopeId(id)) {
      v.push({ rule: 'scope_unsafe', field: 'scope', detail: `unsafe scope id "${id}" (traversal/charset)` });
    } else if (opts.ownership) {
      const exists =
        kind === 'repo'
          ? opts.ownership.repos.some((r) => r.id === id)
          : opts.ownership.projects.some((p) => p.id === id);
      if (!exists) v.push({ rule: 'scope_exists', field: 'scope', detail: `${kind} "${id}" not found in ownership` });
    }
  }

  // (b) tool allowlist — read-only default; operator override widens it explicitly
  const allowed = new Set<string>([...READONLY_TOOLS, ...(opts.toolOverride ?? []).map(toolBase)]);
  for (const t of a.allowedTools.map(toolBase)) {
    if (t && !allowed.has(t)) {
      v.push({ rule: 'tool_allowlist', field: 'allowed-tools', detail: `tool "${t}" not in the read-only allowlist (operator override required)` });
    }
  }

  // (a)+(f) scan BOTH description and body (normalized) for secrets + injection
  const scanText = `${normalizeForScan(a.description ?? '')}\n${normalizeForScan(a.body ?? '')}`;
  for (const { rule, re } of SECRET_PATTERNS) {
    if (re.test(scanText)) v.push({ rule: `secret:${rule}`, field: 'description+body', detail: `possible secret (${rule})` });
  }
  if (hasAssignedSecret(scanText)) {
    v.push({ rule: 'secret:assigned_secret', field: 'description+body', detail: 'possible assigned secret value' });
  }
  for (const { rule, re } of INJECTION_PATTERNS) {
    if (re.test(scanText)) v.push({ rule: `injection:${rule}`, field: 'description+body', detail: `prompt-injection pattern (${rule})` });
  }

  return v;
}
