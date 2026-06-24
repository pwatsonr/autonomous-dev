import {
  vaultDetector,
  testConventionDetector,
  domainGlossaryDetector,
  detectOpportunities,
  defaultDetectors,
} from '../../src/artifact-factory/detectors';
import type { OpportunityDetector } from '../../src/artifact-factory/detectors';
import { writeMemoryDoc } from '../../src/memory/store';
import type { MemoryStoreIO } from '../../src/memory/store';
import type { MemoryDoc } from '../../src/memory/types';

/**
 * Unit tests for opportunity detectors (ONBOARD Phase 2, #590, P2.2).
 * Pure detectors over docs + a best-effort IO orchestrator (injected memory).
 */

function fakeMemoryIO(): MemoryStoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    homedir: () => '/home/test',
    readFile: (p) => files[p],
    writeFile: (p, data) => {
      files[p] = data;
    },
    listDir: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (rest.length > 0 && !rest.includes('/')) names.add(rest);
        }
      }
      return [...names];
    },
  };
}

function test_vault_detector(): void {
  const docs: MemoryDoc[] = [
    { topic: 'dependencies', content: '# Deps\n\n- express\n- node-vault\n- hashicorp/vault-client' },
  ];
  const opps = vaultDetector.detect('acme/api', docs);
  assert(opps.length === 1, 'one vault opportunity');
  assert(opps[0].suggestedName === 'vault-access', 'suggests vault-access');
  assert(opps[0].id === 'skill:vault-access:acme/api', 'stable id');
  assert(opps[0].evidence.includes('vault'), 'evidence cites the line');
  // no false positive on unrelated deps
  assert(vaultDetector.detect('a/b', [{ topic: 'dependencies', content: 'express only' }]).length === 0, 'no false positive');
  console.log('PASS: test_vault_detector');
}

function test_test_and_domain_detectors(): void {
  const tc = testConventionDetector.detect('a/b', [
    { topic: 'test-conventions', content: '# Test conventions — a/b\n\nDetected: jest.config.cjs, tests' },
  ]);
  assert(tc.length === 1 && tc[0].suggestedName === 'run-tests', 'test-convention → run-tests');

  const longReadme = `# Service\n\n${'The orders domain. '.repeat(60)}`;
  const dg = domainGlossaryDetector.detect('a/b', [{ topic: 'overview', content: longReadme }]);
  assert(dg.length === 1 && dg[0].suggestedName === 'domain-context', 'rich overview → domain-context');
  // a short overview is below threshold → no opportunity
  assert(domainGlossaryDetector.detect('a/b', [{ topic: 'overview', content: '# Tiny' }]).length === 0, 'short overview skipped');
  console.log('PASS: test_test_and_domain_detectors');
}

function test_detect_orchestrator_reads_memory(): void {
  const io = fakeMemoryIO();
  writeMemoryDoc('repo:acme/api', 'dependencies', '# Deps\n\n- node-vault\n', io);
  writeMemoryDoc('repo:acme/api', 'test-conventions', '# Test conventions — acme/api\n\nDetected: jest.config.cjs', io);
  const res = detectOpportunities('acme/api', io);
  const names = res.opportunities.map((o) => o.suggestedName).sort();
  assert(names.join(',') === 'run-tests,vault-access', `vault + test opportunities, got ${names.join(',')}`);
  assert(res.errors.length === 0, 'no detector errors');
  console.log('PASS: test_detect_orchestrator_reads_memory');
}

function test_detector_failure_isolated(): void {
  const boom: OpportunityDetector = {
    name: 'boom',
    detect() {
      throw new Error('detector failure');
    },
  };
  const io = fakeMemoryIO();
  writeMemoryDoc('repo:a/b', 'dependencies', '- node-vault', io);
  const res = detectOpportunities('a/b', io, [boom, ...defaultDetectors]);
  assert(res.errors.length === 1 && res.errors[0].detector === 'boom', 'failing detector recorded');
  assert(res.opportunities.some((o) => o.suggestedName === 'vault-access'), 'other detectors still ran');
  console.log('PASS: test_detector_failure_isolated');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/detectors', () => {
  it('test_vault_detector', test_vault_detector);
  it('test_test_and_domain_detectors', test_test_and_domain_detectors);
  it('test_detect_orchestrator_reads_memory', test_detect_orchestrator_reads_memory);
  it('test_detector_failure_isolated', test_detector_failure_isolated);
});
