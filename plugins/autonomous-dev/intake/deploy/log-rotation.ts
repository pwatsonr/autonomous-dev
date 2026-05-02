/**
 * Log rotation policy helper (SPEC-023-3-02).
 *
 * Pure: takes the projected file size + pending write size and decides
 * whether to rotate. Performs no I/O. The actual rename ladder lives in
 * `logger.ts` (see `DeployLogger.rotate`).
 *
 * Rotation rules per TDD-023 §13:
 *   - Trigger when (currentSize + pendingBytes) > rotateAtBytes.
 *   - Shift `<comp>.log.N` → `<comp>.log.N+1` for N = maxRotations-1
 *     down to 1; drop `<comp>.log.maxRotations` if present; rename
 *     `<comp>.log` → `<comp>.log.1`; open a fresh `<comp>.log`.
 *   - Cap at maxRotations rotated files (default 10) so total disk per
 *     component is ≤ 11 × rotateAtBytes.
 *
 * @module intake/deploy/log-rotation
 */

export const DEFAULT_ROTATE_AT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_ROTATIONS = 10;

export interface RotationPlan {
  /** True iff the writer must rotate before appending the next line. */
  shouldRotate: boolean;
  /** Ordered list of (src,dst) renames to execute. */
  renames: { src: string; dst: string }[];
  /** Path the writer should drop (rm) before the rename ladder, if any. */
  drop?: string;
}

export interface PlanRotationArgs {
  basePath: string;
  currentSize: number;
  pendingBytes: number;
  rotateAtBytes: number;
  maxRotations: number;
}

/**
 * Pure planning of the rotation steps. Returns `shouldRotate: false`
 * with an empty `renames` array when no rotation is needed; otherwise
 * the renames are returned in execution order (highest index first).
 */
export function planRotation(args: PlanRotationArgs): RotationPlan {
  if (args.currentSize + args.pendingBytes <= args.rotateAtBytes) {
    return { shouldRotate: false, renames: [] };
  }
  const renames: { src: string; dst: string }[] = [];
  // Drop the oldest file (`.maxRotations`) before shifting so the chain
  // does not exceed the cap.
  const drop = `${args.basePath}.${args.maxRotations}`;
  for (let i = args.maxRotations - 1; i >= 1; i--) {
    renames.push({
      src: `${args.basePath}.${i}`,
      dst: `${args.basePath}.${i + 1}`,
    });
  }
  renames.push({ src: args.basePath, dst: `${args.basePath}.1` });
  return { shouldRotate: true, renames, drop };
}
