/**
 * Hook manifest schema unit tests (SPEC-019-1-05).
 *
 * Validates schemas/hook-manifest-v1.json structure and locks the
 * critical invariants documented in SPEC-019-1-01. No AJV — uses the
 * minimal hand-rolled validator from tests/helpers.
 *
 * @module __tests__/hooks/test-schema
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateManifest } from '../../../tests/helpers/schema-validator';

const SCHEMA_PATH = path.resolve(__dirname, '../../../schemas/hook-manifest-v1.json');

interface RawSchema {
  $schema: string;
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, unknown>;
  $defs: Record<string, unknown>;
  examples: unknown[];
}

describe('hook-manifest-v1.json schema', () => {
  let schema: RawSchema;

  beforeAll(() => {
    schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8')) as RawSchema;
  });

  test('parses cleanly as JSON', () => {
    expect(schema).toBeDefined();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  test('top-level required = id, name, version, hooks', () => {
    expect(schema.required.sort()).toEqual(['hooks', 'id', 'name', 'version']);
  });

  test('additionalProperties is false at top level', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  test('declares hookEntry $defs with the expected required fields', () => {
    const def = (schema.$defs.hookEntry as { required: string[]; additionalProperties: boolean });
    expect(def.required.sort()).toEqual(
      ['entry_point', 'failure_mode', 'hook_point', 'id', 'priority'],
    );
    expect(def.additionalProperties).toBe(false);
  });

  test('declares all 10 HookPoint enum strings on hook_point', () => {
    const def = schema.$defs.hookEntry as { properties: { hook_point: { enum: string[] } } };
    expect(def.properties.hook_point.enum.sort()).toEqual([
      'code-post-write',
      'code-pre-write',
      'deploy-post',
      'deploy-pre',
      'intake-pre-validate',
      'prd-pre-author',
      'review-post-score',
      'review-pre-score',
      'rule-evaluation',
      'tdd-pre-author',
    ]);
  });

  test('failure_mode enum = block | warn | ignore', () => {
    const def = schema.$defs.hookEntry as { properties: { failure_mode: { enum: string[] } } };
    expect(def.properties.failure_mode.enum.sort()).toEqual(['block', 'ignore', 'warn']);
  });

  test('embedded examples[0] passes the helper validator', () => {
    expect(schema.examples).toHaveLength(1);
    const errs = validateManifest(schema.examples[0], SCHEMA_PATH);
    expect(errs).toEqual([]);
  });

  // The remaining invariants exercise the helper validator (mirrors AJV
  // behaviour PLAN-019-2 will provide).
  test('rejects manifest missing id with pointer /id', () => {
    const errs = validateManifest({ name: 'X', version: '1.0.0', hooks: [] }, '/dev/null');
    expect(errs.some((e) => e.pointer === '/id')).toBe(true);
  });

  test('rejects invalid failure_mode (panic)', () => {
    const errs = validateManifest(
      {
        id: 'p',
        name: 'X',
        version: '1.0.0',
        hooks: [
          {
            id: 'h',
            hook_point: 'intake-pre-validate',
            entry_point: './h.js',
            priority: 100,
            failure_mode: 'panic',
          },
        ],
      },
      '/dev/null',
    );
    expect(errs.some((e) => e.pointer === '/hooks/0/failure_mode')).toBe(true);
  });

  test('rejects priority 1500', () => {
    const errs = validateManifest(
      {
        id: 'p',
        name: 'X',
        version: '1.0.0',
        hooks: [
          {
            id: 'h',
            hook_point: 'intake-pre-validate',
            entry_point: './h.js',
            priority: 1500,
            failure_mode: 'warn',
          },
        ],
      },
      '/dev/null',
    );
    expect(errs.some((e) => e.pointer === '/hooks/0/priority')).toBe(true);
  });

  test('rejects bad hook_point', () => {
    const errs = validateManifest(
      {
        id: 'p',
        name: 'X',
        version: '1.0.0',
        hooks: [
          {
            id: 'h',
            hook_point: 'not-a-real-point',
            entry_point: './h.js',
            priority: 100,
            failure_mode: 'warn',
          },
        ],
      },
      '/dev/null',
    );
    expect(errs.some((e) => e.pointer === '/hooks/0/hook_point')).toBe(true);
  });
});
