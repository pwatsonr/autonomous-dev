/**
 * Canonical RequestSource enum + AdapterMetadata discriminated union.
 *
 * Implements SPEC-012-2-03 §Task 4. The literal union `RequestSource` is
 * the compile-time mirror of the SQLite CHECK constraint defined in
 * `intake/db/migrations/002_add_source_metadata.sql`. The two MUST stay in
 * sync; adding a new source requires both a TS edit AND a new migration
 * (see `request_source.ts` § "Adding a new source" comment block).
 *
 * Note on naming: `RequestSource` (this file) is the persistence-layer
 * discriminator and uses hyphens (`'claude-app'`). `ChannelType` in
 * `adapters/adapter_interface.ts` is the runtime channel discriminator and
 * uses underscores (`'claude_app'`). The two are intentionally separate
 * concepts and not unified.
 *
 * @module types/request_source
 */

/**
 * Discriminator for which adapter/channel originated a request.
 * MUST stay in sync with the CHECK constraint in
 * `intake/db/migrations/002_add_source_metadata.sql`.
 *
 * Adding a new source requires:
 *   1. Add the literal here
 *   2. Add a new migration that ALTERs the CHECK constraint
 *   3. Extend AdapterMetadata with the new shape
 *   4. Implement the adapter
 */
export type RequestSource =
  | 'cli'
  | 'claude-app'
  | 'discord'
  | 'slack'
  | 'production-intelligence'
  | 'portal';

/** Iteration-friendly array form of {@link RequestSource}. */
export const REQUEST_SOURCES: readonly RequestSource[] = [
  'cli',
  'claude-app',
  'discord',
  'slack',
  'production-intelligence',
  'portal',
] as const;

/** Type guard — narrows `unknown` to {@link RequestSource}. */
export function isRequestSource(value: unknown): value is RequestSource {
  return (
    typeof value === 'string'
    && (REQUEST_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Discriminated union of per-adapter metadata payloads.
 * The discriminator key is `source` (matches `RequestEntity.source`).
 *
 * All non-discriminator fields are optional — adapters MAY emit any
 * subset depending on what's available. Consumers MUST tolerate
 * missing fields.
 */
export type AdapterMetadata =
  | { source: 'cli'; pid?: number; cwd?: string; branch?: string }
  | { source: 'claude-app'; session_id?: string; user?: string; workspace?: string }
  | {
      source: 'discord';
      guild_id?: string;
      channel_id?: string;
      user_id?: string;
      message_id?: string;
    }
  | {
      source: 'slack';
      team_id?: string;
      channel_id?: string;
      user_id?: string;
      message_ts?: string;
    }
  | { source: 'production-intelligence'; alert_id?: string; severity?: string }
  | { source: 'portal'; session_id?: string; user_agent?: string }
  // Empty object = legacy v1.0 row pre-migration (no discriminator).
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  | {};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link parseAdapterMetadata} when input cannot be coerced to a
 * valid {@link AdapterMetadata} shape. Matches the `ValidationError`
 * naming convention from `intake/adapters/claude_arg_parser.ts`.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Per-source allowed fields (for excess-property dropping in parser)
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS_BY_SOURCE: Record<RequestSource, readonly string[]> = {
  cli: ['source', 'pid', 'cwd', 'branch'],
  'claude-app': ['source', 'session_id', 'user', 'workspace'],
  discord: ['source', 'guild_id', 'channel_id', 'user_id', 'message_id'],
  slack: ['source', 'team_id', 'channel_id', 'user_id', 'message_ts'],
  'production-intelligence': ['source', 'alert_id', 'severity'],
  portal: ['source', 'session_id', 'user_agent'],
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON value as {@link AdapterMetadata}.
 *
 * Behaviour:
 * - `null` / `undefined`               → returns `{}` (treated as v1.0 legacy)
 * - object without `source` key        → returns `{}`
 * - object with `source` not in {@link REQUEST_SOURCES} → throws {@link ValidationError}
 * - object with valid `source`         → returns the typed shape with
 *                                          excess fields dropped
 * - non-object (string, number, array) → throws {@link ValidationError}
 *
 * "Tolerant reader" semantics: forward-compat with newer adapter schemas
 * (excess fields are silently dropped, not echoed back).
 */
export function parseAdapterMetadata(json: unknown): AdapterMetadata {
  if (json === null || json === undefined) return {};

  if (typeof json !== 'object' || Array.isArray(json)) {
    throw new ValidationError('adapter_metadata must be object');
  }

  const obj = json as Record<string, unknown>;
  if (!('source' in obj)) return {};

  const sourceValue = obj.source;
  if (!isRequestSource(sourceValue)) {
    throw new ValidationError(
      `unknown adapter source: ${JSON.stringify(sourceValue)}`,
    );
  }

  const allowed = ALLOWED_FIELDS_BY_SOURCE[sourceValue];
  const result: Record<string, unknown> = { source: sourceValue };
  for (const key of allowed) {
    if (key === 'source') continue;
    if (key in obj && obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result as AdapterMetadata;
}
