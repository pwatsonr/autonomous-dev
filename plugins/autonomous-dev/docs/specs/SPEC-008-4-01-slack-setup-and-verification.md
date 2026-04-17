# SPEC-008-4-01: Slack Module Setup, App Manifest & Request Signature Verification

## Metadata
- **Parent Plan**: PLAN-008-4
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 6 hours

## Description

Set up the Slack bot module with `@slack/web-api`, create the Slack app manifest defining all 10 slash commands and bot scopes, and implement HMAC-SHA256 request signature verification with replay attack prevention.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/slack/slack_client.ts` | Create |
| `intake/adapters/slack/slack_server.ts` | Create |
| `intake/adapters/slack/slack-app-manifest.yaml` | Create |
| `intake/adapters/slack/slack_verifier.ts` | Create |
| `package.json` | Modify (add @slack/web-api) |

## Implementation Details

### Task 1: Slack Module and Dependencies

**Dependencies:**
```json
{
  "@slack/web-api": "^7.0.0",
  "@slack/socket-mode": "^2.0.0"  // optional, for Socket Mode fallback
}
```

**HTTP server (`slack_server.ts`):**

```typescript
import express from 'express';

class SlackServer {
  private app: express.Application;
  private server: http.Server | null = null;

  constructor(
    private verifier: SlackVerifier,
    private commandHandler: SlackCommandHandler,
    private interactionHandler: SlackInteractionHandler,
  ) {
    this.app = express();

    // Raw body parser for signature verification
    this.app.use('/slack', express.raw({ type: 'application/x-www-form-urlencoded' }));

    // Verify all Slack requests
    this.app.use('/slack', (req, res, next) => {
      const timestamp = req.headers['x-slack-request-timestamp'] as string;
      const signature = req.headers['x-slack-signature'] as string;
      const body = req.body.toString();

      if (!this.verifier.verify(timestamp, body, signature)) {
        res.status(401).send('Invalid signature');
        return;
      }
      // Re-parse body as form-encoded after verification
      req.body = new URLSearchParams(body);
      next();
    });

    this.app.post('/slack/commands', this.commandHandler.handle.bind(this.commandHandler));
    this.app.post('/slack/interactions', this.interactionHandler.handle.bind(this.interactionHandler));
    this.app.post('/slack/events', this.handleEvents.bind(this));
  }

  async start(port: number): Promise<void> {
    this.server = this.app.listen(port, () => {
      logger.info('Slack HTTP server started', { port });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
```

**Slack client (`slack_client.ts`):**

```typescript
import { WebClient } from '@slack/web-api';

class SlackClient {
  private client: WebClient;

  constructor() {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is not set');
    }
    this.client = new WebClient(token);
  }

  getClient(): WebClient {
    return this.client;
  }
}
```

**Endpoints:**
- `POST /slack/commands` -- slash command handler
- `POST /slack/interactions` -- button clicks, modal submissions
- `POST /slack/events` -- event subscriptions (message.channels, etc.)

### Task 2: Slack App Manifest

The full manifest from TDD section 3.4.1:

```yaml
display_information:
  name: Autonomous Dev
  description: Autonomous development pipeline intake and status
  background_color: "#2c3e50"

features:
  bot_user:
    display_name: autonomous-dev
    always_online: true
  slash_commands:
    - command: /ad-submit
      url: https://${SLACK_HOST}/slack/commands
      description: Submit a new request to the pipeline
      usage_hint: "[description] --priority high --repo owner/name"
      should_escape: true
    - command: /ad-status
      url: https://${SLACK_HOST}/slack/commands
      description: View request status
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-list
      url: https://${SLACK_HOST}/slack/commands
      description: List all active requests
      usage_hint: "[--priority high|normal|low]"
      should_escape: false
    - command: /ad-cancel
      url: https://${SLACK_HOST}/slack/commands
      description: Cancel a request
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-pause
      url: https://${SLACK_HOST}/slack/commands
      description: Pause a request
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-resume
      url: https://${SLACK_HOST}/slack/commands
      description: Resume a paused request
      usage_hint: "REQ-000042"
      should_escape: false
    - command: /ad-priority
      url: https://${SLACK_HOST}/slack/commands
      description: Change request priority
      usage_hint: "REQ-000042 high|normal|low"
      should_escape: false
    - command: /ad-logs
      url: https://${SLACK_HOST}/slack/commands
      description: View request activity log
      usage_hint: "REQ-000042 [--all]"
      should_escape: false
    - command: /ad-feedback
      url: https://${SLACK_HOST}/slack/commands
      description: Send feedback to an active request
      usage_hint: "REQ-000042 [message]"
      should_escape: true
    - command: /ad-kill
      url: https://${SLACK_HOST}/slack/commands
      description: Emergency stop all requests (admin only)
      should_escape: false

oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
      - im:write
      - users:read
      - channels:read
      - groups:read

settings:
  interactivity:
    is_enabled: true
    request_url: https://${SLACK_HOST}/slack/interactions
  event_subscriptions:
    request_url: https://${SLACK_HOST}/slack/events
    bot_events:
      - message.channels
      - message.groups
      - message.im
  org_deploy_enabled: false
  socket_mode_enabled: false
```

### Task 3: Request Signature Verification

```typescript
import crypto from 'crypto';

class SlackVerifier {
  private signingSecret: string;

  constructor() {
    this.signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
    if (!this.signingSecret) {
      throw new Error('SLACK_SIGNING_SECRET environment variable is not set');
    }
  }

  verify(timestamp: string, body: string, signature: string): boolean {
    // Replay attack prevention: reject if timestamp > 5 minutes old
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    if (parseInt(timestamp, 10) < fiveMinutesAgo) {
      logger.warn('Slack request rejected: stale timestamp', { timestamp });
      return false;
    }

    // Compute expected HMAC
    const baseString = `v0:${timestamp}:${body}`;
    const hmac = crypto.createHmac('sha256', this.signingSecret)
      .update(baseString)
      .digest('hex');
    const expectedSignature = `v0=${hmac}`;

    // Constant-time comparison
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature)
      );
    } catch {
      // Buffer length mismatch
      return false;
    }
  }
}
```

**Security properties:**
- **Replay prevention**: Rejects requests with timestamps older than 5 minutes.
- **Constant-time comparison**: Uses `crypto.timingSafeEqual` to prevent timing attacks.
- **Buffer length mismatch**: Catches `RangeError` from `timingSafeEqual` when signature lengths differ.

## Acceptance Criteria

1. `@slack/web-api` added as dependency.
2. HTTP server exposes `/slack/commands`, `/slack/interactions`, `/slack/events` endpoints.
3. Bot token loaded from `SLACK_BOT_TOKEN`; throws on missing.
4. Signing secret loaded from `SLACK_SIGNING_SECRET`; throws on missing.
5. App manifest defines all 10 slash commands with correct URLs, usage hints, and `should_escape` settings.
6. Bot scopes include: `commands`, `chat:write`, `chat:write.public`, `im:write`, `users:read`, `channels:read`, `groups:read`.
7. Signature verification accepts valid signatures.
8. Signature verification rejects stale timestamps (> 5 minutes).
9. Signature verification rejects invalid signatures.
10. Constant-time comparison used (not `===`).

## Test Cases

1. **Valid signature**: Compute HMAC with known signing secret, timestamp, and body; verify `verify()` returns true.
2. **Invalid signature**: Pass wrong signature; verify returns false.
3. **Stale timestamp**: Pass timestamp 6 minutes old; verify returns false.
4. **Fresh timestamp**: Pass timestamp from 2 seconds ago; verify returns true (with valid sig).
5. **Buffer length mismatch**: Pass signature of different length; verify returns false (no crash).
6. **Missing signing secret**: Unset env var; verify constructor throws.
7. **Missing bot token**: Unset env var; verify `SlackClient` constructor throws.
8. **Manifest command count**: Parse manifest YAML; verify 10 slash commands defined.
9. **Manifest scopes**: Parse manifest; verify all 7 bot scopes present.
10. **Manifest should_escape**: Verify `ad-submit` and `ad-feedback` have `should_escape: true`; others have `false`.
11. **Server middleware**: Send request without valid signature; verify HTTP 401 response.
12. **Server routes**: Verify 3 POST routes registered at correct paths.
