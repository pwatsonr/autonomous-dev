/**
 * `autonomous-dev cred-proxy` subcommand group (SPEC-024-2-04).
 *
 * Three IPC commands against the running daemon:
 *
 *   - `cred-proxy status [--json]` — list active tokens.
 *   - `cred-proxy revoke <token_id>` — admin-forced early revocation.
 *   - `cred-proxy allow <plugin-id>` — add a plugin to
 *     `extensions.privileged_backends[]`.
 *
 * The `send` IPC hook and admin-role check are constructor-injected so
 * unit tests can drive the full subcommand surface without a running
 * daemon. Production wiring uses the IPC client from SPEC-019-1-04.
 *
 * Structure mirrors `chains_command.ts` so cli_adapter wiring stays
 * uniform — a single `registerCredProxyCommand(program, deps)` call.
 *
 * @module cli/cred_proxy_command
 */

import { Command } from 'commander';

import type { ActiveTokenView } from '../cred-proxy/active-tokens';

/**
 * IPC envelope used for the three new commands. Kept structural so this
 * module does NOT depend on the production `IpcRequest`/`IpcResponse`
 * union from `intake/hooks/ipc-server.ts` (extending that union is a
 * cross-spec concern and is wired by the daemon at boot).
 */
export interface CredProxyIpcRequest {
  command: 'cred-proxy.status' | 'cred-proxy.revoke' | 'cred-proxy.allow';
  token_id?: string;
  pluginId?: string;
}

export interface CredProxyIpcResponse {
  status: 'ok' | 'error';
  payload?: {
    tokens?: ActiveTokenView[];
    revoked?: boolean;
    not_found?: boolean;
  };
  error?: string;
}

export type CredProxyIpcSend = (
  req: CredProxyIpcRequest,
) => Promise<CredProxyIpcResponse>;

export interface CredProxyCommandDeps {
  /** Defaults to a function that exits 1 with `daemon is not running`. */
  send?: CredProxyIpcSend;
  /** Returns true iff the calling user is in the admin role. */
  isAdmin?: () => boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

const DEFAULT_NO_DAEMON_SEND: CredProxyIpcSend = async () => ({
  status: 'error',
  error: 'daemon is not running',
});

function getStreams(deps: CredProxyCommandDeps) {
  return {
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
  };
}

/**
 * Render an active-token view as a fixed-width table. Empty lists print
 * `(no active tokens)` so operators can distinguish "none" from "broken
 * connection."
 */
function renderTokenTable(tokens: ActiveTokenView[]): string {
  if (tokens.length === 0) return '(no active tokens)\n';
  const headers = [
    'token_id',
    'caller',
    'provider',
    'operation',
    'issued_at',
    'expires_at',
    'ttl_remaining_s',
  ];
  const now = Date.now();
  const rows = tokens.map((t) => {
    const remaining = Math.max(
      0,
      Math.round((Date.parse(t.expires_at) - now) / 1000),
    );
    return [
      t.token_id.slice(0, 12),
      t.caller,
      t.provider,
      t.operation,
      t.issued_at,
      t.expires_at,
      String(remaining),
    ];
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmt(headers), ...rows.map(fmt)].join('\n') + '\n';
}

export async function runCredProxyStatus(
  opts: { json: boolean },
  deps: CredProxyCommandDeps,
): Promise<number> {
  const { stdout, stderr } = getStreams(deps);
  const send = deps.send ?? DEFAULT_NO_DAEMON_SEND;
  const res = await send({ command: 'cred-proxy.status' });
  if (res.status !== 'ok') {
    stderr.write((res.error ?? 'unknown error') + '\n');
    return 1;
  }
  const tokens = res.payload?.tokens ?? [];
  if (opts.json) {
    stdout.write(JSON.stringify(tokens) + '\n');
    return 0;
  }
  stdout.write(renderTokenTable(tokens));
  return 0;
}

export async function runCredProxyRevoke(
  args: { token_id: string },
  deps: CredProxyCommandDeps,
): Promise<number> {
  const { stdout, stderr } = getStreams(deps);
  if (deps.isAdmin && !deps.isAdmin()) {
    stderr.write('admin role required\n');
    return 1;
  }
  const send = deps.send ?? DEFAULT_NO_DAEMON_SEND;
  const res = await send({
    command: 'cred-proxy.revoke',
    token_id: args.token_id,
  });
  if (res.status !== 'ok') {
    stderr.write((res.error ?? 'unknown error') + '\n');
    return 1;
  }
  if (res.payload?.not_found) {
    stdout.write('(no such token)\n');
    return 0;
  }
  stdout.write(`revoked: ${args.token_id}\n`);
  return 0;
}

export async function runCredProxyAllow(
  args: { pluginId: string },
  deps: CredProxyCommandDeps,
): Promise<number> {
  const { stdout, stderr } = getStreams(deps);
  if (deps.isAdmin && !deps.isAdmin()) {
    stderr.write('admin role required\n');
    return 1;
  }
  const send = deps.send ?? DEFAULT_NO_DAEMON_SEND;
  const res = await send({
    command: 'cred-proxy.allow',
    pluginId: args.pluginId,
  });
  if (res.status !== 'ok') {
    stderr.write((res.error ?? 'unknown error') + '\n');
    return 1;
  }
  stdout.write(`allowed: ${args.pluginId}\n`);
  return 0;
}

export function registerCredProxyCommand(
  program: Command,
  deps: CredProxyCommandDeps = {},
): void {
  const group = program
    .command('cred-proxy')
    .description('Inspect and manage scoped credential issuance')
    .exitOverride();

  group
    .command('status')
    .description('List active credential tokens')
    .option('--json', 'Emit raw JSON instead of a table', false)
    .action(async (opts: Record<string, unknown>) => {
      const code = await runCredProxyStatus(
        { json: opts.json === true },
        deps,
      );
      if (code !== 0) throw new Error('cred-proxy status failed');
    });

  group
    .command('revoke <token_id>')
    .description('Admin: force-revoke a credential token')
    .action(async (token_id: string) => {
      const code = await runCredProxyRevoke({ token_id }, deps);
      if (code !== 0) throw new Error('cred-proxy revoke failed');
    });

  group
    .command('allow <plugin-id>')
    .description('Admin: add a plugin to privileged_backends[]')
    .action(async (pluginId: string) => {
      const code = await runCredProxyAllow({ pluginId }, deps);
      if (code !== 0) throw new Error('cred-proxy allow failed');
    });
}
