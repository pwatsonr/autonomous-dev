/**
 * Shared `runTool` mock used by every backend test (SPEC-023-1-04 +
 * SPEC-023-1-05).
 *
 * Each test registers `(cmdRegex, argMatcher) → response` triples; an
 * unmatched invocation FAILS the test loudly with the offending argv so
 * we never silently let a backend reach a real shell.
 *
 * @module tests/deploy/__mocks__/run-tool
 */

import type { RunToolOptions, RunToolResult } from '../../../intake/deploy/exec';
import { ExternalToolError } from '../../../intake/deploy/errors';

export interface RunToolCall {
  cmd: string;
  args: string[];
  opts: RunToolOptions;
}

export interface MockResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface MockExpectation {
  cmd: RegExp;
  argMatcher: (args: string[]) => boolean;
  response: MockResponse;
}

export interface RunToolMock {
  runTool: (cmd: string, args: string[], opts: RunToolOptions) => Promise<RunToolResult>;
  expect(
    cmdRegex: RegExp,
    argMatcher: (args: string[]) => boolean,
    response: MockResponse,
  ): void;
  calls(): RunToolCall[];
  reset(): void;
}

export function makeRunToolMock(): RunToolMock {
  const expectations: MockExpectation[] = [];
  const calls: RunToolCall[] = [];

  const mock = async (
    cmd: string,
    args: string[],
    opts: RunToolOptions,
  ): Promise<RunToolResult> => {
    calls.push({ cmd, args: [...args], opts });
    for (const exp of expectations) {
      if (exp.cmd.test(cmd) && exp.argMatcher(args)) {
        const code = exp.response.exitCode ?? 0;
        if (code !== 0) {
          throw new ExternalToolError(
            cmd,
            args,
            code,
            exp.response.stdout ?? '',
            exp.response.stderr ?? '',
          );
        }
        return { stdout: exp.response.stdout ?? '', stderr: exp.response.stderr ?? '' };
      }
    }
    throw new Error(
      `runTool mock: no expectation matched ${cmd} ${args.join(' ')}`,
    );
  };

  return {
    runTool: mock,
    expect(cmdRegex, argMatcher, response) {
      expectations.push({ cmd: cmdRegex, argMatcher, response });
    },
    calls() {
      return [...calls];
    },
    reset() {
      expectations.length = 0;
      calls.length = 0;
    },
  };
}
