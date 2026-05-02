/**
 * `autonomous-dev deploy backends list|describe` CLI (SPEC-023-1-04, Task 10).
 *
 * Two read-only subcommands surfaced to operators so they can:
 *   - List every registered backend with availability + capabilities,
 *   - Inspect a single backend's parameter schema, capabilities, and
 *     required tools.
 *
 * Both commands honor a `--json` flag for stable, machine-parseable
 * output that PLAN-013-X portal UI and CI scripts can consume.
 *
 * `registerDeployBackendsCommand(program)` plugs the command group into
 * the existing top-level commander program (analogous to
 * `registerChainsCommand` in `chains_command.ts`).
 *
 * @module cli/deploy_backends_command
 */

import { Command } from 'commander';

import { BackendNotFoundError } from '../deploy/errors';
import { BackendRegistry, type RegisteredBackend } from '../deploy/registry';
import { DockerLocalBackend, PARAM_SCHEMA as DOCKER_LOCAL_SCHEMA } from '../deploy/backends/docker-local';
import { GithubPagesBackend, PARAM_SCHEMA as GITHUB_PAGES_SCHEMA } from '../deploy/backends/github-pages';
import { LocalBackend, PARAM_SCHEMA as LOCAL_SCHEMA } from '../deploy/backends/local';
import { StaticBackend, PARAM_SCHEMA as STATIC_SCHEMA } from '../deploy/backends/static';
import type { ParamSchema } from '../deploy/parameters';

/** Stream pair injected for testability — defaults to process.stdout/stderr. */
export interface DeployBackendsStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * The `describe` subcommand needs each backend's PARAM_SCHEMA. Backends
 * own the schema; the CLI maps a backend name → schema via this table.
 * Adding a new backend requires extending this map (one line) — same
 * cost as adding it to the registry-bootstrap.
 */
const PARAM_SCHEMAS: Record<string, Record<string, ParamSchema>> = {
  local: LOCAL_SCHEMA,
  static: STATIC_SCHEMA,
  'docker-local': DOCKER_LOCAL_SCHEMA,
  'github-pages': GITHUB_PAGES_SCHEMA,
};

// Type-only guard so unused-imports lint stays quiet — the imports are
// here to keep the schema-table source-of-truth in one place even though
// the classes themselves are wired by `registry-bootstrap`.
void LocalBackend;
void StaticBackend;
void DockerLocalBackend;
void GithubPagesBackend;

interface ListEntry {
  name: string;
  version: string;
  available: boolean;
  unavailableReason?: string;
  supportedTargets: string[];
  capabilities: string[];
  requiredTools: string[];
}

function toListEntry(reg: RegisteredBackend): ListEntry {
  return {
    name: reg.backend.metadata.name,
    version: reg.backend.metadata.version,
    available: reg.available,
    ...(reg.unavailableReason ? { unavailableReason: reg.unavailableReason } : {}),
    supportedTargets: [...reg.backend.metadata.supportedTargets],
    capabilities: [...reg.backend.metadata.capabilities],
    requiredTools: [...reg.backend.metadata.requiredTools],
  };
}

/** Render the `list` table. Pure for testability. */
export function renderBackendsTable(entries: ListEntry[]): string {
  if (entries.length === 0) return '(no backends registered)\n';
  const headers = ['NAME', 'VERSION', 'AVAILABLE', 'TARGETS', 'CAPABILITIES'];
  const rows: string[][] = [headers];
  for (const e of entries) {
    rows.push([
      e.name,
      e.version,
      e.available ? 'yes' : `no (${e.unavailableReason ?? 'unknown'})`,
      e.supportedTargets.join(','),
      e.capabilities.join(','),
    ]);
  }
  const widths = headers.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? '').length)),
  );
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(r.map((cell, i) => (cell ?? '').padEnd(widths[i])).join(' | '));
  }
  return lines.join('\n') + '\n';
}

/** Render the `describe` text output. Pure for testability. */
export function renderBackendDescription(
  entry: RegisteredBackend,
  schema: Record<string, ParamSchema> | undefined,
): string {
  const meta = entry.backend.metadata;
  const lines: string[] = [];
  lines.push('Metadata');
  lines.push(`  name:    ${meta.name}`);
  lines.push(`  version: ${meta.version}`);
  lines.push(`  available: ${entry.available ? 'yes' : `no (${entry.unavailableReason ?? 'unknown'})`}`);
  lines.push('');
  lines.push('Required tools');
  if (meta.requiredTools.length === 0) lines.push('  (none)');
  for (const t of meta.requiredTools) lines.push(`  - ${t}`);
  lines.push('');
  lines.push('Capabilities');
  for (const c of meta.capabilities) lines.push(`  - ${c}`);
  lines.push('');
  lines.push('Supported targets');
  for (const t of meta.supportedTargets) lines.push(`  - ${t}`);
  lines.push('');
  lines.push('Parameter schema');
  if (!schema || Object.keys(schema).length === 0) {
    lines.push('  (no schema registered)');
  } else {
    for (const [key, spec] of Object.entries(schema)) {
      const parts: string[] = [`type=${spec.type}`];
      if (spec.required) parts.push('required');
      if (spec.default !== undefined) parts.push(`default=${JSON.stringify(spec.default)}`);
      if (spec.format) parts.push(`format=${spec.format}`);
      if (spec.range) parts.push(`range=[${spec.range[0]},${spec.range[1]}]`);
      if (spec.enum) parts.push(`enum=[${spec.enum.join(',')}]`);
      if (spec.regex) parts.push(`regex=${spec.regex.source}`);
      lines.push(`  ${key}: ${parts.join(' ')}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Run `deploy backends list`. Returns the process exit code. */
export function runDeployBackendsList(
  opts: { json?: boolean },
  streams: DeployBackendsStreams = {},
): number {
  const stdout = streams.stdout ?? process.stdout;
  const entries = BackendRegistry.list().map(toListEntry);
  if (opts.json) {
    stdout.write(JSON.stringify({ backends: entries }, null, 2) + '\n');
    return 0;
  }
  stdout.write(renderBackendsTable(entries));
  return 0;
}

/** Run `deploy backends describe <name>`. Returns the process exit code. */
export function runDeployBackendsDescribe(
  name: string,
  opts: { json?: boolean },
  streams: DeployBackendsStreams = {},
): number {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  let entry: RegisteredBackend;
  try {
    entry = BackendRegistry.getEntry(name);
  } catch (err) {
    if (err instanceof BackendNotFoundError) {
      stderr.write(`backend not registered: ${name}\n`);
      return 1;
    }
    throw err;
  }
  const schema = PARAM_SCHEMAS[entry.backend.metadata.name];
  if (opts.json) {
    const payload: Record<string, unknown> = {
      ...toListEntry(entry),
      parameterSchema: schema ? schemaToJson(schema) : null,
    };
    stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }
  stdout.write(renderBackendDescription(entry, schema));
  return 0;
}

/** JSON-serializable version of a ParamSchema map (RegExp → string). */
function schemaToJson(
  schema: Record<string, ParamSchema>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, spec] of Object.entries(schema)) {
    const entry: Record<string, unknown> = { type: spec.type };
    if (spec.required) entry.required = true;
    if (spec.default !== undefined) entry.default = spec.default;
    if (spec.enum) entry.enum = [...spec.enum];
    if (spec.range) entry.range = [...spec.range];
    if (spec.format) entry.format = spec.format;
    if (spec.regex) entry.regex = spec.regex.source;
    out[key] = entry;
  }
  return out;
}

/** Plug `deploy backends ...` under the top-level `deploy` command. */
export function registerDeployBackendsCommand(
  program: Command,
  streams: DeployBackendsStreams = {},
): void {
  // The orchestrator owns the top-level `deploy` group; if it doesn't
  // exist yet, create it. Subsequent registrations attach to the same
  // group.
  let deployGroup: Command | undefined = program.commands.find(
    (c: Command) => c.name() === 'deploy',
  );
  if (!deployGroup) {
    deployGroup = program
      .command('deploy')
      .description('Deployment backend operations')
      .exitOverride();
  }

  const backends = deployGroup
    .command('backends')
    .description('List or describe registered deployment backends')
    .exitOverride();

  backends
    .command('list')
    .description('List every registered deployment backend')
    .option('--json', 'Emit JSON instead of a table', false)
    .action((opts: Record<string, unknown>) => {
      const code = runDeployBackendsList(
        { json: opts.json === true },
        streams,
      );
      if (code !== 0) throw new Error('deploy backends list failed');
    });

  backends
    .command('describe')
    .description('Show metadata, capabilities, and parameter schema for a backend')
    .argument('<name>', 'Backend name (e.g., local, static, docker-local, github-pages)')
    .option('--json', 'Emit JSON instead of text', false)
    .action((name: string, opts: Record<string, unknown>) => {
      const code = runDeployBackendsDescribe(
        name,
        { json: opts.json === true },
        streams,
      );
      if (code !== 0) throw new Error('deploy backends describe failed');
    });
}
