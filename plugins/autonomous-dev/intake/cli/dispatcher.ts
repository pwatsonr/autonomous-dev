/**
 * Pure CLI dispatcher for the `reload-plugins` operator entry point.
 *
 * Spec coverage: SPEC-030-3-01 (PLAN-030-3 / TDD-030 §7, §7.3, §7.4).
 *
 * Maps argv (without the leading `node` / script path) to a command and
 * returns a `Promise<number>` exit code. The dispatcher itself never exits
 * the process, never reads from process argv, and never touches the
 * filesystem — that is `bin/reload-plugins.js`'s job (SPEC-030-3-02), and
 * is the only place in PLAN-030-3 where direct process exit is permitted
 * (per PRD-016 FR-1660).
 *
 * Exit codes (TDD-030 §7.3):
 *   - 0  Success
 *   - 1  Transient failure (daemon unreachable / timeout)
 *   - 2  Configuration / usage error (unknown command, invalid args,
 *        bad manifest, uncaught throw)
 *
 * Plugin-name validation uses a strict allowlist (`^[A-Za-z0-9._-]+$`) to
 * reject path-traversal payloads (`../etc/passwd`) and whitespace. Any
 * loosening of this regex is a security concern — see SPEC-030-3-01
 * "Risks" and the `Invalid plugin name` test cases.
 *
 * Per PRD-016 R-06 / NG-3006, reload is **deterministic** (explicit RPC),
 * not file-watcher-driven.
 *
 * @module intake/cli/dispatcher
 */

import { runPluginReload, type PluginReloadDeps } from './commands/plugin';

/**
 * Minimal logger surface — a structural subset of `Console`. The default is
 * `console`. Tests inject a buffer.
 */
type DispatcherLogger = Pick<Console, 'log' | 'error' | 'warn'>;

export interface DispatcherDeps {
  /** Logger to capture stdout/stderr. Default: `console`. */
  logger?: DispatcherLogger;
  /** Injected daemon-reload deps; the production hook is wired in `bin/`. */
  pluginReload?: PluginReloadDeps;
}

const USAGE = `\
Usage:
  reload-plugins <plugin-name>           # equivalent to: plugin reload <plugin-name>
  reload-plugins plugin reload <name>

Exit codes:
  0  Success
  1  Transient failure (daemon unreachable / timeout)
  2  Configuration error (unknown command, invalid args, bad manifest)
`;

/** Strict plugin-name allowlist — see module header for rationale. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Translate a raw `argv` array (minus `node` and the script path) into an
 * exit code in `{0, 1, 2}`.
 *
 * Two argv shapes are accepted:
 *   - `['<plugin-name>']`             — bare shorthand (the wrapper is named
 *                                        `reload-plugins`, so the verb is
 *                                        implied)
 *   - `['plugin', 'reload', '<name>']` — explicit verb form
 *
 * Any other shape, an empty argv, or a plugin name that fails the allowlist
 * yields exit 2 with a usage string on `deps.logger.error`.
 */
export async function dispatch(
  argv: ReadonlyArray<string>,
  deps: DispatcherDeps = {},
): Promise<number> {
  const log: DispatcherLogger = deps.logger ?? console;

  let pluginName: string | undefined;
  if (argv.length === 1) {
    pluginName = argv[0];
  } else if (
    argv.length === 3 &&
    argv[0] === 'plugin' &&
    argv[1] === 'reload'
  ) {
    pluginName = argv[2];
  } else {
    log.error(USAGE);
    return 2;
  }

  if (!pluginName || !PLUGIN_NAME_RE.test(pluginName)) {
    log.error(`Invalid plugin name: ${JSON.stringify(pluginName)}`);
    log.error(USAGE);
    return 2;
  }

  try {
    return await runPluginReload(pluginName, deps.pluginReload, log);
  } catch (err) {
    // Defense-in-depth: any uncaught throw maps to exit 2.
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`reload-plugins: unexpected error: ${msg}`);
    return 2;
  }
}
