/**
 * Timeout-resolver tests for `resolveChain` (SPEC-REQ-000050 TASK-003).
 *
 * Covers TR-01..TR-11: verifies that the chain-resolver populates a clamped
 * `timeout_ms` on every returned entry using the four-level precedence chain:
 *   1. entry.timeout_ms
 *   2. gate_defaults[gate].timeout_ms
 *   3. config.defaults.timeout_ms
 *   4. process.env.REVIEWER_TIMEOUT_MS
 *   5. Built-in default 900_000
 *
 * Uses a temp-dir fixture approach mirroring test-chain-resolver.test.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveChain } from '../../intake/reviewers/chain-resolver';

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function trackedRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-resolver-timeout-'));
  tempRoots.push(dir);
  return dir;
}

function writeOverride(repoPath: string, config: object): void {
  const dir = path.join(repoPath, '.autonomous-dev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewer-chains.json'), JSON.stringify(config), 'utf8');
}

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Base config fixture builder
// ---------------------------------------------------------------------------

function makeConfig(overrides: {
  entryTimeout?: number;
  gateDefaultTimeout?: number;
  configDefaultTimeout?: number;
} = {}): object {
  const entry: Record<string, unknown> = {
    name: 'doc-reviewer',
    type: 'built-in',
    blocking: true,
    threshold: 80,
  };
  if (overrides.entryTimeout !== undefined) {
    entry['timeout_ms'] = overrides.entryTimeout;
  }

  const featureBlock: Record<string, unknown> = {
    code_review: [entry],
  };
  if (overrides.gateDefaultTimeout !== undefined) {
    featureBlock['gate_defaults'] = {
      code_review: { timeout_ms: overrides.gateDefaultTimeout },
    };
  }

  const config: Record<string, unknown> = {
    version: 1,
    request_types: {
      feature: featureBlock,
    },
  };
  if (overrides.configDefaultTimeout !== undefined) {
    config['defaults'] = { timeout_ms: overrides.configDefaultTimeout };
  }

  return config;
}

// ---------------------------------------------------------------------------
// TR-01..TR-11 tests
// ---------------------------------------------------------------------------

describe('resolveChain — timeout resolution (SPEC-REQ-000050)', () => {
  const origEnv = process.env.REVIEWER_TIMEOUT_MS;

  beforeEach(() => {
    // Reset env before each test.
    delete process.env.REVIEWER_TIMEOUT_MS;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.REVIEWER_TIMEOUT_MS = origEnv;
    } else {
      delete process.env.REVIEWER_TIMEOUT_MS;
    }
  });

  it('TR-01: per-entry timeout wins over gate_defaults and defaults', async () => {
    const repo = trackedRepo();
    writeOverride(repo, makeConfig({ entryTimeout: 600000, gateDefaultTimeout: 1200000, configDefaultTimeout: 900000 }));
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain).toHaveLength(1);
    expect(chain[0].timeout_ms).toBe(600000);
  });

  it('TR-02: gate_defaults wins over defaults', async () => {
    const repo = trackedRepo();
    writeOverride(repo, makeConfig({ gateDefaultTimeout: 1200000, configDefaultTimeout: 900000 }));
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(1200000);
  });

  it('TR-03: defaults wins over env', async () => {
    process.env.REVIEWER_TIMEOUT_MS = '500000';
    const repo = trackedRepo();
    writeOverride(repo, makeConfig({ configDefaultTimeout: 700000 }));
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(700000);
  });

  it('TR-04: env wins over built-in default', async () => {
    process.env.REVIEWER_TIMEOUT_MS = '500000';
    const repo = trackedRepo();
    writeOverride(repo, makeConfig());
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(500000);
  });

  it('TR-05: built-in default 900_000 when nothing set', async () => {
    const repo = trackedRepo();
    writeOverride(repo, makeConfig());
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(900000);
  });

  it('TR-06: value below 30_000 is clamped to 30_000 (runtime clamp, bypasses schema)', async () => {
    // Write config directly (bypassing schema validation) to test runtime clamp.
    const repo = trackedRepo();
    writeOverride(repo, makeConfig({ entryTimeout: 5000 }));
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(30000);
  });

  it('TR-07: value above 3_600_000 is clamped to 3_600_000', async () => {
    const repo = trackedRepo();
    writeOverride(repo, makeConfig({ entryTimeout: 99_999_999 }));
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(3600000);
  });

  it('TR-08: empty env value "" is ignored (built-in default applies)', async () => {
    process.env.REVIEWER_TIMEOUT_MS = '';
    const repo = trackedRepo();
    writeOverride(repo, makeConfig());
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(900000);
  });

  it('TR-09: non-numeric env value "abc" is ignored', async () => {
    process.env.REVIEWER_TIMEOUT_MS = 'abc';
    const repo = trackedRepo();
    writeOverride(repo, makeConfig());
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain[0].timeout_ms).toBe(900000);
  });

  it('TR-10: gate_defaults is NOT returned as a chain entry', async () => {
    const repo = trackedRepo();
    writeOverride(repo, makeConfig({ gateDefaultTimeout: 1200000 }));

    // The resolved code_review chain should only contain doc-reviewer.
    const chain = await resolveChain(repo, 'feature', 'code_review');
    const names = chain.map((e) => e.name);
    expect(names).toContain('doc-reviewer');
    expect(names).not.toContain('gate_defaults');

    // Resolving the literal key 'gate_defaults' as a gate name returns [].
    const gateDefaultsChain = await resolveChain(repo, 'feature', 'gate_defaults');
    expect(gateDefaultsChain).toEqual([]);
  });

  it('TR-11: every returned entry has timeout_ms as a finite integer', async () => {
    const repo = trackedRepo();
    // Use the bundled defaults so we test multi-entry chains.
    const chain = await resolveChain(repo, 'feature', 'code_review');
    expect(chain.length).toBeGreaterThan(0);
    for (const entry of chain) {
      expect(typeof entry.timeout_ms).toBe('number');
      expect(Number.isInteger(entry.timeout_ms)).toBe(true);
      expect(Number.isFinite(entry.timeout_ms)).toBe(true);
    }
  });
});
