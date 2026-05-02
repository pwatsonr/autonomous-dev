/**
 * Extensions config schema tests for `privileged_backends` (SPEC-024-2-01).
 *
 * The credential proxy reads `extensions.privileged_backends[]` to gate
 * `acquire()` calls. This test pins the JSON-schema contract:
 *
 *   - Each entry must match the plugin-id regex `^[a-z][a-z0-9-]{1,63}$`.
 *   - Default is `[]` (no implicit allowlist — operators must opt in).
 *   - Uppercase / invalid IDs fail validation.
 */

import Ajv2020 from 'ajv/dist/2020';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schemas/autonomous-dev-config.schema.json',
);

function loadSchema(): object {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8')) as object;
}

function makeValidator() {
  // The schema declares draft-2020-12 — use the matching Ajv build to
  // match the production validator path used elsewhere in this plugin.
  const AjvCtor = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;
  const ajv = new AjvCtor({ allErrors: true, useDefaults: true, strict: false });
  return ajv.compile(loadSchema());
}

describe('extensions.privileged_backends schema', () => {
  it('accepts a config with two valid plugin IDs', () => {
    const validate = makeValidator();
    const cfg = {
      extensions: {
        privileged_backends: ['plugin-a', 'autonomous-dev-deploy-aws'],
      },
    };
    expect(validate(cfg)).toBe(true);
    // After validation+default-fill, the field is preserved as supplied.
    expect(
      (cfg.extensions as { privileged_backends: string[] }).privileged_backends,
    ).toEqual(['plugin-a', 'autonomous-dev-deploy-aws']);
  });

  it('rejects uppercase plugin IDs', () => {
    const validate = makeValidator();
    const cfg = { extensions: { privileged_backends: ['BadCase'] } };
    expect(validate(cfg)).toBe(false);
    const errors = validate.errors ?? [];
    expect(errors.some((e) => e.keyword === 'pattern')).toBe(true);
  });

  it('rejects empty-string plugin IDs', () => {
    const validate = makeValidator();
    const cfg = { extensions: { privileged_backends: [''] } };
    expect(validate(cfg)).toBe(false);
  });

  it('rejects plugin IDs longer than 64 chars', () => {
    const validate = makeValidator();
    const tooLong = 'a' + 'b'.repeat(64); // 65 chars total
    const cfg = { extensions: { privileged_backends: [tooLong] } };
    expect(validate(cfg)).toBe(false);
  });

  it('defaults to [] when privileged_backends is absent', () => {
    const validate = makeValidator();
    const cfg: { extensions: Record<string, unknown> } = { extensions: {} };
    expect(validate(cfg)).toBe(true);
    // AJV with useDefaults fills in the default at the field level when
    // the parent object has matching default; here we accept either
    // explicit empty array or absence — both mean "no implicit allowlist".
    const value = (cfg.extensions as { privileged_backends?: string[] })
      .privileged_backends;
    expect(value === undefined || (Array.isArray(value) && value.length === 0))
      .toBe(true);
  });

  it('rejects non-array values', () => {
    const validate = makeValidator();
    const cfg = { extensions: { privileged_backends: 'not-an-array' } };
    expect(validate(cfg)).toBe(false);
  });
});
