/**
 * ONBOARD Phase 4 (#596) — file-backed, restart-safe trigger store.
 *
 * Two concerns persisted under `~/.autonomous-dev/state/triggers/triggers.json`:
 *   1. IDEMPOTENCY — a set of platform message/interaction ids already handled,
 *      so a retried inbound webhook does NOT re-enqueue (survives restarts; the
 *      set is loaded from disk before the accept loop). TTL-evicted.
 *   2. TRIGGER RECORDS — one per enqueued request {requestId, scope, target,
 *      origin, status}, so reporting (step 4) + the stabilization watch (step 5)
 *      know where to report back and what to watch.
 *
 * Mirrors the Phase-2 artifact proposal-store: an injected `TriggerStoreIO`
 * (homedir / readFile / atomic writeFile / numeric now) so it is unit-testable
 * with an in-memory fs + a fake clock; never throws on read (corrupt/missing →
 * safe default, preserving the corrupt file in a sidecar).
 *
 * Concurrency: the intake router processes commands sequentially, so the
 * hasSeen→enqueue→commit ordering in the handler cannot double-enqueue. The
 * store itself does plain load-modify-save (no lock).
 *
 * @module intake/triggers/trigger_store
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { resolveAbsoluteHome } from '../../src/home';

/** How long a handled message id is remembered for dedupe (≥ MAX_WATCH_DAYS). */
export const SEEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type TriggerRecordStatus =
  | 'enqueued'
  | 'watching'
  | 'stable'
  | 'regressed'
  | 'expired'
  | 'failed'; // the pipeline request failed; never entered the watch

export interface TriggerOrigin {
  /** The originating channel type, e.g. 'discord' | 'slack'. */
  platform: string;
  channelId?: string;
  userId?: string;
  /** Platform message/interaction id (the idempotency key). */
  messageId?: string;
}

export interface TriggerRecord {
  requestId: string;
  scope: string;
  scopeId: string;
  scopeType: 'project' | 'repo';
  targetRepo: string;
  origin: TriggerOrigin;
  /** Resolved internal authz subject (the rate-limit key) — distinct from the
   *  raw platform id in origin.userId. Optional for backward compatibility. */
  requesterId?: string;
  createdAtMs: number;
  status: TriggerRecordStatus;
  // Stabilization-watch fields (step 5), set when status → 'watching'.
  /** The PR HEAD branch whose CI the watch tracks. */
  watchPrBranch?: string;
  /** Epoch ms the watch began (for the MAX_WATCH_DAYS hard cap). */
  watchStartedAtMs?: number;
  /** Epoch ms the current green streak began; undefined = no active streak. */
  greenSinceMs?: number;
  /** Epoch ms green was last OBSERVED; a gap > maxGapMs breaks the streak so
   *  `stable` requires continuously-observed green, not just elapsed time. */
  lastGreenMs?: number;
}

interface TriggerState {
  /** messageId → first-seen epoch ms (for TTL eviction). */
  seen: Record<string, number>;
  records: TriggerRecord[];
}

export interface TriggerStoreIO {
  homedir(): string;
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, data: string): void;
  /** Epoch milliseconds. */
  now(): number;
}

export const defaultTriggerStoreIO: TriggerStoreIO = {
  homedir: () => resolveAbsoluteHome(),
  readFile: (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined),
  writeFile: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Unique tmp name (pid + random) so two writers in the same process don't
    // collide on the temp file before the atomic rename.
    const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  },
  now: () => Date.now(),
};

export function triggerStatePath(io: TriggerStoreIO = defaultTriggerStoreIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'state', 'triggers', 'triggers.json');
}

function isState(v: unknown): v is TriggerState {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as TriggerState).seen === 'object' &&
    (v as TriggerState).seen !== null &&
    !Array.isArray((v as TriggerState).seen) &&
    Array.isArray((v as TriggerState).records)
  );
}

/** requestId is used as a filesystem path segment (the watch-tick reads
 *  `<repo>/.autonomous-dev/requests/<requestId>/state.json`), so it MUST be
 *  path-safe — no separators or traversal. Daemon ids (REQ-NNNNNN) match. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

/** A record is usable iff its identifying fields are the right type AND its
 *  requestId is path-safe. Individually corrupt records are dropped on load
 *  (vs discarding the whole store) — this also defeats a crafted on-disk
 *  requestId like `../../../etc/passwd` before it can reach any path join. */
function isRecord(v: unknown): v is TriggerRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.requestId === 'string' &&
    SAFE_REQUEST_ID.test(r.requestId) &&
    typeof r.scope === 'string' &&
    typeof r.targetRepo === 'string' &&
    typeof r.status === 'string'
  );
}

/** Load the trigger state. Never throws: missing → empty; corrupt → empty
 *  (preserving the corrupt file in a sidecar so a save can't silently wipe it). */
function loadState(io: TriggerStoreIO): TriggerState {
  const raw = io.readFile(triggerStatePath(io));
  if (!raw) return { seen: {}, records: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (isState(parsed)) {
    return { seen: parsed.seen, records: parsed.records.filter(isRecord) };
  }
  try {
    io.writeFile(`${triggerStatePath(io)}.corrupt-${io.now()}.${randomBytes(4).toString('hex')}`, raw);
  } catch {
    /* best-effort */
  }
  return { seen: {}, records: [] };
}

function saveState(state: TriggerState, io: TriggerStoreIO): void {
  io.writeFile(triggerStatePath(io), `${JSON.stringify(state, null, 2)}\n`);
}

/** Drop seen entries older than the TTL (called on every mutating save). */
function evictExpired(state: TriggerState, nowMs: number): void {
  for (const [id, seenAt] of Object.entries(state.seen)) {
    if (nowMs - seenAt > SEEN_TTL_MS) delete state.seen[id];
  }
}

/** True iff `messageId` was already handled and is still within the TTL. */
export function hasSeen(messageId: string, io: TriggerStoreIO = defaultTriggerStoreIO): boolean {
  if (messageId.length === 0) return false;
  const state = loadState(io);
  const seenAt = state.seen[messageId];
  return seenAt !== undefined && io.now() - seenAt <= SEEN_TTL_MS;
}

/**
 * Commit a handled trigger: mark its `messageId` seen (when present) and upsert
 * its record (by requestId). One atomic save; evicts expired seen entries.
 */
export function commitTrigger(
  record: TriggerRecord,
  io: TriggerStoreIO = defaultTriggerStoreIO,
): void {
  const state = loadState(io);
  const nowMs = io.now();
  if (record.origin.messageId && record.origin.messageId.length > 0) {
    state.seen[record.origin.messageId] = nowMs;
  }
  const idx = state.records.findIndex((r) => r.requestId === record.requestId);
  if (idx >= 0) state.records[idx] = record;
  else state.records.push(record);
  evictExpired(state, nowMs);
  saveState(state, io);
}

export function getRecord(
  requestId: string,
  io: TriggerStoreIO = defaultTriggerStoreIO,
): TriggerRecord | undefined {
  return loadState(io).records.find((r) => r.requestId === requestId);
}

export function listRecords(io: TriggerStoreIO = defaultTriggerStoreIO): TriggerRecord[] {
  return loadState(io).records;
}

/**
 * Count committed trigger records whose `requesterId` (the resolved internal
 * authz subject) matches `userId` and were created at or after `sinceMs`. Backs
 * the per-user trigger rate limit (a flood of $-spending runs from one
 * requester). The record set is small (one per accepted trigger) and the
 * caller's window bounds relevance; an empty id never matches.
 */
export function countUserTriggersSince(
  userId: string,
  sinceMs: number,
  io: TriggerStoreIO = defaultTriggerStoreIO,
): number {
  if (userId.length === 0) return 0;
  return loadState(io).records.filter(
    (r) => r.requesterId === userId && r.createdAtMs >= sinceMs,
  ).length;
}

/** Patch a record's status (used by reporting + the watch). No-op if absent. */
export function updateRecordStatus(
  requestId: string,
  status: TriggerRecordStatus,
  io: TriggerStoreIO = defaultTriggerStoreIO,
): void {
  const state = loadState(io);
  const idx = state.records.findIndex((r) => r.requestId === requestId);
  if (idx < 0) return;
  state.records[idx] = { ...state.records[idx], status };
  saveState(state, io);
}

/** Merge a partial patch into a record (used by the stabilization watch to set
 *  status + watch fields together). No-op if the record is absent. */
export function patchRecord(
  requestId: string,
  patch: Partial<Omit<TriggerRecord, 'requestId'>>,
  io: TriggerStoreIO = defaultTriggerStoreIO,
): void {
  const state = loadState(io);
  const idx = state.records.findIndex((r) => r.requestId === requestId);
  if (idx < 0) return;
  state.records[idx] = { ...state.records[idx], ...patch, requestId };
  saveState(state, io);
}
