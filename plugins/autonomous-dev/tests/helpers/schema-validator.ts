/**
 * Minimal hand-rolled schema validator for hook manifests
 * (SPEC-019-1-05 helper). Conforms to the SchemaValidator signature
 * PluginDiscovery expects. Keeps PLAN-019-1's tests free of an AJV
 * dependency; PLAN-019-2 will swap in the AJV-backed validator.
 *
 * @module tests/helpers/schema-validator
 */

import type { DiscoveryError } from '../../intake/hooks/discovery';

const HOOK_POINTS = [
  'intake-pre-validate',
  'prd-pre-author',
  'tdd-pre-author',
  'code-pre-write',
  'code-post-write',
  'review-pre-score',
  'review-post-score',
  'deploy-pre',
  'deploy-post',
  'rule-evaluation',
];

const FAILURE_MODES = ['block', 'warn', 'ignore'];

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

export function validateManifest(raw: unknown, manifestPath: string): DiscoveryError[] {
  const errors: DiscoveryError[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: 'manifest must be a JSON object' });
    return errors;
  }
  const m = raw as Record<string, unknown>;

  for (const field of ['id', 'name', 'version'] as const) {
    if (typeof m[field] !== 'string' || !(m[field] as string).length) {
      errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: `missing or invalid ${field}`, pointer: `/${field}` });
    }
  }

  if (typeof m.id === 'string' && !KEBAB_RE.test(m.id)) {
    errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: 'id must be kebab-case', pointer: '/id' });
  }

  if (!Array.isArray(m.hooks)) {
    errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: 'hooks must be an array', pointer: '/hooks' });
    return errors;
  }

  m.hooks.forEach((h, i) => {
    if (typeof h !== 'object' || h === null) {
      errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: 'hook must be object', pointer: `/hooks/${i}` });
      return;
    }
    const hook = h as Record<string, unknown>;
    for (const field of ['id', 'hook_point', 'entry_point', 'failure_mode'] as const) {
      if (typeof hook[field] !== 'string') {
        errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: `hooks[${i}].${field} missing`, pointer: `/hooks/${i}/${field}` });
      }
    }
    if (typeof hook.priority !== 'number' || hook.priority < 0 || hook.priority > 1000 || !Number.isInteger(hook.priority)) {
      errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: `hooks[${i}].priority must be integer 0..1000`, pointer: `/hooks/${i}/priority` });
    }
    if (typeof hook.hook_point === 'string' && !HOOK_POINTS.includes(hook.hook_point)) {
      errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: `hooks[${i}].hook_point invalid`, pointer: `/hooks/${i}/hook_point` });
    }
    if (typeof hook.failure_mode === 'string' && !FAILURE_MODES.includes(hook.failure_mode)) {
      errors.push({ manifestPath, code: 'SCHEMA_ERROR', message: `hooks[${i}].failure_mode invalid`, pointer: `/hooks/${i}/failure_mode` });
    }
  });

  return errors;
}
