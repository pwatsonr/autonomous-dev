/**
 * Schema-shape tests for the chain engine (SPEC-022-1-05).
 *
 * Three schemas in scope:
 *   - schemas/plugin-manifest-v2.json
 *   - schemas/artifacts/security-findings/1.0.json
 *   - schemas/artifacts/code-patches/1.0.json
 *
 * Validation runs through AJV 2020 (the same engine ArtifactRegistry uses
 * in production) so test failures match runtime behavior byte-for-byte.
 *
 * @module tests/chains/test-schemas
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import {
  loadSecurityFindingsExample,
  loadCodePatchesExample,
} from '../helpers/chain-fixtures';

const SCHEMA_ROOT = path.resolve(__dirname, '..', '..', 'schemas');

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

// ---------------------------------------------------------------------------
// plugin-manifest-v2.json
// ---------------------------------------------------------------------------

describe('plugin-manifest-v2.json', () => {
  const manifestSchemaPath = path.join(SCHEMA_ROOT, 'plugin-manifest-v2.json');
  const schema = readJson(manifestSchemaPath) as Record<string, unknown>;
  const validate = makeAjv().compile(schema);

  const v1Manifest = {
    id: 'legacy-plugin',
    name: 'Legacy Plugin',
    version: '1.0.0',
    hooks: [
      {
        id: 'scan',
        hook_point: 'review-pre-score',
        entry_point: './scan.js',
        priority: 100,
        failure_mode: 'warn',
      },
    ],
  };

  it('parses cleanly', () => {
    expect(typeof schema).toBe('object');
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$id']).toContain('plugin-manifest-v2');
  });

  it('accepts the embedded examples[0]', () => {
    const examples = schema['examples'] as unknown[];
    expect(Array.isArray(examples)).toBe(true);
    const ok = validate(examples[0]);
    if (!ok) {
      throw new Error(`example failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it('accepts a v1-shaped manifest with no produces/consumes', () => {
    expect(validate(v1Manifest)).toBe(true);
  });

  it("rejects produces[].format = 'xml'", () => {
    const bad = {
      ...v1Manifest,
      produces: [
        { artifact_type: 'security-findings', schema_version: '1.0', format: 'xml' },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects consumes[] missing artifact_type', () => {
    const bad = {
      ...v1Manifest,
      consumes: [{ schema_version: '^1.0' }],
    };
    expect(validate(bad)).toBe(false);
    const errs = (validate.errors ?? []).map((e) => e.keyword);
    expect(errs).toContain('required');
  });

  it("rejects extra top-level field 'category'", () => {
    const bad = { ...v1Manifest, category: 'reviewer' } as Record<string, unknown>;
    expect(validate(bad)).toBe(false);
    const errs = (validate.errors ?? []).map((e) => e.keyword);
    expect(errs).toContain('additionalProperties');
  });

  it("rejects produces[].schema_version of '1' (pattern violation)", () => {
    const bad = {
      ...v1Manifest,
      produces: [
        { artifact_type: 'security-findings', schema_version: '1', format: 'json' },
      ],
    };
    expect(validate(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// security-findings/1.0.json
// ---------------------------------------------------------------------------

describe('security-findings/1.0.json', () => {
  const schemaPath = path.join(
    SCHEMA_ROOT,
    'artifacts',
    'security-findings',
    '1.0.json',
  );
  const schema = readJson(schemaPath) as Record<string, unknown>;
  const validate = makeAjv().compile(schema);

  it('parses cleanly with $schema and $id set', () => {
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(typeof schema['$id']).toBe('string');
    expect(String(schema['$id'])).toContain('security-findings');
  });

  it('validates the canonical example', async () => {
    const example = await loadSecurityFindingsExample();
    const ok = validate(example);
    if (!ok) {
      throw new Error(JSON.stringify(validate.errors));
    }
    expect(ok).toBe(true);
  });

  it('rejects payload missing scan_id', async () => {
    const example = (await loadSecurityFindingsExample()) as Record<string, unknown>;
    const { scan_id: _scanId, ...rest } = example;
    expect(validate(rest)).toBe(false);
  });

  it("rejects finding with severity 'urgent'", async () => {
    const example = (await loadSecurityFindingsExample()) as Record<string, unknown>;
    const cloned = JSON.parse(JSON.stringify(example));
    cloned.findings[0].severity = 'urgent';
    expect(validate(cloned)).toBe(false);
  });

  it('rejects extra top-level field', async () => {
    const example = (await loadSecurityFindingsExample()) as Record<string, unknown>;
    const cloned = JSON.parse(JSON.stringify(example));
    cloned.unknown_field = 'x';
    expect(validate(cloned)).toBe(false);
  });

  it('has additionalProperties:false at every object level (static walk)', () => {
    const visit = (node: unknown, breadcrumb: string): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object') {
        expect({ at: breadcrumb, additionalProperties: obj.additionalProperties }).toEqual({
          at: breadcrumb,
          additionalProperties: false,
        });
      }
      for (const [k, v] of Object.entries(obj)) {
        visit(v, `${breadcrumb}.${k}`);
      }
    };
    visit(schema, '$');
  });
});

// ---------------------------------------------------------------------------
// code-patches/1.0.json
// ---------------------------------------------------------------------------

describe('code-patches/1.0.json', () => {
  const schemaPath = path.join(SCHEMA_ROOT, 'artifacts', 'code-patches', '1.0.json');
  const schema = readJson(schemaPath) as Record<string, unknown>;
  const validate = makeAjv().compile(schema);

  it('parses cleanly with $schema and $id set', () => {
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(String(schema['$id'])).toContain('code-patches');
  });

  it('validates the canonical example', async () => {
    const example = await loadCodePatchesExample();
    const ok = validate(example);
    if (!ok) {
      throw new Error(JSON.stringify(validate.errors));
    }
    expect(ok).toBe(true);
  });

  it('rejects payload missing patch_id', async () => {
    const example = (await loadCodePatchesExample()) as Record<string, unknown>;
    const { patch_id: _pid, ...rest } = example;
    expect(validate(rest)).toBe(false);
  });

  it('rejects confidence: 1.5', async () => {
    const example = (await loadCodePatchesExample()) as Record<string, unknown>;
    const cloned = JSON.parse(JSON.stringify(example));
    cloned.patches[0].confidence = 1.5;
    expect(validate(cloned)).toBe(false);
  });

  it('rejects extra top-level field', async () => {
    const example = (await loadCodePatchesExample()) as Record<string, unknown>;
    const cloned = JSON.parse(JSON.stringify(example));
    cloned.bonus = true;
    expect(validate(cloned)).toBe(false);
  });
});
