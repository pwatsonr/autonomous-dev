/**
 * RBAC Authorization Engine with YAML config hot-reload.
 *
 * Features:
 *   - 4-role hierarchy: viewer < contributor < operator < admin
 *   - Per-repo permission overrides
 *   - Author-of-request special case for self-service actions
 *   - Review gate designated-reviewer approval
 *   - Hot-reload of YAML config via `fs.watchFile` (5-second poll)
 *   - Every decision is recorded via {@link AuditLogger}
 *
 * @module authz_engine
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';

import type {
  AuthzAction,
  AuthzContext,
  AuthzDecision,
  ChannelType,
} from '../adapters/adapter_interface';
import { AuditLogger } from './audit_logger';

// ---------------------------------------------------------------------------
// Role hierarchy
// ---------------------------------------------------------------------------

/** Canonical role type. */
export type Role = 'admin' | 'operator' | 'contributor' | 'viewer';

/**
 * Numeric weight per role.  Higher value = more privilege.
 */
export const ROLE_HIERARCHY: Record<Role, number> = {
  viewer: 0,
  contributor: 1,
  operator: 2,
  admin: 3,
};

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

/**
 * The minimum role required to perform each action.
 * Actions with author-of-request or reviewer special cases are noted in
 * `AUTHOR_ALLOWED_ACTIONS` and handled in `authorize()`.
 */
const ACTION_REQUIRED_ROLE: Record<AuthzAction, Role> = {
  status: 'viewer',
  list: 'viewer',
  logs: 'viewer',
  submit: 'contributor',
  feedback: 'contributor',
  cancel: 'contributor',
  pause: 'contributor',
  resume: 'contributor',
  priority: 'contributor',
  approve_review: 'operator',
  kill: 'admin',
  config_change: 'admin',
};

/**
 * Actions where the author of the request is granted permission even
 * if their base/scoped role would only be `contributor`.
 */
const AUTHOR_ALLOWED_ACTIONS: Set<AuthzAction> = new Set([
  'cancel',
  'pause',
  'resume',
  'priority',
  'feedback',
]);

// ---------------------------------------------------------------------------
// YAML config types
// ---------------------------------------------------------------------------

/** A single user entry in `intake-auth.yaml`. */
export interface AuthConfigUser {
  internal_id: string;
  identities: {
    discord_id?: string;
    slack_id?: string;
    claude_user?: string;
  };
  role: Role;
  repo_permissions?: Record<string, Role>;
}

/** Review gate definition in the config. */
export interface ReviewGateConfig {
  reviewers: string[];
}

/** Rate limit override per role. */
export interface RoleLimitOverride {
  submissions_per_hour?: number;
  queries_per_minute?: number;
}

/** Top-level structure of `intake-auth.yaml`. */
export interface AuthConfig {
  version: number;
  users: AuthConfigUser[];
  review_gates?: Record<string, ReviewGateConfig>;
  rate_limit_overrides?: Record<string, RoleLimitOverride>;
}

// ---------------------------------------------------------------------------
// AuthzEngine
// ---------------------------------------------------------------------------

/**
 * RBAC authorization engine.
 *
 * Loads the YAML config on construction and watches for changes every
 * 5 seconds.  All decisions are audited through the injected
 * {@link AuditLogger}.
 */
export class AuthzEngine {
  private config: AuthConfig;
  private lastModified: number;
  private readonly configPath: string;
  private readonly auditLogger: AuditLogger;

  /**
   * @param configPath   Absolute path to `intake-auth.yaml`.
   * @param auditLogger  Logger that records every decision.
   * @throws If the config file is missing or contains invalid YAML.
   */
  constructor(configPath: string, auditLogger: AuditLogger) {
    this.configPath = configPath;
    this.auditLogger = auditLogger;

    // Initial load (must succeed or throw)
    this.config = this.loadConfig();
    this.lastModified = fs.statSync(this.configPath).mtimeMs;

    // Start watching for changes
    this.watchForChanges();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Evaluate whether `userId` may perform `action` in the given context.
   *
   * Resolution order:
   *   1. Resolve the user's effective role (base role, then repo override).
   *   2. Check the permission matrix for the required role.
   *   3. If denied and the action is in AUTHOR_ALLOWED_ACTIONS, check
   *      whether the user is the author of the request.
   *   4. If action is `approve_review`, check designated reviewers.
   *   5. Record the decision via the audit logger.
   *
   * @param userId         Internal user ID.
   * @param action         The action being attempted.
   * @param context        Additional context (repo, request author, gate).
   * @param sourceChannel  Originating channel (for audit).
   * @param requesterId    The `requester_id` of the request being acted upon
   *                       (used for author-of-request checks).
   */
  authorize(
    userId: string,
    action: AuthzAction,
    context: AuthzContext & { requesterId?: string },
    sourceChannel: ChannelType | string,
  ): AuthzDecision {
    const user = this.findUser(userId);

    // Unknown user is implicitly denied
    if (!user) {
      const decision: AuthzDecision = {
        granted: false,
        userId,
        action,
        reason: 'User not found in authorization config',
        timestamp: new Date(),
      };
      this.auditLogger.log(
        decision,
        this.buildResource(context),
        sourceChannel,
      );
      return decision;
    }

    // Resolve effective role (base or repo-scoped override)
    const effectiveRole = this.resolveEffectiveRole(user, context.targetRepo);
    const requiredRole = ACTION_REQUIRED_ROLE[action];

    // Check base permission matrix
    const hasBasePermission =
      ROLE_HIERARCHY[effectiveRole] >= ROLE_HIERARCHY[requiredRole];

    if (hasBasePermission) {
      // For author-only actions at contributor level, non-authors need operator+
      if (
        AUTHOR_ALLOWED_ACTIONS.has(action) &&
        effectiveRole === 'contributor' &&
        context.requesterId !== undefined &&
        context.requesterId !== userId
      ) {
        const decision: AuthzDecision = {
          granted: false,
          userId,
          action,
          reason: `Role '${effectiveRole}' can only ${action} own requests; need operator+ for others`,
          timestamp: new Date(),
        };
        this.auditLogger.log(
          decision,
          this.buildResource(context),
          sourceChannel,
        );
        return decision;
      }

      const decision: AuthzDecision = {
        granted: true,
        userId,
        action,
        reason: `Role '${effectiveRole}' meets required role '${requiredRole}'`,
        timestamp: new Date(),
      };
      this.auditLogger.log(
        decision,
        this.buildResource(context),
        sourceChannel,
      );
      return decision;
    }

    // Special case: author-of-request
    if (
      AUTHOR_ALLOWED_ACTIONS.has(action) &&
      context.requesterId !== undefined &&
      context.requesterId === userId &&
      ROLE_HIERARCHY[effectiveRole] >= ROLE_HIERARCHY['contributor']
    ) {
      const decision: AuthzDecision = {
        granted: true,
        userId,
        action,
        reason: 'Author-of-request: user is the request owner',
        timestamp: new Date(),
      };
      this.auditLogger.log(
        decision,
        this.buildResource(context),
        sourceChannel,
      );
      return decision;
    }

    // Special case: designated reviewer for approve_review
    if (action === 'approve_review' && context.gate) {
      const gate = this.config.review_gates?.[context.gate];
      if (gate && gate.reviewers.includes(userId)) {
        const decision: AuthzDecision = {
          granted: true,
          userId,
          action,
          reason: `Designated reviewer for gate '${context.gate}'`,
          timestamp: new Date(),
        };
        this.auditLogger.log(
          decision,
          this.buildResource(context),
          sourceChannel,
        );
        return decision;
      }
    }

    // Denied
    const decision: AuthzDecision = {
      granted: false,
      userId,
      action,
      reason: `Role '${effectiveRole}' does not meet required role '${requiredRole}'`,
      timestamp: new Date(),
    };
    this.auditLogger.log(
      decision,
      this.buildResource(context),
      sourceChannel,
    );
    return decision;
  }

  /**
   * Return the current in-memory config.  Useful for rate limit override
   * lookups by other modules.
   */
  getConfig(): AuthConfig {
    return this.config;
  }

  /**
   * Look up a user by internal ID.
   */
  findUser(userId: string): AuthConfigUser | undefined {
    return this.config.users.find((u) => u.internal_id === userId);
  }

  /**
   * Resolve a user's internal ID from a platform identity.
   *
   * @param platform  One of `'discord_id'`, `'slack_id'`, `'claude_user'`.
   * @param platformId The platform-specific user identifier.
   */
  resolveUserId(
    platform: 'discord_id' | 'slack_id' | 'claude_user',
    platformId: string,
  ): string | undefined {
    const user = this.config.users.find(
      (u) => u.identities[platform] === platformId,
    );
    return user?.internal_id;
  }

  /**
   * Stop the config file watcher.  Call during graceful shutdown.
   */
  stopWatching(): void {
    fs.unwatchFile(this.configPath);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the effective role for a user, considering repo-scoped overrides.
   *
   * If `targetRepo` is provided and the user has an override for that repo,
   * the override role is returned.  Otherwise the base role is used.
   */
  private resolveEffectiveRole(
    user: AuthConfigUser,
    targetRepo?: string,
  ): Role {
    if (targetRepo && user.repo_permissions?.[targetRepo]) {
      return user.repo_permissions[targetRepo];
    }
    return user.role;
  }

  /**
   * Build a human-readable resource string for audit logging.
   */
  private buildResource(context: AuthzContext): string {
    const parts: string[] = [];
    if (context.requestId) parts.push(`request:${context.requestId}`);
    if (context.targetRepo) parts.push(`repo:${context.targetRepo}`);
    if (context.gate) parts.push(`gate:${context.gate}`);
    return parts.length > 0 ? parts.join(', ') : 'global';
  }

  // -----------------------------------------------------------------------
  // Config loading & hot-reload
  // -----------------------------------------------------------------------

  /**
   * Load and validate the YAML config from disk.
   *
   * @throws On missing file or invalid YAML.
   */
  private loadConfig(): AuthConfig {
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const parsed = yaml.load(raw) as AuthConfig;

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid auth config: expected a YAML object at ${this.configPath}`);
    }
    if (!Array.isArray(parsed.users)) {
      throw new Error(`Invalid auth config: 'users' must be an array at ${this.configPath}`);
    }

    // Validate each user entry
    for (const user of parsed.users) {
      if (!user.internal_id || typeof user.internal_id !== 'string') {
        throw new Error(`Invalid auth config: user entry missing 'internal_id'`);
      }
      if (!user.role || !(user.role in ROLE_HIERARCHY)) {
        throw new Error(
          `Invalid auth config: user '${user.internal_id}' has invalid role '${user.role}'`,
        );
      }
      // Validate repo permission overrides
      if (user.repo_permissions) {
        for (const [repo, role] of Object.entries(user.repo_permissions)) {
          if (!(role in ROLE_HIERARCHY)) {
            throw new Error(
              `Invalid auth config: user '${user.internal_id}' has invalid repo_permissions role '${role}' for repo '${repo}'`,
            );
          }
        }
      }
    }

    return parsed;
  }

  /**
   * Watch the config file for changes, reloading on modification.
   *
   * - Polls every 5 seconds via `fs.watchFile`.
   * - If the YAML has a parse error, the previous valid config is retained
   *   and a warning is emitted.
   */
  private watchForChanges(): void {
    fs.watchFile(this.configPath, { interval: 5000 }, (stats) => {
      if (stats.mtimeMs > this.lastModified) {
        try {
          this.config = this.loadConfig();
          this.lastModified = stats.mtimeMs;
        } catch (err) {
          // Keep previous valid config; log the error
          const message =
            err instanceof Error ? err.message : String(err);
          process.stderr.write(
            JSON.stringify({
              level: 'warn',
              msg: 'Failed to reload auth config; keeping previous config',
              error: message,
              ts: new Date().toISOString(),
            }) + '\n',
          );
        }
      }
    });
  }
}
