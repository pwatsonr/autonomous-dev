/**
 * Thin wrapper over the `nft` shell tool (SPEC-024-3-01).
 *
 * All interaction with the real `nft` binary funnels through this module
 * so tests can mock it in one place via `jest.mock('./nft-cli')`. The
 * production code never spawns `nft` directly elsewhere.
 *
 * @module intake/firewall/nft-cli
 */

import { spawn } from 'child_process';

export interface NftResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `nft -f -` with the given stdin. Returns `{stdout, stderr, exitCode}`.
 * Never throws on non-zero exit — callers inspect `exitCode` and stderr to
 * distinguish "table missing" (exit 1, expected) from real failures.
 */
export async function runNft(stdin: string): Promise<NftResult> {
  return new Promise<NftResult>((resolve, reject) => {
    const child = spawn('nft', ['-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.end(stdin);
  });
}
