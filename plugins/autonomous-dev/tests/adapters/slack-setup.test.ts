/**
 * Unit tests for Slack module setup, app manifest, and request signature
 * verification (SPEC-008-4-01, Tasks 1--3).
 *
 * Test case IDs correspond to the spec's acceptance criteria:
 *   TC-4-01-01 through TC-4-01-12.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { SlackVerifier } from '../../intake/adapters/slack/slack_verifier';
import { SlackClient } from '../../intake/adapters/slack/slack_client';
import { SlackServer } from '../../intake/adapters/slack/slack_server';
import type {
  SlackCommandHandler,
  SlackInteractionHandler,
} from '../../intake/adapters/slack/slack_server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current Unix epoch in seconds. */
function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Compute a valid Slack signature for the given parameters. */
function computeSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(baseString)
    .digest('hex');
  return `v0=${hmac}`;
}

/** Build a minimal mock command handler. */
function buildMockCommandHandler(): SlackCommandHandler {
  return {
    handle: (_req, res) => {
      res.status(200).send('ok');
    },
  };
}

/** Build a minimal mock interaction handler. */
function buildMockInteractionHandler(): SlackInteractionHandler {
  return {
    handle: (_req, res) => {
      res.status(200).send('ok');
    },
  };
}

// ---------------------------------------------------------------------------
// Environment management
// ---------------------------------------------------------------------------

const TEST_SIGNING_SECRET = 'test_signing_secret_abc123';
const TEST_BOT_TOKEN = 'xoxb-FAKE-test-token';

let originalSigningSecret: string | undefined;
let originalBotToken: string | undefined;

beforeEach(() => {
  originalSigningSecret = process.env.SLACK_SIGNING_SECRET;
  originalBotToken = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_SIGNING_SECRET = TEST_SIGNING_SECRET;
  process.env.SLACK_BOT_TOKEN = TEST_BOT_TOKEN;
});

afterEach(() => {
  if (originalSigningSecret !== undefined) {
    process.env.SLACK_SIGNING_SECRET = originalSigningSecret;
  } else {
    delete process.env.SLACK_SIGNING_SECRET;
  }
  if (originalBotToken !== undefined) {
    process.env.SLACK_BOT_TOKEN = originalBotToken;
  } else {
    delete process.env.SLACK_BOT_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// TC-4-01-01: Valid signature
// ---------------------------------------------------------------------------

describe('SlackVerifier', () => {
  test('TC-4-01-01: accepts a valid signature', () => {
    const verifier = new SlackVerifier();
    const timestamp = nowSeconds();
    const body = 'token=abc&text=hello';
    const signature = computeSignature(TEST_SIGNING_SECRET, timestamp, body);

    expect(verifier.verify(timestamp, body, signature)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-02: Invalid signature
  // -------------------------------------------------------------------------

  test('TC-4-01-02: rejects an invalid signature', () => {
    const verifier = new SlackVerifier();
    const timestamp = nowSeconds();
    const body = 'token=abc&text=hello';
    const wrongSignature = 'v0=0000000000000000000000000000000000000000000000000000000000000000';

    expect(verifier.verify(timestamp, body, wrongSignature)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-03: Stale timestamp (> 5 minutes old)
  // -------------------------------------------------------------------------

  test('TC-4-01-03: rejects stale timestamp older than 5 minutes', () => {
    const verifier = new SlackVerifier();
    // 6 minutes ago
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 360);
    const body = 'token=abc&text=hello';
    const signature = computeSignature(TEST_SIGNING_SECRET, staleTimestamp, body);

    expect(verifier.verify(staleTimestamp, body, signature)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-04: Fresh timestamp (2 seconds ago, valid sig)
  // -------------------------------------------------------------------------

  test('TC-4-01-04: accepts fresh timestamp with valid signature', () => {
    const verifier = new SlackVerifier();
    const freshTimestamp = String(Math.floor(Date.now() / 1000) - 2);
    const body = 'token=abc&text=status';
    const signature = computeSignature(TEST_SIGNING_SECRET, freshTimestamp, body);

    expect(verifier.verify(freshTimestamp, body, signature)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-05: Buffer length mismatch -- no crash
  // -------------------------------------------------------------------------

  test('TC-4-01-05: rejects signature of different length without crashing', () => {
    const verifier = new SlackVerifier();
    const timestamp = nowSeconds();
    const body = 'token=abc&text=hello';
    const shortSignature = 'v0=tooshort';

    expect(verifier.verify(timestamp, body, shortSignature)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-06: Missing signing secret
  // -------------------------------------------------------------------------

  test('TC-4-01-06: constructor throws when SLACK_SIGNING_SECRET is missing', () => {
    delete process.env.SLACK_SIGNING_SECRET;

    expect(() => new SlackVerifier()).toThrow(
      'SLACK_SIGNING_SECRET environment variable is not set',
    );
  });
});

// ---------------------------------------------------------------------------
// TC-4-01-07: Missing bot token
// ---------------------------------------------------------------------------

describe('SlackClient', () => {
  test('TC-4-01-07: constructor throws when SLACK_BOT_TOKEN is missing', () => {
    delete process.env.SLACK_BOT_TOKEN;

    expect(() => new SlackClient()).toThrow(
      'SLACK_BOT_TOKEN environment variable is not set',
    );
  });

  test('getClient returns a WebClient instance', () => {
    const client = new SlackClient();
    expect(client.getClient()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TC-4-01-08 through TC-4-01-10: App manifest validation
// ---------------------------------------------------------------------------

describe('Slack App Manifest', () => {
  const manifestPath = path.resolve(
    __dirname,
    '../../intake/adapters/slack/slack-app-manifest.yaml',
  );

  let manifest: Record<string, unknown>;

  beforeAll(() => {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    manifest = yaml.parse(raw);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-08: Manifest command count
  // -------------------------------------------------------------------------

  test('TC-4-01-08: defines exactly 10 slash commands', () => {
    const features = manifest.features as Record<string, unknown>;
    const commands = features.slash_commands as Array<Record<string, unknown>>;

    expect(commands).toHaveLength(10);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-09: Manifest scopes
  // -------------------------------------------------------------------------

  test('TC-4-01-09: includes all 7 required bot scopes', () => {
    const oauthConfig = manifest.oauth_config as Record<string, unknown>;
    const scopes = oauthConfig.scopes as Record<string, string[]>;
    const botScopes = scopes.bot;

    const requiredScopes = [
      'commands',
      'chat:write',
      'chat:write.public',
      'im:write',
      'users:read',
      'channels:read',
      'groups:read',
    ];

    for (const scope of requiredScopes) {
      expect(botScopes).toContain(scope);
    }
    expect(botScopes).toHaveLength(7);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-10: Manifest should_escape settings
  // -------------------------------------------------------------------------

  test('TC-4-01-10: ad-submit and ad-feedback have should_escape true; others false', () => {
    const features = manifest.features as Record<string, unknown>;
    const commands = features.slash_commands as Array<Record<string, unknown>>;

    const shouldEscapeTrue = ['/ad-submit', '/ad-feedback'];

    for (const cmd of commands) {
      if (shouldEscapeTrue.includes(cmd.command as string)) {
        expect(cmd.should_escape).toBe(true);
      } else {
        expect(cmd.should_escape).toBe(false);
      }
    }
  });

  test('manifest defines correct command names', () => {
    const features = manifest.features as Record<string, unknown>;
    const commands = features.slash_commands as Array<Record<string, unknown>>;
    const commandNames = commands.map((c) => c.command);

    expect(commandNames).toEqual([
      '/ad-submit',
      '/ad-status',
      '/ad-list',
      '/ad-cancel',
      '/ad-pause',
      '/ad-resume',
      '/ad-priority',
      '/ad-logs',
      '/ad-feedback',
      '/ad-kill',
    ]);
  });
});

// ---------------------------------------------------------------------------
// TC-4-01-11 & TC-4-01-12: Server middleware and routes
// ---------------------------------------------------------------------------

describe('SlackServer', () => {
  let server: SlackServer;

  beforeEach(() => {
    const verifier = new SlackVerifier();
    server = new SlackServer(
      verifier,
      buildMockCommandHandler(),
      buildMockInteractionHandler(),
    );
  });

  // -------------------------------------------------------------------------
  // TC-4-01-11: Request without valid signature returns 401
  // -------------------------------------------------------------------------

  test('TC-4-01-11: rejects request without valid signature with HTTP 401', async () => {
    // Dynamically import supertest (or manually build a request)
    const supertest = await import('supertest');
    const request = supertest.default;

    const res = await request(server.getApp())
      .post('/slack/commands')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp', nowSeconds())
      .set('x-slack-signature', 'v0=invalidsignature')
      .send('command=%2Fad-status&text=REQ-000042');

    expect(res.status).toBe(401);
  });

  test('rejects request with missing signature headers with HTTP 401', async () => {
    const supertest = await import('supertest');
    const request = supertest.default;

    const res = await request(server.getApp())
      .post('/slack/commands')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('command=%2Fad-status&text=REQ-000042');

    expect(res.status).toBe(401);
  });

  test('accepts request with valid signature', async () => {
    const supertest = await import('supertest');
    const request = supertest.default;

    const timestamp = nowSeconds();
    const body = 'command=%2Fad-status&text=REQ-000042';
    const signature = computeSignature(TEST_SIGNING_SECRET, timestamp, body);

    const res = await request(server.getApp())
      .post('/slack/commands')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', signature)
      .send(body);

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // TC-4-01-12: 3 POST routes registered at correct paths
  // -------------------------------------------------------------------------

  test('TC-4-01-12: has 3 POST routes at /slack/commands, /slack/interactions, /slack/events', () => {
    const app = server.getApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes: Array<{ route?: { path: string; methods: Record<string, boolean> } }> =
      app._router.stack.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (layer: any) => layer.route && layer.route.methods.post,
      );

    const paths = routes.map((r) => r.route!.path);

    expect(paths).toContain('/slack/commands');
    expect(paths).toContain('/slack/interactions');
    expect(paths).toContain('/slack/events');
    expect(routes).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Server lifecycle
  // -------------------------------------------------------------------------

  test('start and stop lifecycle works', async () => {
    await server.start(0); // port 0 = random available port
    await server.stop();
  });

  test('stop is safe to call when server is not started', async () => {
    await server.stop(); // should not throw
  });
});
