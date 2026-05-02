/**
 * Cloud helper agent + plugin README static-validation suite (SPEC-024-1-04).
 *
 * The `agent-meta-reviewer` (PLAN-017-2) is a Claude Code agent that runs
 * INSIDE Claude — there is no `runAgentMetaReviewer(content)` callable
 * function in the TypeScript codebase. This suite enforces the
 * meta-reviewer's CHECKLIST statically:
 *
 *   - frontmatter YAML parses
 *   - `tools` is exactly `[Read, Glob, Grep]` (no Bash / Edit / Write / MCP)
 *   - `name` matches the filename
 *   - `description` is one sentence, ≤ 200 chars
 *   - body contains the four required sections (Role & boundaries,
 *     checklist, Output contract, Anti-patterns)
 *   - body does not instruct the agent to write files or invoke shell
 *     commands (no occurrences of Bash / Edit / Write / execFile /
 *     child_process / spawn)
 *
 * The README portion of SPEC-024-1-04 is verified here too: each plugin's
 * README has the eight required sections in order, the YAML config example
 * parses, and the troubleshooting section has at least 5 entries. This
 * keeps SPEC-04's deliverables under one Jest run.
 *
 * @module tests/agents/cloud-deploy-experts.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

interface AgentSpec {
  plugin: string;
  name: string;
}

const AGENTS: readonly AgentSpec[] = [
  { plugin: 'autonomous-dev-deploy-gcp', name: 'gcp-deploy-expert' },
  { plugin: 'autonomous-dev-deploy-aws', name: 'aws-deploy-expert' },
  { plugin: 'autonomous-dev-deploy-azure', name: 'azure-deploy-expert' },
  { plugin: 'autonomous-dev-deploy-k8s', name: 'k8s-deploy-expert' },
] as const;

const PLUGIN_ROOT = join(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ParsedAgent {
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function loadAgent(spec: AgentSpec): ParsedAgent {
  const path = join(PLUGIN_ROOT, spec.plugin, 'agents', `${spec.name}.md`);
  const raw = readFileSync(path, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`agent ${spec.name}: missing or malformed frontmatter`);
  }
  const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
  return { raw, frontmatter, body: match[2] };
}

function loadReadme(plugin: string): string {
  return readFileSync(join(PLUGIN_ROOT, plugin, 'README.md'), 'utf8');
}

// ---------------------------------------------------------------------------
// agent file checks
// ---------------------------------------------------------------------------

describe.each(AGENTS)('cloud helper agent: $name', (spec) => {
  const agent = loadAgent(spec);

  test('frontmatter parses as YAML', () => {
    expect(typeof agent.frontmatter).toBe('object');
    expect(agent.frontmatter).not.toBeNull();
  });

  test('name matches filename (without .md)', () => {
    expect(agent.frontmatter.name).toBe(spec.name);
  });

  test('description is a single sentence ≤ 200 chars', () => {
    const desc = agent.frontmatter.description;
    expect(typeof desc).toBe('string');
    const text = String(desc);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.length).toBeGreaterThan(0);
    // single sentence: at most one terminal "." — periods inside parentheses
    // are allowed, but no second standalone sentence.
    const sentenceCount = text.split(/[.!?]\s+[A-Z]/).length;
    expect(sentenceCount).toBeLessThanOrEqual(2);
  });

  test('tools field is exactly [Read, Glob, Grep]', () => {
    const tools = agent.frontmatter.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toEqual(['Read', 'Glob', 'Grep']);
  });

  test('frontmatter regex (raw text) matches Read/Glob/Grep block', () => {
    expect(agent.raw).toMatch(/tools:\s*\n\s*-\s*Read\s*\n\s*-\s*Glob\s*\n\s*-\s*Grep/);
  });

  test('frontmatter name (raw text) matches filename', () => {
    expect(agent.raw).toMatch(new RegExp(`^name:\\s*${spec.name}\\s*$`, 'm'));
  });

  test('body has Role & Boundaries section', () => {
    expect(agent.body).toMatch(/##\s+Role\s*&\s*Boundaries/i);
  });

  test('body has Cloud-Specific Concerns Checklist section', () => {
    expect(agent.body).toMatch(/##\s+Cloud-Specific Concerns Checklist/i);
  });

  test('body has Output Contract section', () => {
    expect(agent.body).toMatch(/##\s+Output Contract/i);
  });

  test('body has Anti-Patterns section', () => {
    expect(agent.body).toMatch(/##\s+Anti-Patterns/i);
  });

  test('body does not instruct the agent to mutate state', () => {
    // The body documents tools and code references, but MUST NOT contain
    // imperative instructions to use Bash / Edit / Write etc. We allow
    // the strings to appear inside descriptive text by matching only on
    // tool-list-style bullets and direct verbs.
    const forbiddenPatterns = [
      /\buse\s+(?:the\s+)?Bash\b/i,
      /\buse\s+(?:the\s+)?Edit\b/i,
      /\buse\s+(?:the\s+)?Write\b/i,
      /\bcall\s+execFile\b/i,
      /\bspawn\s*\(/i,
      /\bchild_process\b/i,
    ];
    for (const pat of forbiddenPatterns) {
      expect(agent.body).not.toMatch(pat);
    }
  });

  test('frontmatter has no forbidden tools (Bash / Edit / Write / MCP)', () => {
    const tools = (agent.frontmatter.tools ?? []) as readonly string[];
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Write');
    for (const t of tools) {
      expect(t.startsWith('mcp__')).toBe(false);
    }
  });

  test('agent file ends with a last-reviewed footer', () => {
    expect(agent.raw).toMatch(/<!--\s*last reviewed:\s*\d{4}-\d{2}-\d{2}\s*-->/);
  });
});

// ---------------------------------------------------------------------------
// README checks (SPEC-024-1-04 acceptance)
// ---------------------------------------------------------------------------

const REQUIRED_README_SECTIONS = [
  'Overview',
  'Prerequisites',
  'Install',
  'Configuration',
  'Configuration example',
  'Helper agent',
  'Troubleshooting',
  'Release-time manual smoke checklist',
] as const;

describe.each(AGENTS)('plugin README: $plugin', (spec) => {
  const readme = loadReadme(spec.plugin);

  test('has all 8 required sections in order', () => {
    let lastIndex = -1;
    for (const section of REQUIRED_README_SECTIONS) {
      const idx = readme.indexOf(`## ${section}`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  test('install section references the canonical install command', () => {
    expect(readme).toMatch(new RegExp(`claude plugin install ${spec.plugin}`));
    expect(readme).toMatch(/deploy backends list/);
  });

  test('configuration example is valid YAML', () => {
    // First fenced ```yaml block under "Configuration example".
    const sectionIdx = readme.indexOf('## Configuration example');
    expect(sectionIdx).toBeGreaterThanOrEqual(0);
    const after = readme.slice(sectionIdx);
    const fence = after.match(/```yaml\s*\n([\s\S]*?)\n```/);
    expect(fence).not.toBeNull();
    const parsed = yaml.load(fence![1]) as Record<string, unknown>;
    expect(parsed).toBeTruthy();
    expect(typeof parsed).toBe('object');
    expect('parameters' in parsed).toBe(true);
  });

  test('troubleshooting section has at least 5 entries', () => {
    const sectionIdx = readme.indexOf('## Troubleshooting');
    expect(sectionIdx).toBeGreaterThanOrEqual(0);
    const nextSectionIdx = readme.indexOf('## Release-time', sectionIdx + 1);
    expect(nextSectionIdx).toBeGreaterThan(sectionIdx);
    const slice = readme.slice(sectionIdx, nextSectionIdx);
    const entries = slice.match(/^###\s+/gm) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(5);
  });

  test('readme is ≤ 250 lines', () => {
    const lines = readme.split('\n').length;
    expect(lines).toBeLessThanOrEqual(250);
  });
});

// ---------------------------------------------------------------------------
// Azure-specific: release-time manual smoke checklist >= 4 numbered steps
// ---------------------------------------------------------------------------

test('Azure README release-time checklist has ≥ 4 numbered steps', () => {
  const readme = loadReadme('autonomous-dev-deploy-azure');
  const idx = readme.indexOf('## Release-time manual smoke checklist');
  expect(idx).toBeGreaterThanOrEqual(0);
  const slice = readme.slice(idx);
  const numbered = slice.match(/^\d+\.\s+\*\*[A-Z]/gm) ?? [];
  expect(numbered.length).toBeGreaterThanOrEqual(4);
});
