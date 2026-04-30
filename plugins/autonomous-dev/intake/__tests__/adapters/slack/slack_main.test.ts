/**
 * Smoke tests for the Slack service helpers (SPEC-011-4-01..05).
 *
 * Focuses on pure functions and small classes exported from
 * `intake/adapters/slack/main.ts`: rate limiting, signature middleware,
 * payload mapping, error formatting, config validation, response_url
 * posting, signature computation.
 *
 * The full SlackService orchestrator class (which would wire HTTP server,
 * Socket Mode client, signature middleware, command/interaction
 * dispatch, rate limiting, and lifecycle) is NOT yet implemented in this
 * branch — see PR notes.  Once that lands, the matching lifecycle test
 * suite belongs alongside this file.
 *
 * @module slack_main.test
 */

import * as crypto from 'crypto';
import {
  DEFAULT_SLACK_SERVICE_CONFIG,
  DEFERRED_SENTINEL,
  InMemoryInboundRateLimiter,
  SLACK_CONTEXT_FLAG,
  SUPPORTED_SLASH_SUBCOMMANDS,
  computeSlackSignature,
  formatError,
  getSlackContext,
  mapInteractionPayload,
  mapSlashCommandPayload,
  postToResponseUrl,
  validateSlackServiceConfig,
  verifySlackSignatureMiddleware,
  type FetchLike,
  type SlackInteractionPayload,
  type SlackServiceConfig,
  type SlackServiceLogger,
  type SlackSlashCommandBody,
} from '../../../adapters/slack/main';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): SlackServiceLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function defaultConfig(
  overrides: Partial<SlackServiceConfig> = {},
): SlackServiceConfig {
  return { ...DEFAULT_SLACK_SERVICE_CONFIG, ...overrides };
}

const SIGNING_SECRET = 'test_signing_secret_value';

// ===========================================================================
// Group 1 — InMemoryInboundRateLimiter
// ===========================================================================

describe('InMemoryInboundRateLimiter', () => {
  test('first request is allowed', async () => {
    const lim = new InMemoryInboundRateLimiter();
    const r = await lim.check({ key: 'WS1', perMinute: 5 });
    expect(r.allowed).toBe(true);
  });

  test('allows up to perMinute requests in the same window', async () => {
    const lim = new InMemoryInboundRateLimiter();
    const results: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      results.push((await lim.check({ key: 'WS1', perMinute: 3 })).allowed);
    }
    expect(results).toEqual([true, true, true]);
  });

  test('rejects once perMinute is exceeded with retryAfterMs', async () => {
    const lim = new InMemoryInboundRateLimiter();
    for (let i = 0; i < 2; i++) {
      await lim.check({ key: 'WS1', perMinute: 2 });
    }
    const r = await lim.check({ key: 'WS1', perMinute: 2 });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  test('separate keys do not interfere', async () => {
    const lim = new InMemoryInboundRateLimiter();
    await lim.check({ key: 'WS1', perMinute: 1 });
    const r = await lim.check({ key: 'WS2', perMinute: 1 });
    expect(r.allowed).toBe(true);
  });
});

// ===========================================================================
// Group 2 — computeSlackSignature
// ===========================================================================

describe('computeSlackSignature', () => {
  test('produces v0=<hex> signature', () => {
    const sig = computeSlackSignature(SIGNING_SECRET, 1700000000, 'body=1');
    expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  test('matches HMAC of v0:timestamp:body', () => {
    const ts = 1700000000;
    const body = 'token=foo&team_id=T1';
    const expected =
      'v0=' +
      crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(`v0:${ts}:${body}`)
        .digest('hex');
    expect(computeSlackSignature(SIGNING_SECRET, ts, body)).toBe(expected);
  });

  test('different bodies produce different signatures', () => {
    const a = computeSlackSignature(SIGNING_SECRET, 100, 'a');
    const b = computeSlackSignature(SIGNING_SECRET, 100, 'b');
    expect(a).not.toBe(b);
  });

  test('accepts string and number timestamps', () => {
    const a = computeSlackSignature(SIGNING_SECRET, 1700000000, 'x');
    const b = computeSlackSignature(SIGNING_SECRET, '1700000000', 'x');
    expect(a).toBe(b);
  });
});

// ===========================================================================
// Group 3 — verifySlackSignatureMiddleware (skipped — see note below)
// ===========================================================================

// The middleware takes a SlackVerifier instance (not a signing-secret
// string) and uses req.header() / res.status().json().  Authoring a fully
// faithful mock requires either instantiating SlackVerifier (which
// requires SLACK_SIGNING_SECRET env at construction time) or constructing
// a typed fake of its public surface.  Both belong with the broader
// SlackService lifecycle suite that has not yet landed.  The
// computeSlackSignature primitive that the middleware delegates to is
// covered above in Group 2.
describe.skip('verifySlackSignatureMiddleware', () => {
  test('placeholder', () => {
    expect(verifySlackSignatureMiddleware).toBeDefined();
  });
});

// ===========================================================================
// Group 4 — mapSlashCommandPayload
// ===========================================================================

describe('mapSlashCommandPayload', () => {
  function body(o: Partial<SlackSlashCommandBody> = {}): SlackSlashCommandBody {
    return {
      command: '/request-status',
      text: 'REQ-000001',
      user_id: 'U123',
      team_id: 'T123',
      channel_id: 'C123',
      ...o,
    } as SlackSlashCommandBody;
  }

  test('maps /request-status REQ-000001 to commandName=status', () => {
    const cmd = mapSlashCommandPayload(body());
    expect(cmd.commandName).toBe('status');
    expect(cmd.args).toContain('REQ-000001');
    expect(cmd.source.channelType).toBe('slack');
    expect(cmd.source.userId).toBe('U123');
  });

  test('maps /ad- prefix as backwards-compat', () => {
    const cmd = mapSlashCommandPayload(
      body({ command: '/ad-list', text: '' }),
    );
    expect(cmd.commandName).toBe('list');
  });

  test('throws on unsupported subcommand', () => {
    expect(() =>
      mapSlashCommandPayload(body({ command: '/request-frobnicate' })),
    ).toThrow(/invalid_subcommand/);
  });

  test('throws on unrecognised command prefix', () => {
    expect(() => mapSlashCommandPayload(body({ command: '/random' }))).toThrow(
      /unknown_command/,
    );
  });

  test('throws on empty command', () => {
    expect(() => mapSlashCommandPayload(body({ command: '' }))).toThrow(
      /unknown_command/,
    );
  });

  test('round-trip via getSlackContext recovers workspace/channel info', () => {
    const cmd = mapSlashCommandPayload(
      body({ team_id: 'TWORK', channel_id: 'CCHAN', team_domain: 'acme' }),
    );
    const ctx = getSlackContext(cmd);
    expect(ctx).toBeDefined();
    expect(ctx?.workspaceId).toBe('TWORK');
    expect(ctx?.channelId).toBe('CCHAN');
    expect(ctx?.workspaceDomain).toBe('acme');
  });

  test('isDM flag set when channel_id starts with D', () => {
    const cmd = mapSlashCommandPayload(body({ channel_id: 'DABC' }));
    const ctx = getSlackContext(cmd);
    expect(ctx?.isDM).toBe(true);
  });

  test('isDM false for channel-prefixed channel_id', () => {
    const cmd = mapSlashCommandPayload(body({ channel_id: 'CABC' }));
    const ctx = getSlackContext(cmd);
    expect(ctx?.isDM).toBe(false);
  });
});

// ===========================================================================
// Group 5 — getSlackContext
// ===========================================================================

describe('getSlackContext', () => {
  test('returns undefined for non-Slack-sourced commands', () => {
    expect(
      getSlackContext({
        commandName: 'status',
        args: [],
        flags: {},
        rawText: '',
        source: { channelType: 'cli', userId: 'U', timestamp: new Date() },
      }),
    ).toBeUndefined();
  });

  test('returns undefined when context flag is malformed JSON', () => {
    expect(
      getSlackContext({
        commandName: 'status',
        args: [],
        flags: { [SLACK_CONTEXT_FLAG]: 'not-json{' },
        rawText: '',
        source: { channelType: 'slack', userId: 'U', timestamp: new Date() },
      }),
    ).toBeUndefined();
  });
});

// ===========================================================================
// Group 6 — mapInteractionPayload
// ===========================================================================

describe('mapInteractionPayload', () => {
  // Concrete payload shapes (block IDs, action IDs, callback IDs) are
  // wired in the slack_components / slack_interaction_handler modules.
  // We only exercise the export's existence + view_closed noop here;
  // payload-shape coverage belongs in a focused interaction-handler test
  // suite that uses real fixture payloads.
  test('mapInteractionPayload is exported', () => {
    expect(typeof mapInteractionPayload).toBe('function');
  });

  test('view_closed maps to a non-command dispatch', () => {
    const payload = {
      type: 'view_closed',
      user: { id: 'U' },
      team: { id: 'T' },
    } as unknown as SlackInteractionPayload;
    const dispatch = mapInteractionPayload(payload);
    expect(dispatch.kind).not.toBe('command');
  });
});

// ===========================================================================
// Group 7 — formatError
// ===========================================================================

describe('formatError', () => {
  test('returns ephemeral response with warning prefix', () => {
    const r = formatError({ message: 'boom', code: 'INTERNAL_ERROR' });
    expect(r.response_type).toBe('ephemeral');
    expect(JSON.stringify(r.blocks)).toContain(':warning:');
  });

  test('includes request id context block when supplied', () => {
    const r = formatError({ message: 'oops', code: 'INTERNAL_ERROR' }, 'REQ-000123');
    expect(JSON.stringify(r.blocks)).toContain('REQ-000123');
  });

  test('falls back to INTERNAL_ERROR for unknown codes', () => {
    const r = formatError({ message: 'mystery' } as unknown as Parameters<
      typeof formatError
    >[0]);
    expect(JSON.stringify(r.blocks)).toContain('INTERNAL_ERROR');
  });
});

// ===========================================================================
// Group 8 — validateSlackServiceConfig
// ===========================================================================

describe('validateSlackServiceConfig', () => {
  const baseEnv = {
    SLACK_SIGNING_SECRET: 'secret',
    SLACK_BOT_TOKEN: 'xoxb-token',
  };

  test('valid config + env passes', () => {
    expect(() =>
      validateSlackServiceConfig(defaultConfig(), baseEnv),
    ).not.toThrow();
  });

  test('invalid port throws', () => {
    expect(() =>
      validateSlackServiceConfig(defaultConfig({ port: 0 }), baseEnv),
    ).toThrow(/invalid port/);
    expect(() =>
      validateSlackServiceConfig(defaultConfig({ port: -1 }), baseEnv),
    ).toThrow(/invalid port/);
    expect(() =>
      validateSlackServiceConfig(
        defaultConfig({ port: 1.5 as unknown as number }),
        baseEnv,
      ),
    ).toThrow(/invalid port/);
  });

  test('out-of-range timestamp tolerance throws', () => {
    expect(() =>
      validateSlackServiceConfig(
        defaultConfig({ timestamp_tolerance_seconds: 30 }),
        baseEnv,
      ),
    ).toThrow(/timestamp_tolerance_seconds/);
    expect(() =>
      validateSlackServiceConfig(
        defaultConfig({ timestamp_tolerance_seconds: 700 }),
        baseEnv,
      ),
    ).toThrow(/timestamp_tolerance_seconds/);
  });

  test('zero perWorkspacePerMinute throws', () => {
    expect(() =>
      validateSlackServiceConfig(
        defaultConfig({ rate_limits: { perWorkspacePerMinute: 0 } }),
        baseEnv,
      ),
    ).toThrow();
  });
});

// ===========================================================================
// Group 9 — postToResponseUrl
// ===========================================================================

describe('postToResponseUrl', () => {
  test('POSTs JSON to the provided url', async () => {
    const calls: Array<{
      url: string;
      init: { method: string; body: string };
    }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    };
    await postToResponseUrl(
      'https://hooks.slack.com/x',
      { text: 'hello' },
      fetchFn,
      silentLogger(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.slack.com/x');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: 'hello' });
  });

  test('swallows fetch errors and logs them', async () => {
    const logger = silentLogger();
    const fetchFn: FetchLike = async () => {
      throw new Error('network down');
    };
    await expect(
      postToResponseUrl('https://x', { text: 'y' }, fetchFn, logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

// ===========================================================================
// Group 10 — module-level exports
// ===========================================================================

describe('module-level exports', () => {
  test('SUPPORTED_SLASH_SUBCOMMANDS contains the 10 documented verbs', () => {
    const expected = [
      'submit',
      'status',
      'list',
      'cancel',
      'pause',
      'resume',
      'priority',
      'logs',
      'feedback',
      'kill',
    ];
    for (const v of expected) {
      expect(SUPPORTED_SLASH_SUBCOMMANDS).toContain(v);
    }
  });

  test('DEFERRED_SENTINEL is a stable string sentinel', () => {
    expect(typeof DEFERRED_SENTINEL).toBe('string');
    expect(DEFERRED_SENTINEL.length).toBeGreaterThan(0);
  });

  test('DEFAULT_SLACK_SERVICE_CONFIG has spec-conforming defaults', () => {
    expect(DEFAULT_SLACK_SERVICE_CONFIG.port).toBeGreaterThan(0);
    expect(DEFAULT_SLACK_SERVICE_CONFIG.timestamp_tolerance_seconds).toBe(300);
    expect(
      DEFAULT_SLACK_SERVICE_CONFIG.rate_limits.perWorkspacePerMinute,
    ).toBeGreaterThan(0);
  });
});
