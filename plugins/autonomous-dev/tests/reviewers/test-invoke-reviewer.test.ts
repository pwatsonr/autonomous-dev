/**
 * Unit tests for the concrete dispatcher in intake/reviewers/invoke-reviewer.ts.
 *
 * Locks the contract from createClaudeDispatcher():
 *   - Builds the command with `--print --agent <name> --add-dir <repo> <prompt>`
 *     (positional prompt; NO `--input-json` flag — that was the #611 bug).
 *   - Well-formed stdout JSON `{ score, verdict }` → resolves the verdict.
 *   - JSON embedded in surrounding text → still parsed correctly (last
 *     balanced `{…}` wins).
 *   - Non-zero exit code → throws an Error.
 *   - Unparseable stdout (no valid JSON object) → throws an Error.
 *   - Missing `score` or `verdict` in the JSON → throws an Error.
 *   - `findings` field is propagated when present.
 *   - `getRegisteredReviewerNames()` returns the six known reviewer names.
 *   - `invokeReviewer` is exported and is an InvokeReviewerFn.
 */

import {
  createClaudeDispatcher,
  getRegisteredReviewerNames,
  invokeReviewer,
  type SpawnFn,
} from '../../intake/reviewers/invoke-reviewer';
import type { ChangeSetContext, ReviewerEntry } from '../../intake/reviewers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(name = 'code-reviewer'): ReviewerEntry {
  return { name, type: 'built-in', blocking: true, threshold: 80 };
}

function makeContext(): ChangeSetContext {
  return {
    repoPath: '/tmp/repo',
    changedFiles: ['src/foo.ts'],
    requestId: 'REQ-disp-test',
    gate: 'code_review',
    requestType: 'feature',
    isFrontendChange: false,
  };
}

/**
 * Build a mock SpawnFn that returns a fixed response.
 */
function mockSpawn(code: number, stdout: string, stderr = ''): SpawnFn {
  return jest.fn().mockResolvedValue({ code, stdout, stderr });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createClaudeDispatcher', () => {
  describe('command construction', () => {
    it('invokes claude with --print --add-dir <repo> --agent <name> <prompt>', async () => {
      const spawnMock = mockSpawn(0, JSON.stringify({ score: 85, verdict: 'APPROVE' }));
      const dispatch = createClaudeDispatcher({ spawn: spawnMock });
      const entry = makeEntry('code-reviewer');
      const context = makeContext();

      await dispatch(entry, context);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args] = (spawnMock as jest.Mock).mock.calls[0] as [string, string[], object];
      expect(cmd).toBe('claude');
      expect(args[0]).toBe('--print');
      // --add-dir is VARIADIC, so it must precede --agent (which terminates it);
      // otherwise it would swallow the positional prompt as a second directory.
      expect(args[1]).toBe('--add-dir');
      expect(args[2]).toBe(context.repoPath);
      expect(args[3]).toBe('--agent');
      expect(args[4]).toBe('code-reviewer');
      // There must be NO invalid --input-json flag anywhere in the argv.
      expect(args).not.toContain('--input-json');
      // The prompt is the LAST (positional) argument.
      expect(args).toHaveLength(6);
      // A per-reviewer wall-clock cap is passed so a hung reviewer can't stall the gate.
      const opts = (spawnMock as jest.Mock).mock.calls[0][2] as { timeoutMs?: number };
      expect(typeof opts.timeoutMs).toBe('number');
      expect(opts.timeoutMs as number).toBeGreaterThan(0);
    });

    it('passes a positional prompt that names the change set and demands the verdict JSON', async () => {
      const spawnMock = mockSpawn(0, JSON.stringify({ score: 85, verdict: 'APPROVE' }));
      const dispatch = createClaudeDispatcher({ spawn: spawnMock });
      const entry = makeEntry('code-reviewer');
      const context = makeContext();

      await dispatch(entry, context);

      const [, args] = (spawnMock as jest.Mock).mock.calls[0] as [string, string[], object];
      const prompt = args[args.length - 1];
      // Identifies the change to review.
      expect(prompt).toContain('code-reviewer');
      expect(prompt).toContain(context.repoPath);
      expect(prompt).toContain('src/foo.ts');
      // Instructs the exact verdict JSON shape that extractJsonVerdict parses.
      expect(prompt).toContain('"score"');
      expect(prompt).toContain('"verdict"');
      expect(prompt).toContain('APPROVE');
      expect(prompt).toContain('REQUEST_CHANGES');
    });

    it('inherits the parent environment so PATH and Anthropic creds survive', async () => {
      const spawnMock = mockSpawn(0, JSON.stringify({ score: 85, verdict: 'APPROVE' }));
      const dispatch = createClaudeDispatcher({ spawn: spawnMock });

      await dispatch(makeEntry(), makeContext());

      const [, , opts] = (spawnMock as jest.Mock).mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      // Not the stripped `{}` of the old bug — the full process env is forwarded.
      expect(opts.env).toBe(process.env);
    });

    it('parses a verdict from a mock reviewer emitting {score,verdict,findings}', async () => {
      const stdout = JSON.stringify({
        score: 91,
        verdict: 'APPROVE',
        findings: [{ severity: 'info', file: 'src/foo.ts', line: 1, message: 'looks good' }],
      });
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      const result = await dispatch(makeEntry(), makeContext());

      expect(result.score).toBe(91);
      expect(result.verdict).toBe('APPROVE');
      expect(result.findings).toEqual([
        { severity: 'info', file: 'src/foo.ts', line: 1, message: 'looks good' },
      ]);
    });

    it('uses the provided cwd option', async () => {
      const spawnMock = mockSpawn(0, JSON.stringify({ score: 85, verdict: 'APPROVE' }));
      const dispatch = createClaudeDispatcher({ spawn: spawnMock, cwd: '/custom/cwd' });

      await dispatch(makeEntry(), makeContext());

      const [, , opts] = (spawnMock as jest.Mock).mock.calls[0] as [
        string,
        string[],
        { cwd: string },
      ];
      expect(opts.cwd).toBe('/custom/cwd');
    });
  });

  describe('stdout JSON parsing', () => {
    it('parses a well-formed JSON verdict from stdout', async () => {
      const stdout = JSON.stringify({ score: 92, verdict: 'APPROVE', findings: { ok: true } });
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      const result = await dispatch(makeEntry(), makeContext());

      expect(result.score).toBe(92);
      expect(result.verdict).toBe('APPROVE');
      expect(result.findings).toEqual({ ok: true });
    });

    it('parses a REQUEST_CHANGES verdict', async () => {
      const stdout = JSON.stringify({ score: 60, verdict: 'REQUEST_CHANGES' });
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      const result = await dispatch(makeEntry(), makeContext());

      expect(result.verdict).toBe('REQUEST_CHANGES');
      expect(result.score).toBe(60);
    });

    it('extracts the LAST balanced JSON object when surrounded by chain-of-thought text', async () => {
      const stdout = [
        'Thinking about the code...',
        '{"note": "intermediate step"}',
        'Let me check security...',
        'Final verdict:',
        '{"score": 88, "verdict": "APPROVE", "findings": {"summary": "all good"}}',
        'Done.',
      ].join('\n');
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      const result = await dispatch(makeEntry(), makeContext());

      expect(result.score).toBe(88);
      expect(result.verdict).toBe('APPROVE');
    });

    it('extracts a verdict when it appears after non-JSON text with no newlines', async () => {
      const stdout = 'Some preamble text here. {"score":75,"verdict":"REQUEST_CHANGES"}. End.';
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      const result = await dispatch(makeEntry(), makeContext());

      expect(result.score).toBe(75);
      expect(result.verdict).toBe('REQUEST_CHANGES');
    });

    it('omits findings when not present in the JSON', async () => {
      const stdout = JSON.stringify({ score: 80, verdict: 'APPROVE' });
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      const result = await dispatch(makeEntry(), makeContext());

      expect(result.findings).toBeUndefined();
    });
  });

  describe('error paths', () => {
    it('throws when exit code is non-zero', async () => {
      const dispatch = createClaudeDispatcher({
        spawn: mockSpawn(1, '', 'claude: command failed'),
      });

      await expect(dispatch(makeEntry('code-reviewer'), makeContext())).rejects.toThrow(
        /exited with code 1/,
      );
    });

    it('throws when stdout has no parseable JSON object', async () => {
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, 'plain text, no json') });

      await expect(dispatch(makeEntry('code-reviewer'), makeContext())).rejects.toThrow(
        /unparseable output/,
      );
    });

    it('throws when JSON object is missing score', async () => {
      const stdout = JSON.stringify({ verdict: 'APPROVE' }); // score missing
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      await expect(dispatch(makeEntry('code-reviewer'), makeContext())).rejects.toThrow(
        /unparseable output/,
      );
    });

    it('throws when JSON object is missing verdict', async () => {
      const stdout = JSON.stringify({ score: 85 }); // verdict missing
      const dispatch = createClaudeDispatcher({ spawn: mockSpawn(0, stdout) });

      await expect(dispatch(makeEntry('code-reviewer'), makeContext())).rejects.toThrow(
        /unparseable output/,
      );
    });

    it('includes the reviewer name in the error message on non-zero exit', async () => {
      const dispatch = createClaudeDispatcher({
        spawn: mockSpawn(2, '', 'agent not found'),
      });

      await expect(dispatch(makeEntry('security-reviewer'), makeContext())).rejects.toThrow(
        /security-reviewer/,
      );
    });
  });
});

describe('getRegisteredReviewerNames', () => {
  it('returns a non-empty array including the six built-in reviewer names', () => {
    const names = getRegisteredReviewerNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names).toContain('quality-reviewer');
    expect(names).toContain('security-reviewer');
    expect(names).toContain('qa-edge-case-reviewer');
    expect(names).toContain('ux-ui-reviewer');
    expect(names).toContain('accessibility-reviewer');
    expect(names).toContain('rule-set-enforcement-reviewer');
  });

  it('returns a fresh array each call (not the internal reference)', () => {
    const a = getRegisteredReviewerNames();
    a.push('injected');
    const b = getRegisteredReviewerNames();
    expect(b).not.toContain('injected');
  });
});

describe('invokeReviewer compatibility export', () => {
  it('is a function (InvokeReviewerFn shape)', () => {
    expect(typeof invokeReviewer).toBe('function');
  });
});
