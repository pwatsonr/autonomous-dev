import { generateArtifact, extractArtifactMarkdown, buildGenerationPrompt } from '../../src/artifact-factory/generator';
import type { GenerateInput } from '../../src/artifact-factory/generator';
import type { ArtifactRuntime } from '../../src/artifact-factory/runtime';
import type { Opportunity } from '../../src/artifact-factory/detectors';

/**
 * Unit tests for skill generation (ONBOARD Phase 2, #590, P2.5).
 * Fake runtime — no live model. Asserts the framework FORCES the security
 * metadata (scope/name/managed/read-only tools); the model only contributes
 * description + body.
 */

const OPP: Opportunity = {
  id: 'skill:vault-access:acme/api',
  kind: 'skill',
  repoId: 'acme/api',
  title: 'Secrets/vault access skill for acme/api',
  evidence: '[dependencies] - node-vault',
  suggestedName: 'vault-access',
};

const INPUT: GenerateInput = {
  opportunity: OPP,
  scope: 'repo:acme/api',
  suggestedName: 'vault-access',
  repoDocs: [{ topic: 'dependencies', content: '- node-vault' }],
};

function fakeRuntime(output: string | (() => never)): ArtifactRuntime {
  return {
    async generate() {
      if (typeof output === 'function') return output();
      return output;
    },
  };
}

// A model that tries to set a different scope AND escalate tools — must be overridden.
const MODEL_SKILL = [
  '```markdown',
  '---',
  'name: model-chosen-name',
  'description: Access the acme/api vault secrets.',
  'kind: skill',
  'scope: global',
  'managed: true',
  'allowed-tools: [Bash, Write]',
  '---',
  '',
  '# Vault access',
  'Read secrets from the repo vault.',
  '```',
].join('\n');

async function test_forces_security_metadata(): Promise<void> {
  const res = await generateArtifact(INPUT, fakeRuntime(MODEL_SKILL));
  assert(!!res.artifact, `generation succeeds: ${res.errors.join('; ')}`);
  const a = res.artifact!;
  assert(a.scope === 'repo:acme/api', `scope FORCED to decided value, got ${a.scope}`);
  assert(a.name === 'vault-access', `name FORCED to suggestedName, got ${a.name}`);
  assert(a.managed === true, 'managed forced true');
  assert(a.kind === 'skill', 'kind forced skill');
  assert(a.allowedTools.join(',') === 'Read,Glob,Grep', `tools FORCED read-only, got ${a.allowedTools.join(',')}`);
  // model content IS used for description + body
  assert(a.description.includes('vault'), 'description from model');
  assert(a.body.includes('Read secrets'), 'body from model');
  console.log('PASS: test_forces_security_metadata');
}

async function test_unparseable_model_output(): Promise<void> {
  const res = await generateArtifact(INPUT, fakeRuntime('I cannot help with that.'));
  assert(!res.artifact && res.errors.length > 0, 'no artifact on junk output');
  console.log('PASS: test_unparseable_model_output');
}

async function test_runtime_error(): Promise<void> {
  const res = await generateArtifact(INPUT, fakeRuntime(() => {
    throw new Error('model down');
  }));
  assert(!res.artifact && res.errors.some((e) => e.includes('runtime error')), 'runtime error surfaced');
  console.log('PASS: test_runtime_error');
}

function test_extract_markdown(): void {
  const fenced = '```markdown\n---\nname: x\n---\nbody\n```';
  assert(extractArtifactMarkdown(fenced).startsWith('---'), 'extracts fenced block');
  const bare = 'Here:\n---\nname: x\n---\nbody';
  assert(extractArtifactMarkdown(bare).startsWith('---'), 'extracts bare frontmatter');
  assert(buildGenerationPrompt(INPUT).includes('vault-access'), 'prompt names the skill');
  console.log('PASS: test_extract_markdown');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/generator', () => {
  it('test_forces_security_metadata', test_forces_security_metadata);
  it('test_unparseable_model_output', test_unparseable_model_output);
  it('test_runtime_error', test_runtime_error);
  it('test_extract_markdown', test_extract_markdown);
});
