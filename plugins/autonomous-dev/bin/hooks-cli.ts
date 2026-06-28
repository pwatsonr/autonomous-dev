#!/usr/bin/env bun
/**
 * CLI logic for best-effort lifecycle hook emission (#561 item 1 / #568 part 2).
 *
 * This module EXPORTS `main` and is imported by the jest CLI suite. The
 * executable wrapper that bun runs is `bin/hooks-emit.ts` (see the note at the
 * bottom of `bin/review-gate-cli.ts` for why run and import are split — the
 * same ts-jest/bun module constraint applies here).
 *
 * Purpose: let the bash pipeline driver (`bin/supervisor-loop.sh`) FIRE the
 * `plan-pre-author` / `spec-pre-author` hook points during a live run. Today no
 * production plugin registers for those points, so emission is a deliberate
 * NO-OP (`{ran:0}`) — but the mechanism is wired and ready for future
 * consumers (#561 acceptance: the hooks fire during a live run).
 *
 * Usage (via the launcher):
 *   bun run bin/hooks-emit.ts emit <hook-point> \
 *     --request-id <id> \
 *     --repo <path> \
 *     --phase <phase> \
 *     [--request-type <type>]
 *
 * Output:
 *   A single-line JSON summary is printed to stdout:
 *     {"point":"plan-pre-author","ran":0,"aborted":false,"failures":0}
 *
 * Exit codes (BEST-EFFORT — this CLI MUST NEVER block the pipeline):
 *   0  — emission completed, OR no hooks were registered (no-op), OR a
 *        load/execution error occurred (logged to stderr, swallowed).
 *   2  — ONLY for an unknown/invalid <hook-point>. This is a caller bug, not a
 *        runtime failure, so it is the single non-zero path.
 *
 * Registry loading: there is no production bootstrap that assembles a populated
 * HookRegistry outside the daemon's TS internals, so this CLI builds a minimal
 * best-effort one. It scans the plugins root (`$HOME/.claude/plugins` by
 * default, overridable via `AUTONOMOUS_DEV_PLUGINS_ROOT`) using the same
 * `PluginDiscovery` API the ReloadController uses, then registers each manifest.
 * Any failure resolves to an empty registry — never a throw.
 *
 * @module bin/hooks-cli
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  HookPoint,
  isValidHookPoint,
  HookRegistry,
  HookExecutor,
  PluginDiscovery,
  type DiscoveryError,
} from '../intake/hooks';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
Usage: hooks-cli emit <hook-point> [options]

Best-effort emission of an autonomous-dev lifecycle hook point. Fires every
plugin hook registered for <hook-point>; a no-op when none are registered.

Arguments:
  <hook-point>               (required) e.g. plan-pre-author, spec-pre-author.

Options:
  --request-id <id>          (required) The request identifier (REQ-NNNNNN).
  --repo <path>              (required) Absolute path to the repository root.
  --phase <phase>            (required) The pipeline phase emitting the hook.
  --request-type <type>      Optional request type (feature, bug, ...).
  --help, -h                 Print this help and exit 0.

Output:
  A single-line JSON summary {point, ran, aborted, failures} to stdout.

Exit codes:
  0  emission completed, no hooks registered, or a swallowed runtime error.
  2  unknown/invalid <hook-point> (the only non-zero path).
`.trimStart();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  hookPoint: string;
  requestId: string;
  repo: string;
  phase: string;
  requestType?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: '',
    hookPoint: '',
    requestId: '',
    repo: '',
    phase: '',
    help: false,
  };

  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true;
        i++;
        break;
      case '--request-id':
        result.requestId = argv[++i] ?? '';
        i++;
        break;
      case '--repo':
        result.repo = argv[++i] ?? '';
        i++;
        break;
      case '--phase':
        result.phase = argv[++i] ?? '';
        i++;
        break;
      case '--request-type':
        result.requestType = argv[++i] ?? '';
        i++;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`unknown option: ${arg}`);
        }
        positionals.push(arg);
        i++;
        break;
    }
  }

  result.command = positionals[0] ?? '';
  result.hookPoint = positionals[1] ?? '';
  return result;
}

// ---------------------------------------------------------------------------
// Best-effort registry loader
// ---------------------------------------------------------------------------

/**
 * Resolve the plugins root the loader scans. Mirrors the cheapness-guard path
 * in `bin/supervisor-loop.sh` so the two never diverge.
 */
export function pluginsRoot(): string {
  return process.env.AUTONOMOUS_DEV_PLUGINS_ROOT ?? path.join(os.homedir(), '.claude', 'plugins');
}

/**
 * Permissive structural validator for the best-effort load path.
 *
 * Intentionally laxer than the canonical AJV/test validators: it only rejects
 * shapes that would crash `HookRegistry.register`. Unknown hook points are
 * accepted here (they simply never fire), so this loader does NOT need to track
 * the HookPoint catalog. Cross-reference: tests/helpers/schema-validator.ts.
 */
function bestEffortValidator(raw: unknown, manifestPath: string): DiscoveryError[] {
  const errors: DiscoveryError[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: 'manifest must be a JSON object' });
    return errors;
  }
  const m = raw as Record<string, unknown>;
  for (const field of ['id', 'name', 'version'] as const) {
    if (typeof m[field] !== 'string' || (m[field] as string).length === 0) {
      errors.push({
        manifestPath,
        code: 'SCHEMA_ERROR',
        message: `missing or invalid ${field}`,
        pointer: `/${field}`,
      });
    }
  }
  if (!Array.isArray(m.hooks)) {
    errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: 'hooks must be an array', pointer: '/hooks' });
    return errors;
  }
  m.hooks.forEach((h, idx) => {
    if (typeof h !== 'object' || h === null) {
      errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: 'hook must be an object', pointer: `/hooks/${idx}` });
      return;
    }
    const hook = h as Record<string, unknown>;
    for (const field of ['id', 'hook_point', 'entry_point'] as const) {
      if (typeof hook[field] !== 'string' || (hook[field] as string).length === 0) {
        errors.push({
          manifestPath,
          code: 'SCHEMA_ERROR',
          message: `hooks[${idx}].${field} missing`,
          pointer: `/hooks/${idx}/${field}`,
        });
      }
    }
    if (typeof hook.priority !== 'number' || !Number.isFinite(hook.priority)) {
      errors.push({
        manifestPath,
        code: 'SCHEMA_ERROR',
        message: `hooks[${idx}].priority must be a number`,
        pointer: `/hooks/${idx}/priority`,
      });
    }
  });
  return errors;
}

/**
 * Build a populated HookRegistry by scanning the plugins root. BEST-EFFORT:
 * any failure (missing root, unreadable manifest, malformed hook) is swallowed
 * and yields whatever could be registered (possibly an empty registry). Each
 * manifest registration is independently guarded so one bad plugin cannot
 * prevent the rest from loading.
 */
async function loadRegistry(
  log: (level: 'warn' | 'info', msg: string) => void,
): Promise<HookRegistry> {
  const registry = new HookRegistry();
  const root = pluginsRoot();
  try {
    const discovery = new PluginDiscovery(bestEffortValidator);
    const results = await discovery.scan(root);
    for (const r of results) {
      if (!r.manifest) continue;
      try {
        registry.register(r.manifest, path.dirname(r.manifestPath));
      } catch (err) {
        log('warn', `hooks-cli: skipping manifest ${r.manifestPath}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log('warn', `hooks-cli: registry load failed for ${root}: ${(err as Error).message}`);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (the main() seam)
// ---------------------------------------------------------------------------

export interface HooksCliDeps {
  /** Pre-built registry. When supplied, the on-disk loader is skipped (tests). */
  registry?: HookRegistry;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * CLI entry function. Separated from `process.argv` so tests can call
 * `main(argv, { registry })` and capture stdout via jest mocks.
 *
 * @param argv  Argument vector (exclude the node/bun executable + script path).
 * @param deps  Optional injectable dependencies for testing.
 * @returns     Exit code (0 = success/no-op/swallowed error; 2 = bad hook-point).
 */
export async function main(argv: string[], deps: HooksCliDeps = {}): Promise<number> {
  const log = (level: 'warn' | 'info', msg: string): void => {
    process.stderr.write(`[${level}] ${msg}\n`);
  };

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    // Unknown option is a caller error, but BEST-EFFORT: never block. Log and
    // exit 0 so the pipeline is undisturbed.
    log('warn', `hooks-cli: ${(err as Error).message}`);
    return 0;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (args.command !== 'emit') {
    log('warn', `hooks-cli: unknown command '${args.command}' (expected 'emit')`);
    return 0;
  }

  // The ONLY non-zero path: an unknown/invalid hook point. This is a wiring
  // bug in the caller, not a runtime condition, so we surface it.
  if (!isValidHookPoint(args.hookPoint)) {
    log('warn', `hooks-cli: unknown hook-point '${args.hookPoint}'`);
    return 2;
  }
  const point = args.hookPoint as HookPoint;

  // Everything below is best-effort and must resolve to exit 0.
  try {
    const registry = deps.registry ?? (await loadRegistry(log));
    const executor = new HookExecutor(() => registry.snapshot());

    const context = {
      requestId: args.requestId,
      repo: args.repo,
      phase: args.phase,
      requestType: args.requestType,
    };

    const result = await executor.executeHooksChained(point, context, (level, msg, meta) => {
      log(level, `${msg} ${JSON.stringify(meta)}`);
    });

    const summary = {
      point,
      ran: result.results.length,
      aborted: result.aborted,
      failures: result.failures.length,
    };
    process.stdout.write(JSON.stringify(summary) + '\n');
    return 0;
  } catch (err) {
    // executeHooksChained can throw HookBlockedError (block-mode hook). Even a
    // block must NOT halt the pipeline here — record it and report a no-op-ish
    // aborted summary, then exit 0.
    log('warn', `hooks-cli: emission error for ${point}: ${(err as Error).message}`);
    process.stdout.write(JSON.stringify({ point, ran: 0, aborted: true, failures: 0 }) + '\n');
    return 0;
  }
}
