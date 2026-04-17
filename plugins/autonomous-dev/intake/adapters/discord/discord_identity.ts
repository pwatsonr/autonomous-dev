/**
 * Discord User Identity Resolver.
 *
 * Maps Discord user IDs to internal user identities via the `user_identities`
 * table. Unlike the Claude App adapter, Discord users are NOT auto-provisioned;
 * they must be pre-configured in `intake-auth.yaml` by an administrator.
 *
 * Implements SPEC-008-3-02, Task 10.
 *
 * @module discord_identity
 */

import type { Repository, UserIdentity } from '../../db/repository';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a Discord user attempts an action but has no mapping in the
 * `user_identities` table.
 *
 * This is a deliberate design difference from the Claude App adapter which
 * auto-provisions unknown users. Discord users must be explicitly added to
 * `intake-auth.yaml` with their `discord_id` by an administrator.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

// ---------------------------------------------------------------------------
// Guild interface (subset of discord.js Guild)
// ---------------------------------------------------------------------------

/**
 * Minimal guild interface for member lookups.
 *
 * Accepts the real discord.js `Guild` object at runtime or a test stub.
 */
export interface GuildLike {
  members: {
    fetch(userId: string): Promise<{ displayName: string }>;
  };
}

// ---------------------------------------------------------------------------
// DiscordIdentityResolver
// ---------------------------------------------------------------------------

/**
 * Resolves a Discord user ID to an internal identity stored in the
 * `user_identities` table.
 *
 * Lookup flow:
 * 1. Query `user_identities` for a row whose `discord_id` column matches
 *    the provided Discord user ID.
 * 2. If found, return the existing `internal_id`.
 * 3. If not found, throw an {@link AuthorizationError} directing the user
 *    to contact an administrator.
 *
 * Display name resolution:
 * - Fetches the guild member via the Discord API for the display name.
 * - Falls back to "Discord User {id}" if the fetch fails.
 */
export class DiscordIdentityResolver {
  constructor(
    private db: Repository,
    private guild: GuildLike,
  ) {}

  /**
   * Resolve a Discord user ID to an internal identity.
   *
   * @param discordUserId - The Discord snowflake user ID.
   * @returns The internal user ID mapped to this Discord account.
   * @throws {AuthorizationError} When the Discord user has no provisioned mapping.
   */
  async resolve(discordUserId: string): Promise<string> {
    const user = this.db.getUserByPlatformId('discord', discordUserId);
    if (!user) {
      throw new AuthorizationError(
        `Discord user ${discordUserId} is not provisioned. ` +
          'Discord users must be added to intake-auth.yaml by an administrator.',
      );
    }
    return user.internal_id;
  }

  /**
   * Resolve the display name for a Discord user.
   *
   * Fetches the guild member object from the Discord API to retrieve the
   * server-specific nickname or global display name. Falls back to a
   * generic string if the fetch fails (e.g., user left the guild, API error).
   *
   * @param discordUserId - The Discord snowflake user ID.
   * @returns The user's display name, or a fallback string.
   */
  async resolveDisplayName(discordUserId: string): Promise<string> {
    try {
      const member = await this.guild.members.fetch(discordUserId);
      return member.displayName;
    } catch {
      return `Discord User ${discordUserId}`;
    }
  }
}
