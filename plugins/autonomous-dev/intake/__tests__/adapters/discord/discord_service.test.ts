/**
 * Smoke tests for the DiscordService orchestrator (SPEC-011-3-01..05).
 *
 * Focuses on pure functions and constructor-time validation that don't
 * require a live Discord client.  Full integration coverage of start(),
 * reconnection, slash command registration, and signal-handler wiring
 * is documented as a follow-up — the WIP PR notes the architecture
 * overlap with the existing `setupInteractionListener()` on
 * DiscordAdapter that should be resolved before broader test coverage
 * lands.
 *
 * @module discord_service.test
 */

import {
  ConfigurationError,
  DiscordService,
  StartupError,
  loadConfigFromEnv,
  redactToken,
  type DiscordServiceConfig,
} from '../../../adapters/discord/main';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN =
  'M1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-.';
const VALID_APP_ID = '1234567890123456789';
const VALID_GUILD_ID = '9876543210987654321';

function baseConfig(
  overrides: Partial<DiscordServiceConfig> = {},
): DiscordServiceConfig {
  return {
    botToken: VALID_TOKEN,
    applicationId: VALID_APP_ID,
    guildId: VALID_GUILD_ID,
    enabled: true,
    readyTimeoutMs: 30_000,
    shutdownDrainMs: 5_000,
    ...overrides,
  };
}

// Minimal stub adapter — DiscordService never calls into it during
// construction-only tests.
const stubAdapter = {} as unknown as Parameters<typeof DiscordService>[1];

const stubLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

afterEach(() => {
  jest.clearAllMocks();
});

// ===========================================================================
// Group 1 — redactToken
// ===========================================================================

describe('redactToken', () => {
  test('replaces 50+ char token-shaped runs with [REDACTED]', () => {
    const out = redactToken(`prefix ${VALID_TOKEN} suffix`);
    expect(out).toBe('prefix [REDACTED] suffix');
  });

  test('preserves short strings (no false positives)', () => {
    expect(redactToken('hello world')).toBe('hello world');
    expect(redactToken('short_token_123')).toBe('short_token_123');
  });

  test('redacts multiple tokens in one string', () => {
    const t1 = VALID_TOKEN;
    const t2 = VALID_TOKEN.replace('M', 'N');
    expect(redactToken(`${t1} and ${t2}`)).toBe('[REDACTED] and [REDACTED]');
  });

  test('passes through empty string', () => {
    expect(redactToken('')).toBe('');
  });

  test('handles strings containing the token regex characters but under length', () => {
    const safeRun = 'a'.repeat(49);
    expect(redactToken(safeRun)).toBe(safeRun);
  });
});

// ===========================================================================
// Group 2 — loadConfigFromEnv
// ===========================================================================

describe('loadConfigFromEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_ENABLED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('reads botToken from DISCORD_BOT_TOKEN', () => {
    process.env.DISCORD_BOT_TOKEN = VALID_TOKEN;
    expect(loadConfigFromEnv().botToken).toBe(VALID_TOKEN);
  });

  test('reads applicationId from DISCORD_APPLICATION_ID', () => {
    process.env.DISCORD_APPLICATION_ID = VALID_APP_ID;
    expect(loadConfigFromEnv().applicationId).toBe(VALID_APP_ID);
  });

  test('reads optional guildId from DISCORD_GUILD_ID', () => {
    process.env.DISCORD_GUILD_ID = VALID_GUILD_ID;
    expect(loadConfigFromEnv().guildId).toBe(VALID_GUILD_ID);
  });

  test('guildId is undefined when env var unset', () => {
    expect(loadConfigFromEnv().guildId).toBeUndefined();
  });

  test('enabled defaults to true when DISCORD_ENABLED unset', () => {
    expect(loadConfigFromEnv().enabled).toBe(true);
  });

  test('enabled true when DISCORD_ENABLED=true', () => {
    process.env.DISCORD_ENABLED = 'true';
    expect(loadConfigFromEnv().enabled).toBe(true);
  });

  test('enabled false when DISCORD_ENABLED=false', () => {
    process.env.DISCORD_ENABLED = 'false';
    expect(loadConfigFromEnv().enabled).toBe(false);
  });

  test('returns sane default timeouts', () => {
    const cfg = loadConfigFromEnv();
    expect(cfg.readyTimeoutMs).toBe(30_000);
    expect(cfg.shutdownDrainMs).toBe(5_000);
  });

  test('missing env vars yield empty strings (not undefined)', () => {
    const cfg = loadConfigFromEnv();
    expect(cfg.botToken).toBe('');
    expect(cfg.applicationId).toBe('');
  });
});

// ===========================================================================
// Group 3 — DiscordService constructor / validateConfig
// ===========================================================================

describe('DiscordService constructor validation', () => {
  test('valid config constructs without throwing', () => {
    expect(
      () => new DiscordService(baseConfig(), stubAdapter, stubLogger),
    ).not.toThrow();
  });

  test('disabled channel throws ConfigurationError', () => {
    expect(
      () =>
        new DiscordService(
          baseConfig({ enabled: false }),
          stubAdapter,
          stubLogger,
        ),
    ).toThrow(ConfigurationError);
  });

  test('disabled error message names the config flag', () => {
    try {
      new DiscordService(
        baseConfig({ enabled: false }),
        stubAdapter,
        stubLogger,
      );
    } catch (err) {
      expect((err as Error).message).toContain(
        'intake.channels.discord.enabled',
      );
    }
  });

  test('missing botToken throws ConfigurationError naming the env var', () => {
    expect(
      () =>
        new DiscordService(
          baseConfig({ botToken: '' }),
          stubAdapter,
          stubLogger,
        ),
    ).toThrow(/DISCORD_BOT_TOKEN/);
  });

  test('missing applicationId throws ConfigurationError naming the env var', () => {
    expect(
      () =>
        new DiscordService(
          baseConfig({ applicationId: '' }),
          stubAdapter,
          stubLogger,
        ),
    ).toThrow(/DISCORD_APPLICATION_ID/);
  });

  test('malformed botToken throws (and message does NOT contain the token)', () => {
    const badToken = 'too-short';
    let captured = '';
    try {
      new DiscordService(
        baseConfig({ botToken: badToken }),
        stubAdapter,
        stubLogger,
      );
    } catch (err) {
      captured = (err as Error).message;
    }
    expect(captured).toMatch(/DISCORD_BOT_TOKEN/);
    expect(captured).not.toContain(badToken);
  });
});

// ===========================================================================
// Group 4 — Test accessors before start()
// ===========================================================================

describe('DiscordService accessors before start()', () => {
  test('isShutdownRequested is false', () => {
    const svc = new DiscordService(baseConfig(), stubAdapter, stubLogger);
    expect(svc.isShutdownRequested).toBe(false);
  });

  test('inflightCount is 0', () => {
    const svc = new DiscordService(baseConfig(), stubAdapter, stubLogger);
    expect(svc.inflightCount).toBe(0);
  });

  test('getClient() returns null before start()', () => {
    const svc = new DiscordService(baseConfig(), stubAdapter, stubLogger);
    expect(svc.getClient()).toBeNull();
  });
});

// ===========================================================================
// Group 5 — Custom error types
// ===========================================================================

describe('Custom error types', () => {
  test('ConfigurationError has the right name', () => {
    const err = new ConfigurationError('oops');
    expect(err.name).toBe('ConfigurationError');
    expect(err.message).toBe('oops');
    expect(err).toBeInstanceOf(Error);
  });

  test('StartupError has the right name', () => {
    const err = new StartupError('startup failed');
    expect(err.name).toBe('StartupError');
    expect(err.message).toBe('startup failed');
    expect(err).toBeInstanceOf(Error);
  });
});
