/**
 * Tests for policy config loading — issues #668 + #669.
 *
 * Coverage:
 *   1. `loadPolicyFile` — absent file (null), valid YAML, invalid YAML,
 *      schema validation errors
 *   2. `extractPolicyFromConfig` — absent key (null), valid nested policy,
 *      invalid value (throws)
 *   3. `getActivePolicy` / `setActivePolicy` / `resetActivePolicy` singleton
 *   4. Schema validation: empty rules array, valid rules, invalid rule shape
 *
 * @module tests/deploy/policy-config.test
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadPolicyFile,
  policyPathFor,
  extractPolicyFromConfig,
  getActivePolicy,
  setActivePolicy,
  resetActivePolicy,
} from '../../intake/deploy/policy-config';
import { EMPTY_POLICY } from '../../intake/deploy/policy-types';
import { ConfigValidationError } from '../../intake/deploy/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeRepoWithPolicy(content: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'policy-config-'));
  await mkdir(join(tmp, '.autonomous-dev'), { recursive: true });
  await writeFile(join(tmp, '.autonomous-dev', 'policy.yaml'), content, 'utf8');
  return tmp;
}

async function makeEmptyRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'policy-config-empty-'));
}

const VALID_POLICY_YAML = `
version: "1.0"
rules: []
`;

const VALID_POLICY_WITH_RULES_YAML = `
version: "1.0"
rules:
  - id: gpu-placement
    description: ML nodes need GPU
    when:
      tag:
        key: role
        value: ml
    type: placement
    effect: deny
    params:
      require:
        capability: gpu
  - id: prod-approval
    when:
      env: prod
    type: placement
    effect: require-approval
    params:
      approvers:
        - senior-engineers
`;

// ---------------------------------------------------------------------------
// 1. loadPolicyFile
// ---------------------------------------------------------------------------

describe('loadPolicyFile', () => {
  it('returns null when no policy.yaml exists', async () => {
    const repo = await makeEmptyRepo();
    try {
      expect(await loadPolicyFile(repo)).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns PolicyDocument for valid empty-rules YAML', async () => {
    const repo = await makeRepoWithPolicy(VALID_POLICY_YAML);
    try {
      const doc = await loadPolicyFile(repo);
      expect(doc).not.toBeNull();
      expect(doc!.version).toBe('1.0');
      expect(doc!.rules).toHaveLength(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns PolicyDocument with parsed rules', async () => {
    const repo = await makeRepoWithPolicy(VALID_POLICY_WITH_RULES_YAML);
    try {
      const doc = await loadPolicyFile(repo);
      expect(doc).not.toBeNull();
      expect(doc!.rules).toHaveLength(2);
      expect(doc!.rules[0].id).toBe('gpu-placement');
      expect(doc!.rules[0].effect).toBe('deny');
      expect(doc!.rules[1].id).toBe('prod-approval');
      expect(doc!.rules[1].effect).toBe('require-approval');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError for invalid YAML', async () => {
    const repo = await makeRepoWithPolicy('{{{{invalid yaml');
    try {
      await expect(loadPolicyFile(repo)).rejects.toThrow(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError when top-level is not a mapping', async () => {
    const repo = await makeRepoWithPolicy('- item1\n- item2\n');
    try {
      await expect(loadPolicyFile(repo)).rejects.toThrow(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError when version is wrong', async () => {
    const repo = await makeRepoWithPolicy('version: "2.0"\nrules: []\n');
    try {
      await expect(loadPolicyFile(repo)).rejects.toThrow(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError when required field is missing (no version)', async () => {
    const repo = await makeRepoWithPolicy('rules: []\n');
    try {
      await expect(loadPolicyFile(repo)).rejects.toThrow(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError when rule has invalid effect', async () => {
    const bad = `
version: "1.0"
rules:
  - id: bad-rule
    type: placement
    effect: invalid-effect
    params: {}
`;
    const repo = await makeRepoWithPolicy(bad);
    try {
      await expect(loadPolicyFile(repo)).rejects.toThrow(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws ConfigValidationError when rule id has invalid format', async () => {
    const bad = `
version: "1.0"
rules:
  - id: "UPPERCASE-not-allowed"
    type: placement
    effect: deny
    params: {}
`;
    const repo = await makeRepoWithPolicy(bad);
    try {
      await expect(loadPolicyFile(repo)).rejects.toThrow(ConfigValidationError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('policyPathFor returns correct path', () => {
    expect(policyPathFor('/my/repo')).toBe('/my/repo/.autonomous-dev/policy.yaml');
  });
});

// ---------------------------------------------------------------------------
// 2. extractPolicyFromConfig
// ---------------------------------------------------------------------------

describe('extractPolicyFromConfig', () => {
  it('returns null when policy key is absent', () => {
    const config = { version: '2.0', environments: {}, rules: [] };
    const result = extractPolicyFromConfig(config as Record<string, unknown>, '/fake/path');
    expect(result).toBeNull();
  });

  it('returns PolicyDocument when policy key is valid', () => {
    const config = {
      version: '2.0',
      environments: {},
      policy: {
        version: '1.0',
        rules: [],
      },
    };
    const result = extractPolicyFromConfig(config as Record<string, unknown>, '/fake/path');
    expect(result).not.toBeNull();
    expect(result!.version).toBe('1.0');
    expect(result!.rules).toHaveLength(0);
  });

  it('extracts rules from inline policy', () => {
    const config = {
      policy: {
        version: '1.0',
        rules: [
          {
            id: 'my-rule',
            type: 'quota',
            effect: 'deny',
            params: { max: 5 },
          },
        ],
      },
    };
    const result = extractPolicyFromConfig(config as Record<string, unknown>, '/fake/path');
    expect(result!.rules).toHaveLength(1);
    expect(result!.rules[0].id).toBe('my-rule');
  });

  it('throws ConfigValidationError when policy key is an array', () => {
    const config = { policy: [{ id: 'bad' }] };
    expect(() => extractPolicyFromConfig(config as Record<string, unknown>, '/fake/path')).toThrow(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when policy key is a string', () => {
    const config = { policy: 'invalid' };
    expect(() => extractPolicyFromConfig(config as Record<string, unknown>, '/fake/path')).toThrow(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when inline policy fails schema validation', () => {
    const config = {
      policy: {
        version: '1.0',
        rules: [
          {
            id: 'bad-rule',
            type: 'placement',
            effect: 'not-a-valid-effect', // invalid
            params: {},
          },
        ],
      },
    };
    expect(() => extractPolicyFromConfig(config as Record<string, unknown>, '/fake/path')).toThrow(
      ConfigValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Active policy singleton
// ---------------------------------------------------------------------------

describe('active policy singleton', () => {
  afterEach(() => resetActivePolicy());

  it('getActivePolicy returns EMPTY_POLICY by default', () => {
    expect(getActivePolicy()).toBe(EMPTY_POLICY);
  });

  it('setActivePolicy replaces the active policy', async () => {
    const repo = await makeRepoWithPolicy(VALID_POLICY_WITH_RULES_YAML);
    try {
      const doc = await loadPolicyFile(repo);
      setActivePolicy(doc!);
      expect(getActivePolicy()).toBe(doc!);
      expect(getActivePolicy().rules).toHaveLength(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
      resetActivePolicy();
    }
  });

  it('resetActivePolicy restores EMPTY_POLICY', async () => {
    const repo = await makeRepoWithPolicy(VALID_POLICY_YAML);
    try {
      const doc = await loadPolicyFile(repo);
      setActivePolicy(doc!);
      resetActivePolicy();
      expect(getActivePolicy()).toBe(EMPTY_POLICY);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('getActivePolicy is backward-compatible: returns allow-all when no policy configured', () => {
    // No setActivePolicy call — singleton is EMPTY_POLICY
    const { evaluatePolicy } = require('../../intake/deploy/policy-engine');
    const { EMPTY_POLICY: EP } = require('../../intake/deploy/policy-types');
    const policy = getActivePolicy();
    expect(policy).toBe(EP);
    // Verifying it allows all deploys
    const d = evaluatePolicy(
      {
        service: 'svc',
        target: {
          id: 't1',
          name: 'T',
          kind: 'local',
          provider: 'local',
          capabilities: [],
          tags: {},
          source: 'config',
        },
      },
      policy,
    );
    expect(d.allowed).toBe(true);
  });
});
