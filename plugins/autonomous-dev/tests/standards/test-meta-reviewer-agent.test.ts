/**
 * Static-validation tests for `agents/standards-meta-reviewer.md`
 * (SPEC-021-3-04, Task 11).
 *
 * No agent execution: this suite parses the markdown frontmatter and
 * inspects the prompt body for required structural elements. It guards
 * against regressions in the agent file's contract:
 *   - frontmatter schema (name, model, read-only tools)
 *   - four detection-category sections
 *   - two-person-approval directive with the three trigger conditions
 *   - false-positive guard
 *   - impact-scan cap
 *   - reference to the reviewer-finding output schema
 *
 * @module tests/standards/test-meta-reviewer-agent.test
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const AGENT_FILE = path.join(
  __dirname,
  '..',
  '..',
  'agents',
  'standards-meta-reviewer.md',
);

interface ParsedAgent {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseAgentFile(file: string): ParsedAgent {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!m) {
    throw new Error(`agent file ${file} does not contain a frontmatter block`);
  }
  const fm = yaml.safeLoad(m[1]) as Record<string, unknown>;
  return { frontmatter: fm, body: m[2] };
}

describe('standards-meta-reviewer.md (static validation)', () => {
  let parsed: ParsedAgent;

  beforeAll(() => {
    parsed = parseAgentFile(AGENT_FILE);
  });

  it('frontmatter parses as YAML without error', () => {
    expect(parsed.frontmatter).toBeTruthy();
    expect(typeof parsed.frontmatter).toBe('object');
  });

  it('frontmatter.name is "standards-meta-reviewer"', () => {
    expect(parsed.frontmatter.name).toBe('standards-meta-reviewer');
  });

  it('frontmatter.model is set (sonnet family)', () => {
    expect(typeof parsed.frontmatter.model).toBe('string');
    expect(String(parsed.frontmatter.model)).toMatch(/sonnet/i);
  });

  it('frontmatter.tools is exactly the read-only set [Read, Glob, Grep]', () => {
    const tools = parsed.frontmatter.tools as string[];
    expect(Array.isArray(tools)).toBe(true);
    const sorted = [...tools].sort();
    expect(sorted).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('frontmatter.tools does NOT declare any mutating tools', () => {
    const tools = (parsed.frontmatter.tools as string[]) ?? [];
    const forbidden = ['Write', 'Edit', 'Bash', 'MultiEdit', 'NotebookEdit'];
    for (const t of forbidden) {
      expect(tools).not.toContain(t);
    }
  });

  it('prompt body contains the four detection-category sections', () => {
    const lower = parsed.body.toLowerCase();
    expect(lower).toContain('detect rule conflicts');
    expect(lower).toContain('detect unworkability');
    expect(lower).toContain('detect impact');
    expect(lower).toContain('detect overly broad predicates');
  });

  it('prompt body contains the two-person-approval directive and three trigger conditions', () => {
    expect(parsed.body).toContain('requires_two_person_approval');
    // Three trigger conditions: add immutable, remove immutable, framework_match
    expect(parsed.body).toMatch(/immutable: true/);
    expect(parsed.body.toLowerCase()).toContain('framework_match');
    expect(parsed.body).toMatch(/ADD/);
    expect(parsed.body).toMatch(/REMOVE/);
  });

  it('prompt body contains the false-positive guard', () => {
    const lower = parsed.body.toLowerCase();
    expect(lower).toContain('single change');
    expect(lower).toContain('not a delete-then-add');
  });

  it('prompt body contains the impact-scan cap (50 commits)', () => {
    expect(parsed.body).toMatch(/50 commits|--max-count=50/);
  });

  it('prompt body references the reviewer-finding output schema', () => {
    expect(parsed.body).toContain('reviewer-finding-v1.json');
  });
});
