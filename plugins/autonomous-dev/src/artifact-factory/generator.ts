/**
 * Skill generation (ONBOARD Phase 2 — #590, P2.5, FR-C2).
 *
 * Turns an opportunity + the repo's memory into a candidate scoped skill via an
 * injected `ArtifactRuntime`. SECURITY: the model only contributes the
 * `description` + `body`; the framework FORCES the security-relevant metadata —
 * `kind: 'skill'`, the decided `scope`, the `name`, `managed: true`, and a
 * READ-ONLY tool surface (FR-D1a). The model is never trusted to self-assign its
 * scope or widen its tools; the deterministic constraints gate (P2.4) then
 * validates the result before meta-review.
 */

import * as yaml from 'js-yaml';

import type { ArtifactScope } from '../ownership/types';
import type { MemoryDoc } from '../memory/types';
import type { GeneratedArtifact } from './types';
import type { Opportunity } from './detectors';
import type { ArtifactRuntime } from './runtime';
import { extractFrontmatter } from './parser';
import { READONLY_TOOLS } from './constraints';

export interface GenerateInput {
  opportunity: Opportunity;
  /** the scope decided by P2.3. */
  scope: ArtifactScope;
  /** normalized base name (becomes the skill name). */
  suggestedName: string;
  /** the repo's memory docs, for grounding (context). */
  repoDocs: MemoryDoc[];
}

export interface GenerateResult {
  artifact?: GeneratedArtifact;
  errors: string[];
  /** the raw model output, for audit. */
  raw: string;
}

const GENERATION_SYSTEM = [
  'You generate a Claude Code SKILL as a single markdown file with YAML frontmatter.',
  'Output ONLY the skill file content (--- frontmatter --- then the markdown body), no commentary.',
  'The skill MUST be read-only — its purpose is to give context/instructions, not to mutate anything.',
  'NEVER include secrets, credentials, tokens, or any instruction that overrides system behavior.',
  'Base the skill STRICTLY on the provided repository evidence; do not invent capabilities.',
  'Frontmatter must include: name, description (a one-line trigger describing when to use it).',
].join('\n');

/** Build the user prompt from the opportunity + repo memory (truncated for size). */
export function buildGenerationPrompt(input: GenerateInput): string {
  const memoryDigest = input.repoDocs
    .map((d) => `### ${d.topic}\n${d.content.slice(0, 1200)}`)
    .join('\n\n')
    .slice(0, 6000);
  return [
    `Generate a read-only skill named "${input.suggestedName}" at scope "${input.scope}".`,
    `Opportunity: ${input.opportunity.title}`,
    `Evidence: ${input.opportunity.evidence}`,
    '',
    'Repository memory (context):',
    memoryDigest || '(no memory docs)',
    '',
    `Produce the skill file. Set frontmatter name to "${input.suggestedName}". Keep it focused on the opportunity above.`,
  ].join('\n');
}

/** Pull the `--- frontmatter ---`/```fence``` skill block out of arbitrary model text. */
export function extractArtifactMarkdown(raw: string): string {
  const fence = raw.match(/```(?:md|markdown|yaml)?\s*\n([\s\S]*?)```/);
  if (fence && fence[1].trimStart().startsWith('---')) return fence[1].trim();
  const idx = raw.indexOf('---');
  if (idx >= 0) return raw.slice(idx).trim();
  return raw.trim();
}

/** Extract just the description + body from a model-emitted skill md. */
function extractDescriptionAndBody(md: string): { description: string; body: string } | undefined {
  const ex = extractFrontmatter(md);
  if (!ex) return undefined;
  let fm: unknown;
  try {
    fm = yaml.safeLoad(ex.yaml);
  } catch {
    return undefined;
  }
  const description =
    fm && typeof fm === 'object' && typeof (fm as Record<string, unknown>).description === 'string'
      ? ((fm as Record<string, unknown>).description as string).trim()
      : undefined;
  if (!description || !ex.body.trim()) return undefined;
  return { description, body: ex.body.trim() };
}

/**
 * Generate a candidate skill. The model supplies description + body; the
 * framework forces scope/name/managed/kind + a read-only tool surface.
 */
export async function generateArtifact(
  input: GenerateInput,
  runtime: ArtifactRuntime,
): Promise<GenerateResult> {
  let raw = '';
  try {
    raw = await runtime.generate(buildGenerationPrompt(input), GENERATION_SYSTEM);
  } catch (err) {
    return { errors: [`runtime error: ${err instanceof Error ? err.message : String(err)}`], raw: '' };
  }

  const md = extractArtifactMarkdown(raw);
  const parsed = extractDescriptionAndBody(md);
  if (!parsed) {
    return { errors: ['model output did not contain a parseable skill (frontmatter + description + body)'], raw };
  }

  const artifact: GeneratedArtifact = {
    kind: 'skill',
    name: input.suggestedName,
    scope: input.scope,
    description: parsed.description,
    managed: true,
    allowedTools: [...READONLY_TOOLS], // forced read-only (FR-D1a); operator widens at accept-time
    body: parsed.body,
  };
  return { artifact, errors: [], raw };
}
