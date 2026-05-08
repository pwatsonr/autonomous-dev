/**
 * `plugin reload <name>` command module.
 *
 * Spec coverage: SPEC-030-3-01 (PLAN-030-3 / TDD-030 §7, §7.3, §7.4).
 *
 * This module is intentionally **pure**: it accepts a plugin name, an
 * injected `PluginReloadDeps` (which carries the daemon-reload RPC hook),
 * and an injected logger; it returns a `Promise<number>` exit code in the
 * closed set `{0, 1, 2}` and never exits the process or reads from
 * process argv (PRD-016 FR-1660).
 *
 * The exit-code contract (TDD-030 §7.3):
 *   - 0  Success — daemon confirmed reload of the named plugin.
 *   - 1  Transient failure — daemon unreachable, RPC timeout, or daemon
 *        returned a retriable error.
 *   - 2  Configuration / usage error — bad manifest, unknown plugin, or
 *        missing reload hook.
 *
 * Per PLAN-030-3 TASK-001 risk note + AC-12: the production daemon-reload
 * hook is injected at the `bin/reload-plugins.js` boundary (SPEC-030-3-02).
 * If a future PR cannot locate an importable reload hook in the daemon
 * source, that PR is paused and escalated; this module does not invent a
 * new daemon mechanism.
 *
 * @module intake/cli/commands/plugin
 */

/**
 * Minimal logger surface — a structural subset of `Console`. We accept this
 * shape (rather than the full `Console`) so tests can inject a buffer without
 * having to satisfy every console method.
 */
export type Logger = Pick<Console, 'log' | 'error'>;

/**
 * Result returned by the daemon-reload RPC hook. The kind discriminator
 * controls the exit code: `ok → 0`, `transient → 1`, `config-error → 2`.
 */
export type ReloadResult =
  | { kind: 'ok'; version: string }
  | { kind: 'transient'; message: string }
  | { kind: 'config-error'; message: string };

/**
 * Dependencies for `runPluginReload`. The `reloadHook` is the RPC seam:
 * unit tests inject a fake; the integration test (SPEC-030-3-03) drives a
 * real daemon through a thin adapter; production wires up the daemon's
 * actual reload hook from inside `bin/reload-plugins.js`.
 */
export interface PluginReloadDeps {
  /** RPC client that issues the reload message to the daemon. */
  reloadHook: (
    pluginName: string,
    opts: { timeoutMs: number },
  ) => Promise<ReloadResult>;
  /** Allow tests to inject a deterministic timeout. Default: 5000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Issue a reload RPC for `pluginName` and translate the result into an
 * exit code in `{0, 1, 2}`.
 *
 * Contract:
 *   - Never exits the process.
 *   - Never reads from process argv.
 *   - On a missing `deps.reloadHook`, returns 2 with a stderr message
 *     (defense-in-depth — the dispatcher only calls this once it has
 *     validated argv).
 */
export async function runPluginReload(
  pluginName: string,
  deps: PluginReloadDeps | undefined,
  log: Logger,
): Promise<number> {
  if (!deps?.reloadHook) {
    log.error('reload-plugins: daemon reload hook not configured');
    return 2;
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await deps.reloadHook(pluginName, { timeoutMs });

  switch (result.kind) {
    case 'ok':
      log.log(
        `reload-plugins: ${pluginName} reloaded (version ${result.version})`,
      );
      return 0;
    case 'transient':
      log.error(`reload-plugins: transient failure: ${result.message}`);
      return 1;
    case 'config-error':
      log.error(`reload-plugins: configuration error: ${result.message}`);
      return 2;
  }
}
