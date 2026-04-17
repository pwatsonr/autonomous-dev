# SPEC-008-1-03: AuthzEngine & RateLimiter

## Metadata
- **Parent Plan**: PLAN-008-1
- **Tasks Covered**: Task 5, Task 6
- **Estimated effort**: 10 hours

## Description

Implement the RBAC authorization engine with YAML config hot-reload, repo-scoped permission overrides, author-of-request special case, and review gate approval. Also implement the sliding window counter rate limiter backed by SQLite with role-based limit overrides.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/authz/authz_engine.ts` | Create |
| `intake/authz/audit_logger.ts` | Create |
| `intake/rate_limit/rate_limiter.ts` | Create |

## Implementation Details

### Task 5: AuthzEngine

**YAML config schema (`intake-auth.yaml`):**

```yaml
version: 1
users:
  - internal_id: string
    identities:
      discord_id?: string
      slack_id?: string
      claude_user?: string
    role: 'admin' | 'operator' | 'contributor' | 'viewer'
    repo_permissions: Record<string, Role>  # repo -> override role
review_gates:
  prd_review:
    reviewers: string[]  # internal_id list
  tdd_review:
    reviewers: string[]
  code_review:
    reviewers: string[]
rate_limit_overrides:
  admin:
    submissions_per_hour: number
    queries_per_minute: number
  operator:
    submissions_per_hour: number
    queries_per_minute: number
```

**Role hierarchy numeric mapping:**

```typescript
const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  contributor: 1,
  operator: 2,
  admin: 3,
};
```

**Permission matrix (required role per action):**

| Action | Base Required Role | Notes |
|--------|-------------------|-------|
| `status` | viewer | |
| `list` | viewer | |
| `logs` | viewer | |
| `submit` | contributor | |
| `feedback` | contributor | author-of-request OR operator+ |
| `cancel` | contributor | author-of-request OR operator+ |
| `pause` | contributor | author-of-request OR operator+ |
| `resume` | contributor | author-of-request OR operator+ |
| `priority` | contributor | author-of-request OR operator+ |
| `approve_review` | operator | OR designated reviewer |
| `kill` | admin | |
| `config_change` | admin | |

**Author-of-request special case**: For actions in `AUTHOR_ALLOWED_ACTIONS = {'cancel', 'pause', 'resume', 'priority', 'feedback'}`, if the user is the request's `requester_id`, the action is granted even if the user's role is `contributor` (which normally only allows operating on own requests).

**Review gate approval**: For `approve_review`, if the user is listed in `config.review_gates[context.gate].reviewers`, the action is granted regardless of role.

**Hot-reload implementation:**

```typescript
private watchForChanges(): void {
  fs.watchFile(this.configPath, { interval: 5000 }, (stats) => {
    if (stats.mtimeMs > this.lastModified) {
      try {
        this.config = this.loadConfig();
        this.lastModified = stats.mtimeMs;
      } catch (err) {
        // Log parse error, keep previous valid config
      }
    }
  });
}
```

- Polls every 5 seconds via `fs.watchFile`.
- If the YAML file has a parse error, the previous valid config is retained and a warning is logged.
- `stopWatching()` method calls `fs.unwatchFile()` for graceful shutdown.

**Audit logger (`audit_logger.ts`):**

Every `AuthzDecision` is:
1. Inserted into `authz_audit_log` table via `Repository.insertAuditLog()`.
2. Written to structured JSON stdout via `logger.info()` with fields: `user_id`, `action`, `resource`, `decision`, `reason`, `source_channel`, `timestamp`.

### Task 6: RateLimiter

**Sliding window counter algorithm:**

```typescript
class RateLimiter {
  constructor(private db: Repository) {}

  async checkLimit(
    userId: string,
    actionType: 'submission' | 'query',
    config: RateLimitConfig,
    roleOverrides?: RateLimitOverrides
  ): Promise<RateLimitResult> {
    const limit = this.resolveLimit(actionType, config, roleOverrides);
    const windowMs = actionType === 'submission' ? 3_600_000 : 60_000;
    const windowStart = new Date(Date.now() - windowMs);
    const count = await this.db.countActions(userId, actionType, windowStart);

    if (count >= limit) {
      const oldest = await this.db.getOldestActionInWindow(userId, actionType, windowStart);
      const retryAfterMs = oldest
        ? oldest.getTime() + windowMs - Date.now()
        : windowMs;
      return { allowed: false, remaining: 0, limit, retryAfterMs, message: '...' };
    }

    await this.db.recordAction(userId, actionType, new Date());
    return { allowed: true, remaining: limit - count - 1, limit, retryAfterMs: 0 };
  }
}
```

**Window durations:**
- `submission`: 1 hour (3,600,000 ms)
- `query`: 1 minute (60,000 ms)

**Default limits (from `intake-config.yaml`):**
- `submissions_per_hour`: 10
- `queries_per_minute`: 60

**Role-based overrides** are loaded from `intake-auth.yaml` `rate_limit_overrides` section. If a user's role has an override, it takes precedence over the default.

**`retryAfterMs` calculation**: When the limit is exceeded, find the oldest action still in the window. The retry time is `oldestActionTimestamp + windowMs - now`. This tells the user exactly when the oldest action will slide out of the window.

## Acceptance Criteria

1. `AuthzEngine` loads `intake-auth.yaml` on construction; throws on missing or invalid file.
2. `authorize()` returns `granted: true` for all role/action combinations in the permission matrix.
3. `authorize()` returns `granted: false` when a `viewer` attempts `submit`.
4. Repo-scoped overrides: a `contributor` with `operator` override on `myorg/api-service` can `cancel` any request targeting that repo.
5. Author-of-request: a `contributor` can `cancel` their own request but not another user's request.
6. Review gate: a `contributor` listed as a reviewer for `prd_review` can `approve_review` for that gate.
7. Hot-reload: modifying the YAML file on disk results in the new config being used within 10 seconds.
8. Hot-reload error resilience: if the YAML file is temporarily invalid, the previous config remains active.
9. Every `authorize()` call produces an audit log entry in both the database and structured JSON.
10. `RateLimiter.checkLimit()` returns `allowed: true` when under the limit.
11. `RateLimiter.checkLimit()` returns `allowed: false` with accurate `retryAfterMs` when at/over the limit.
12. Role-based rate limit overrides are applied when available.
13. The sliding window correctly expires old actions (actions older than the window are not counted).

## Test Cases

1. **Full permission matrix**: For each of the 4 roles and each of the 12 actions, call `authorize()` and assert the correct grant/deny per the matrix table above.
2. **Repo-scoped override elevation**: User with base role `contributor` and `operator` override on repo X; authorize `cancel` on repo X (grant), authorize `cancel` on repo Y (deny, unless author).
3. **Repo-scoped override restriction**: User with base role `operator` and `viewer` override on repo Z; authorize `submit` on repo Z (deny).
4. **Author special case**: User is `contributor`, request was submitted by them; authorize `cancel` (grant). Different request, different author; authorize `cancel` (deny).
5. **Review gate designated reviewer**: User is `contributor`, listed as reviewer for `tdd_review`; authorize `approve_review` for `tdd_review` (grant), authorize `approve_review` for `code_review` (deny).
6. **Hot-reload**: Write config, construct engine, change config on disk, wait 6 seconds, verify new config is active.
7. **Hot-reload invalid YAML**: Write valid config, construct engine, overwrite with invalid YAML, wait 6 seconds, verify old config still active.
8. **Audit log population**: Call `authorize()` 5 times, query `authz_audit_log`, verify 5 entries with correct fields.
9. **Rate limit under limit**: Call `checkLimit` 3 times with a limit of 10; all return `allowed: true` with correct `remaining`.
10. **Rate limit at limit**: Record 10 actions, call `checkLimit`; returns `allowed: false`.
11. **Rate limit retryAfterMs accuracy**: Record 10 actions with known timestamps, call `checkLimit`; verify `retryAfterMs` matches expected value (oldest action timestamp + window - now).
12. **Rate limit window sliding**: Record 10 actions at T-70 minutes (for 1-hour window); call `checkLimit` at T; returns `allowed: true` because actions expired.
13. **Role override on rate limit**: Admin role with `submissions_per_hour: 50`; verify limit is 50, not the default 10.
14. **Rate limit per-user isolation**: User A at limit, user B under limit; `checkLimit` for B returns `allowed: true`.
