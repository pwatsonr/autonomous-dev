/**
 * IpcClient — CLI-side socket client for the daemon's IPC server
 * (SPEC-019-1-04, Task 7).
 *
 * Sends a single newline-delimited JSON request, awaits one
 * newline-delimited JSON response, then closes the connection.
 *
 * Timeouts: 5s on connect, 30s on response (covers the worst-case reload
 * of 50 plugins per TDD-019 §16).
 *
 * @module intake/hooks/ipc-client
 */

import * as net from 'node:net';
import { defaultSocketPath, type IpcRequest, type IpcResponse } from './ipc-server';

const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 30_000;

export class DaemonNotRunningError extends Error {
  constructor(socketPath: string) {
    super(`daemon is not running (no socket at ${socketPath})`);
    this.name = 'DaemonNotRunningError';
  }
}

export class IpcTimeoutError extends Error {
  constructor(public readonly phase: 'connect' | 'response', ms: number) {
    super(`ipc ${phase} timeout after ${ms}ms`);
    this.name = 'IpcTimeoutError';
  }
}

export interface SendOptions {
  socketPath?: string;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export async function send(req: IpcRequest, opts: SendOptions = {}): Promise<IpcResponse> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const connectTimeout = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const responseTimeout = opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;

  return new Promise<IpcResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = '';
    let connected = false;
    socket.setEncoding('utf-8');

    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new IpcTimeoutError('connect', connectTimeout));
    }, connectTimeout);

    const responseTimer = setTimeout(() => {
      socket.destroy();
      reject(new IpcTimeoutError('response', responseTimeout));
    }, responseTimeout);

    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.write(JSON.stringify(req) + '\n');
    });

    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      clearTimeout(responseTimer);
      try {
        const res = JSON.parse(line) as IpcResponse;
        socket.destroy();
        resolve(res);
      } catch (err) {
        socket.destroy();
        reject(new Error(`invalid IPC response: ${(err as Error).message}`));
      }
    });

    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      if (!connected && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
        reject(new DaemonNotRunningError(socketPath));
        return;
      }
      reject(err);
    });
  });
}
