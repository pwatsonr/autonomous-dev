/**
 * Jest tests for the `submit-bug` interactive flow + non-interactive
 * flag mode (SPEC-018-3-05, Task 9).
 *
 * The spec proposes `inquirer-test` as the harness, but the
 * implementation uses readline-driven prompts instead of inquirer
 * (documented in SPEC-018-3-02 commit). To stay framework-free we
 * inject a fake {@link PromptIO} via the exported
 * {@link runInteractivePrompts} entry point — exercising every prompt,
 * validation rule, and re-prompt path without spawning a real TTY.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runInteractivePrompts,
  validateBugReport,
  defaultEnvironment,
  BUG_PROMPTS,
  type PromptIO,
} from '../../cli/bug-prompts';
import { collectBugReport } from '../../adapters/cli_adapter';

// ---------------------------------------------------------------------------
// Scripted-PromptIO helper
// ---------------------------------------------------------------------------

interface ScriptedIO extends PromptIO {
  prompts: string[];
  outputs: string[];
}

/**
 * Build a {@link PromptIO} that returns answers from a fixed queue.
 * `answers` is consumed in order; each call to ask() pops one.
 *
 * Supplying fewer answers than prompts asked throws 'no scripted answer'
 * — protects against silent test underspecification.
 */
function scripted(answers: string[]): ScriptedIO {
  const queue = [...answers];
  const prompts: string[] = [];
  const outputs: string[] = [];
  return {
    prompts,
    outputs,
    write(line: string): void {
      outputs.push(line);
    },
    ask(prompt: string): Promise<string> {
      prompts.push(prompt);
      if (queue.length === 0) {
        return Promise.reject(
          new Error(`no scripted answer for prompt: ${prompt}`),
        );
      }
      return Promise.resolve(queue.shift() as string);
    },
    close(): void {
      // no-op
    },
  };
}

// Convenience: minimum valid scripted answers in BUG_PROMPTS order.
function happyPathAnswers(): string[] {
  return [
    'My bug title', // title
    'A short description', // description
    'step 1', 'step 2', '', // reproduction_steps loop (2 + sentinel)
    'Expected X', // expected_behavior
    'Actual Y', // actual_behavior
    'err line 1', '', // error_messages loop (1 + sentinel)
    '', // environment.os (accept default)
    '', // environment.runtime (accept default)
    '', // environment.version (accept default)
    '', // severity (accept default = medium)
    '', // affected_components (immediate sentinel)
    '', // labels CSV (skip)
    '', // user_impact (skip)
  ];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SPEC-018-3-05 — submit-bug interactive flow', () => {
  it('case 1: happy path produces a fully populated, valid BugReport', async () => {
    const io = scripted(happyPathAnswers());
    const report = await runInteractivePrompts(io);
    expect(validateBugReport(report)).toEqual([]);
    expect(report.title).toBe('My bug title');
    expect(report.reproduction_steps).toEqual(['step 1', 'step 2']);
    expect(report.error_messages).toEqual(['err line 1']);
    expect(report.severity).toBe('medium'); // default applied
  });

  it('case 3: empty repro_steps re-prompts with the locked message', async () => {
    // First repro answer empty triggers the re-prompt; then a real step.
    const answers = [
      'title',
      'description',
      '', // reproduction_steps #1: empty → re-prompted
      'step 1', // reproduction_steps #1 retry
      '', // sentinel
      'expected',
      'actual',
      '', // error_messages sentinel (zero allowed)
      '', '', '', // environment defaults
      '', // severity default
      '', '', '', // optional fields skipped
    ];
    const io = scripted(answers);
    const report = await runInteractivePrompts(io);
    expect(io.outputs).toContain(
      '! At least one reproduction step is required',
    );
    expect(report.reproduction_steps).toEqual(['step 1']);
  });

  it('case 4: title >200 chars is re-prompted with length error', async () => {
    const longTitle = 'x'.repeat(201);
    const answers = [
      longTitle, // first attempt — rejected
      'short ok', // accepted
      'description',
      'step 1', '',
      'expected',
      'actual',
      '',
      '', '', '',
      '',
      '', '', '',
    ];
    const io = scripted(answers);
    const report = await runInteractivePrompts(io);
    const rejectMsg = io.outputs.find((o) => o.includes('Title must be at most 200'));
    expect(rejectMsg).toBeDefined();
    expect(report.title).toBe('short ok');
  });

  it('case 5: severity defaults to medium when prompt skipped', async () => {
    const io = scripted(happyPathAnswers());
    const report = await runInteractivePrompts(io);
    expect(report.severity).toBe('medium');
  });

  it('case 6: optional fields stay absent (not undefined / null) when skipped', async () => {
    const io = scripted(happyPathAnswers());
    const report = await runInteractivePrompts(io);
    expect('affected_components' in report).toBe(false);
    expect('labels' in report).toBe(false);
    expect('user_impact' in report).toBe(false);
  });

  it('case 10: env defaults reflect the running platform', async () => {
    const io = scripted(happyPathAnswers());
    const report = await runInteractivePrompts(io);
    const env = defaultEnvironment();
    expect(report.environment.os).toBe(env.os);
    expect(report.environment.runtime).toBe(`node ${process.version}`);
  });

  it('exposes BUG_PROMPTS in the documented order', () => {
    const fields = BUG_PROMPTS.map((p) => p.field);
    expect(fields[0]).toBe('title');
    expect(fields[2]).toBe('reproduction_steps');
    expect(fields[fields.length - 1]).toBe('user_impact');
    expect(fields).toContain('severity');
  });
});

// ---------------------------------------------------------------------------
// Non-interactive flag mode (cases 7, 8, 9) via collectBugReport
// ---------------------------------------------------------------------------

describe('SPEC-018-3-05 — submit-bug non-interactive flag mode', () => {
  let stderrChunks: string[];
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrChunks = [];
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      });
  });
  afterEach(() => stderrSpy.mockRestore());

  it('case 7: all required flags supplied succeeds without prompting', async () => {
    const opts: Record<string, unknown> = {
      nonInteractive: true,
      title: 'flag title',
      description: 'flag description',
      reproStep: ['step a'],
      expected: 'E',
      actual: 'A',
      os: 'linux 6.0',
      runtime: 'node v20',
      version: '0.0.1',
    };
    const report = await collectBugReport(opts);
    expect(report).not.toBeNull();
    expect(report?.title).toBe('flag title');
    expect(report?.reproduction_steps).toEqual(['step a']);
    expect(report?.environment.os).toBe('linux 6.0');
  });

  it('case 8: missing --title rejects with validation header', async () => {
    const opts: Record<string, unknown> = {
      nonInteractive: true,
      description: 'd',
      reproStep: ['s'],
      expected: 'e',
      actual: 'a',
      os: 'o',
      runtime: 'r',
      version: 'v',
    };
    await expect(collectBugReport(opts)).rejects.toThrow();
    expect(stderrChunks.join('')).toMatch(/^Error: bug report validation failed:\n/);
    expect(stderrChunks.join('')).toMatch(/title: must have required property 'title'/);
  });

  it('case 9: repeatable --repro-step preserves order', async () => {
    const opts: Record<string, unknown> = {
      nonInteractive: true,
      title: 't',
      description: 'd',
      reproStep: ['1', '2', '3'],
      expected: 'e',
      actual: 'a',
      os: 'o',
      runtime: 'r',
      version: 'v',
    };
    const report = await collectBugReport(opts);
    expect(report?.reproduction_steps).toEqual(['1', '2', '3']);
  });

  it('--bug-context-path short-circuits flag assembly when supplied', async () => {
    const fixturePath = path.resolve(
      __dirname,
      '../../../tests/fixtures/bug-fixture.json',
    );
    const opts: Record<string, unknown> = {
      nonInteractive: true,
      bugContextPath: fixturePath,
    };
    const report = await collectBugReport(opts);
    expect(report?.title).toBe(
      'submit-bug fails when description contains backtick',
    );
    expect(report?.severity).toBe('high');
  });

  it('--bug-context-path missing file rejects with file-not-found message', async () => {
    const missing = path.join(os.tmpdir(), `nope-${Date.now()}.json`);
    const opts: Record<string, unknown> = {
      nonInteractive: true,
      bugContextPath: missing,
    };
    await expect(collectBugReport(opts)).rejects.toThrow();
    expect(stderrChunks.join('')).toBe(
      `Error: bug context file not found: ${missing}\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// Smoke test for the fixture
// ---------------------------------------------------------------------------

describe('bug-fixture.json smoke', () => {
  it('validates clean against the BugReport schema', () => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '../../../tests/fixtures/bug-fixture.json'),
      'utf8',
    );
    const errors = validateBugReport(JSON.parse(raw));
    expect(errors).toEqual([]);
  });
});
