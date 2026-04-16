/**
 * Slack HTTP Server -- Express-based server for Slack slash commands,
 * interactions, and event subscriptions.
 *
 * Implements SPEC-008-4-01, Task 1 (server portion).
 *
 * Endpoints:
 * - POST /slack/commands     -- Slash command handler
 * - POST /slack/interactions -- Button clicks, modal submissions
 * - POST /slack/events       -- Event subscriptions (message.channels, etc.)
 *
 * All requests under /slack are verified via HMAC-SHA256 signature
 * verification before being dispatched to their respective handlers.
 *
 * @module slack_server
 */

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { SlackVerifier } from './slack_verifier';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the Slack server.
 */
export interface SlackServerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Default no-op logger (used when none is injected)
// ---------------------------------------------------------------------------

const noopLogger: SlackServerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Handler interfaces
// ---------------------------------------------------------------------------

/**
 * Handler for Slack slash commands.
 * Receives the parsed body (as URLSearchParams) via `req.body`.
 */
export interface SlackCommandHandler {
  handle(req: Request, res: Response): void | Promise<void>;
}

/**
 * Handler for Slack interactive payloads (button clicks, modal submissions).
 * Receives the parsed body (as URLSearchParams) via `req.body`.
 */
export interface SlackInteractionHandler {
  handle(req: Request, res: Response): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// SlackServer
// ---------------------------------------------------------------------------

/**
 * Express-based HTTP server that receives Slack webhook requests.
 *
 * All requests to `/slack/*` are:
 * 1. Parsed as raw bodies (for signature verification).
 * 2. Verified against the Slack signing secret via {@link SlackVerifier}.
 * 3. Re-parsed as `URLSearchParams` and dispatched to the appropriate handler.
 *
 * The server exposes three POST routes:
 * - `/slack/commands`     -- routed to {@link SlackCommandHandler}
 * - `/slack/interactions` -- routed to {@link SlackInteractionHandler}
 * - `/slack/events`       -- handled internally for URL verification challenges
 */
export class SlackServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private logger: SlackServerLogger;

  /**
   * @param verifier           Signature verifier for incoming Slack requests.
   * @param commandHandler     Handler for slash command payloads.
   * @param interactionHandler Handler for interactive component payloads.
   * @param logger             Optional structured logger.
   */
  constructor(
    private verifier: SlackVerifier,
    private commandHandler: SlackCommandHandler,
    private interactionHandler: SlackInteractionHandler,
    logger?: SlackServerLogger,
  ) {
    this.logger = logger ?? noopLogger;
    this.app = express();

    this.setupMiddleware();
    this.setupRoutes();
  }

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------

  /**
   * Configure Express middleware for the /slack path:
   * - Raw body parser (required for HMAC verification of the original body).
   * - Signature verification middleware (rejects with 401 on failure).
   */
  private setupMiddleware(): void {
    // Parse the body as a raw Buffer so we can verify the signature against
    // the unmodified request body. Slack sends application/x-www-form-urlencoded.
    this.app.use(
      '/slack',
      express.raw({ type: 'application/x-www-form-urlencoded' }),
    );

    // Verify all Slack requests via HMAC-SHA256 signature.
    this.app.use('/slack', (req: Request, res: Response, next: NextFunction) => {
      const timestamp = req.headers['x-slack-request-timestamp'] as string;
      const signature = req.headers['x-slack-signature'] as string;

      if (!timestamp || !signature) {
        this.logger.warn('Slack request rejected: missing headers', {
          hasTimestamp: !!timestamp,
          hasSignature: !!signature,
        });
        res.status(401).send('Invalid signature');
        return;
      }

      const body = req.body instanceof Buffer ? req.body.toString() : String(req.body);

      if (!this.verifier.verify(timestamp, body, signature)) {
        this.logger.warn('Slack request rejected: invalid signature');
        res.status(401).send('Invalid signature');
        return;
      }

      // Re-parse body as URLSearchParams after verification
      req.body = new URLSearchParams(body);
      next();
    });
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /**
   * Register the three POST routes for Slack webhooks.
   */
  private setupRoutes(): void {
    this.app.post(
      '/slack/commands',
      this.commandHandler.handle.bind(this.commandHandler),
    );

    this.app.post(
      '/slack/interactions',
      this.interactionHandler.handle.bind(this.interactionHandler),
    );

    this.app.post('/slack/events', this.handleEvents.bind(this));
  }

  // -------------------------------------------------------------------------
  // Event handler
  // -------------------------------------------------------------------------

  /**
   * Handle Slack Events API requests.
   *
   * Supports the URL verification challenge (required during app setup)
   * and logs other event types for future processing.
   */
  private handleEvents(req: Request, res: Response): void {
    // The body was re-parsed as URLSearchParams by the middleware, but
    // Events API sends JSON. Try to parse it from the original payload.
    let payload: Record<string, unknown>;
    try {
      // If the body is URLSearchParams, reconstruct it
      if (req.body instanceof URLSearchParams) {
        // Events API sends JSON, not form-encoded. The raw body was already
        // consumed, so we check for the 'payload' param or try to parse.
        const payloadStr = req.body.get('payload');
        if (payloadStr) {
          payload = JSON.parse(payloadStr);
        } else {
          // For URL verification challenges, the body is JSON
          const entries = Object.fromEntries(req.body.entries());
          payload = entries as Record<string, unknown>;
        }
      } else {
        payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      }
    } catch {
      this.logger.error('Failed to parse event payload');
      res.status(400).send('Bad request');
      return;
    }

    // URL verification challenge -- Slack sends this during app setup
    if (payload.type === 'url_verification') {
      this.logger.info('Slack URL verification challenge received');
      res.json({ challenge: payload.challenge });
      return;
    }

    // Log other event types for future processing
    this.logger.info('Slack event received', { type: payload.type as string });
    res.status(200).send('ok');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the HTTP server on the specified port.
   *
   * @param port The port number to listen on.
   */
  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        this.logger.info('Slack HTTP server started', { port });
        resolve();
      });
    });
  }

  /**
   * Gracefully stop the HTTP server, closing all connections.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Slack HTTP server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Return the underlying Express application for testing purposes.
   */
  getApp(): express.Application {
    return this.app;
  }
}
