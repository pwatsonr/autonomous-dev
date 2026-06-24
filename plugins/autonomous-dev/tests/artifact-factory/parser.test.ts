import { parseArtifact, serializeArtifact, isArtifactScope } from '../../src/artifact-factory/parser';
import type { GeneratedArtifact } from '../../src/artifact-factory/types';

/**
 * Unit tests for the generated-artifact parser/serializer (ONBOARD Phase 2, #590, P2.1).
 * Round-trip stable + validates structure. Pure — no IO.
 */

const SAMPLE: GeneratedArtifact = {
  kind: 'skill',
  name: 'acme-api-vault',
  scope: 'repo:acme/api',
  description: 'Access HashiCorp Vault secrets for the acme/api repo.',
  managed: true,
  allowedTools: ['Read', 'Glob', 'Grep'],
  body: '# Vault access\n\nUse the repo vault at `vault.acme.internal`.',
};

function test_round_trip(): void {
  const md = serializeArtifact(SAMPLE);
  assert(md.startsWith('---\n'), 'starts with frontmatter delimiter');
  assert(md.includes('scope: repo:acme/api') || md.includes("scope: 'repo:acme/api'"), 'scope serialized');
  const res = parseArtifact(md);
  assert(res.success && !!res.artifact, `parse succeeds: ${JSON.stringify(res.errors)}`);
  const a = res.artifact!;
  assert(a.kind === SAMPLE.kind, 'kind round-trips');
  assert(a.name === SAMPLE.name, 'name round-trips');
  assert(a.scope === SAMPLE.scope, 'scope round-trips');
  assert(a.description === SAMPLE.description, 'description round-trips');
  assert(a.managed === true, 'managed round-trips');
  assert(a.allowedTools.join(',') === 'Read,Glob,Grep', 'allowedTools round-trip');
  assert(a.body === SAMPLE.body.trim(), 'body round-trips (trimmed)');
  console.log('PASS: test_round_trip');
}

function test_emits_valid_skill_frontmatter(): void {
  // The emitted file must ALSO be a usable Claude Code skill (name + description + allowed-tools).
  const md = serializeArtifact(SAMPLE);
  assert(/^name: /m.test(md), 'has name field');
  assert(/^description: /m.test(md), 'has description field');
  assert(/^allowed-tools:/m.test(md), 'has allowed-tools field');
  console.log('PASS: test_emits_valid_skill_frontmatter');
}

function test_parse_hand_written(): void {
  const md = [
    '---',
    'name: payments-tests',
    'description: Run the payments project test suite.',
    'kind: skill',
    'scope: project:payments',
    'managed: true',
    'allowed-tools: [Read, Grep]',
    '---',
    '',
    'Run `npm test` in each member repo.',
  ].join('\n');
  const res = parseArtifact(md);
  assert(res.success, `valid hand-written skill parses: ${JSON.stringify(res.errors)}`);
  assert(res.artifact!.scope === 'project:payments', 'project scope parsed');
  assert(res.artifact!.allowedTools.length === 2, 'flow-array tools parsed');
  console.log('PASS: test_parse_hand_written');
}

function test_parse_rejects_invalid(): void {
  const cases: { md: string; why: string }[] = [
    { md: 'no frontmatter here', why: 'no frontmatter' },
    {
      md: '---\nname: x\ndescription: d\nscope: repo:a/b\nmanaged: maybe\n---\nbody',
      why: 'non-boolean managed',
    },
    {
      md: '---\nname: x\ndescription: d\nscope: nonsense\nmanaged: true\n---\nbody',
      why: 'invalid scope',
    },
    {
      md: '---\ndescription: d\nscope: global\nmanaged: true\n---\nbody',
      why: 'missing name',
    },
    {
      md: '---\nname: x\ndescription: d\nkind: widget\nscope: global\nmanaged: true\n---\nbody',
      why: 'invalid kind',
    },
    {
      md: '---\nname: x\ndescription: d\nscope: global\nmanaged: true\nallowed-tools: "Read"\n---\nbody',
      why: 'allowed-tools not a string list',
    },
  ];
  for (const c of cases) {
    const res = parseArtifact(c.md);
    assert(!res.success, `rejects: ${c.why}`);
    assert(res.errors.length > 0, `reports an error for: ${c.why}`);
  }
  console.log('PASS: test_parse_rejects_invalid');
}

function test_is_artifact_scope(): void {
  assert(isArtifactScope('global'), 'global');
  assert(isArtifactScope('repo:acme/api'), 'repo scope');
  assert(isArtifactScope('project:payments'), 'project scope');
  assert(!isArtifactScope('repo:'), 'empty repo id rejected');
  assert(!isArtifactScope('org:acme'), 'org is not an artifact scope');
  assert(!isArtifactScope(42), 'non-string rejected');
  console.log('PASS: test_is_artifact_scope');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('artifact-factory/parser', () => {
  it('test_round_trip', test_round_trip);
  it('test_emits_valid_skill_frontmatter', test_emits_valid_skill_frontmatter);
  it('test_parse_hand_written', test_parse_hand_written);
  it('test_parse_rejects_invalid', test_parse_rejects_invalid);
  it('test_is_artifact_scope', test_is_artifact_scope);
});
