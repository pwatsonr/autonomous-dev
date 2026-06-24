/**
 * Generated-artifact parser/serializer (ONBOARD Phase 2 — #590, P2.1).
 *
 * Round-trippable: `serializeArtifact` emits a valid scoped skill `.md`
 * (YAML frontmatter + markdown body) and `parseArtifact` reads it back. Uses
 * js-yaml (already a dependency) — no custom YAML. The parser validates
 * structure (presence + types + a valid scope/kind); the deeper safety policy
 * (tool allowlist, no-secrets, injection patterns, name charset) is the
 * constraints layer's job (P2.4), not the parser's.
 */

import * as yaml from 'js-yaml';

import type { ArtifactScope } from '../ownership/types';
import type { GeneratedArtifact, ArtifactKind, ArtifactParseResult } from './types';
import { ARTIFACT_KINDS } from './types';

/** Structural check that a value is a valid ArtifactScope (safe id charset for project/repo). */
export function isArtifactScope(s: unknown): s is ArtifactScope {
  if (s === 'global') return true;
  if (typeof s !== 'string') return false;
  const idx = s.indexOf(':');
  if (idx < 0) return false;
  const kind = s.slice(0, idx);
  const id = s.slice(idx + 1);
  // id must be a safe path segment (no `:`, traversal, etc.) — mirrors memory/store isSafeScope.
  return (kind === 'project' || kind === 'repo') && /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/i.test(id);
}

/** Serialize an artifact to a scoped skill `.md` (frontmatter + body). */
export function serializeArtifact(a: GeneratedArtifact): string {
  const frontmatter = {
    name: a.name,
    description: a.description,
    kind: a.kind,
    scope: a.scope,
    managed: a.managed,
    'allowed-tools': a.allowedTools,
  };
  // lineWidth -1 → never wrap (keeps descriptions on one line); quotingType for safety.
  const front = yaml.safeDump(frontmatter, { lineWidth: -1, noRefs: true }).trimEnd();
  return `---\n${front}\n---\n\n${a.body.trim()}\n`;
}

export interface Extracted {
  yaml: string;
  body: string;
}

/** Split `---\n…\n---\n` frontmatter from the body, or undefined if absent. */
export function extractFrontmatter(content: string): Extracted | undefined {
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1) return undefined;
  if (content.slice(0, firstNewline).replace(/\r$/, '') !== '---') return undefined;

  let pos = firstNewline + 1;
  while (pos < content.length) {
    const lineEnd = content.indexOf('\n', pos);
    const end = lineEnd === -1 ? content.length : lineEnd;
    if (content.slice(pos, end).replace(/\r$/, '') === '---') {
      const yamlStr = content.slice(firstNewline + 1, pos);
      const body = lineEnd === -1 ? '' : content.slice(lineEnd + 1);
      return { yaml: yamlStr, body };
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Parse a scoped skill `.md` back into a GeneratedArtifact (validates structure). */
export function parseArtifact(content: string): ArtifactParseResult {
  const extracted = extractFrontmatter(content);
  if (!extracted) {
    return { success: false, errors: [{ message: 'No YAML frontmatter found (need opening + closing ---).' }] };
  }

  let raw: Record<string, unknown>;
  try {
    const loaded = yaml.safeLoad(extracted.yaml);
    if (loaded === null || loaded === undefined || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return { success: false, errors: [{ message: 'Frontmatter is not a YAML mapping.' }] };
    }
    raw = loaded as Record<string, unknown>;
  } catch (err) {
    return { success: false, errors: [{ message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  const errors: { message: string; field?: string }[] = [];

  const name = asString(raw.name)?.trim();
  if (!name) errors.push({ message: 'Missing or non-string "name".', field: 'name' });

  const description = asString(raw.description)?.trim();
  if (!description) errors.push({ message: 'Missing or non-string "description".', field: 'description' });

  const kindRaw = raw.kind ?? 'skill'; // default skill
  if (!ARTIFACT_KINDS.has(kindRaw as ArtifactKind)) {
    errors.push({ message: `Invalid "kind": ${JSON.stringify(raw.kind)} (expected skill|command).`, field: 'kind' });
  }

  if (!isArtifactScope(raw.scope)) {
    errors.push({ message: `Invalid "scope": ${JSON.stringify(raw.scope)} (expected global|project:<id>|repo:<id>).`, field: 'scope' });
  }

  // managed: strict boolean (a present-but-non-bool must error, not default — mirrors the agent parser).
  if (typeof raw.managed !== 'boolean') {
    errors.push({ message: `Invalid "managed": ${JSON.stringify(raw.managed)} (expected true or false).`, field: 'managed' });
  }

  // allowed-tools: array of strings (default []).
  const toolsRaw = raw['allowed-tools'] ?? [];
  let allowedTools: string[] = [];
  if (Array.isArray(toolsRaw) && toolsRaw.every((t) => typeof t === 'string')) {
    allowedTools = toolsRaw as string[];
  } else {
    errors.push({ message: 'Invalid "allowed-tools" (expected a list of strings).', field: 'allowed-tools' });
  }

  if (errors.length > 0) return { success: false, errors };

  const artifact: GeneratedArtifact = {
    kind: kindRaw as ArtifactKind,
    name: name!,
    scope: raw.scope as ArtifactScope,
    description: description!,
    managed: raw.managed as boolean,
    allowedTools,
    body: extracted.body.trim(),
  };
  return { success: true, artifact, errors: [] };
}
