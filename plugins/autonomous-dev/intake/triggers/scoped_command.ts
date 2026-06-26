/**
 * ONBOARD Phase 4 (#596) — scoped trigger command grammar.
 *
 * Grammar: `/{autodev} <scope-type> <scope-id> <task…>`
 * The intake adapters tokenize this into an `IncomingCommand` whose `args`
 * arrive as `[scopeType, scopeId, ...taskWords]`. This module is the pure
 * parser for those args — no I/O, no scope resolution (that is FR-C, against
 * P0 ownership). Task bounds mirror the intake submit handler's
 * MIN/MAX_DESCRIPTION_LENGTH (10–10 000) so a triggered task and a CLI/portal
 * task obey the same limits.
 *
 * @module intake/triggers/scoped_command
 */

export const SCOPE_TYPES = ['project', 'repo'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Mirrors `MIN_DESCRIPTION_LENGTH` in `intake/handlers/submit_handler.ts`. */
export const MIN_TASK_LENGTH = 10;
/** Mirrors `MAX_DESCRIPTION_LENGTH` in `intake/handlers/submit_handler.ts`. */
export const MAX_TASK_LENGTH = 10_000;
/** Upper bound on a scope id (an `owner/name` repo or a project slug). */
export const MAX_SCOPE_ID_LENGTH = 200;

export type ScopedTriggerParseError =
  | 'bad-scope-type'
  | 'missing-scope-id'
  | 'empty-task'
  | 'task-too-short'
  | 'task-too-long';

export type ParsedScopedTrigger =
  | { ok: true; scopeType: ScopeType; scopeId: string; task: string }
  | { ok: false; reason: ScopedTriggerParseError; message: string };

function isScopeType(v: unknown): v is ScopeType {
  return typeof v === 'string' && (SCOPE_TYPES as readonly string[]).includes(v);
}

/**
 * Parse the scoped-trigger args `[scopeType, scopeId, ...taskWords]`.
 *
 * Validation is intentionally shallow: the parser only checks SHAPE (a valid
 * scope-type keyword, a non-empty scope-id token, a task within bounds). It
 * does NOT verify the scope-id exists — that is scope resolution against
 * ownership (FR-C), which is the authority on existence + access.
 */
export function parseScopedTrigger(args: readonly string[]): ParsedScopedTrigger {
  const scopeTypeRaw = args[0];
  const scopeId = args[1];
  const taskWords = args.slice(2);

  if (!isScopeType(scopeTypeRaw)) {
    return {
      ok: false,
      reason: 'bad-scope-type',
      message: `scope type must be one of: ${SCOPE_TYPES.join(', ')}`,
    };
  }
  const trimmedScopeId = typeof scopeId === 'string' ? scopeId.trim() : '';
  if (trimmedScopeId.length === 0) {
    return {
      ok: false,
      reason: 'missing-scope-id',
      message: 'a scope id (project or repo) is required',
    };
  }
  if (trimmedScopeId.length > MAX_SCOPE_ID_LENGTH) {
    return {
      ok: false,
      reason: 'missing-scope-id',
      message: `scope id is too long (max ${MAX_SCOPE_ID_LENGTH} characters)`,
    };
  }
  const task = taskWords.join(' ').trim();
  if (task.length === 0) {
    return { ok: false, reason: 'empty-task', message: 'a task description is required' };
  }
  if (task.length < MIN_TASK_LENGTH) {
    return {
      ok: false,
      reason: 'task-too-short',
      message: `task must be at least ${MIN_TASK_LENGTH} characters`,
    };
  }
  if (task.length > MAX_TASK_LENGTH) {
    return {
      ok: false,
      reason: 'task-too-long',
      message: `task must be at most ${MAX_TASK_LENGTH} characters`,
    };
  }

  return { ok: true, scopeType: scopeTypeRaw, scopeId: trimmedScopeId, task };
}
