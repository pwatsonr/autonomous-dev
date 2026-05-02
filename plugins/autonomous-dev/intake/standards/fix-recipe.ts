/**
 * FixRecipe interface, Violation input shape, and `emitFixRecipe()` helper
 * (SPEC-021-3-03).
 *
 * The fix-recipe is the contract by which the rule-set-enforcement-reviewer
 * (PLAN-020-1) emits machine-applicable fix instructions. Downstream
 * consumers (TDD-022 code-fixer plugins) read recipes from
 * `<state-dir>/fix-recipes/<id>.json` and apply them.
 *
 * `emitFixRecipe()`:
 *   - Generates a deterministic `violation_id` from a UTC timestamp +
 *     SHA-256 hash of the input. Identical inputs within the same second
 *     produce the same id (idempotency).
 *   - Validates against `schemas/fix-recipe-v1.json` BEFORE any file I/O.
 *   - Creates `<stateDir>/fix-recipes/` (mode 0700) if absent.
 *   - Writes atomically: write to `<id>.json.tmp` then `rename()`.
 *   - File mode 0600.
 *
 * @module intake/standards/fix-recipe
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// Reuse the same Ajv 2020 entry as the loader (PLAN-021-1) for consistency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import Ajv2020 from 'ajv/dist/2020';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import addFormats from 'ajv-formats';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixRecipeSchema = require('../../schemas/fix-recipe-v1.json');

/** Discriminator for the kind of fix. */
export type FixType = 'code-replacement' | 'file-creation' | 'dependency-add';

/**
 * The persisted recipe shape — mirrors `schemas/fix-recipe-v1.json` 1:1.
 */
export interface FixRecipe {
  violation_id: string;
  rule_id: string;
  file: string;
  line: number;
  fix_type: FixType;
  before: string;
  after_template: string;
  confidence: number;
  manual_review_required?: boolean;
}

/**
 * Input shape passed by the rule-set-enforcement-reviewer when emitting
 * a finding. Differs from `FixRecipe` only by the absence of `violation_id`
 * (the helper generates that deterministically).
 */
export interface Violation {
  rule_id: string;
  file: string;
  line: number;
  fix_type: FixType;
  before: string;
  after_template: string;
  confidence: number;
  manual_review_required?: boolean;
}

// Compile the schema once per process. Ajv compilation is the expensive
// step; subsequent `validate()` calls are O(spec) and reused across
// many recipe emissions.
let cachedValidator: ((data: unknown) => boolean) & { errors?: unknown } | null = null;
let cachedAjv: Ajv2020 | null = null;

function getValidator() {
  if (cachedValidator !== null) return { validate: cachedValidator, ajv: cachedAjv! };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(fixRecipeSchema);
  cachedValidator = validate as typeof cachedValidator;
  cachedAjv = ajv;
  return { validate: cachedValidator!, ajv };
}

/**
 * Reset compiled validator cache — test-only hook.
 */
export function __resetFixRecipeValidatorCacheForTests(): void {
  cachedValidator = null;
  cachedAjv = null;
}

/**
 * Build the `violation_id` deterministically.
 *
 * Format: `VIO-<YYYYMMDDTHHmmssZ>-<8-hex>` where the timestamp is the
 * current UTC second and the hash is SHA-256 of the canonicalized
 * violation JSON, truncated to 8 hex chars.
 *
 * Two emissions with byte-identical content within the same UTC second
 * produce the same id (intentional idempotency); even one differing byte
 * yields a different hash.
 */
export function buildViolationId(violation: Violation, now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/[-:.]/g, '')
    .slice(0, 15) + 'Z'; // YYYYMMDDTHHmmssZ
  const hash = createHash('sha256')
    .update(JSON.stringify(violation))
    .digest('hex')
    .slice(0, 8);
  return `VIO-${ts}-${hash}`;
}

/**
 * Persist a Violation as a FixRecipe at `<stateDir>/fix-recipes/<violation_id>.json`.
 *
 * - Generates `violation_id` via `buildViolationId(violation)`.
 * - Validates the constructed recipe against `fix-recipe-v1.json`.
 * - Creates `<stateDir>/fix-recipes/` with mode 0700 if absent.
 * - Writes atomically (temp file + rename) with file mode 0600.
 *
 * @returns the generated violation_id
 * @throws Error("invalid fix recipe: ...") if schema validation fails
 * @throws underlying fs errors if the state dir is unwritable
 */
export async function emitFixRecipe(
  violation: Violation,
  stateDir: string,
): Promise<string> {
  const violationId = buildViolationId(violation);
  const recipe: FixRecipe = { violation_id: violationId, ...violation };

  const { validate, ajv } = getValidator();
  if (!validate(recipe)) {
    throw new Error(`invalid fix recipe: ${ajv.errorsText((validate as any).errors ?? null)}`);
  }

  const dir = path.join(stateDir, 'fix-recipes');
  // mkdir recursive ignores existing dirs. We then chmod to enforce 0700
  // on the leaf directory regardless of the caller's umask.
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Best-effort: some FS (Windows, certain CI sandboxes) reject chmod;
    // the spec's mode requirement is informational on those platforms.
  }

  const target = path.join(dir, `${violationId}.json`);
  const tmp = `${target}.tmp`;
  // Stringify with two-space indent so the on-disk file is human-diffable.
  const body = JSON.stringify(recipe, null, 2) + '\n';
  await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  // Ensure the mode is enforced even if writeFile honored umask differently.
  try {
    await fs.chmod(tmp, 0o600);
  } catch {
    // see chmod note above
  }
  await fs.rename(tmp, target);

  return violationId;
}

/**
 * Convenience: read and parse a recipe file from disk. Useful for tests
 * and future code-fixer consumers; not required by the emitter.
 */
export async function readFixRecipe(filePath: string): Promise<FixRecipe> {
  const buf = await fs.readFile(filePath, { encoding: 'utf8' });
  const parsed = JSON.parse(buf) as FixRecipe;
  return parsed;
}

/**
 * Test helper: ensure a path exists with the expected mode bits. Returns
 * the file's mode (masked to permission bits) without throwing on missing.
 */
export async function statModeBits(p: string): Promise<number | null> {
  try {
    const s = await fs.stat(p);
    return s.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Re-export the constant so tests can verify access without re-reading the FS.
export const PERMISSION_CHECK_FLAG = fsConstants.F_OK;
