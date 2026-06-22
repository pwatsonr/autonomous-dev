/**
 * #541 guard: autonomous (no-human) promotion must stay dormant and unreachable.
 *
 * The AutoPromoter subsystem (`promotion/auto-promoter.ts`) can, if wired,
 * promote a `meta_approved` proposal with no human in the loop. The #529 security
 * review confirmed it has no production caller and that its config gate
 * (`config.autonomousPromotion.enabled`) is not parseable from YAML. These tests
 * lock in those invariants so a future change can't silently make autonomous
 * promotion live — the only promotion path must remain operator-gated
 * (`agent improve` → `meta_approved` park → explicit `agent accept`).
 *
 * @module __tests__/agent-factory/promotion/no_autonomous_promotion.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadConfig } from '../../../src/agent-factory/config';
import { isEligibleForAutoPromotion } from '../../../src/agent-factory/promotion/auto-promoter';
import type { ParsedAgent } from '../../../src/agent-factory/types';
import type { AgentProposal } from '../../../src/agent-factory/improvement/types';

const SRC_ROOT = path.resolve(__dirname, '../../../src/agent-factory');
const BIN_ROOT = path.resolve(__dirname, '../../../bin');

// A low-risk, patch-bump agent+proposal — passes gates 2-4, so ONLY the config
// gate (gate 1) can block. If gate 1 ever opens by default, this turns eligible.
function lowRiskAgent(): ParsedAgent {
  return {
    name: 'doc-reviewer',
    version: '1.0.1',
    role: 'reviewer',
    model: 'claude-opus-4-7',
    temperature: 0.2,
    turn_limit: 20,
    tools: ['Read', 'Glob', 'Grep', 'Write'],
    expertise: ['docs'],
    evaluation_rubric: [{ name: 'a', weight: 1.0, description: 'x' }],
    version_history: [{ version: '1.0.0', date: '2026-01-01', change: 'init' }],
    risk_tier: 'low',
    frozen: false,
    description: 'd',
    system_prompt: '# x',
  };
}

function patchProposal(): AgentProposal {
  return { version_bump: 'patch' } as AgentProposal;
}

/** Recursively list .ts files under dir (skipping __tests__ + node_modules). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('#541: autonomous promotion stays dormant', () => {
  test('eligibility gate is CLOSED under the default/loaded config', () => {
    const config = loadConfig(); // production default — autonomousPromotion absent
    const result = isEligibleForAutoPromotion(lowRiskAgent(), patchProposal(), config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
  });

  test('a YAML config edit CANNOT enable autonomous promotion (loadConfig does not parse it)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cfg-'));
    const cfgPath = path.join(tmp, 'agent-factory.yaml');
    fs.writeFileSync(
      cfgPath,
      'autonomous-promotion:\n  enabled: true\n  overrideHours: 24\n',
      'utf-8',
    );
    try {
      const config = loadConfig(cfgPath);
      // The flag must NOT be honored from YAML.
      expect(config.autonomousPromotion?.enabled).not.toBe(true);
      // And eligibility still blocks.
      expect(isEligibleForAutoPromotion(lowRiskAgent(), patchProposal(), config).eligible).toBe(
        false,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('NO production code wires the AutoPromoter (no caller outside its own module)', () => {
    const selfModule = path.join(SRC_ROOT, 'promotion', 'auto-promoter.ts');
    const offenders: string[] = [];
    const callPattern = /\b(attemptAutoPromote\s*\(|new\s+AutoPromoter\s*\()/;

    for (const file of listTsFiles(SRC_ROOT)) {
      if (path.resolve(file) === path.resolve(selfModule)) continue; // the definition
      const text = fs.readFileSync(file, 'utf-8');
      if (callPattern.test(text)) offenders.push(path.relative(SRC_ROOT, file));
    }
    // Also scan the bash daemon surface.
    if (fs.existsSync(BIN_ROOT)) {
      for (const entry of fs.readdirSync(BIN_ROOT)) {
        if (!entry.endsWith('.sh')) continue;
        const text = fs.readFileSync(path.join(BIN_ROOT, entry), 'utf-8');
        if (/attemptAutoPromote|AutoPromoter/.test(text)) offenders.push(`bin/${entry}`);
      }
    }

    expect(offenders).toEqual([]); // if this fails, something WIRED autonomous promotion
  });
});
