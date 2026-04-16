/**
 * Claude App User Identity Resolver.
 *
 * Maps the OS-level username to an internal user identity, auto-provisioning
 * new users on first encounter.  The first user ever created receives the
 * `admin` role; all subsequent users are provisioned as `viewer`.
 *
 * Implements SPEC-008-2-02, Task 4.
 *
 * @module claude_identity
 */

import * as os from 'os';

import type { Repository, UserIdentity } from '../db/repository';

// ---------------------------------------------------------------------------
// Identity resolver
// ---------------------------------------------------------------------------

/**
 * Resolves the current OS user to an internal identity stored in the
 * `user_identities` table.
 *
 * Lookup flow:
 * 1. Read the OS username via `os.userInfo().username`.
 * 2. Query `user_identities` for a row whose `claude_user` column matches.
 * 3. If found, return the existing `internal_id`.
 * 4. If not found, auto-provision:
 *    - First-ever user (table is empty) -> `admin` role.
 *    - All others -> `viewer` role.
 *    - `internal_id` is set to the OS username.
 *    - `discord_id` and `slack_id` are null (unmapped).
 *    - `repo_permissions` defaults to `'{}'` (JSON string).
 */
export class ClaudeIdentityResolver {
  constructor(private db: Repository) {}

  /**
   * Resolve the current OS user to an internal identity.
   *
   * @returns The `internal_id` for the resolved user.
   */
  async resolve(): Promise<string> {
    const osUsername = os.userInfo().username;

    // Lookup by claude_user column
    const existing = this.db.getUserByPlatformId('claude_app', osUsername);
    if (existing) {
      return existing.internal_id;
    }

    // Auto-provision
    const userCount = this.db.getUserCount();
    const role = userCount === 0 ? 'admin' : 'viewer';

    const newUser: UserIdentity = {
      internal_id: osUsername,
      role,
      claude_user: osUsername,
      discord_id: null,
      slack_id: null,
      repo_permissions: '{}',
      rate_limit_override: null,
    };

    this.db.upsertUser(newUser);
    return newUser.internal_id;
  }
}
