/**
 * CredProxySocketServer integration tests using a real Unix socket
 * (SPEC-024-2-04).
 *
 * Uses `os.tmpdir()/cred-proxy-test-<rand>/sock` to avoid interference
 * with a running daemon's `/tmp/autonomous-dev-cred.sock`.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ActiveTokenRegistry,
} from '../../intake/cred-proxy/active-tokens';
import {
  CredentialAuditEmitter,
  type AuditSink,
} from '../../intake/cred-proxy/audit-emitter';
import {
  __resetLiveBackendsForTests,
  registerLiveBackend,
} from '../../intake/cred-proxy/caller-identity';
import { CredentialProxy } from '../../intake/cred-proxy/proxy';
import {
  CredProxySocketServer,
  type SocketResponse,
} from '../../intake/cred-proxy/socket-server';
import {
  type CredentialScoper,
  type Provider,
} from '../../intake/cred-proxy/types';

function makeScoper(): CredentialScoper {
  return {
    provider: 'aws',
    async scope(_op, _scope) {
      return {
        payload: '{"k":"v"}',
        expires_at: '2030-01-01T00:15:00.000Z',
        revoke: async () => undefined,
      };
    },
  };
}

function makeProxy(privileged: string[]): {
  proxy: CredentialProxy;
  registry: ActiveTokenRegistry;
} {
  const sink: AuditSink = { append: () => undefined };
  const registry = new ActiveTokenRegistry();
  const fakeTimer = {} as NodeJS.Timeout;
  const proxy = new CredentialProxy({
    scopers: new Map<Provider, CredentialScoper>([['aws', makeScoper()]]),
    privilegedBackends: new Set(privileged),
    registry,
    audit: new CredentialAuditEmitter(sink),
    setTimer: () => fakeTimer,
    delay: () => Promise.resolve(),
    retryDelaysMs: [0],
  });
  return { proxy, registry };
}

function tmpSocketPath(): string {
  const dir = path.join(
    os.tmpdir(),
    `cred-proxy-test-${randomBytes(4).toString('hex')}`,
  );
  return path.join(dir, 'sock');
}

async function sendRequest(
  socketPath: string,
  body: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => (buf += c));
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    sock.write(body);
    sock.end();
  });
}

describe('CredProxySocketServer', () => {
  const ORIGINAL_ENV = process.env.AUTONOMOUS_DEV_PLUGIN_ID;
  let server: CredProxySocketServer | null = null;
  let socketPath: string;

  beforeEach(() => {
    __resetLiveBackendsForTests();
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = 'plugin-good';
    socketPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    process.env.AUTONOMOUS_DEV_PLUGIN_ID = ORIGINAL_ENV;
  });

  it('start() creates the socket file with mode 0o600', async () => {
    const { proxy } = makeProxy(['plugin-good']);
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => ({ pid: 9999, uid: 1000 }),
    });
    await server.start();
    const stat = fs.statSync(socketPath);
    // mode bits & 0o777 isolate the perm bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('start() removes a stale socket file from a previous unclean shutdown', async () => {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.writeFileSync(socketPath, 'stale');
    expect(fs.existsSync(socketPath)).toBe(true);

    const { proxy } = makeProxy(['plugin-good']);
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => ({ pid: 9999, uid: 1000 }),
    });
    await server.start();
    const stat = fs.statSync(socketPath);
    // Should now be a socket, not a regular file.
    expect(stat.isSocket()).toBe(true);
  });

  it('stop() closes the server and unlinks the socket file', async () => {
    const { proxy } = makeProxy(['plugin-good']);
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => ({ pid: 9999, uid: 1000 }),
    });
    await server.start();
    await server.stop();
    server = null;
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('restores the umask after start()', async () => {
    const { proxy } = makeProxy(['plugin-good']);
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => ({ pid: 9999, uid: 1000 }),
    });
    const before = process.umask();
    await server.start();
    const after = process.umask(process.umask());
    expect(after).toBe(before);
  });

  it('serves a successful acquire to a registered live backend', async () => {
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-good' });
    const { proxy, registry } = makeProxy(['plugin-good']);
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => ({ pid: 1234, uid: 1000 }),
    });
    await server.start();
    const respText = await sendRequest(
      socketPath,
      JSON.stringify({
        provider: 'aws',
        operation: 'op',
        scope: { region: 'us-east-1' },
      }),
    );
    const resp = JSON.parse(respText.trim()) as SocketResponse;
    expect(resp.ok).toBe(true);
    interface CredEnvelope { delivery: 'stdin' | 'socket' }
    expect((resp.cred as CredEnvelope).delivery).toBe('socket');
    expect(registry.size()).toBe(1);
  });

  it('rejects an unregistered peer with CALLER_SPOOFED', async () => {
    const { proxy } = makeProxy(['plugin-good']);
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => ({ pid: 99999, uid: 1000 }),
    });
    await server.start();
    const respText = await sendRequest(
      socketPath,
      JSON.stringify({
        provider: 'aws',
        operation: 'op',
        scope: { region: 'us-east-1' },
      }),
    );
    const resp = JSON.parse(respText.trim()) as SocketResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/peer pid=/);
  });

  it('serializes two concurrent requests', async () => {
    registerLiveBackend({ pid: 1234, uid: 1000, pluginId: 'plugin-good' });
    const order: string[] = [];

    const slowScoper: CredentialScoper = {
      provider: 'aws',
      async scope(op) {
        order.push('start:' + op);
        await new Promise((r) => setTimeout(r, 30));
        order.push('end:' + op);
        return {
          payload: '{}',
          expires_at: '2030-01-01T00:15:00.000Z',
          revoke: async () => undefined,
        };
      },
    };
    const sink: AuditSink = { append: () => undefined };
    const fakeTimer = {} as NodeJS.Timeout;
    const proxy = new CredentialProxy({
      scopers: new Map<Provider, CredentialScoper>([['aws', slowScoper]]),
      privilegedBackends: new Set(['plugin-good']),
      registry: new ActiveTokenRegistry(),
      audit: new CredentialAuditEmitter(sink),
      setTimer: () => fakeTimer,
      delay: () => Promise.resolve(),
      retryDelaysMs: [0],
    });
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => ({ pid: 1234, uid: 1000 }),
    });
    await server.start();
    await Promise.all([
      sendRequest(
        socketPath,
        JSON.stringify({ provider: 'aws', operation: 'A', scope: {} }),
      ),
      sendRequest(
        socketPath,
        JSON.stringify({ provider: 'aws', operation: 'B', scope: {} }),
      ),
    ]);
    // The end of the first call MUST appear before the start of the
    // second — the chain enforces serial dispatch.
    const firstEnd = order.findIndex((e) => e.startsWith('end:'));
    const secondStart = order.findIndex(
      (e, i) => i > firstEnd && e.startsWith('start:'),
    );
    expect(firstEnd).toBeGreaterThan(-1);
    expect(secondStart).toBeGreaterThan(firstEnd);
  });

  it('replies with an error envelope when peerCredFor throws', async () => {
    const { proxy } = makeProxy(['plugin-good']);
    server = new CredProxySocketServer(proxy, {
      socketPath,
      peerCredFor: () => {
        throw new Error('binding-missing');
      },
    });
    await server.start();
    const respText = await sendRequest(
      socketPath,
      JSON.stringify({ provider: 'aws', operation: 'op', scope: {} }),
    );
    const resp = JSON.parse(respText.trim()) as SocketResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/binding-missing/);
  });
});
