/**
 * cred-proxy CLI subcommand tests (SPEC-024-2-04).
 */

import { Writable } from 'node:stream';

import type { ActiveTokenView } from '../../intake/cred-proxy/active-tokens';
import {
  runCredProxyAllow,
  runCredProxyRevoke,
  runCredProxyStatus,
  type CredProxyIpcRequest,
  type CredProxyIpcResponse,
} from '../../intake/cli/cred_proxy_command';

class StringWritable extends Writable {
  public buf = '';
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void) {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

function makeStreams() {
  return { stdout: new StringWritable(), stderr: new StringWritable() };
}

function fakeToken(overrides: Partial<ActiveTokenView> = {}): ActiveTokenView {
  return {
    token_id: '12345678-90ab-cdef-1234-567890abcdef',
    provider: 'aws',
    operation: 'ECS:UpdateService',
    caller: 'plugin-deploy',
    issued_at: new Date(Date.now() - 5_000).toISOString(),
    expires_at: new Date(Date.now() + 895_000).toISOString(),
    ...overrides,
  };
}

describe('cred-proxy status', () => {
  it('prints a table including all required columns', async () => {
    const { stdout, stderr } = makeStreams();
    const send = async (
      _req: CredProxyIpcRequest,
    ): Promise<CredProxyIpcResponse> => ({
      status: 'ok',
      payload: { tokens: [fakeToken()] },
    });
    const code = await runCredProxyStatus(
      { json: false },
      { send, stdout, stderr },
    );
    expect(code).toBe(0);
    expect(stdout.buf).toContain('token_id');
    expect(stdout.buf).toContain('caller');
    expect(stdout.buf).toContain('provider');
    expect(stdout.buf).toContain('operation');
    expect(stdout.buf).toContain('issued_at');
    expect(stdout.buf).toContain('expires_at');
    expect(stdout.buf).toContain('ttl_remaining_s');
    // first 12 chars of token_id
    expect(stdout.buf).toContain('12345678-90a');
  });

  it('--json emits a parseable JSON array with no revoke/timer fields', async () => {
    const { stdout, stderr } = makeStreams();
    const send = async (): Promise<CredProxyIpcResponse> => ({
      status: 'ok',
      payload: { tokens: [fakeToken()] },
    });
    const code = await runCredProxyStatus(
      { json: true },
      { send, stdout, stderr },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.buf);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].revoke).toBeUndefined();
    expect(parsed[0].timer).toBeUndefined();
    expect(parsed[0].token_id).toBe('12345678-90ab-cdef-1234-567890abcdef');
  });

  it('prints (no active tokens) and exits 0 when list is empty', async () => {
    const { stdout, stderr } = makeStreams();
    const send = async (): Promise<CredProxyIpcResponse> => ({
      status: 'ok',
      payload: { tokens: [] },
    });
    const code = await runCredProxyStatus(
      { json: false },
      { send, stdout, stderr },
    );
    expect(code).toBe(0);
    expect(stdout.buf).toContain('(no active tokens)');
  });

  it('exits 1 with daemon-not-running on error response', async () => {
    const { stdout, stderr } = makeStreams();
    const send = async (): Promise<CredProxyIpcResponse> => ({
      status: 'error',
      error: 'daemon is not running',
    });
    const code = await runCredProxyStatus(
      { json: false },
      { send, stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.buf).toContain('daemon is not running');
  });

  it('exits 1 with daemon-not-running when send is omitted (default)', async () => {
    const { stdout, stderr } = makeStreams();
    const code = await runCredProxyStatus(
      { json: false },
      { stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.buf).toContain('daemon is not running');
  });
});

describe('cred-proxy revoke', () => {
  const adminTrue = () => true;
  const adminFalse = () => false;

  it('revokes an existing token and prints confirmation', async () => {
    const { stdout, stderr } = makeStreams();
    const send = async (
      req: CredProxyIpcRequest,
    ): Promise<CredProxyIpcResponse> => {
      expect(req.command).toBe('cred-proxy.revoke');
      expect(req.token_id).toBe('abc');
      return { status: 'ok', payload: { revoked: true } };
    };
    const code = await runCredProxyRevoke(
      { token_id: 'abc' },
      { send, isAdmin: adminTrue, stdout, stderr },
    );
    expect(code).toBe(0);
    expect(stdout.buf).toContain('revoked: abc');
  });

  it('prints (no such token) when daemon reports not_found', async () => {
    const { stdout, stderr } = makeStreams();
    const send = async (): Promise<CredProxyIpcResponse> => ({
      status: 'ok',
      payload: { not_found: true },
    });
    const code = await runCredProxyRevoke(
      { token_id: 'bogus' },
      { send, isAdmin: adminTrue, stdout, stderr },
    );
    expect(code).toBe(0);
    expect(stdout.buf).toContain('(no such token)');
  });

  it('exits 1 with admin-required when isAdmin returns false', async () => {
    const { stdout, stderr } = makeStreams();
    const send = jest.fn();
    const code = await runCredProxyRevoke(
      { token_id: 'abc' },
      { send: send as never, isAdmin: adminFalse, stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.buf).toContain('admin role required');
    expect(send).not.toHaveBeenCalled();
  });

  it('exits 1 with daemon-not-running on default send', async () => {
    const { stdout, stderr } = makeStreams();
    const code = await runCredProxyRevoke(
      { token_id: 'abc' },
      { isAdmin: adminTrue, stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.buf).toContain('daemon is not running');
  });
});

describe('cred-proxy allow', () => {
  const adminTrue = () => true;
  const adminFalse = () => false;

  it('adds a plugin to privileged_backends and prints confirmation', async () => {
    const { stdout, stderr } = makeStreams();
    let received: CredProxyIpcRequest | null = null;
    const send = async (
      req: CredProxyIpcRequest,
    ): Promise<CredProxyIpcResponse> => {
      received = req;
      return { status: 'ok' };
    };
    const code = await runCredProxyAllow(
      { pluginId: 'plugin-x' },
      { send, isAdmin: adminTrue, stdout, stderr },
    );
    expect(code).toBe(0);
    expect(received).not.toBeNull();
    expect(received!.command).toBe('cred-proxy.allow');
    expect(received!.pluginId).toBe('plugin-x');
    expect(stdout.buf).toContain('allowed: plugin-x');
  });

  it('exits 1 with admin-required for non-admin', async () => {
    const { stdout, stderr } = makeStreams();
    const code = await runCredProxyAllow(
      { pluginId: 'plugin-x' },
      { isAdmin: adminFalse, stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.buf).toContain('admin role required');
  });

  it('exits 1 with daemon-not-running on default send', async () => {
    const { stdout, stderr } = makeStreams();
    const code = await runCredProxyAllow(
      { pluginId: 'plugin-x' },
      { isAdmin: adminTrue, stdout, stderr },
    );
    expect(code).toBe(1);
    expect(stderr.buf).toContain('daemon is not running');
  });
});
