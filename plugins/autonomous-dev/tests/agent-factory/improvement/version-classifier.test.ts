/**
 * Unit tests for version bump classifier (SPEC-005-3-3, Task 7).
 */

import {
  classifyVersionBump,
  computeBodyChangePercent,
  detectFrontmatterChanges,
  incrementVersion,
} from '../../../src/agent-factory/improvement/version-classifier';
import { ParsedAgent } from '../../../src/agent-factory/types';

// ---------------------------------------------------------------------------
// Helper: build a valid ParsedAgent
// ---------------------------------------------------------------------------

function baseAgent(overrides?: Partial<ParsedAgent>): ParsedAgent {
  const base: ParsedAgent = {
    name: 'code-executor',
    version: '1.0.0',
    role: 'executor',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.3,
    turn_limit: 25,
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    expertise: ['TypeScript', 'testing'],
    evaluation_rubric: [
      { name: 'correctness', weight: 0.4, description: 'Passes tests' },
      { name: 'quality', weight: 0.3, description: 'Clean code' },
      { name: 'coverage', weight: 0.3, description: 'Adequate test coverage' },
    ],
    version_history: [
      { version: '1.0.0', date: '2026-01-01', change: 'Initial release' },
    ],
    risk_tier: 'medium',
    frozen: false,
    description: 'Executes code changes',
    system_prompt: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10',
  };
  return { ...base, ...overrides };
}

/**
 * Build a system prompt of N lines where a specified percentage
 * of lines differ from the original (10-line prompt).
 */
function makeBody(totalLines: number, differentLines: number): string {
  const lines: string[] = [];
  for (let i = 0; i < totalLines; i++) {
    if (i < differentLines) {
      lines.push(`New line ${i + 1}`);
    } else {
      lines.push(`Line ${i + 1}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Version bump classification tests
// ---------------------------------------------------------------------------

function test_major_bump_role_change(): void {
  const current = baseAgent();
  const proposed = baseAgent({ role: 'author' });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bump === 'major', `expected major, got ${result.bump}`);
  assert(result.frontmatterChanges.includes('role'), 'should include role change');
  console.log('PASS: test_major_bump_role_change');
}

function test_major_bump_new_expertise_tags(): void {
  const current = baseAgent();
  const proposed = baseAgent({ expertise: ['TypeScript', 'testing', 'python'] });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bump === 'major', `expected major, got ${result.bump}`);
  assert(result.frontmatterChanges.includes('expertise_new_tags'), 'should include expertise_new_tags');
  console.log('PASS: test_major_bump_new_expertise_tags');
}

function test_major_bump_large_body_change(): void {
  const current = baseAgent();
  // Replace all 10 lines with different content -> 100% change
  const proposed = baseAgent({
    system_prompt: 'A\nB\nC\nD\nE\nF\nG\nH\nI\nJ',
  });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bump === 'major', `expected major, got ${result.bump}`);
  assert(result.bodyChangePercent > 50, `expected >50%, got ${result.bodyChangePercent}%`);
  assert(result.reason.includes('>50% body changed'), `reason should mention body change: ${result.reason}`);
  console.log('PASS: test_major_bump_large_body_change');
}

function test_minor_bump_rubric_change(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    evaluation_rubric: [
      { name: 'correctness', weight: 0.55, description: 'Passes tests' },
      { name: 'quality', weight: 0.3, description: 'Clean code' },
      { name: 'coverage', weight: 0.15, description: 'Adequate test coverage' },
    ],
  });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bump === 'minor', `expected minor, got ${result.bump}`);
  assert(result.frontmatterChanges.includes('evaluation_rubric'), 'should include evaluation_rubric');
  console.log('PASS: test_minor_bump_rubric_change');
}

function test_minor_bump_medium_body_change(): void {
  const current = baseAgent();
  // Change 3 of 10 lines => 30% area which is 10-50% range
  // LCS of 7 means: 3 removed + 3 added = 6 changes / 10 total = 60%
  // Actually, we need careful line construction.
  // Use: keep 7 lines same, change 3 lines
  const proposed = baseAgent({
    system_prompt: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nChanged 8\nChanged 9\nChanged 10',
  });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bodyChangePercent >= 10 && result.bodyChangePercent <= 50,
    `expected 10-50%, got ${result.bodyChangePercent}%`);
  assert(result.bump === 'minor', `expected minor, got ${result.bump}`);
  console.log('PASS: test_minor_bump_medium_body_change');
}

function test_patch_bump_small_body_change(): void {
  const current = baseAgent();
  // Change only 1 line out of 10 -> should be <10%
  // Actually LCS = 9, removed = 1, added = 1, change = 2/10 = 20%. That's minor.
  // For <10% with 10 lines: can't change any full line.
  // Use 20 lines and change 1 -> LCS=19, removed=1, added=1 = 2/20 = 10% (boundary)
  // Use 100 lines and change 1 -> 2/100 = 2%
  const lines100: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines100.push(`Line ${i + 1}`);
  }
  const current100 = baseAgent({ system_prompt: lines100.join('\n') });
  const modifiedLines = [...lines100];
  modifiedLines[50] = 'Modified line 51';
  const proposed100 = baseAgent({ system_prompt: modifiedLines.join('\n') });

  const result = classifyVersionBump(current100, proposed100, '');
  assert(result.bodyChangePercent < 10, `expected <10%, got ${result.bodyChangePercent}%`);
  assert(result.bump === 'patch', `expected patch, got ${result.bump}`);
  console.log('PASS: test_patch_bump_small_body_change');
}

function test_boundary_50_percent_is_major(): void {
  // Need >50%, so 51% body change. With 100 lines, need >50 changes.
  // 26 lines changed out of 100: LCS=74, removed=26, added=26 = 52/100 = 52%
  const lines100: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines100.push(`Line ${i + 1}`);
  }
  const current = baseAgent({ system_prompt: lines100.join('\n') });
  const modifiedLines = [...lines100];
  for (let i = 0; i < 26; i++) {
    modifiedLines[i] = `Changed ${i + 1}`;
  }
  const proposed = baseAgent({ system_prompt: modifiedLines.join('\n') });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bodyChangePercent > 50, `expected >50%, got ${result.bodyChangePercent}%`);
  assert(result.bump === 'major', `expected major, got ${result.bump}`);
  console.log('PASS: test_boundary_50_percent_is_major');
}

function test_boundary_10_percent_is_minor(): void {
  // Exactly 10% with 100 lines: 5 changed -> LCS=95, removed=5, added=5 = 10/100 = 10%
  const lines100: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines100.push(`Line ${i + 1}`);
  }
  const current = baseAgent({ system_prompt: lines100.join('\n') });
  const modifiedLines = [...lines100];
  for (let i = 0; i < 5; i++) {
    modifiedLines[i] = `Changed ${i + 1}`;
  }
  const proposed = baseAgent({ system_prompt: modifiedLines.join('\n') });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bodyChangePercent >= 10, `expected >=10%, got ${result.bodyChangePercent}%`);
  assert(result.bump === 'minor', `expected minor, got ${result.bump}`);
  console.log('PASS: test_boundary_10_percent_is_minor');
}

function test_boundary_9_percent_is_patch(): void {
  // <10% with 100 lines: 4 changed -> LCS=96, removed=4, added=4 = 8/100 = 8%
  const lines100: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines100.push(`Line ${i + 1}`);
  }
  const current = baseAgent({ system_prompt: lines100.join('\n') });
  const modifiedLines = [...lines100];
  for (let i = 0; i < 4; i++) {
    modifiedLines[i] = `Changed ${i + 1}`;
  }
  const proposed = baseAgent({ system_prompt: modifiedLines.join('\n') });

  const result = classifyVersionBump(current, proposed, '');
  assert(result.bodyChangePercent < 10, `expected <10%, got ${result.bodyChangePercent}%`);
  assert(result.bump === 'patch', `expected patch, got ${result.bump}`);
  console.log('PASS: test_boundary_9_percent_is_patch');
}

// ---------------------------------------------------------------------------
// Body change percent tests
// ---------------------------------------------------------------------------

function test_body_change_percent_empty_current(): void {
  const pct = computeBodyChangePercent('', 'Line 1\nLine 2');
  // Current = 0 lines, proposed = 2 lines, LCS = 0
  // (0 + 2) / max(0, 1) * 100 = 200%
  assert(pct === 200, `expected 200%, got ${pct}%`);
  console.log('PASS: test_body_change_percent_empty_current');
}

function test_body_change_percent_identical(): void {
  const body = 'Line 1\nLine 2\nLine 3';
  const pct = computeBodyChangePercent(body, body);
  assert(pct === 0, `expected 0%, got ${pct}%`);
  console.log('PASS: test_body_change_percent_identical');
}

function test_body_change_percent_completely_different(): void {
  const current = 'A\nB\nC';
  const proposed = 'X\nY\nZ';
  const pct = computeBodyChangePercent(current, proposed);
  // LCS = 0, removed = 3, added = 3, total = 6/3 = 200%
  assert(pct === 200, `expected 200%, got ${pct}%`);
  console.log('PASS: test_body_change_percent_completely_different');
}

// ---------------------------------------------------------------------------
// Frontmatter change detection tests
// ---------------------------------------------------------------------------

function test_frontmatter_change_detection_excludes_version(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    version: '2.0.0',
    version_history: [
      ...current.version_history,
      { version: '2.0.0', date: '2026-04-08', change: 'Updated' },
    ],
  });

  const changes = detectFrontmatterChanges(current, proposed);
  assert(changes.length === 0, `expected no changes, got ${JSON.stringify(changes)}`);
  console.log('PASS: test_frontmatter_change_detection_excludes_version');
}

function test_frontmatter_detects_temperature_change(): void {
  const current = baseAgent();
  const proposed = baseAgent({ temperature: 0.7 });

  const changes = detectFrontmatterChanges(current, proposed);
  assert(changes.includes('temperature'), `expected temperature change, got ${JSON.stringify(changes)}`);
  console.log('PASS: test_frontmatter_detects_temperature_change');
}

function test_frontmatter_detects_model_change(): void {
  const current = baseAgent();
  const proposed = baseAgent({ model: 'claude-opus-4-20250514' });

  const changes = detectFrontmatterChanges(current, proposed);
  assert(changes.includes('model'), `expected model change, got ${JSON.stringify(changes)}`);
  console.log('PASS: test_frontmatter_detects_model_change');
}

function test_frontmatter_detects_turn_limit_change(): void {
  const current = baseAgent();
  const proposed = baseAgent({ turn_limit: 50 });

  const changes = detectFrontmatterChanges(current, proposed);
  assert(changes.includes('turn_limit'), `expected turn_limit change, got ${JSON.stringify(changes)}`);
  console.log('PASS: test_frontmatter_detects_turn_limit_change');
}

function test_frontmatter_rubric_weight_small_change_no_flag(): void {
  const current = baseAgent();
  // Weight change of 0.05 (<=0.1 threshold) -> should not flag
  const proposed = baseAgent({
    evaluation_rubric: [
      { name: 'correctness', weight: 0.45, description: 'Passes tests' },
      { name: 'quality', weight: 0.25, description: 'Clean code' },
      { name: 'coverage', weight: 0.3, description: 'Adequate test coverage' },
    ],
  });

  const changes = detectFrontmatterChanges(current, proposed);
  assert(!changes.includes('evaluation_rubric'), `expected no rubric change for small weight delta, got ${JSON.stringify(changes)}`);
  console.log('PASS: test_frontmatter_rubric_weight_small_change_no_flag');
}

function test_frontmatter_rubric_dimension_added_flags(): void {
  const current = baseAgent();
  const proposed = baseAgent({
    evaluation_rubric: [
      ...current.evaluation_rubric,
      { name: 'performance', weight: 0.1, description: 'Runtime efficiency' },
    ],
  });

  const changes = detectFrontmatterChanges(current, proposed);
  assert(changes.includes('evaluation_rubric'), `expected rubric change for new dimension, got ${JSON.stringify(changes)}`);
  console.log('PASS: test_frontmatter_rubric_dimension_added_flags');
}

function test_frontmatter_expertise_case_insensitive(): void {
  const current = baseAgent({ expertise: ['TypeScript', 'testing'] });
  const proposed = baseAgent({ expertise: ['typescript', 'Testing'] });

  const changes = detectFrontmatterChanges(current, proposed);
  assert(!changes.includes('expertise_new_tags'), `expected no new expertise tags for case changes, got ${JSON.stringify(changes)}`);
  console.log('PASS: test_frontmatter_expertise_case_insensitive');
}

// ---------------------------------------------------------------------------
// Semver increment tests
// ---------------------------------------------------------------------------

function test_increment_major(): void {
  assert(incrementVersion('1.2.3', 'major') === '2.0.0', 'major: 1.2.3 -> 2.0.0');
  console.log('PASS: test_increment_major');
}

function test_increment_minor(): void {
  assert(incrementVersion('1.2.3', 'minor') === '1.3.0', 'minor: 1.2.3 -> 1.3.0');
  console.log('PASS: test_increment_minor');
}

function test_increment_patch(): void {
  assert(incrementVersion('1.2.3', 'patch') === '1.2.4', 'patch: 1.2.3 -> 1.2.4');
  console.log('PASS: test_increment_patch');
}

function test_increment_from_zero(): void {
  assert(incrementVersion('0.0.0', 'major') === '1.0.0', 'major: 0.0.0 -> 1.0.0');
  assert(incrementVersion('0.0.0', 'minor') === '0.1.0', 'minor: 0.0.0 -> 0.1.0');
  assert(incrementVersion('0.0.0', 'patch') === '0.0.1', 'patch: 0.0.0 -> 0.0.1');
  console.log('PASS: test_increment_from_zero');
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests = [
  // Version bump classification
  test_major_bump_role_change,
  test_major_bump_new_expertise_tags,
  test_major_bump_large_body_change,
  test_minor_bump_rubric_change,
  test_minor_bump_medium_body_change,
  test_patch_bump_small_body_change,
  test_boundary_50_percent_is_major,
  test_boundary_10_percent_is_minor,
  test_boundary_9_percent_is_patch,

  // Body change percent
  test_body_change_percent_empty_current,
  test_body_change_percent_identical,
  test_body_change_percent_completely_different,

  // Frontmatter change detection
  test_frontmatter_change_detection_excludes_version,
  test_frontmatter_detects_temperature_change,
  test_frontmatter_detects_model_change,
  test_frontmatter_detects_turn_limit_change,
  test_frontmatter_rubric_weight_small_change_no_flag,
  test_frontmatter_rubric_dimension_added_flags,
  test_frontmatter_expertise_case_insensitive,

  // Semver increment
  test_increment_major,
  test_increment_minor,
  test_increment_patch,
  test_increment_from_zero,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
    passed++;
  } catch (err) {
    console.log(`FAIL: ${test.name} -- ${err}`);
    failed++;
  }
}

console.log(`\nResults: ${passed}/${tests.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
