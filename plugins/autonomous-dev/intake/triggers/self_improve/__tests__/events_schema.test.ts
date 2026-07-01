/**
 * T009 (schema tests) — Validate all 8 event JSON schemas using ajv.
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as path from 'path';
import * as fs from 'fs';

const SCHEMAS_DIR = path.resolve(__dirname, '../../../../../../docs/schemas/events');

const SCHEMA_FILES = [
  'self_improve_disabled.schema.json',
  'self_improve_issue_detected.schema.json',
  'self_improve_issue_skipped.schema.json',
  'self_improve_request_submitted.schema.json',
  'self_improve_tick_summary.schema.json',
  'self_improve_error.schema.json',
  'self_improve_body_truncated.schema.json',
  'self_improve_config_invalid.schema.json',
];

const VALID_FIXTURES: Record<string, object> = {
  'self_improve_disabled.schema.json': {
    type: 'self_improve_disabled',
    ts: '2026-07-01T14:00:00.000Z',
  },
  'self_improve_issue_detected.schema.json': {
    type: 'self_improve_issue_detected',
    ts: '2026-07-01T14:00:00.000Z',
    repoId: 'owner/repo',
    issueNumber: 42,
    class: 'A1',
  },
  'self_improve_issue_skipped.schema.json': {
    type: 'self_improve_issue_skipped',
    ts: '2026-07-01T14:00:00.000Z',
    repoId: 'owner/repo',
    issueNumber: 42,
    guard: 'GD1',
    evidence: {},
  },
  'self_improve_request_submitted.schema.json': {
    type: 'self_improve_request_submitted',
    ts: '2026-07-01T14:00:00.000Z',
    repoId: 'owner/repo',
    issueNumber: 42,
    requestId: 'REQ-000001',
    class: 'A1',
  },
  'self_improve_tick_summary.schema.json': {
    type: 'self_improve_tick_summary',
    ts: '2026-07-01T14:00:00.000Z',
    scanned: 5,
    submitted: 1,
    skipped: { GD1: 2 },
    errors: 0,
  },
  'self_improve_error.schema.json': {
    type: 'self_improve_error',
    ts: '2026-07-01T14:00:00.000Z',
    error: 'something went wrong',
    code: 'GH_LIST_FAILED',
    repoId: 'owner/repo',
    issueNumber: 42,
  },
  'self_improve_body_truncated.schema.json': {
    type: 'self_improve_body_truncated',
    ts: '2026-07-01T14:00:00.000Z',
    repoId: 'owner/repo',
    issueNumber: 42,
    originalBytes: 40960,
    truncatedBytes: 32768,
  },
  'self_improve_config_invalid.schema.json': {
    type: 'self_improve_config_invalid',
    ts: '2026-07-01T14:00:00.000Z',
    envVar: 'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ATTEMPTS',
    raw: 'bad',
    fallback: '3',
  },
};

/** Create a fresh Ajv instance per schema to avoid "already exists" collisions. */
function makeAjv(): Ajv {
  const instance = new Ajv({ strict: false });
  addFormats(instance);
  return instance;
}

describe('event JSON schemas', () => {
  describe.each(SCHEMA_FILES)('%s', (schemaFile) => {
    it('T009-03: schema compiles without error', () => {
      const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      expect(() => makeAjv().compile(schema)).not.toThrow();
    });

    it('T009-04: valid fixture validates against schema', () => {
      const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const validate = makeAjv().compile(schema);
      const fixture = VALID_FIXTURES[schemaFile];
      const valid = validate(fixture);
      expect(valid).toBe(true);
    });

    it('T009-05: fixture missing "type" fails validation', () => {
      const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const validate = makeAjv().compile(schema);
      const fixture = { ...VALID_FIXTURES[schemaFile] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (fixture as any).type;
      const valid = validate(fixture);
      expect(valid).toBe(false);
    });

    it('T009-06: fixture with extra field fails (additionalProperties)', () => {
      const schemaPath = path.join(SCHEMAS_DIR, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      const validate = makeAjv().compile(schema);
      const fixture = { ...VALID_FIXTURES[schemaFile], __EXTRA__: 'should fail' };
      const valid = validate(fixture);
      expect(valid).toBe(false);
    });
  });
});
