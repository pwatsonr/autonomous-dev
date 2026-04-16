/**
 * Unit tests for ClaudeIdentityResolver (SPEC-008-2-02, Task 4).
 *
 * Covers:
 * 1. First user auto-admin provisioning.
 * 2. Subsequent user auto-viewer provisioning.
 * 3. Existing user lookup returns stored ID.
 * 4. OS username resolution from `os.userInfo()`.
 *
 * Total: 4 tests.
 *
 * @module claude_identity.test
 */

import * as os from 'os';

import { ClaudeIdentityResolver } from '../../adapters/claude_identity';
import type { Repository, UserIdentity } from '../../db/repository';

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

/**
 * In-memory mock repository that implements the subset of Repository
 * methods used by ClaudeIdentityResolver.
 */
function createMockRepository(): Repository & {
  users: UserIdentity[];
} {
  const users: UserIdentity[] = [];

  return {
    users,

    getUserByPlatformId(
      _channelType: string,
      platformId: string,
    ): UserIdentity | null {
      return users.find((u) => u.claude_user === platformId) ?? null;
    },

    getUserCount(): number {
      return users.length;
    },

    upsertUser(user: UserIdentity): void {
      const idx = users.findIndex((u) => u.internal_id === user.internal_id);
      if (idx >= 0) {
        users[idx] = user;
      } else {
        users.push(user);
      }
    },
  } as Repository & { users: UserIdentity[] };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClaudeIdentityResolver (SPEC-008-2-02, Task 4)', () => {
  // -----------------------------------------------------------------------
  // Test 1: First user gets admin role
  // -----------------------------------------------------------------------
  test('first user is auto-provisioned with admin role', async () => {
    const repo = createMockRepository();
    const resolver = new ClaudeIdentityResolver(repo);

    const userId = await resolver.resolve();

    expect(repo.users.length).toBe(1);
    expect(repo.users[0].role).toBe('admin');
    expect(userId).toBe(os.userInfo().username);
  });

  // -----------------------------------------------------------------------
  // Test 2: Subsequent users get viewer role
  // -----------------------------------------------------------------------
  test('subsequent user is auto-provisioned with viewer role', async () => {
    const repo = createMockRepository();

    // Pre-populate with an existing admin user
    repo.upsertUser({
      internal_id: 'existing-admin',
      role: 'admin',
      claude_user: 'existing-admin',
      discord_id: null,
      slack_id: null,
      repo_permissions: '{}',
      rate_limit_override: null,
    });

    const resolver = new ClaudeIdentityResolver(repo);
    const userId = await resolver.resolve();

    // The resolver uses os.userInfo().username, which is different from
    // 'existing-admin' (unless running as that user), so it will provision
    // a new user with viewer role.
    const osUsername = os.userInfo().username;
    if (osUsername !== 'existing-admin') {
      expect(repo.users.length).toBe(2);
      const newUser = repo.users.find((u) => u.internal_id === osUsername);
      expect(newUser).toBeDefined();
      expect(newUser!.role).toBe('viewer');
      expect(userId).toBe(osUsername);
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Existing user lookup returns stored internal_id
  // -----------------------------------------------------------------------
  test('existing user lookup returns stored internal_id', async () => {
    const repo = createMockRepository();
    const osUsername = os.userInfo().username;

    // Pre-populate with the current OS user
    repo.upsertUser({
      internal_id: osUsername,
      role: 'contributor',
      claude_user: osUsername,
      discord_id: null,
      slack_id: null,
      repo_permissions: '{}',
      rate_limit_override: null,
    });

    const resolver = new ClaudeIdentityResolver(repo);
    const userId = await resolver.resolve();

    // Should return the existing user, not create a new one
    expect(repo.users.length).toBe(1);
    expect(userId).toBe(osUsername);
    expect(repo.users[0].role).toBe('contributor'); // unchanged
  });

  // -----------------------------------------------------------------------
  // Test 4: OS username resolution
  // -----------------------------------------------------------------------
  test('resolves user identity from os.userInfo().username', async () => {
    const repo = createMockRepository();
    const resolver = new ClaudeIdentityResolver(repo);

    const userId = await resolver.resolve();
    const expectedUsername = os.userInfo().username;

    expect(userId).toBe(expectedUsername);
    expect(repo.users[0].claude_user).toBe(expectedUsername);
    expect(repo.users[0].internal_id).toBe(expectedUsername);
    expect(repo.users[0].discord_id).toBeNull();
    expect(repo.users[0].slack_id).toBeNull();
    expect(repo.users[0].repo_permissions).toBe('{}');
  });
});
