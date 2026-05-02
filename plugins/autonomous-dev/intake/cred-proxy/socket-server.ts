/**
 * CredProxySocketServer — Unix domain socket fallback for backends that
 * need to acquire additional credentials mid-deploy (SPEC-024-2-04).
 *
 * Listens at `/tmp/autonomous-dev-cred.sock` (mode 0o600 inside a
 * mode-0o700 parent directory). Each accepted connection:
 *
 *   1. Reads peer credentials via the platform-specific SO_PEERCRED /
 *      LOCAL_PEERCRED syscall (injected via `peerCredFor` so tests bypass
 *      the native binding).
 *   2. Reads a single newline-or-EOF-terminated JSON request:
 *      `{ provider, operation, scope }`.
 *   3. Calls `proxy.acquire(...)` with `caller.socketPeer = { pid, uid }`.
 *   4. Writes a JSON response and closes the connection.
 *
 * Requests are processed SERIALLY via an internal promise chain — TDD-024
 * §7.3 requires "no race." Two simultaneous connections that both pass
 * authentication still go through `acquire` one at a time.
 *
 * The `umask(0o077) → listen → chmod 0o600 → restore umask` pattern is
 * defense in depth: the umask alone is sufficient on Linux, but the
 * explicit chmod handles platforms where the umask doesn't apply to
 * `bind()`. The umask is restored even on `start()` failure.
 *
 * @module intake/cred-proxy/socket-server
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import type { CredentialProxy } from './proxy';
import type { Provider, Scope } from './types';

export const SOCKET_PATH = '/tmp/autonomous-dev-cred.sock';

export interface SocketRequest {
  provider: Provider;
  operation: string;
  scope: Scope;
}

export interface SocketResponse {
  ok: boolean;
  cred?: unknown;
  error?: string;
}

/**
 * Function that returns the peer credentials of an accepted Unix-socket
 * connection. The default implementation throws — production deployments
 * MUST inject a native-binding-backed implementation. Tests inject a
 * deterministic stub.
 */
export type PeerCredResolver = (
  sock: net.Socket,
) => { pid: number; uid: number };

const DEFAULT_PEER_CRED: PeerCredResolver = () => {
  throw new Error(
    'PeerCredResolver not configured: install/inject a SO_PEERCRED native binding',
  );
};

export interface CredProxySocketServerOptions {
  /** Override for tests; production uses `SOCKET_PATH`. */
  socketPath?: string;
  /** Native-binding-backed peer-cred resolver. */
  peerCredFor?: PeerCredResolver;
}

export class CredProxySocketServer {
  private server: net.Server | null = null;
  /** Serializes all request handling. TDD-024 §7.3: "no race." */
  private chain: Promise<void> = Promise.resolve();
  private readonly socketPath: string;
  private readonly peerCredFor: PeerCredResolver;

  constructor(
    private readonly proxy: CredentialProxy,
    opts: CredProxySocketServerOptions = {},
  ) {
    this.socketPath = opts.socketPath ?? SOCKET_PATH;
    this.peerCredFor = opts.peerCredFor ?? DEFAULT_PEER_CRED;
  }

  async start(): Promise<void> {
    if (fs.existsSync(this.socketPath)) {
      // Stale socket from an unclean shutdown. Remove and recreate.
      fs.unlinkSync(this.socketPath);
    }
    fs.mkdirSync(path.dirname(this.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    const previousUmask = process.umask(0o077);
    try {
      // allowHalfOpen=true so the server can still write after the
      // client signals end-of-write (the request/response wire protocol
      // relies on this half-close handshake).
      this.server = net.createServer({ allowHalfOpen: true }, (sock) =>
        this.handle(sock),
      );
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        this.server!.once('error', onError);
        this.server!.listen(this.socketPath, () => {
          this.server!.off('error', onError);
          resolve();
        });
      });
      // Defense in depth: explicit chmod regardless of umask honour.
      fs.chmodSync(this.socketPath, 0o600);
    } finally {
      process.umask(previousUmask);
    }
  }

  private handle(sock: net.Socket): void {
    sock.on('error', () => {
      // Connection-level error; the dispatch promise (if any) is
      // self-contained. No-op here so an EPIPE doesn't crash the daemon.
    });

    let peer: { pid: number; uid: number };
    try {
      peer = this.peerCredFor(sock);
    } catch (err) {
      const resp: SocketResponse = {
        ok: false,
        error: `peer-cred unavailable: ${(err as Error).message}`,
      };
      // We can't acquire without peer credentials, but we still need to
      // drain the client's pending write so its `end()` resolves cleanly
      // (otherwise destroying immediately races the client's write and
      // surfaces as EPIPE on its side). Discard incoming bytes; on the
      // client's FIN reply with the error envelope and end the socket
      // (which sends our FIN and lets `server.close()` complete).
      sock.resume();
      sock.on('end', () => {
        sock.end(JSON.stringify(resp) + '\n');
      });
      return;
    }

    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
    });
    sock.on('end', () => {
      this.chain = this.chain.then(() => this.dispatch(sock, peer, buf));
    });
  }

  private async dispatch(
    sock: net.Socket,
    peer: { pid: number; uid: number },
    buf: string,
  ): Promise<void> {
    let resp: SocketResponse;
    try {
      const req = JSON.parse(buf.trim()) as SocketRequest;
      const cred = await this.proxy.acquire(
        req.provider,
        req.operation,
        req.scope,
        { socketPeer: peer },
      );
      resp = { ok: true, cred };
    } catch (err) {
      resp = { ok: false, error: (err as Error).message };
    }
    sock.end(JSON.stringify(resp) + '\n');
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }
}
