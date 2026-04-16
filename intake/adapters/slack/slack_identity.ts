/**
 * Slack User Identity Resolver.
 *
 * Maps Slack user IDs to internal user identities via the `user_identities`
 * table. Unlike the Claude App adapter, Slack users are NOT auto-provisioned;
 * they must be pre-configured in `intake-auth.yaml` by an administrator.
 *
 * Display name caching: `users.info` results are cached for 1 hour to avoid
 * excessive API calls.
 *
 * Implements SPEC-008-4-02, Task 11.
 *
 * @module slack_identity
 */

import type { Repository } from '../../db/repository';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a Slack user attempts an action but has no mapping in the
 * `user_identities` table.
 *
 * This is a deliberate design decision: Slack users must be explicitly added
 * to `intake-auth.yaml` with their `slack_id` by an administrator.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

// ---------------------------------------------------------------------------
// Slack WebClient type stub (minimal interface for compile-time decoupling)
// ---------------------------------------------------------------------------

/**
 * Minimal Slack WebClient interface for user lookups.
 *
 * Accepts the real `@slack/web-api` `WebClient` at runtime; tests can
 * supply a stub.
 */
export interface SlackWebClient {
  users: {
    info(params: { user: string }): Promise<{
      ok: boolean;
      user?: {
        real_name?: string;
        name?: string;
      };
    }>;
  };
}

// ---------------------------------------------------------------------------
// Display name cache entry
// ---------------------------------------------------------------------------

/** Cached display name with fetch timestamp. */
interface CachedDisplayName {
  name: string;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// SlackIdentityResolver
// ---------------------------------------------------------------------------

/**
 * Resolves a Slack user ID to an internal identity stored in the
 * `user_identities` table.
 *
 * Lookup flow:
 * 1. Query `user_identities` for a row whose `slack_id` column matches
 *    the provided Slack user ID.
 * 2. If found, return the existing `internal_id`.
 * 3. If not found, throw an {@link AuthorizationError} directing the user
 *    to contact an administrator.
 *
 * Display name resolution:
 * - Fetches the Slack user via the `users.info` API.
 * - Results are cached for 1 hour to minimize API calls.
 * - Falls back to "Slack User {id}" if the API call fails.
 */
export class SlackIdentityResolver {
  private displayNameCache: Map<string, CachedDisplayName> = new Map();
  private readonly CACHE_TTL = 3600_000; // 1 hour

  constructor(
    private db: Repository,
    private web: SlackWebClient,
  ) {}

  /**
   * Resolve a Slack user ID to an internal identity.
   *
   * @param slackUserId - The Slack user ID (e.g., "U01ABCDEF23").
   * @returns The internal user ID mapped to this Slack account.
   * @throws {AuthorizationError} When the Slack user has no provisioned mapping.
   */
  async resolve(slackUserId: string): Promise<string> {
    const user = this.db.getUserByPlatformId('slack', slackUserId);
    if (!user) {
      throw new AuthorizationError(
        `Slack user ${slackUserId} is not provisioned. ` +
          'Slack users must be added to intake-auth.yaml by an administrator.',
      );
    }
    return user.internal_id;
  }

  /**
   * Resolve the display name for a Slack user.
   *
   * Fetches the user profile from the Slack API (`users.info`). Results are
   * cached for {@link CACHE_TTL} (1 hour). Falls back to a generic string
   * if the API call fails (e.g., user deactivated, network error).
   *
   * @param slackUserId - The Slack user ID (e.g., "U01ABCDEF23").
   * @returns The user's display name, or a fallback string.
   */
  async resolveDisplayName(slackUserId: string): Promise<string> {
    const cached = this.displayNameCache.get(slackUserId);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL) {
      return cached.name;
    }

    try {
      const result = await this.web.users.info({ user: slackUserId });
      const name =
        result.user?.real_name ?? result.user?.name ?? `Slack User ${slackUserId}`;
      this.displayNameCache.set(slackUserId, {
        name,
        fetchedAt: Date.now(),
      });
      return name;
    } catch {
      return `Slack User ${slackUserId}`;
    }
  }
}
