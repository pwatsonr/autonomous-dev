/**
 * Unit tests for the fix-recipe schema + emitter (SPEC-021-3-04, Task 11).
 *
 * Coverage targets:
 *   - Schema validates each canonical fixture.
 *   - Schema rejects each documented invalid shape (missing required fields,
 *     bad enum, out-of-range confidence, malformed ids, extra root fields).
 *   - Schema's own `examples` self-validate (drift guard).
 *   - `emitFixRecipe()` round-trip writes a valid file with deterministic id.
 *   - `emitFixRecipe()` rejects invalid input BEFORE any file I/O.
 *   - Idempotent id for byte-identical input; distinct id when input differs.
 *   - Directory mode 0700 / file mode 0600 (best-effort on hostile FS).
 *
 * @module tests/standards/test-fix-recipe.test
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
import Ajv2020 from 'ajv/dist/2020';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import addFormats from 'ajv-formats';

import {
  emitFixRecipe,
  buildViolationId,
  readFixRecipe,
  statModeBits,
  __resetFixRecipeValidatorCacheForTests,
  type Violation,
} from '../../intake/standards/fix-recipe';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixRecipeSchema = require('../../schemas/fix-recipe-v1.json');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'fix-recipes');
const FIXTURE_FILES = [
  'code-replacement-sql.json',
  'file-creation-health.json',
  'dependency-add-fastapi.json',
];

function makeValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(fixRecipeSchema);
}

async function readJson(file: string): Promise<unknown> {
  const buf = await fs.readFile(file, { encoding: 'utf8' });
  return JSON.parse(buf);
}

async function makeTempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'fix-recipe-test-'));
}

beforeEach(() => {
  __resetFixRecipeValidatorCacheForTests();
});

describe('fix-recipe schema', () => {
  const validate = makeValidator();

  it.each(FIXTURE_FILES)('accepts the %s fixture', async (name) => {
    const data = await readJson(path.join(FIXTURE_DIR, name));
    const ok = validate(data);
    if (!ok) {
      // surface ajv errors when the test fails so debugging is fast
      // eslint-disable-next-line no-console
      console.error(validate.errors);
    }
    expect(ok).toBe(true);
  });

  it('rejects a recipe missing violation_id', async () => {
    const fixture = (await readJson(path.join(FIXTURE_DIR, 'code-replacement-sql.json'))) as Record<string, unknown>;
    delete fixture.violation_id;
    expect(validate(fixture)).toBe(false);
    const text = (validate.errors ?? []).map((e: any) => e.message).join(';');
    expect(text).toMatch(/violation_id/);
  });

  it('rejects a recipe with an invalid fix_type', async () => {
    const fixture = (await readJson(path.join(FIXTURE_DIR, 'code-replacement-sql.json'))) as Record<string, unknown>;
    fixture.fix_type = 'magic-fix';
    expect(validate(fixture)).toBe(false);
    const text = (validate.errors ?? []).map((e: any) => e.keyword).join(';');
    expect(text).toContain('enum');
  });

  it('rejects confidence > 1', async () => {
    const fixture = (await readJson(path.join(FIXTURE_DIR, 'code-replacement-sql.json'))) as Record<string, unknown>;
    fixture.confidence = 1.5;
    expect(validate(fixture)).toBe(false);
  });

  it('rejects confidence < 0', async () => {
    const fixture = (await readJson(path.join(FIXTURE_DIR, 'code-replacement-sql.json'))) as Record<string, unknown>;
    fixture.confidence = -0.1;
    expect(validate(fixture)).toBe(false);
  });

  it('rejects malformed violation_id', async () => {
    const fixture = (await readJson(path.join(FIXTURE_DIR, 'code-replacement-sql.json'))) as Record<string, unknown>;
    fixture.violation_id = 'VIO-bad';
    expect(validate(fixture)).toBe(false);
  });

  it('rejects malformed rule_id (missing namespace separator)', async () => {
    const fixture = (await readJson(path.join(FIXTURE_DIR, 'code-replacement-sql.json'))) as Record<string, unknown>;
    fixture.rule_id = 'no-namespace';
    expect(validate(fixture)).toBe(false);
  });

  it('rejects extra root fields under additionalProperties: false', async () => {
    const fixture = (await readJson(path.join(FIXTURE_DIR, 'code-replacement-sql.json'))) as Record<string, unknown>;
    (fixture as any).extra_field = 'x';
    expect(validate(fixture)).toBe(false);
    const keywords = (validate.errors ?? []).map((e: any) => e.keyword);
    expect(keywords).toContain('additionalProperties');
  });

  it('self-test: every example in schema.examples validates against the schema', () => {
    const examples = (fixRecipeSchema as any).examples ?? [];
    expect(Array.isArray(examples)).toBe(true);
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      const ok = validate(ex);
      if (!ok) {
        // eslint-disable-next-line no-console
        console.error('Example failed validation:', ex, validate.errors);
      }
      expect(ok).toBe(true);
    }
  });
});

describe('emitFixRecipe', () => {
  let stateDir = '';

  beforeEach(async () => {
    stateDir = await makeTempStateDir();
  });

  afterEach(async () => {
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  const validViolation: Violation = {
    rule_id: 'security:no-sql-injection',
    file: 'src/db/users.ts',
    line: 42,
    fix_type: 'code-replacement',
    before: 'db.query(`SELECT * FROM users WHERE id = ${userId}`)',
    after_template: "db.query('SELECT * FROM users WHERE id = $1', [userId])",
    confidence: 0.95,
  };

  it('writes a valid recipe file and returns a matching violation_id', async () => {
    const id = await emitFixRecipe(validViolation, stateDir);
    expect(id).toMatch(/^VIO-\d{8}T\d{6}Z-[a-f0-9]{8}$/);

    const file = path.join(stateDir, 'fix-recipes', `${id}.json`);
    const recipe = await readFixRecipe(file);
    expect(recipe.violation_id).toBe(id);

    // Re-validate against the schema by re-reading raw JSON.
    const validate = makeValidator();
    const raw = await readJson(file);
    expect(validate(raw)).toBe(true);
  });

  it('throws on schema-invalid input and writes no file', async () => {
    const bad: Violation = { ...validViolation, confidence: 1.5 };
    await expect(emitFixRecipe(bad, stateDir)).rejects.toThrow(/invalid fix recipe/);
    // Directory may exist (mkdir is recursive), but should hold no recipes.
    const dir = path.join(stateDir, 'fix-recipes');
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // dir may not exist if mkdir hadn't run yet; that's also acceptable.
    }
    expect(entries.filter((e) => e.endsWith('.json'))).toEqual([]);
  });

  it('produces the same violation_id for byte-identical input within the same second', () => {
    const fixed = new Date('2026-05-01T12:00:00Z');
    const a = buildViolationId(validViolation, fixed);
    const b = buildViolationId(validViolation, fixed);
    expect(a).toBe(b);
  });

  it('produces a different violation_id for differing input (hash differs)', () => {
    const fixed = new Date('2026-05-01T12:00:00Z');
    const a = buildViolationId(validViolation, fixed);
    const b = buildViolationId({ ...validViolation, confidence: 0.94 }, fixed);
    expect(a).not.toBe(b);
    // Same timestamp prefix, different hash suffix.
    expect(a.slice(0, 20)).toBe(b.slice(0, 20));
    expect(a.slice(-8)).not.toBe(b.slice(-8));
  });

  it('creates the fix-recipes directory with mode 0700 (best-effort)', async () => {
    await emitFixRecipe(validViolation, stateDir);
    const dirMode = await statModeBits(path.join(stateDir, 'fix-recipes'));
    // On Windows / some CI sandboxes chmod is a no-op; skip the strict check there.
    if (process.platform === 'win32') {
      expect(dirMode).not.toBeNull();
    } else {
      expect(dirMode).toBe(0o700);
    }
  });

  it('writes the recipe file with mode 0600 (best-effort)', async () => {
    const id = await emitFixRecipe(validViolation, stateDir);
    const fileMode = await statModeBits(path.join(stateDir, 'fix-recipes', `${id}.json`));
    if (process.platform === 'win32') {
      expect(fileMode).not.toBeNull();
    } else {
      expect(fileMode).toBe(0o600);
    }
  });

  it('round-trips each fixture as a Violation input', async () => {
    for (const name of FIXTURE_FILES) {
      const fixture = (await readJson(path.join(FIXTURE_DIR, name))) as Record<string, unknown>;
      // Strip the pre-baked violation_id; emitter regenerates it.
      const { violation_id: _omit, ...rest } = fixture as any;
      const id = await emitFixRecipe(rest as Violation, stateDir);
      expect(id).toMatch(/^VIO-\d{8}T\d{6}Z-[a-f0-9]{8}$/);
      const written = await readFixRecipe(path.join(stateDir, 'fix-recipes', `${id}.json`));
      expect(written.rule_id).toBe(rest.rule_id);
      expect(written.fix_type).toBe(rest.fix_type);
    }
  });
});
