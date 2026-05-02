/**
 * Thin wrapper over `pfctl` shell tool (SPEC-024-3-02).
 *
 * All interaction with the real `pfctl` binary funnels through this module
 * so tests mock it via `jest.mock('./pfctl-cli')`. Production code never
 * spawns `pfctl` directly elsewhere.
 *
 * @module intake/firewall/pfctl-cli
 */

import { spawn } from 'child_process';

export interface PfctlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Invoke `pfctl` with explicit args and optional stdin. Returns the raw
 * exit code so callers can distinguish "pf not enabled" (a recoverable
 * config issue) from real failures.
 */
export async function runPfctl(args: string[], stdin?: string): Promise<PfctlResult> {
  return new Promise<PfctlResult>((resolve, reject) => {
    const child = spawn('pfctl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}
