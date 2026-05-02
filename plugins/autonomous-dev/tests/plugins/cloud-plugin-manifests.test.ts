/**
 * Cloud plugin manifest validation (SPEC-024-1-01).
 *
 * Validates that each of the four cloud-deployment plugin manifests
 * declares the required v2 extension surface (`extends`,
 * `deployment_backend`) per TDD-024 §5. The PLAN-022-1 v2 schema
 * (`schemas/plugin-manifest-v2.json`) is for hook-manifest files
 * (`hooks.json`), NOT for `.claude-plugin/plugin.json`; this suite
 * therefore performs structural assertions directly rather than
 * invoking a v2 validator that does not yet exist for plugin manifests.
 *
 * @module tests/plugins/cloud-plugin-manifests.test
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGINS = [
  'autonomous-dev-deploy-gcp',
  'autonomous-dev-deploy-aws',
  'autonomous-dev-deploy-azure',
  'autonomous-dev-deploy-k8s',
] as const;

const EXPECTED_BACKEND_NAMES: Record<(typeof PLUGINS)[number], string> = {
  'autonomous-dev-deploy-gcp': 'gcp',
  'autonomous-dev-deploy-aws': 'aws',
  'autonomous-dev-deploy-azure': 'azure',
  'autonomous-dev-deploy-k8s': 'k8s',
};

/** Repo root resolved from this file's location (works regardless of cwd). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  extends?: unknown;
  deployment_backend?: {
    name?: unknown;
    regions_supported?: unknown;
    services_supported?: unknown;
    credential_provider?: unknown;
  };
}

function readManifest(plugin: string): PluginManifest {
  const path = join(REPO_ROOT, 'plugins', plugin, '.claude-plugin', 'plugin.json');
  const raw = readFileSync(path, 'utf8');
  // Round-trip via JSON.parse to confirm no comments / trailing commas.
  return JSON.parse(raw) as PluginManifest;
}

describe.each(PLUGINS)('cloud plugin manifest: %s', (name) => {
  let manifest: PluginManifest;

  beforeAll(() => {
    manifest = readManifest(name);
  });

  test('parses as strict JSON (no comments, no trailing commas)', () => {
    expect(manifest).toBeDefined();
    expect(typeof manifest).toBe('object');
  });

  test('declares the matching name field', () => {
    expect(manifest.name).toBe(name);
  });

  test('declares version 0.1.0', () => {
    expect(manifest.version).toBe('0.1.0');
  });

  test('extends autonomous-dev', () => {
    expect(manifest.extends).toEqual(['autonomous-dev']);
  });

  test('declares deployment_backend block with credential-proxy provider', () => {
    expect(manifest.deployment_backend).toBeDefined();
    const block = manifest.deployment_backend as NonNullable<
      PluginManifest['deployment_backend']
    >;
    expect(block.credential_provider).toBe('credential-proxy');
    expect(Array.isArray(block.regions_supported)).toBe(true);
    expect((block.regions_supported as string[]).length).toBeGreaterThan(0);
    expect(Array.isArray(block.services_supported)).toBe(true);
    expect((block.services_supported as string[]).length).toBeGreaterThan(0);
  });

  test('deployment_backend.name matches the expected cloud identifier', () => {
    const block = manifest.deployment_backend as NonNullable<
      PluginManifest['deployment_backend']
    >;
    expect(block.name).toBe(EXPECTED_BACKEND_NAMES[name]);
  });
});
