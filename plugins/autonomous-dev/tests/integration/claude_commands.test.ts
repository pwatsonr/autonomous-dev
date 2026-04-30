/**
 * Integration tests for Claude App slash command discovery (SPEC-011-2-03,
 * Task 8).
 *
 * Asserts that the 10 `commands/autonomous-dev-*.md` files exist, parse as
 * valid YAML frontmatter + Markdown body, and conform to the contract laid
 * down in:
 *   - `commands/_shared/command_template.yaml`  (frontmatter shape)
 *   - `commands/_shared/arg_schemas.yaml`       (per-command arguments)
 *   - SPEC-011-2-01                              (bridge proxy contract)
 *
 * The tests do not invoke the bridge end-to-end -- the slow rebuild cycle
 * called for in the spec is exercised by manual verification
 * (`docs/manual_verification/PLAN-011-2.md`).  Instead, the body of each
 * command's bash block is parsed and statically checked for a call to
 * `bridge_proxy_invoke` with the matching subcommand.
 *
 * @module claude_commands.test
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const SHARED_DIR = path.join(COMMANDS_DIR, '_shared');

/** Subcommands that must each have an `autonomous-dev-<name>.md` file. */
const EXPECTED_SUBCOMMANDS = [
  'submit',
  'status',
  'list',
  'cancel',
  'pause',
  'resume',
  'priority',
  'logs',
  'feedback',
  'kill',
] as const;

type Subcommand = (typeof EXPECTED_SUBCOMMANDS)[number];

const NAME_PATTERN =
  /^autonomous-dev-(submit|status|list|cancel|pause|resume|priority|logs|feedback|kill)$/;

// ---------------------------------------------------------------------------
// Frontmatter / body parsing
// ---------------------------------------------------------------------------

interface FrontmatterArgument {
  name: string;
  type: 'string' | 'enum' | 'integer';
  required: boolean;
  description?: string;
  enum?: string[];
  default?: string | number;
}

interface CommandFrontmatter {
  name: string;
  description: string;
  arguments: FrontmatterArgument[];
  allowed_tools: string[];
}

interface ParsedCommand {
  frontmatter: CommandFrontmatter;
  body: string;
}

/**
 * Split a Markdown file with YAML frontmatter into its two parts.  Throws
 * when the leading `---` delimiters are missing so test failures point at
 * the offending file directly.
 */
function parseCommandFile(filePath: string): ParsedCommand {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Frontmatter delimiters: a leading `---` line and a trailing `---` line.
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `${filePath}: missing YAML frontmatter (expected --- ... --- at top)`,
    );
  }
  const frontmatter = yaml.load(match[1]) as CommandFrontmatter;
  const body = match[2];
  return { frontmatter, body };
}

/** Load `_shared/arg_schemas.yaml` as a plain map. */
function loadArgSchemas(): Record<Subcommand, FrontmatterArgument[]> {
  const raw = fs.readFileSync(
    path.join(SHARED_DIR, 'arg_schemas.yaml'),
    'utf8',
  );
  return yaml.load(raw) as Record<Subcommand, FrontmatterArgument[]>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Claude App slash command discovery (SPEC-011-2-03)', () => {
  // -----------------------------------------------------------------------
  // Plugin layout sanity checks
  // -----------------------------------------------------------------------

  test('commands directory exists', () => {
    expect(fs.existsSync(COMMANDS_DIR)).toBe(true);
    expect(fs.statSync(COMMANDS_DIR).isDirectory()).toBe(true);
  });

  test('_shared/ directory contains the bridge proxy and reference YAML', () => {
    expect(fs.existsSync(path.join(SHARED_DIR, 'bridge_proxy.sh'))).toBe(true);
    expect(fs.existsSync(path.join(SHARED_DIR, 'command_template.yaml'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(SHARED_DIR, 'arg_schemas.yaml'))).toBe(true);
  });

  test('bridge_proxy.sh is readable and exports bridge_proxy_invoke', () => {
    const proxyPath = path.join(SHARED_DIR, 'bridge_proxy.sh');
    const content = fs.readFileSync(proxyPath, 'utf8');
    expect(content).toMatch(/bridge_proxy_invoke\(\)/);
    expect(content).toMatch(/CLAUDE_COMMAND_SOURCE/);
    expect(content).toMatch(/CLAUDE_SESSION_ID/);
  });

  test('exactly 10 autonomous-dev-*.md files exist', () => {
    const entries = fs
      .readdirSync(COMMANDS_DIR)
      .filter((f) => /^autonomous-dev-.+\.md$/.test(f))
      .sort();
    expect(entries).toHaveLength(EXPECTED_SUBCOMMANDS.length);
    const nameStems = entries.map((f) => f.replace(/^autonomous-dev-|\.md$/g, ''));
    for (const sub of EXPECTED_SUBCOMMANDS) {
      expect(nameStems).toContain(sub);
    }
  });

  // -----------------------------------------------------------------------
  // Per-command frontmatter validation
  // -----------------------------------------------------------------------

  describe.each(EXPECTED_SUBCOMMANDS)('autonomous-dev-%s.md', (sub) => {
    const filePath = path.join(COMMANDS_DIR, `autonomous-dev-${sub}.md`);

    test('exists on disk', () => {
      expect(fs.existsSync(filePath)).toBe(true);
    });

    test('parses as YAML frontmatter + Markdown body', () => {
      const parsed = parseCommandFile(filePath);
      expect(parsed.frontmatter).toBeDefined();
      expect(parsed.body.length).toBeGreaterThan(0);
    });

    test('frontmatter.name matches autonomous-dev-<sub>', () => {
      const { frontmatter } = parseCommandFile(filePath);
      expect(frontmatter.name).toBe(`autonomous-dev-${sub}`);
      expect(frontmatter.name).toMatch(NAME_PATTERN);
    });

    test('frontmatter.description is non-empty and short', () => {
      const { frontmatter } = parseCommandFile(filePath);
      expect(typeof frontmatter.description).toBe('string');
      expect(frontmatter.description.length).toBeGreaterThan(0);
      // Spec template: <= 120 chars.
      expect(frontmatter.description.length).toBeLessThanOrEqual(120);
    });

    test('frontmatter.allowed_tools contains Bash(bash:*)', () => {
      const { frontmatter } = parseCommandFile(filePath);
      expect(Array.isArray(frontmatter.allowed_tools)).toBe(true);
      expect(frontmatter.allowed_tools).toContain('Bash(bash:*)');
    });

    test('frontmatter.arguments matches arg_schemas.yaml', () => {
      const { frontmatter } = parseCommandFile(filePath);
      const schemas = loadArgSchemas();
      const expected = schemas[sub];
      expect(expected).toBeDefined();
      expect(frontmatter.arguments).toBeDefined();
      // All commands in this plan have at least one argument.
      expect(frontmatter.arguments.length).toBeGreaterThan(0);
      expect(frontmatter.arguments.length).toBe(expected.length);

      for (let i = 0; i < expected.length; i++) {
        const a = frontmatter.arguments[i];
        const e = expected[i];
        expect(a.name).toBe(e.name);
        expect(a.type).toBe(e.type);
        expect(Boolean(a.required)).toBe(Boolean(e.required));
        if (e.enum !== undefined) {
          expect(a.enum).toEqual(e.enum);
        }
        if (e.default !== undefined) {
          expect(a.default).toEqual(e.default);
        }
      }
    });

    test('body invokes bridge_proxy_invoke with the matching subcommand', () => {
      const { body } = parseCommandFile(filePath);
      // Each command's body is a single ```bash block sourcing
      // _shared/bridge_proxy.sh and calling bridge_proxy_invoke "<sub>" "$@".
      expect(body).toMatch(/```bash\s*\n[\s\S]*```/);
      expect(body).toMatch(/_shared\/bridge_proxy\.sh/);
      // The first arg to bridge_proxy_invoke must be the subcommand string.
      const invokeRegex = new RegExp(
        `bridge_proxy_invoke\\s+["']${sub}["']`,
      );
      expect(body).toMatch(invokeRegex);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-cutting checks
  // -----------------------------------------------------------------------

  test('no extra autonomous-dev-*.md files beyond the documented 10', () => {
    const entries = fs
      .readdirSync(COMMANDS_DIR)
      .filter((f) => /^autonomous-dev-.+\.md$/.test(f));
    const stems = entries
      .map((f) => f.replace(/^autonomous-dev-|\.md$/g, ''))
      .sort();
    const expected = [...EXPECTED_SUBCOMMANDS].sort();
    expect(stems).toEqual(expected);
  });

  test('arg_schemas.yaml has an entry for every expected subcommand', () => {
    const schemas = loadArgSchemas();
    for (const sub of EXPECTED_SUBCOMMANDS) {
      expect(schemas[sub]).toBeDefined();
      expect(Array.isArray(schemas[sub])).toBe(true);
    }
  });

  test('arg_schemas.yaml contains no unexpected subcommands', () => {
    const schemas = loadArgSchemas();
    const keys = Object.keys(schemas).sort();
    expect(keys).toEqual([...EXPECTED_SUBCOMMANDS].sort());
  });
});
