/**
 * `autonomous-dev standards` subcommand family (SPEC-021-1-04).
 *
 * Three verbs:
 *   - `standards scan [--repo <path>] [--diff] [--json]`
 *       Runs AutoDetectionScanner against `--repo` (default: cwd), prints
 *       a tabular or JSON summary, and ALWAYS writes
 *       `<repo>/.autonomous-dev/standards.inferred.yaml`. With `--diff`,
 *       prints only IDs not already present in `<repo>/.autonomous-dev/standards.yaml`.
 *
 *   - `standards show [--rule <id>] [--json]`
 *       Resolves default + org + repo rules via the InheritanceResolver
 *       and prints the merged set with source attribution. Missing org/repo
 *       files are treated as empty (not errors).
 *
 *   - `standards validate <path>`
 *       Schema-checks a standards.yaml. Exits 0 on success, 1 with one
 *       error line per problem on failure.
 *
 * Factored out of `cli_adapter.ts` to keep that file's commander dispatch
 * focused on `request` verbs. Wire-up via `registerStandardsCommand(program)`.
 *
 * @module intake/adapters/cli_adapter_standards
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

import { Command, Option } from 'commander';

import {
  AutoDetectionScanner,
  loadStandardsFile,
  resolveStandards,
  writeInferredStandards,
} from '../standards';
import type { Rule, RuleSource } from '../standards';

/** Path to the bundled empty defaults file (created by SPEC-021-1-04). */
export const BUILTIN_DEFAULTS_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'standards',
  'defaults.yaml',
);

/** Stdout/stderr/cwd writer interface so tests can capture output. */
export interface StandardsCliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: () => string;
  homedir: () => string;
}

const defaultIO: StandardsCliIO = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  cwd: () => process.cwd(),
  homedir: () => homedir(),
};

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

/**
 * Implementation of `standards scan`. Returns the exit code (0 on success).
 * Always writes the inferred file as a side effect, even when `--diff` is set.
 */
export async function standardsScanCommand(
  args: { repo?: string; diff?: boolean; json?: boolean },
  io: StandardsCliIO = defaultIO,
): Promise<number> {
  const repoPath = path.resolve(args.repo ?? io.cwd());
  const result = await new AutoDetectionScanner(repoPath).scan();

  let payload: unknown = result;
  if (args.diff) {
    const existing = await loadStandardsFile(
      path.join(repoPath, '.autonomous-dev', 'standards.yaml'),
    );
    const existingIds = new Set(
      (existing.artifact?.rules ?? []).map((r) => r.id),
    );
    payload = {
      additions: result.detected.filter((d) => !existingIds.has(d.rule.id)),
      warnings: result.warnings,
    };
  }

  if (args.json) {
    io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    io.stdout(formatScanTable(result.detected));
    if (result.warnings.length > 0) {
      io.stdout(`\nWarnings:\n`);
      for (const w of result.warnings) io.stdout(`  - ${w}\n`);
    }
  }

  await writeInferredStandards(repoPath, result.detected);
  return 0;
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

export async function standardsShowCommand(
  args: { rule?: string; json?: boolean },
  io: StandardsCliIO = defaultIO,
): Promise<number> {
  const def = (await loadStandardsFile(BUILTIN_DEFAULTS_PATH)).artifact;
  const orgPath = path.join(io.homedir(), '.claude', 'autonomous-dev', 'standards.yaml');
  const repoPath = path.join(io.cwd(), '.autonomous-dev', 'standards.yaml');
  const org = (await loadStandardsFile(orgPath)).artifact;
  const repo = (await loadStandardsFile(repoPath)).artifact;
  const resolved = resolveStandards(
    def?.rules ?? [],
    org?.rules ?? [],
    repo?.rules ?? [],
    [],
  );

  if (args.rule) {
    const r = resolved.rules.get(args.rule);
    if (!r) {
      io.stderr(`Rule not found: ${args.rule}\n`);
      return 1;
    }
    const out = { rule: r, source: resolved.source.get(args.rule) };
    if (args.json) io.stdout(`${JSON.stringify(out, null, 2)}\n`);
    else io.stdout(formatRuleDetail(r, out.source as RuleSource));
    return 0;
  }

  if (args.json) {
    const list = [...resolved.rules.entries()].map(([id, rule]) => ({
      rule,
      source: resolved.source.get(id),
    }));
    io.stdout(`${JSON.stringify(list, null, 2)}\n`);
  } else {
    io.stdout(formatResolvedTable([...resolved.rules.values()], resolved.source));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export async function standardsValidateCommand(
  args: { path: string },
  io: StandardsCliIO = defaultIO,
): Promise<number> {
  const result = await loadStandardsFile(args.path);
  if (result.errors.length === 0) {
    io.stdout(`OK: ${args.path} validates against standards-v1.json\n`);
    return 0;
  }
  for (const e of result.errors) {
    const prefix =
      e.type === 'schema_error' ? `ERROR ${e.path}` : `ERROR (${e.type})`;
    io.stderr(`${prefix}: ${e.message}\n`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 3)}...`;
}

function formatScanTable(detected: ReadonlyArray<{ rule: { id: string }; confidence: number; signal: string; evidence: string[] }>): string {
  if (detected.length === 0) return '(no signals detected)\n';
  const header = `${'ID'.padEnd(36)} ${'CONF'.padEnd(5)} ${'SIGNAL'.padEnd(20)} EVIDENCE\n`;
  const rows = detected.map((d) => {
    const id = truncate(d.rule.id, 36).padEnd(36);
    const conf = d.confidence.toFixed(2).padEnd(5);
    const sig = truncate(d.signal, 20).padEnd(20);
    const ev = truncate(d.evidence.join(','), 80 - 36 - 5 - 20 - 3);
    return `${id} ${conf} ${sig} ${ev}`;
  });
  return `${header}${rows.join('\n')}\n`;
}

function formatResolvedTable(rules: Rule[], source: Map<string, RuleSource>): string {
  if (rules.length === 0) return '(no rules resolved)\n';
  const header = `${'ID'.padEnd(36)} ${'SEV'.padEnd(9)} ${'SRC'.padEnd(8)} DESCRIPTION\n`;
  const rows = rules.map((r) => {
    const id = truncate(r.id, 36).padEnd(36);
    const sev = r.severity.padEnd(9);
    const src = (source.get(r.id) ?? '?').padEnd(8);
    const desc = truncate(r.description, 80 - 36 - 9 - 8 - 3);
    return `${id} ${sev} ${src} ${desc}`;
  });
  return `${header}${rows.join('\n')}\n`;
}

function formatRuleDetail(rule: Rule, src: RuleSource): string {
  return [
    `id:          ${rule.id}`,
    `source:      ${src}`,
    `severity:    ${rule.severity}`,
    `immutable:   ${rule.immutable ?? false}`,
    `evaluator:   ${rule.evaluator}`,
    `description: ${rule.description}`,
    `applies_to:  ${JSON.stringify(rule.applies_to)}`,
    `requires:    ${JSON.stringify(rule.requires)}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

/**
 * Attach the `standards` subcommand family to `program`.
 * Each verb returns its own exit code; on a non-zero return we throw a
 * marker error so the parent `main()` can exit with the right code.
 */
export function registerStandardsCommand(
  program: Command,
  io: StandardsCliIO = defaultIO,
): void {
  const standards = program
    .command('standards')
    .description('Inspect, scan, and validate standards artifacts');

  standards
    .command('scan')
    .description('Auto-detect standards from a repo and write standards.inferred.yaml')
    .addOption(new Option('--repo <path>', 'Repo to scan (default: cwd)'))
    .option('--diff', 'Show only IDs not present in <repo>/.autonomous-dev/standards.yaml')
    .option('--json', 'Emit JSON instead of a table')
    .action(async (opts: { repo?: string; diff?: boolean; json?: boolean }) => {
      const code = await standardsScanCommand(opts, io);
      if (code !== 0) throw new Error(`standards scan exited ${code}`);
    });

  standards
    .command('show')
    .description(
      'Resolve default + org + repo standards and print with source attribution',
    )
    .option('--rule <id>', 'Print the full definition of a single rule')
    .option('--json', 'Emit JSON instead of a table')
    .action(async (opts: { rule?: string; json?: boolean }) => {
      const code = await standardsShowCommand(opts, io);
      if (code !== 0) throw new Error(`standards show exited ${code}`);
    });

  standards
    .command('validate <path>')
    .description('Schema-check a standards.yaml against standards-v1.json')
    .action(async (filePath: string) => {
      const code = await standardsValidateCommand({ path: filePath }, io);
      if (code !== 0) throw new Error(`standards validate exited ${code}`);
    });
}
