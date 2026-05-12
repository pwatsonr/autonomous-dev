/**
 * state.json writer helper for TDD-038 intake-to-deploy pipeline.
 *
 * Implements the FR-824a two-phase commit pattern: atomic temp file write +
 * rename to produce state.json files that the daemon can discover. Enforces
 * path-traversal guards and request ID validation per security requirements.
 *
 * @module lib/state_json_writer
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Request entity passed to writeStateJson(). Maps from the SQLite RequestEntity
 * with additional fields needed for state.json generation.
 */
export interface RequestEntity {
  request_id: string;
  status: string;
  current_phase: string;
  priority: 'high' | 'normal' | 'low' | string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string;
  target_repo: string;
  source_channel: string;
  type: 'feature' | 'bug' | 'infra' | 'refactor' | 'hotfix' | string;
}

/**
 * Typed error for state.json write failures. Code field allows callers to
 * distinguish between different failure modes for appropriate remediation.
 */
export class StateJsonError extends Error {
  constructor(public code: 'VALIDATION_ERROR' | 'PATH_ESCAPE' | 'PERMISSION_DENIED' | 'IO_ERROR', message: string) {
    super(message);
    this.name = 'StateJsonError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Write a request's state.json file atomically using the FR-824a pattern.
 *
 * Creates the file at `<targetRepo>/.autonomous-dev/requests/<id>/state.json`
 * with all 19 fields from TDD §6.1. Uses atomic temp + rename to prevent
 * readers from observing partial writes.
 *
 * @param request - The request entity to write
 * @param targetRepo - Absolute path to the target repository
 * @returns Absolute path to the written state.json file
 * @throws {StateJsonError} On validation, path escape, or I/O errors
 */
export function writeStateJson(request: RequestEntity, targetRepo: string): string {
  // Validate request_id format per SPEC-039-1-02
  if (!request.request_id.match(/^REQ-\d{6}$/)) {
    throw new StateJsonError(
      'VALIDATION_ERROR',
      `request_id must match ^REQ-\\d{6}$, got: ${request.request_id}`
    );
  }

  const reqDir = path.join(targetRepo, '.autonomous-dev', 'requests', request.request_id);
  const stateFile = path.join(reqDir, 'state.json');
  const tmpFile = `${stateFile}.tmp.${process.pid}`;

  // Path-traversal guard: resolved request dir must be within target repo
  const resolvedReqDir = path.resolve(reqDir);
  const resolvedTargetRepo = path.resolve(targetRepo);

  // Use realpath to handle symlinks consistently (e.g., macOS /tmp -> /private/var/folders)
  let realReqDir: string;
  let realTargetRepo: string;
  try {
    realTargetRepo = fs.realpathSync.native(resolvedTargetRepo);
  } catch {
    // If target repo doesn't exist yet, use resolved path
    realTargetRepo = resolvedTargetRepo;
  }

  try {
    realReqDir = fs.realpathSync.native(resolvedReqDir);
  } catch {
    // If req dir doesn't exist yet (which is normal), construct the real path
    // by checking parent directories up to what exists
    let checkPath = resolvedReqDir;
    while (checkPath && !fs.existsSync(checkPath)) {
      checkPath = path.dirname(checkPath);
    }
    if (checkPath && checkPath !== '.') {
      const realCheckPath = fs.realpathSync.native(checkPath);
      const relativePart = path.relative(checkPath, resolvedReqDir);
      realReqDir = path.join(realCheckPath, relativePart);
    } else {
      realReqDir = resolvedReqDir;
    }
  }

  const expectedPrefix = realTargetRepo + path.sep;
  if (!realReqDir.startsWith(expectedPrefix) && realReqDir !== realTargetRepo) {
    throw new StateJsonError(
      'PATH_ESCAPE',
      `request directory escapes target repo: ${realReqDir} not under ${realTargetRepo}`
    );
  }

  // Priority mapping: string to integer per TDD §6.1
  const priorityMap: Record<string, number> = { high: 0, normal: 1, low: 2 };
  const priorityValue = priorityMap[request.priority] ?? 1;

  // Build state object with exactly the 19 fields from TDD §6.1
  const state = {
    id: request.request_id,
    status: 'queued',
    current_phase: 'intake',
    priority: priorityValue,
    created_at: request.created_at,
    updated_at: request.updated_at,
    title: request.title,
    description: request.description,
    target_repo: targetRepo,
    source: request.source_channel,
    type: request.type,
    blocked_by: [],
    phase_history: [],
    phase_overrides: [],  // Always present per SUGGESTION-1
    current_phase_metadata: {},
    cost_accrued_usd: 0,
    turn_count: 0,
    escalation_count: 0,
    schema_version: 1,
    error: null,
  };

  try {
    // Create parent directories
    fs.mkdirSync(reqDir, { recursive: true });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EACCES') {
      throw new StateJsonError(
        'PERMISSION_DENIED',
        `cannot create directory ${reqDir}: permission denied. Check that the target repository is writable.`
      );
    }
    throw new StateJsonError(
      'IO_ERROR',
      `failed to create directory ${reqDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    // Write to temp file first
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');

    // Atomic rename
    fs.renameSync(tmpFile, stateFile);

    return stateFile;
  } catch (err) {
    // Clean up temp file on any error
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }

    if (err instanceof Error && 'code' in err && err.code === 'EACCES') {
      throw new StateJsonError(
        'PERMISSION_DENIED',
        `cannot write state file ${stateFile}: permission denied`
      );
    }

    throw new StateJsonError(
      'IO_ERROR',
      `failed to write state file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}