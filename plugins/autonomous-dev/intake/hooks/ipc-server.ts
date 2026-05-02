/**
 * IpcServer — Unix domain socket server inside the daemon
 * (SPEC-019-1-04, Task 7).
 *
 * Listens on `~/.autonomous-dev/daemon.sock` (POSIX-only). Accepts
 * newline-delimited JSON requests and returns one newline-delimited JSON
 * response per request, then closes the connection.
 *
 * Two commands today: `list` and `reload`. The dispatcher is a switch so
 * adding commands in PLAN-019-2/3/4 is a 5-line change.
 *
 * @module intake/hooks/ipc-server
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HookRegistry } from './registry';
import type { ReloadController } from './reload-controller';
import type { RegisteredHook } from './registry';
import type { DependencyGraph, ChainEdge } from '../chains/dependency-graph';
import { renderGraph, type ChainGraphFormat } from '../chains/render';

/**
 * IPC request envelope.
 *
 * SPEC-022-1-04 widens this from `'list'|'reload'` to include the chain
 * inspection commands. `format` is only meaningful for `'chains-graph'`.
 */
export interface IpcRequest {
  command: 'list' | 'reload' | 'chains-list' | 'chains-graph';
  /** Only used by 'chains-graph'; defaults to 'dot'. */
  format?: ChainGraphFormat;
}

export interface IpcResponse {
  status: 'ok' | 'error';
  payload?: unknown;
  error?: string;
}

/** One row in the `list` response payload. */
export interface ListRow {
  pluginId: string;
  pluginVersion: string;
  hookPoint: string;
  hookId: string;
  priority: number;
  failureMode: string;
}

const SOCKET_DIR_MODE = 0o700;
const SOCKET_FILE_MODE = 0o600;

export function defaultSocketDir(): string {
  return path.join(os.homedir(), '.autonomous-dev');
}

export function defaultSocketPath(): string {
  return path.join(defaultSocketDir(), 'daemon.sock');
}

export class IpcServer {
  private server: net.Server | null = null;

  constructor(
    private readonly registry: HookRegistry,
    private readonly reloadController: ReloadController,
    private readonly socketPath: string = defaultSocketPath(),
    /** SPEC-022-1-04: optional chain dependency graph for chains-list /
     *  chains-graph IPC commands. When undefined the daemon was started
     *  without chain support; chain commands return an error. */
    private readonly chainGraph?: DependencyGraph,
  ) {}

  /** Start listening. Removes a stale socket file if present. */
  async start(): Promise<void> {
    const dir = path.dirname(this.socketPath);
    await fs.promises.mkdir(dir, { recursive: true, mode: SOCKET_DIR_MODE });
    // Tighten dir mode in case it pre-existed with looser permissions.
    try {
      await fs.promises.chmod(dir, SOCKET_DIR_MODE);
    } catch {
      // Best-effort; dir mode is defense in depth.
    }

    await this.cleanStaleSocket();

    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        // Tighten socket file permissions.
        try {
          fs.chmodSync(this.socketPath, SOCKET_FILE_MODE);
        } catch {
          // Best-effort; UDS is loopback-only by nature.
        }
        this.server = server;
        // eslint-disable-next-line no-console
        console.info(`ipc-server: listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /** Stop listening and remove the socket file. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await fs.promises.unlink(this.socketPath);
    } catch {
      // Already gone.
    }
  }

  private async cleanStaleSocket(): Promise<void> {
    let exists = false;
    try {
      await fs.promises.stat(this.socketPath);
      exists = true;
    } catch {
      return;
    }
    if (!exists) return;

    // Try to connect; if successful, another daemon owns it — refuse to start.
    const owned = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(this.socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });

    if (owned) {
      throw new Error(`ipc-server: socket ${this.socketPath} is in use by another daemon`);
    }

    await fs.promises.unlink(this.socketPath);
  }

  private handleConnection(socket: net.Socket): void {
    let buf = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      this.dispatch(line)
        .then((res) => {
          socket.end(JSON.stringify(res) + '\n');
        })
        .catch((err) => {
          socket.end(
            JSON.stringify({ status: 'error', error: (err as Error).message } satisfies IpcResponse) + '\n',
          );
        });
    });
    socket.on('error', () => {
      // Quiet — clients may disconnect mid-request.
    });
  }

  private async dispatch(line: string): Promise<IpcResponse> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch (err) {
      return { status: 'error', error: `invalid JSON: ${(err as Error).message}` };
    }

    switch (req.command) {
      case 'list':
        return { status: 'ok', payload: this.list() };
      case 'reload':
        try {
          const diff = await this.reloadController.reload();
          return { status: 'ok', payload: diff };
        } catch (err) {
          return { status: 'error', error: (err as Error).message };
        }
      case 'chains-list':
        if (!this.chainGraph) {
          return { status: 'error', error: 'chain graph not available' };
        }
        return { status: 'ok', payload: this.chainGraph.getEdges() satisfies ChainEdge[] };
      case 'chains-graph':
        if (!this.chainGraph) {
          return { status: 'error', error: 'chain graph not available' };
        }
        try {
          const fmt: ChainGraphFormat = req.format ?? 'dot';
          if (fmt !== 'dot' && fmt !== 'mermaid') {
            return { status: 'error', error: `unsupported format '${fmt}' (use dot or mermaid)` };
          }
          return { status: 'ok', payload: renderGraph(this.chainGraph, fmt) };
        } catch (err) {
          return { status: 'error', error: (err as Error).message };
        }
      default:
        return { status: 'error', error: `unknown command: ${(req as IpcRequest).command}` };
    }
  }

  private list(): ListRow[] {
    const rows: ListRow[] = [];
    const snap = this.registry.snapshot();
    for (const [point, list] of snap.entries()) {
      for (const rh of list as readonly RegisteredHook[]) {
        rows.push({
          pluginId: rh.pluginId,
          pluginVersion: rh.pluginVersion,
          hookPoint: point,
          hookId: rh.hook.id,
          priority: rh.hook.priority,
          failureMode: rh.hook.failure_mode,
        });
      }
    }
    // Sort: (hookPoint, -priority, pluginId).
    rows.sort((a, b) => {
      if (a.hookPoint !== b.hookPoint) return a.hookPoint.localeCompare(b.hookPoint);
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.pluginId.localeCompare(b.pluginId);
    });
    return rows;
  }
}
