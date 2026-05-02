/**
 * Unit tests for the chain resolver (SPEC-020-2-05, Task 10).
 *
 * Covers the contract from intake/reviewers/chain-resolver.ts:
 *   - Repo override at <repo>/.autonomous-dev/reviewer-chains.json wins.
 *   - Falls back to bundled defaults when no override is present.
 *   - Unknown requestType falls back to the `feature` chain.
 *   - Missing gate returns [].
 *   - Malformed override JSON throws ChainConfigError (no silent fallback).
 *   - enabled: false entries are filtered out.
 *
 * Spec note: SPEC-020-2-05 prescribed Vitest, but this plugin uses Jest
 * (jest.config.cjs at the package root); the deviation matches
 * test-frontend-detection.test.ts (PLAN-020-1).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ChainConfigError,
  loadChainConfig,
  resolveChain,
} from '../../intake/reviewers/chain-resolver';

const tempRoots: string[] = [];

function trackedRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-resolver-'));
  tempRoots.push(dir);
  return dir;
}

function writeOverride(repoPath: string, contents: string): void {
  const dir = path.join(repoPath, '.autonomous-dev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewer-chains.json'), contents, 'utf8');
}

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('chain-resolver', () => {
  describe('defaults fallback', () => {
    it('returns the bundled default feature.code_review chain when no override exists', async () => {
      const repo = trackedRepo();
      const chain = await resolveChain(repo, 'feature', 'code_review');
      // The default chain has 6 reviewers (matches config_defaults/reviewer-chains.json).
      expect(chain).toHaveLength(6);
      expect(chain[0].name).toBe('code-reviewer');
      expect(chain[5].name).toBe('rule-set-enforcement-reviewer');
    });

    it('returns the bundled hotfix chain (built-ins only)', async () => {
      const repo = trackedRepo();
      const chain = await resolveChain(repo, 'hotfix', 'code_review');
      expect(chain).toHaveLength(2);
      expect(chain.every((e) => e.type === 'built-in')).toBe(true);
    });
  });

  describe('repo override precedence', () => {
    it('returns the override chain when <repo>/.autonomous-dev/reviewer-chains.json exists', async () => {
      const repo = trackedRepo();
      writeOverride(
        repo,
        JSON.stringify({
          version: 1,
          request_types: {
            feature: {
              code_review: [
                {
                  name: 'custom-only-reviewer',
                  type: 'built-in',
                  blocking: true,
                  threshold: 70,
                },
              ],
            },
          },
        }),
      );
      const chain = await resolveChain(repo, 'feature', 'code_review');
      expect(chain).toHaveLength(1);
      expect(chain[0].name).toBe('custom-only-reviewer');
    });
  });

  describe('missing request type', () => {
    it('falls back to the feature chain when requestType is unknown', async () => {
      const repo = trackedRepo();
      const chore = await resolveChain(repo, 'chore', 'code_review');
      const feature = await resolveChain(repo, 'feature', 'code_review');
      expect(chore).toEqual(feature);
    });
  });

  describe('missing gate', () => {
    it('returns [] when the gate key is absent', async () => {
      const repo = trackedRepo();
      const chain = await resolveChain(repo, 'feature', 'post_deploy');
      expect(chain).toEqual([]);
    });
  });

  describe('malformed JSON', () => {
    it('throws ChainConfigError referencing the file path; does not fall back to defaults', async () => {
      const repo = trackedRepo();
      writeOverride(repo, '{invalid json'); // intentionally broken
      await expect(resolveChain(repo, 'feature', 'code_review')).rejects.toBeInstanceOf(
        ChainConfigError,
      );
      try {
        await resolveChain(repo, 'feature', 'code_review');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ChainConfigError);
        const e = err as ChainConfigError;
        expect(e.filePath).toBeDefined();
        expect(e.filePath).toContain('reviewer-chains.json');
      }
    });
  });

  describe('enabled filter', () => {
    it('excludes entries with enabled: false; keeps entries with enabled: true or absent', async () => {
      const repo = trackedRepo();
      writeOverride(
        repo,
        JSON.stringify({
          version: 1,
          request_types: {
            feature: {
              code_review: [
                { name: 'on-default', type: 'built-in', blocking: true, threshold: 80 },
                {
                  name: 'on-explicit',
                  type: 'built-in',
                  blocking: true,
                  threshold: 80,
                  enabled: true,
                },
                {
                  name: 'off',
                  type: 'specialist',
                  blocking: true,
                  threshold: 80,
                  enabled: false,
                },
              ],
            },
          },
        }),
      );
      const chain = await resolveChain(repo, 'feature', 'code_review');
      const names = chain.map((e) => e.name);
      expect(names).toEqual(['on-default', 'on-explicit']);
    });
  });

  describe('loadChainConfig', () => {
    it('loads bundled defaults and exposes both feature and hotfix entries', async () => {
      const repo = trackedRepo();
      const config = await loadChainConfig(repo);
      expect(config.version).toBe(1);
      expect(config.request_types.feature).toBeDefined();
      expect(config.request_types.hotfix).toBeDefined();
    });
  });
});
