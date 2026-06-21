/**
 * Smoke tests for the review-gate CLI (SPEC-020-2-04, Task 8).
 *
 * Tests the `main(argv, deps)` seam exported from bin/review-gate-cli.ts.
 * A mock InvokeReviewerFn is injected so no Claude process is spawned.
 * stdout is captured by temporarily replacing process.stdout.write.
 *
 * Locks:
 *   - All required args present → runs gate, emits GateDecision JSON, exits 0.
 *   - --help → prints usage, exits 0, no gate invocation.
 *   - Missing required args → exits 1, no gate invocation.
 *   - Unknown option → exits 1.
 *   - --context-json path → loads context from file.
 *   - Empty chain (gate absent from config) → APPROVE JSON, exits 0.
 *   - Gate outcome APPROVE → exits 0 (not 1).
 *   - Gate outcome REQUEST_CHANGES → still exits 0 (hard-error-only convention).
 *   - Bad --context-json path → exits 1.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { main, type ReviewGateCliDeps } from '../../bin/review-gate-cli';
import type { ReviewerEntry } from '../../intake/reviewers/types';
import type { InvokeReviewerFn } from '../../intake/reviewers/runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function trackedTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write a minimal reviewer-chains.json override for `feature.code_review`.
 */
function writeChain(repoPath: string, entries: ReviewerEntry[]): void {
  const dir = path.join(repoPath, '.autonomous-dev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'reviewer-chains.json'),
    JSON.stringify({
      version: 1,
      request_types: { feature: { code_review: entries } },
    }),
    'utf8',
  );
}

/**
 * Run `main(argv, deps)` while capturing stdout. Returns `{ code, output }`.
 */
async function runCli(
  argv: string[],
  deps: ReviewGateCliDeps = {},
): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // Intercept stdout.write.
  process.stdout.write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  try {
    const code = await main(argv, deps);
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
}

/** A mock InvokeReviewerFn that always APPROVEs with score 90. */
const alwaysApprove: InvokeReviewerFn = jest.fn().mockResolvedValue({
  score: 90,
  verdict: 'APPROVE' as const,
});

/** A mock InvokeReviewerFn that always REQUEST_CHANGEs with score 50. */
const alwaysRequestChanges: InvokeReviewerFn = jest.fn().mockResolvedValue({
  score: 50,
  verdict: 'REQUEST_CHANGES' as const,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('review-gate-cli main()', () => {
  beforeEach(() => {
    (alwaysApprove as jest.Mock).mockClear();
    (alwaysRequestChanges as jest.Mock).mockClear();
  });

  describe('successful run', () => {
    it('runs a gate and emits GateDecision JSON to stdout, exits 0', async () => {
      const repo = trackedTmp('cli-basic-');
      writeChain(repo, [
        { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
      ]);

      const { code, output } = await runCli(
        ['--repo', repo, '--request-type', 'feature', '--gate', 'code_review'],
        { invoke: alwaysApprove },
      );

      expect(code).toBe(0);
      const decision = JSON.parse(output) as Record<string, unknown>;
      expect(decision.outcome).toBe('APPROVE');
      expect(decision.gate).toBe('code_review');
      expect(decision.requestType).toBe('feature');
      expect(Array.isArray(decision.results)).toBe(true);
    });

    it('exits 0 even when outcome is REQUEST_CHANGES (verdict is in JSON)', async () => {
      const repo = trackedTmp('cli-rc-exit-');
      writeChain(repo, [
        { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
      ]);

      const { code, output } = await runCli(
        ['--repo', repo, '--request-type', 'feature', '--gate', 'code_review'],
        { invoke: alwaysRequestChanges },
      );

      expect(code).toBe(0);
      const decision = JSON.parse(output) as Record<string, unknown>;
      expect(decision.outcome).toBe('REQUEST_CHANGES');
    });

    it('passes --changed-files into the context', async () => {
      const repo = trackedTmp('cli-changed-');
      writeChain(repo, [
        { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
      ]);
      const capturedContexts: unknown[] = [];
      const captureInvoke: InvokeReviewerFn = jest
        .fn()
        .mockImplementation(async (_entry, context) => {
          capturedContexts.push(context);
          return { score: 90, verdict: 'APPROVE' as const };
        });

      await runCli(
        [
          '--repo',
          repo,
          '--request-type',
          'feature',
          '--gate',
          'code_review',
          '--changed-files',
          'src/a.ts,src/b.ts',
        ],
        { invoke: captureInvoke },
      );

      expect(capturedContexts).toHaveLength(1);
      const ctx = capturedContexts[0] as { changedFiles: string[] };
      expect(ctx.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('handles empty chain (gate not in config) → APPROVE JSON, exits 0', async () => {
      const repo = trackedTmp('cli-empty-');
      // Write a config with no code_review key.
      const dir = path.join(repo, '.autonomous-dev');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'reviewer-chains.json'),
        JSON.stringify({
          version: 1,
          request_types: { feature: {} },
        }),
        'utf8',
      );

      const invoke: InvokeReviewerFn = jest.fn();
      const { code, output } = await runCli(
        ['--repo', repo, '--request-type', 'feature', '--gate', 'code_review'],
        { invoke },
      );

      expect(code).toBe(0);
      const decision = JSON.parse(output) as Record<string, unknown>;
      expect(decision.outcome).toBe('APPROVE');
      expect(decision.reason).toContain('no reviewers configured');
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('--context-json', () => {
    it('loads context from a JSON file', async () => {
      const repo = trackedTmp('cli-ctx-json-');
      writeChain(repo, [
        { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
      ]);

      const contextFile = path.join(repo, 'context.json');
      fs.writeFileSync(
        contextFile,
        JSON.stringify({
          repoPath: repo,
          changedFiles: ['foo.ts'],
          requestId: 'REQ-ctx-file',
          gate: 'code_review',
          requestType: 'feature',
          isFrontendChange: false,
        }),
        'utf8',
      );

      const capturedRequestIds: string[] = [];
      const captureInvoke: InvokeReviewerFn = jest
        .fn()
        .mockImplementation(async (_entry, context) => {
          capturedRequestIds.push((context as { requestId: string }).requestId);
          return { score: 90, verdict: 'APPROVE' as const };
        });

      const { code } = await runCli(
        [
          '--repo',
          repo,
          '--request-type',
          'feature',
          '--gate',
          'code_review',
          '--context-json',
          contextFile,
        ],
        { invoke: captureInvoke },
      );

      expect(code).toBe(0);
      expect(capturedRequestIds[0]).toBe('REQ-ctx-file');
    });

    it('exits 1 when --context-json path does not exist', async () => {
      const repo = trackedTmp('cli-ctx-missing-');
      writeChain(repo, [
        { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
      ]);

      const { code } = await runCli(
        [
          '--repo',
          repo,
          '--request-type',
          'feature',
          '--gate',
          'code_review',
          '--context-json',
          '/nonexistent/path/context.json',
        ],
        { invoke: alwaysApprove },
      );

      expect(code).toBe(1);
    });
  });

  describe('argument errors', () => {
    it('exits 1 and does not invoke the gate when --repo is missing', async () => {
      const invoke: InvokeReviewerFn = jest.fn();
      const { code } = await runCli(['--request-type', 'feature', '--gate', 'code_review'], {
        invoke,
      });
      expect(code).toBe(1);
      expect(invoke).not.toHaveBeenCalled();
    });

    it('exits 1 when --request-type is missing', async () => {
      const { code } = await runCli(['--repo', '/tmp', '--gate', 'code_review']);
      expect(code).toBe(1);
    });

    it('exits 1 when --gate is missing', async () => {
      const { code } = await runCli(['--repo', '/tmp', '--request-type', 'feature']);
      expect(code).toBe(1);
    });

    it('exits 1 on unknown option', async () => {
      const { code } = await runCli([
        '--repo',
        '/tmp',
        '--request-type',
        'feature',
        '--gate',
        'code_review',
        '--unknown-flag',
      ]);
      expect(code).toBe(1);
    });
  });

  describe('--help', () => {
    it('prints usage and exits 0 without invoking the gate', async () => {
      const invoke: InvokeReviewerFn = jest.fn();
      const { code, output } = await runCli(['--help'], { invoke });
      expect(code).toBe(0);
      expect(output).toContain('--repo');
      expect(output).toContain('--gate');
      expect(invoke).not.toHaveBeenCalled();
    });

    it('-h is equivalent to --help', async () => {
      const { code } = await runCli(['-h']);
      expect(code).toBe(0);
    });
  });
});
