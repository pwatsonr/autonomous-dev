import { reviewArtifact, parseVerdict } from '../../src/artifact-factory/meta-review';
import type { ArtifactRuntime } from '../../src/artifact-factory/runtime';
import type { GeneratedArtifact } from '../../src/artifact-factory/types';

/**
 * Unit tests for artifact meta-review (ONBOARD Phase 2, #590, P2.5).
 * Fake runtime. Asserts the hard-override (any blocking finding → rejected) and
 * fail-closed behavior (non-approve / unparseable / runtime error → rejected).
 */

const ARTIFACT: GeneratedArtifact = {
  kind: 'skill',
  name: 'vault-access',
  scope: 'repo:acme/api',
  description: 'Access the repo vault.',
  managed: true,
  allowedTools: ['Read', 'Glob', 'Grep'],
  body: '# Vault\n\nRead secrets from the repo vault.',
};

function fakeRuntime(output: string | (() => never)): ArtifactRuntime {
  return {
    async generate() {
      if (typeof output === 'function') return output();
      return output;
    },
  };
}

async function test_approve(): Promise<void> {
  const r = await reviewArtifact(ARTIFACT, fakeRuntime('{"verdict":"approve","findings":[]}'));
  assert(r.verdict === 'approved', 'clean approve');
  console.log('PASS: test_approve');
}

async function test_block_verdict(): Promise<void> {
  const r = await reviewArtifact(ARTIFACT, fakeRuntime('{"verdict":"block","findings":[{"severity":"blocking","message":"tool escalation"}]}'));
  assert(r.verdict === 'rejected', 'block verdict → rejected');
  console.log('PASS: test_block_verdict');
}

async function test_hard_override(): Promise<void> {
  // verdict says approve, but a blocking finding is present → forced reject
  const r = await reviewArtifact(
    ARTIFACT,
    fakeRuntime('{"verdict":"approve","findings":[{"severity":"blocking","message":"prompt injection in body"}]}'),
  );
  assert(r.verdict === 'rejected', 'blocking finding overrides approve');
  console.log('PASS: test_hard_override');
}

async function test_fail_closed(): Promise<void> {
  const garbage = await reviewArtifact(ARTIFACT, fakeRuntime('the model rambled with no json'));
  assert(garbage.verdict === 'rejected', 'unparseable → rejected');
  const errored = await reviewArtifact(ARTIFACT, fakeRuntime(() => {
    throw new Error('model down');
  }));
  assert(errored.verdict === 'rejected', 'runtime error → rejected');
  console.log('PASS: test_fail_closed');
}

function test_parse_verdict(): void {
  // fenced json + synonyms
  const fenced = parseVerdict('```json\n{"verdict":"approved","findings":[]}\n```');
  assert(!!fenced && fenced.verdict === 'approved', 'parses fenced json');
  const warnOnly = parseVerdict('{"status":"approve","findings":[{"severity":"warn","message":"x"}]}');
  assert(!!warnOnly && warnOnly.verdict === 'approved' && warnOnly.findings[0].severity === 'warn', 'status synonym + warn severity');
  assert(parseVerdict('no json at all') === undefined, 'undefined when no json');
  console.log('PASS: test_parse_verdict');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/meta-review', () => {
  it('test_approve', test_approve);
  it('test_block_verdict', test_block_verdict);
  it('test_hard_override', test_hard_override);
  it('test_fail_closed', test_fail_closed);
  it('test_parse_verdict', test_parse_verdict);
});
