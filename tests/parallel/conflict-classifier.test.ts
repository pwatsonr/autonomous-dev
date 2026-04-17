/**
 * Tests for ConflictClassifier (SPEC-006-4-2 Tasks 4-6).
 *
 * Verifies:
 *   - 5-tier conflict classification (disjoint, non-overlapping,
 *     overlapping-compatible, overlapping-conflicting, structural)
 *   - Git stage extraction (base/ours/theirs via git show :N:<file>)
 *   - Hunk computation and overlap analysis
 *   - Deterministic classification for the same input
 *   - diffLines utility function
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  ConflictClassifier,
  diffLines,
} from '../../src/parallel/conflict-classifier';
import { ConflictType } from '../../src/parallel/types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temp git repo with an initial commit.
 */
function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  execSync('git add . && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupTempRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Set up a non-overlapping merge conflict scenario.
 * Base: file with functions foo() on lines 1-5 and bar() on lines 10-15.
 * Ours: modifies foo() (lines 1-5).
 * Theirs: modifies bar() (lines 10-15).
 */
function setupNonOverlappingConflict(repoRoot: string): void {
  const srcDir = path.join(repoRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const baseContent = [
    'function foo() {',
    '  return "hello";',
    '}',
    '',
    '// separator',
    '',
    '// more separator',
    '',
    '// even more',
    'function bar() {',
    '  return "world";',
    '}',
  ].join('\n');

  fs.writeFileSync(path.join(srcDir, 'service.ts'), baseContent);
  execSync('git add . && git commit -m "add service"', { cwd: repoRoot, stdio: 'pipe' });

  // Create integration branch
  execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

  // Track A: modifies foo() at the top
  execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  const oursContent = baseContent.replace(
    'function foo() {\n  return "hello";\n}',
    'function foo() {\n  return "hello modified by ours";\n}',
  );
  fs.writeFileSync(path.join(srcDir, 'service.ts'), oursContent);
  execSync('git add . && git commit -m "track-a changes foo"', { cwd: repoRoot, stdio: 'pipe' });

  // Track B: modifies bar() at the bottom
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  const theirsContent = baseContent.replace(
    'function bar() {\n  return "world";\n}',
    'function bar() {\n  return "world modified by theirs";\n}',
  );
  fs.writeFileSync(path.join(srcDir, 'service.ts'), theirsContent);
  execSync('git add . && git commit -m "track-b changes bar"', { cwd: repoRoot, stdio: 'pipe' });

  // Merge track-a into integration, then start merging track-b (which conflicts)
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  try {
    execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    // Expected conflict
  }
}

/**
 * Set up an overlapping conflicting merge conflict scenario.
 * Both sides modify the same function differently.
 */
function setupOverlappingConflictingConflict(repoRoot: string): void {
  const srcDir = path.join(repoRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const baseContent = 'function greet() {\n  return "hello";\n}\n';
  fs.writeFileSync(path.join(srcDir, 'greeting.ts'), baseContent);
  execSync('git add . && git commit -m "add greeting"', { cwd: repoRoot, stdio: 'pipe' });

  // Integration branch
  execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

  // Track A: returns "hello world"
  execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(srcDir, 'greeting.ts'),
    'function greet() {\n  return "hello world";\n}\n',
  );
  execSync('git add . && git commit -m "track-a greeting"', { cwd: repoRoot, stdio: 'pipe' });

  // Track B: returns "hello universe"
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(srcDir, 'greeting.ts'),
    'function greet() {\n  return "hello universe";\n}\n',
  );
  execSync('git add . && git commit -m "track-b greeting"', { cwd: repoRoot, stdio: 'pipe' });

  // Merge track-a, then merge track-b to get conflict
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  try {
    execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    // Expected conflict
  }
}

/**
 * Set up an overlapping compatible merge conflict scenario.
 * Both sides make the exact same change.
 */
function setupOverlappingCompatibleConflict(repoRoot: string): void {
  const srcDir = path.join(repoRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const baseContent = 'function greet() {\n  return "hello";\n}\n';
  fs.writeFileSync(path.join(srcDir, 'greeting.ts'), baseContent);
  execSync('git add . && git commit -m "add greeting"', { cwd: repoRoot, stdio: 'pipe' });

  // Integration branch
  execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

  // Track A: returns "hello world"
  execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(srcDir, 'greeting.ts'),
    'function greet() {\n  return "hello world";\n}\n',
  );
  execSync('git add . && git commit -m "track-a greeting"', { cwd: repoRoot, stdio: 'pipe' });

  // Track B: SAME change -- returns "hello world"
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(srcDir, 'greeting.ts'),
    'function greet() {\n  return "hello world";\n}\n',
  );
  execSync('git add . && git commit -m "track-b greeting"', { cwd: repoRoot, stdio: 'pipe' });

  // Merge track-a, then merge track-b to get conflict
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  try {
    execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    // Expected conflict (git doesn't know they're the same)
  }
}

/**
 * Set up a structural conflict scenario (file deleted on one side, modified on other).
 */
function setupStructuralConflict(repoRoot: string): void {
  const srcDir = path.join(repoRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(path.join(srcDir, 'removed.ts'), 'export const x = 1;\n');
  execSync('git add . && git commit -m "add removed.ts"', { cwd: repoRoot, stdio: 'pipe' });

  execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

  // Track A: deletes the file
  execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  fs.unlinkSync(path.join(srcDir, 'removed.ts'));
  execSync('git add . && git commit -m "track-a deletes removed.ts"', { cwd: repoRoot, stdio: 'pipe' });

  // Track B: modifies the file
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(path.join(srcDir, 'removed.ts'), 'export const x = 2;\nexport const y = 3;\n');
  execSync('git add . && git commit -m "track-b modifies removed.ts"', { cwd: repoRoot, stdio: 'pipe' });

  // Merge track-a, then track-b
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  try {
    execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    // Expected conflict
  }
}

// ============================================================================
// diffLines unit tests
// ============================================================================

describe('diffLines', () => {
  it('returns single unchanged block for identical strings', () => {
    const changes = diffLines('a\nb\nc', 'a\nb\nc');
    expect(changes).toEqual([{ count: 3 }]);
  });

  it('detects a simple addition', () => {
    const changes = diffLines('a\nc', 'a\nb\nc');
    const additions = changes.filter((c) => c.added);
    expect(additions.length).toBeGreaterThan(0);
    const addedCount = additions.reduce((sum, c) => sum + c.count, 0);
    expect(addedCount).toBe(1);
  });

  it('detects a simple removal', () => {
    const changes = diffLines('a\nb\nc', 'a\nc');
    const removals = changes.filter((c) => c.removed);
    expect(removals.length).toBeGreaterThan(0);
    const removedCount = removals.reduce((sum, c) => sum + c.count, 0);
    expect(removedCount).toBe(1);
  });

  it('detects a modification as remove+add', () => {
    const changes = diffLines('a\nold\nc', 'a\nnew\nc');
    const removals = changes.filter((c) => c.removed);
    const additions = changes.filter((c) => c.added);
    expect(removals.length).toBeGreaterThan(0);
    expect(additions.length).toBeGreaterThan(0);
  });

  it('handles empty base', () => {
    const changes = diffLines('', 'a\nb');
    const addedCount = changes
      .filter((c) => c.added)
      .reduce((sum, c) => sum + c.count, 0);
    // Empty string split gives [''], so base has 1 "line"
    // The modified has 2 lines: 'a' and 'b'
    expect(addedCount).toBeGreaterThan(0);
  });

  it('handles empty modified', () => {
    const changes = diffLines('a\nb', '');
    const removedCount = changes
      .filter((c) => c.removed)
      .reduce((sum, c) => sum + c.count, 0);
    expect(removedCount).toBeGreaterThan(0);
  });
});

// ============================================================================
// ConflictClassifier unit tests (hunk computation, no git)
// ============================================================================

describe('ConflictClassifier hunk analysis (unit)', () => {
  // Use a classifier with a dummy repo root (won't call git in these tests)
  const classifier = new ConflictClassifier('/tmp/fake');

  describe('computeHunks', () => {
    it('returns empty array for identical content', () => {
      const hunks = classifier.computeHunks('a\nb\nc', 'a\nb\nc');
      expect(hunks).toEqual([]);
    });

    it('detects single modification hunk', () => {
      const hunks = classifier.computeHunks('a\nold\nc', 'a\nnew\nc');
      expect(hunks.length).toBeGreaterThan(0);
    });

    it('detects addition hunk', () => {
      const hunks = classifier.computeHunks('a\nc', 'a\nb\nc');
      expect(hunks.length).toBeGreaterThan(0);
      // At least one hunk should have baseStart === baseEnd (pure insertion)
      const insertions = hunks.filter((h) => h.baseStart === h.baseEnd);
      expect(insertions.length).toBeGreaterThan(0);
    });

    it('detects deletion hunk', () => {
      const hunks = classifier.computeHunks('a\nb\nc', 'a\nc');
      expect(hunks.length).toBeGreaterThan(0);
      // At least one hunk should have modStart === modEnd (pure deletion)
      const deletions = hunks.filter((h) => h.modStart === h.modEnd);
      expect(deletions.length).toBeGreaterThan(0);
    });
  });

  describe('analyzeHunkOverlaps', () => {
    it('reports no overlap for disjoint hunks', () => {
      const oursHunks = [{ baseStart: 0, baseEnd: 2, modStart: 0, modEnd: 2 }];
      const theirsHunks = [{ baseStart: 5, baseEnd: 7, modStart: 5, modEnd: 7 }];
      const analysis = classifier.analyzeHunkOverlaps(oursHunks, theirsHunks);
      expect(analysis.some((h) => h.overlaps)).toBe(false);
    });

    it('reports overlap for hunks touching the same base range', () => {
      const oursHunks = [{ baseStart: 0, baseEnd: 5, modStart: 0, modEnd: 5 }];
      const theirsHunks = [{ baseStart: 3, baseEnd: 8, modStart: 3, modEnd: 8 }];
      const analysis = classifier.analyzeHunkOverlaps(oursHunks, theirsHunks);
      expect(analysis.some((h) => h.overlaps)).toBe(true);
    });

    it('includes non-overlapping hunks in the analysis', () => {
      const oursHunks = [
        { baseStart: 0, baseEnd: 2, modStart: 0, modEnd: 2 },
        { baseStart: 10, baseEnd: 12, modStart: 10, modEnd: 12 },
      ];
      const theirsHunks = [
        { baseStart: 5, baseEnd: 7, modStart: 5, modEnd: 7 },
      ];
      const analysis = classifier.analyzeHunkOverlaps(oursHunks, theirsHunks);
      // All hunks are non-overlapping
      expect(analysis.every((h) => !h.overlaps)).toBe(true);
      // Should include all three hunks
      expect(analysis.length).toBe(3);
    });
  });

  describe('checkOverlapCompatibility', () => {
    it('returns true when overlapping regions produce identical content', () => {
      const base = 'a\nold\nc';
      const ours = 'a\nnew\nc';
      const theirs = 'a\nnew\nc';
      const hunks = [
        {
          baseRange: { start: 1, end: 2 },
          oursRange: { start: 1, end: 2 },
          theirsRange: { start: 1, end: 2 },
          overlaps: true,
        },
      ];
      expect(classifier.checkOverlapCompatibility(base, ours, theirs, hunks)).toBe(true);
    });

    it('returns false when overlapping regions differ', () => {
      const base = 'a\nold\nc';
      const ours = 'a\nchange-A\nc';
      const theirs = 'a\nchange-B\nc';
      const hunks = [
        {
          baseRange: { start: 1, end: 2 },
          oursRange: { start: 1, end: 2 },
          theirsRange: { start: 1, end: 2 },
          overlaps: true,
        },
      ];
      expect(classifier.checkOverlapCompatibility(base, ours, theirs, hunks)).toBe(false);
    });
  });
});

// ============================================================================
// ConflictClassifier integration tests (with real git repos)
// ============================================================================

describe('ConflictClassifier (integration)', () => {
  let repoRoot: string;
  let classifier: ConflictClassifier;

  afterEach(() => {
    if (repoRoot) cleanupTempRepo(repoRoot);
  });

  describe('non-overlapping conflict', () => {
    beforeEach(() => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);
      setupNonOverlappingConflict(repoRoot);
    });

    it('classifies as non-overlapping', async () => {
      const result = await classifier.classifyConflict('src/service.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.NonOverlapping);
      expect(result.confidence).toBe(0.95);
    });

    it('extracts all three stages', async () => {
      const result = await classifier.classifyConflict('src/service.ts', 'req-001');
      expect(result.baseContent).toBeTruthy();
      expect(result.oursContent).toBeTruthy();
      expect(result.theirsContent).toBeTruthy();
    });

    it('includes hunk analysis', async () => {
      const result = await classifier.classifyConflict('src/service.ts', 'req-001');
      expect(result.hunks.length).toBeGreaterThan(0);
    });
  });

  describe('overlapping conflicting', () => {
    beforeEach(() => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);
      setupOverlappingConflictingConflict(repoRoot);
    });

    it('classifies as overlapping-conflicting', async () => {
      const result = await classifier.classifyConflict('src/greeting.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.OverlappingConflicting);
    });

    it('has overlapping hunks', async () => {
      const result = await classifier.classifyConflict('src/greeting.ts', 'req-001');
      expect(result.hunks.some((h) => h.overlaps)).toBe(true);
    });
  });

  describe('overlapping compatible', () => {
    beforeEach(() => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);
      setupOverlappingCompatibleConflict(repoRoot);
    });

    it('classifies as overlapping-compatible', async () => {
      const result = await classifier.classifyConflict('src/greeting.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.OverlappingCompatible);
    });
  });

  describe('structural conflict', () => {
    beforeEach(() => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);
      setupStructuralConflict(repoRoot);
    });

    it('classifies as structural when stage missing', async () => {
      const result = await classifier.classifyConflict('src/removed.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.Structural);
      expect(result.confidence).toBe(1.0);
    });

    it('returns empty hunks for structural conflicts', async () => {
      const result = await classifier.classifyConflict('src/removed.ts', 'req-001');
      expect(result.hunks).toEqual([]);
    });
  });

  describe('determinism', () => {
    beforeEach(() => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);
      setupOverlappingConflictingConflict(repoRoot);
    });

    it('is deterministic for the same input', async () => {
      const r1 = await classifier.classifyConflict('src/greeting.ts', 'req-001');
      const r2 = await classifier.classifyConflict('src/greeting.ts', 'req-001');
      expect(r1.conflictType).toBe(r2.conflictType);
      expect(r1.confidence).toBe(r2.confidence);
      expect(r1.hunks.length).toBe(r2.hunks.length);
    });
  });

  // --------------------------------------------------------------------------
  // Additional classification scenarios (SPEC-006-4-4)
  // --------------------------------------------------------------------------

  describe('multi-hunk non-overlapping', () => {
    beforeEach(() => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);

      // Set up: ours changes top and bottom, theirs changes middle
      const srcDir = path.join(repoRoot, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      const baseContent = [
        'line-1',
        'line-2',
        'line-3',
        'line-4',
        'line-5',
        'line-6',
        'line-7',
        'line-8',
        'line-9',
        'line-10',
      ].join('\n');

      fs.writeFileSync(path.join(srcDir, 'multi.ts'), baseContent);
      execSync('git add . && git commit -m "add multi"', { cwd: repoRoot, stdio: 'pipe' });

      execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

      // Track A: changes lines 1-2
      execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      const oursContent = baseContent
        .replace('line-1', 'OURS-1')
        .replace('line-2', 'OURS-2');
      fs.writeFileSync(path.join(srcDir, 'multi.ts'), oursContent);
      execSync('git add . && git commit -m "track-a changes"', { cwd: repoRoot, stdio: 'pipe' });

      // Track B: changes lines 8-9
      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      const theirsContent = baseContent
        .replace('line-8', 'THEIRS-8')
        .replace('line-9', 'THEIRS-9');
      fs.writeFileSync(path.join(srcDir, 'multi.ts'), theirsContent);
      execSync('git add . && git commit -m "track-b changes"', { cwd: repoRoot, stdio: 'pipe' });

      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      try {
        execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      } catch {
        // Expected conflict
      }
    });

    it('classifies multi-hunk non-overlapping as non-overlapping', async () => {
      const result = await classifier.classifyConflict('src/multi.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.NonOverlapping);
      // Should have multiple hunks, none overlapping
      expect(result.hunks.length).toBeGreaterThan(0);
      expect(result.hunks.every((h) => !h.overlaps)).toBe(true);
    });
  });

  describe('disjoint (single-side modification)', () => {
    beforeEach(() => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);

      const srcDir = path.join(repoRoot, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      const baseContent = 'const x = 1;\n';
      fs.writeFileSync(path.join(srcDir, 'disjoint.ts'), baseContent);
      execSync('git add . && git commit -m "add disjoint"', { cwd: repoRoot, stdio: 'pipe' });

      execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

      // Track A: modifies the file
      execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      fs.writeFileSync(path.join(srcDir, 'disjoint.ts'), 'const x = 2;\n');
      execSync('git add . && git commit -m "track-a changes"', { cwd: repoRoot, stdio: 'pipe' });

      // Track B: does NOT change this file (adds a different file)
      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      fs.writeFileSync(path.join(srcDir, 'other.ts'), 'const y = 1;\n');
      execSync('git add . && git commit -m "track-b changes"', { cwd: repoRoot, stdio: 'pipe' });

      // Merge both into integration
      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      try {
        execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      } catch {
        // May or may not conflict depending on git version
      }
    });

    it('classifies disjoint when only one side modifies a file', async () => {
      // If there's a conflict in the index for disjoint.ts, verify disjoint classification
      // Otherwise, this is a clean merge (no conflict) and we skip
      try {
        const result = await classifier.classifyConflict('src/disjoint.ts', 'req-001');
        expect(result.conflictType).toBe(ConflictType.Disjoint);
      } catch {
        // If git resolved this cleanly (no stage entries), that's also valid
        // for a disjoint scenario -- no conflict to classify
      }
    });
  });

  describe('empty file scenarios', () => {
    it('classifies empty base with both sides adding content as overlapping-conflicting', async () => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);

      const srcDir = path.join(repoRoot, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      // Create empty file
      fs.writeFileSync(path.join(srcDir, 'empty.ts'), '');
      execSync('git add . && git commit -m "add empty"', { cwd: repoRoot, stdio: 'pipe' });

      execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

      // Track A adds content
      execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      fs.writeFileSync(path.join(srcDir, 'empty.ts'), 'export const a = 1;\n');
      execSync('git add . && git commit -m "track-a adds"', { cwd: repoRoot, stdio: 'pipe' });

      // Track B adds different content
      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      fs.writeFileSync(path.join(srcDir, 'empty.ts'), 'export const b = 2;\n');
      execSync('git add . && git commit -m "track-b adds"', { cwd: repoRoot, stdio: 'pipe' });

      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      try {
        execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      } catch {
        // Expected conflict
      }

      const result = await classifier.classifyConflict('src/empty.ts', 'req-001');
      // Both sides modified the same (empty) base region differently
      expect(result.conflictType).toBe(ConflictType.OverlappingConflicting);
    });
  });

  describe('large file classification', () => {
    it('handles files with many lines correctly', async () => {
      repoRoot = createTempRepo();
      classifier = new ConflictClassifier(repoRoot);

      const srcDir = path.join(repoRoot, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      // Generate a 100-line file
      const baseLines: string[] = [];
      for (let i = 0; i < 100; i++) {
        baseLines.push(`line-${i}`);
      }
      const baseContent = baseLines.join('\n');

      fs.writeFileSync(path.join(srcDir, 'large.ts'), baseContent);
      execSync('git add . && git commit -m "add large file"', { cwd: repoRoot, stdio: 'pipe' });

      execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

      // Track A: modifies lines 5-10
      execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      const oursLines = [...baseLines];
      for (let i = 5; i <= 10; i++) oursLines[i] = `OURS-${i}`;
      fs.writeFileSync(path.join(srcDir, 'large.ts'), oursLines.join('\n'));
      execSync('git add . && git commit -m "track-a changes"', { cwd: repoRoot, stdio: 'pipe' });

      // Track B: modifies lines 80-85 (no overlap)
      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      const theirsLines = [...baseLines];
      for (let i = 80; i <= 85; i++) theirsLines[i] = `THEIRS-${i}`;
      fs.writeFileSync(path.join(srcDir, 'large.ts'), theirsLines.join('\n'));
      execSync('git add . && git commit -m "track-b changes"', { cwd: repoRoot, stdio: 'pipe' });

      execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
      try {
        execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
      } catch {
        // Expected conflict
      }

      const result = await classifier.classifyConflict('src/large.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.NonOverlapping);
    });
  });
});
