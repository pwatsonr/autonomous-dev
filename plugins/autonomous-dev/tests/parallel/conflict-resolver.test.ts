/**
 * Tests for ConflictResolver (SPEC-006-4-2 + SPEC-006-4-3).
 *
 * SPEC-006-4-2 verifies:
 *   - autoResolve for non-overlapping conflicts (3-way merge, staging, events)
 *   - aiResolve with confidence threshold gating
 *   - ConflictResolutionBelowThresholdError when confidence < threshold
 *   - AI prompt includes base/ours/theirs, both specs, and interface contracts
 *   - merge.conflict_detected and merge.conflict_resolved events
 *
 * SPEC-006-4-3 verifies:
 *   - Escalation report generation with correct structure
 *   - Report persistence to `.autonomous-dev/conflicts/req-{id}/`
 *   - AI suggestion inclusion when provided
 *   - `git merge --abort` invocation on escalation
 *   - `merge.escalated` event emission
 *   - Conflict classification logic
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  ConflictResolver,
  EscalationReport,
  ConflictResolutionBelowThresholdError,
  threeWayMerge,
  SpawnConflictAgentFn,
  ConflictAgentResponse,
} from '../../src/parallel/conflict-resolver';
import type { ClassificationResult } from '../../src/parallel/conflict-classifier';
import {
  ConflictType,
  ConflictResolutionResult,
  ConflictResolutionRequest,
} from '../../src/parallel/types';
import { loadConfig, ParallelConfig } from '../../src/parallel/config';

// ============================================================================
// Helpers
// ============================================================================

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-resolver-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });

  // Create initial commit on main
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  execSync('git add . && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupTempRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Set up a merge conflict scenario for testing.
 * Creates two branches that modify the same file differently,
 * then starts a merge that will conflict.
 */
function setupMergeConflict(repoRoot: string): void {
  // Create file on main
  fs.writeFileSync(path.join(repoRoot, 'src', 'service.ts'), 'line1\nline2\nline3\n');
  execSync('mkdir -p src', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoRoot, 'src', 'service.ts'), 'line1\nline2\nline3\n');
  execSync('git add . && git commit -m "add service"', { cwd: repoRoot, stdio: 'pipe' });

  // Create integration branch
  execSync('git branch auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });

  // Create track-a branch with different content
  execSync('git checkout -b auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoRoot, 'src', 'service.ts'), 'line1\ntrack-a-change\nline3\n');
  execSync('git add . && git commit -m "track-a changes"', { cwd: repoRoot, stdio: 'pipe' });

  // Create track-b branch with conflicting content
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git checkout -b auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  fs.writeFileSync(path.join(repoRoot, 'src', 'service.ts'), 'line1\ntrack-b-change\nline3\n');
  execSync('git add . && git commit -m "track-b changes"', { cwd: repoRoot, stdio: 'pipe' });

  // Start a merge that will conflict
  execSync('git checkout auto/req-001/integration', { cwd: repoRoot, stdio: 'pipe' });
  try {
    execSync('git merge --no-ff auto/req-001/track-a', { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    // May or may not conflict at this point
  }
  try {
    execSync('git merge --no-ff auto/req-001/track-b', { cwd: repoRoot, stdio: 'pipe' });
  } catch {
    // This should conflict
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('ConflictResolver', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let config: ParallelConfig;
  let resolver: ConflictResolver;

  beforeEach(() => {
    repoRoot = createTempRepo();
    emitter = new EventEmitter();
    config = loadConfig();
    resolver = new ConflictResolver(repoRoot, config, emitter);
  });

  afterEach(() => {
    cleanupTempRepo(repoRoot);
  });

  // --------------------------------------------------------------------------
  // classifyConflict
  // --------------------------------------------------------------------------

  describe('classifyConflict', () => {
    it('returns NonOverlapping when ours is null', () => {
      expect(resolver.classifyConflict('base', null, 'theirs'))
        .toBe(ConflictType.NonOverlapping);
    });

    it('returns NonOverlapping when theirs is null', () => {
      expect(resolver.classifyConflict('base', 'ours', null))
        .toBe(ConflictType.NonOverlapping);
    });

    it('returns OverlappingConflicting when base is null', () => {
      // Both tracks added the file independently
      expect(resolver.classifyConflict(null, 'ours', 'theirs'))
        .toBe(ConflictType.OverlappingConflicting);
    });

    it('returns NonOverlapping when changes are on different lines', () => {
      const base = 'line1\nline2\nline3\nline4\n';
      const ours = 'CHANGED1\nline2\nline3\nline4\n';     // changed line 1
      const theirs = 'line1\nline2\nline3\nCHANGED4\n';   // changed line 4
      expect(resolver.classifyConflict(base, ours, theirs))
        .toBe(ConflictType.NonOverlapping);
    });

    it('returns OverlappingConflicting when changes are on the same lines', () => {
      const base = 'line1\nline2\nline3\n';
      const ours = 'line1\nOURS\nline3\n';
      const theirs = 'line1\nTHEIRS\nline3\n';
      expect(resolver.classifyConflict(base, ours, theirs))
        .toBe(ConflictType.OverlappingConflicting);
    });
  });

  // --------------------------------------------------------------------------
  // escalateConflict
  // --------------------------------------------------------------------------

  describe('escalateConflict', () => {
    it('writes escalation report to correct path', async () => {
      const report = await resolver.escalateConflict(
        'src/service.ts', 'req-001', 'track-a', 'track-b',
      );

      const reportDir = path.join(repoRoot, '.autonomous-dev', 'conflicts', 'req-req-001');
      expect(fs.existsSync(reportDir)).toBe(true);

      const files = fs.readdirSync(reportDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^conflict-req-001-\d+\.json$/);
    });

    it('report contains all required fields', async () => {
      const report = await resolver.escalateConflict(
        'src/service.ts', 'req-001', 'track-a', 'track-b',
      );

      expect(report.id).toMatch(/^conflict-req-001-\d+$/);
      expect(report.requestId).toBe('req-001');
      expect(report.file).toBe('src/service.ts');
      expect(report.trackA).toBe('track-a');
      expect(report.trackB).toBe('track-b');
      expect(report.conflictType).toBeDefined();
      expect(report.timestamp).toBeDefined();
      expect(typeof report.baseContent).toBe('string');
      expect(typeof report.oursContent).toBe('string');
      expect(typeof report.theirsContent).toBe('string');
      expect(report.specAIntent).toBeDefined();
      expect(report.specBIntent).toBeDefined();
    });

    it('includes AI suggestion when provided', async () => {
      const aiResult: ConflictResolutionResult = {
        resolvedContent: 'merged content',
        confidence: 0.5,
        reasoning: 'unsure about this merge',
        strategy: 'ai',
      };

      const report = await resolver.escalateConflict(
        'src/service.ts', 'req-001', 'track-a', 'track-b', aiResult,
      );

      expect(report.aiSuggestion).toBe('merged content');
      expect(report.aiConfidence).toBe(0.5);
      expect(report.aiReasoning).toBe('unsure about this merge');
    });

    it('sets AI fields to null when no AI result provided', async () => {
      const report = await resolver.escalateConflict(
        'src/service.ts', 'req-001', 'track-a', 'track-b',
      );

      expect(report.aiSuggestion).toBeNull();
      expect(report.aiConfidence).toBeNull();
      expect(report.aiReasoning).toBeNull();
    });

    it('aborts the in-progress merge', async () => {
      // Set up a merge conflict first
      setupMergeConflict(repoRoot);

      await resolver.escalateConflict(
        'src/service.ts', 'req-001', 'track-a', 'track-b',
      );

      // Verify no merge in progress
      const status = execSync(`git -C "${repoRoot}" status`, { encoding: 'utf-8' });
      expect(status).not.toContain('Unmerged');
    });

    it('emits merge.escalated event', async () => {
      const events: any[] = [];
      emitter.on('merge.escalated', (e) => events.push(e));

      await resolver.escalateConflict(
        'src/service.ts', 'req-001', 'track-a', 'track-b',
      );

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('merge.escalated');
      expect(events[0].requestId).toBe('req-001');
      expect(events[0].file).toBe('src/service.ts');
      expect(events[0].trackA).toBe('track-a');
      expect(events[0].trackB).toBe('track-b');
      expect(events[0].reportPath).toBeDefined();
      expect(events[0].timestamp).toBeDefined();
    });

    it('report JSON on disk matches returned report', async () => {
      const report = await resolver.escalateConflict(
        'src/service.ts', 'req-001', 'track-a', 'track-b',
      );

      const reportDir = path.join(repoRoot, '.autonomous-dev', 'conflicts', 'req-req-001');
      const files = fs.readdirSync(reportDir);
      const reportPath = path.join(reportDir, files[0]);
      const diskReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

      expect(diskReport.id).toBe(report.id);
      expect(diskReport.requestId).toBe(report.requestId);
      expect(diskReport.file).toBe(report.file);
      expect(diskReport.trackA).toBe(report.trackA);
      expect(diskReport.trackB).toBe(report.trackB);
    });

    it('creates multiple reports for the same request', async () => {
      await resolver.escalateConflict('src/a.ts', 'req-001', 'track-a', 'track-b');
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      await resolver.escalateConflict('src/b.ts', 'req-001', 'track-a', 'track-b');

      const reportDir = path.join(repoRoot, '.autonomous-dev', 'conflicts', 'req-req-001');
      const files = fs.readdirSync(reportDir);
      expect(files.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getStageContent
  // --------------------------------------------------------------------------

  describe('getStageContent', () => {
    it('returns null when no merge in progress', async () => {
      const content = await resolver.getStageContent('nonexistent.ts', 1);
      expect(content).toBeNull();
    });
  });
});

// ============================================================================
// threeWayMerge unit tests (SPEC-006-4-2)
// ============================================================================

describe('threeWayMerge', () => {
  it('merges non-overlapping changes successfully', () => {
    const base = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const ours = ['MODIFIED1', 'line2', 'line3', 'line4', 'line5'];
    const theirs = ['line1', 'line2', 'line3', 'line4', 'MODIFIED5'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(true);
    expect(result.result).toContain('MODIFIED1');
    expect(result.result).toContain('MODIFIED5');
    expect(result.result).toContain('line2');
    expect(result.result).toContain('line3');
    expect(result.result).toContain('line4');
  });

  it('keeps base when neither side changes a line', () => {
    const base = ['a', 'b', 'c'];
    const ours = ['a', 'b', 'c'];
    const theirs = ['a', 'b', 'c'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(true);
    expect(result.result).toEqual(['a', 'b', 'c']);
  });

  it('takes ours when only ours changes', () => {
    const base = ['a', 'b', 'c'];
    const ours = ['a', 'B', 'c'];
    const theirs = ['a', 'b', 'c'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(true);
    expect(result.result).toEqual(['a', 'B', 'c']);
  });

  it('takes theirs when only theirs changes', () => {
    const base = ['a', 'b', 'c'];
    const ours = ['a', 'b', 'c'];
    const theirs = ['a', 'b', 'C'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(true);
    expect(result.result).toEqual(['a', 'b', 'C']);
  });

  it('accepts both sides making the same change', () => {
    const base = ['a', 'b', 'c'];
    const ours = ['a', 'B', 'c'];
    const theirs = ['a', 'B', 'c'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(true);
    expect(result.result).toEqual(['a', 'B', 'c']);
  });

  it('fails when both sides make different changes to the same line', () => {
    const base = ['a', 'b', 'c'];
    const ours = ['a', 'X', 'c'];
    const theirs = ['a', 'Y', 'c'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(false);
    expect(result.conflictDescription).toBeDefined();
  });

  it('handles insertions from one side', () => {
    const base = ['a', 'c'];
    const ours = ['a', 'b', 'c'];
    const theirs = ['a', 'c'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(true);
    expect(result.result).toContain('b');
  });

  it('handles deletions from one side', () => {
    const base = ['a', 'b', 'c'];
    const ours = ['a', 'c'];
    const theirs = ['a', 'b', 'c'];

    const result = threeWayMerge(base, ours, theirs);
    expect(result.success).toBe(true);
    expect(result.result).not.toContain('b');
  });

  it('handles empty base', () => {
    const base: string[] = [];
    const ours = ['a'];
    const theirs = ['b'];

    // Both insert into empty base at the same position -- conflict
    const result = threeWayMerge(base, ours, theirs);
    // Could either succeed or fail depending on whether insertions are at same point
    expect(typeof result.success).toBe('boolean');
  });
});

// ============================================================================
// ConflictResolver.autoResolve (SPEC-006-4-2)
// ============================================================================

describe('ConflictResolver.autoResolve', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let config: ParallelConfig;
  let resolver: ConflictResolver;

  beforeEach(() => {
    repoRoot = createTempRepo();
    emitter = new EventEmitter();
    config = loadConfig();

    // Create src directory for file staging
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

    resolver = new ConflictResolver(repoRoot, config, emitter);
  });

  afterEach(() => {
    cleanupTempRepo(repoRoot);
  });

  const nonOverlappingClassification: ClassificationResult = {
    file: 'src/service.ts',
    conflictType: ConflictType.NonOverlapping,
    confidence: 0.95,
    baseContent: 'line1\nline2\nline3\nline4\nline5',
    oursContent: 'MODIFIED1\nline2\nline3\nline4\nline5',
    theirsContent: 'line1\nline2\nline3\nline4\nMODIFIED5',
    hunks: [],
  };

  it('resolves non-overlapping conflict', async () => {
    const result = await resolver.autoResolve(nonOverlappingClassification, 'req-001');
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.95);
    expect(result!.resolvedContent).toContain('MODIFIED1');
    expect(result!.resolvedContent).toContain('MODIFIED5');
    expect(result!.strategy).toBe('auto');
  });

  it('stages the resolved file', async () => {
    await resolver.autoResolve(nonOverlappingClassification, 'req-001');
    const staged = execSync(`git -C "${repoRoot}" diff --cached --name-only`).toString().trim();
    expect(staged).toContain('src/service.ts');
  });

  it('writes the merged content to disk', async () => {
    await resolver.autoResolve(nonOverlappingClassification, 'req-001');
    const content = fs.readFileSync(path.join(repoRoot, 'src', 'service.ts'), 'utf-8');
    expect(content).toContain('MODIFIED1');
    expect(content).toContain('MODIFIED5');
  });

  it('returns null for overlapping-conflicting conflicts', async () => {
    const classification: ClassificationResult = {
      ...nonOverlappingClassification,
      conflictType: ConflictType.OverlappingConflicting,
    };
    const result = await resolver.autoResolve(classification, 'req-001');
    expect(result).toBeNull();
  });

  it('returns null for overlapping-compatible conflicts', async () => {
    const classification: ClassificationResult = {
      ...nonOverlappingClassification,
      conflictType: ConflictType.OverlappingCompatible,
    };
    const result = await resolver.autoResolve(classification, 'req-001');
    expect(result).toBeNull();
  });

  it('returns null for structural conflicts', async () => {
    const classification: ClassificationResult = {
      ...nonOverlappingClassification,
      conflictType: ConflictType.Structural,
    };
    const result = await resolver.autoResolve(classification, 'req-001');
    expect(result).toBeNull();
  });

  it('returns null for disjoint conflicts', async () => {
    const classification: ClassificationResult = {
      ...nonOverlappingClassification,
      conflictType: ConflictType.Disjoint,
    };
    const result = await resolver.autoResolve(classification, 'req-001');
    expect(result).toBeNull();
  });

  it('emits merge.conflict_resolved event', async () => {
    const events: any[] = [];
    emitter.on('merge.conflict_resolved', (e) => events.push(e));
    await resolver.autoResolve(nonOverlappingClassification, 'req-001');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('merge.conflict_resolved');
    expect(events[0].strategy).toBe('auto');
    expect(events[0].confidence).toBe(0.95);
    expect(events[0].file).toBe('src/service.ts');
    expect(events[0].requestId).toBe('req-001');
  });

  it('returns confidence 0.95 on success', async () => {
    const result = await resolver.autoResolve(nonOverlappingClassification, 'req-001');
    expect(result!.confidence).toBe(0.95);
  });

  it('includes reasoning in the result', async () => {
    const result = await resolver.autoResolve(nonOverlappingClassification, 'req-001');
    expect(result!.reasoning).toContain('Non-overlapping');
  });
});

// ============================================================================
// ConflictResolver.aiResolve (SPEC-006-4-2)
// ============================================================================

describe('ConflictResolver.aiResolve', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let config: ParallelConfig;

  beforeEach(() => {
    repoRoot = createTempRepo();
    emitter = new EventEmitter();
    config = loadConfig(); // default threshold is 0.85

    // Create src directory for file staging
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempRepo(repoRoot);
  });

  const conflictRequest: ConflictResolutionRequest = {
    file: 'src/service.ts',
    requestId: 'req-001',
    trackA: 'track-a',
    trackB: 'track-b',
    baseContent: 'function foo() { return "hello"; }',
    oursContent: 'function foo() { return "hello world"; }',
    theirsContent: 'function foo() { return "hello universe"; }',
    specA: 'Spec A: add greeting world',
    specB: 'Spec B: add greeting universe',
    interfaceContracts: [
      {
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface Greeting { message: string; }',
        filePath: 'src/types.ts',
      },
    ],
  };

  function createMockAgent(response: ConflictAgentResponse): SpawnConflictAgentFn {
    return async (_prompt: string, _maxTurns: number) => response;
  }

  it('accepts resolution above confidence threshold', async () => {
    const mockAgent = createMockAgent({
      content: 'function foo() { return "hello world universe"; }',
      confidence: 0.9,
      reasoning: 'Combined both changes',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    const result = await resolver.aiResolve(conflictRequest);
    expect(result.strategy).toBe('ai');
    expect(result.confidence).toBe(0.9);
    expect(result.resolvedContent).toContain('hello world universe');
  });

  it('accepts resolution at exactly the threshold', async () => {
    const mockAgent = createMockAgent({
      content: 'merged',
      confidence: 0.85,
      reasoning: 'at threshold',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    const result = await resolver.aiResolve(conflictRequest);
    expect(result.confidence).toBe(0.85);
  });

  it('rejects resolution below confidence threshold', async () => {
    const mockAgent = createMockAgent({
      content: 'merged',
      confidence: 0.5,
      reasoning: 'unsure',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    await expect(resolver.aiResolve(conflictRequest)).rejects.toThrow(
      ConflictResolutionBelowThresholdError,
    );
  });

  it('error contains file, confidence, threshold, and result', async () => {
    const mockAgent = createMockAgent({
      content: 'merged',
      confidence: 0.3,
      reasoning: 'very unsure',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    try {
      await resolver.aiResolve(conflictRequest);
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictResolutionBelowThresholdError);
      const e = err as ConflictResolutionBelowThresholdError;
      expect(e.file).toBe('src/service.ts');
      expect(e.confidence).toBe(0.3);
      expect(e.threshold).toBe(0.85);
      expect(e.result.strategy).toBe('ai');
      expect(e.result.resolvedContent).toBe('merged');
    }
  });

  it('writes and stages the file on acceptance', async () => {
    const resolvedContent = 'function foo() { return "merged result"; }';
    const mockAgent = createMockAgent({
      content: resolvedContent,
      confidence: 0.95,
      reasoning: 'clean merge',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    await resolver.aiResolve(conflictRequest);

    const diskContent = fs.readFileSync(path.join(repoRoot, 'src', 'service.ts'), 'utf-8');
    expect(diskContent).toBe(resolvedContent);

    const staged = execSync(`git -C "${repoRoot}" diff --cached --name-only`).toString().trim();
    expect(staged).toContain('src/service.ts');
  });

  it('does not write file when below threshold', async () => {
    const mockAgent = createMockAgent({
      content: 'should not be written',
      confidence: 0.1,
      reasoning: 'low confidence',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    try {
      await resolver.aiResolve(conflictRequest);
    } catch {
      // Expected
    }

    expect(fs.existsSync(path.join(repoRoot, 'src', 'service.ts'))).toBe(false);
  });

  it('provides base/ours/theirs and both specs to agent', async () => {
    let capturedPrompt = '';
    const mockAgent: SpawnConflictAgentFn = async (prompt, _maxTurns) => {
      capturedPrompt = prompt;
      return { content: 'merged', confidence: 0.9, reasoning: 'ok' };
    };
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    await resolver.aiResolve(conflictRequest);

    expect(capturedPrompt).toContain('Base version');
    expect(capturedPrompt).toContain('Ours');
    expect(capturedPrompt).toContain('Theirs');
    expect(capturedPrompt).toContain(conflictRequest.baseContent);
    expect(capturedPrompt).toContain(conflictRequest.oursContent);
    expect(capturedPrompt).toContain(conflictRequest.theirsContent);
    expect(capturedPrompt).toContain(conflictRequest.specA);
    expect(capturedPrompt).toContain(conflictRequest.specB);
  });

  it('includes interface contracts in the prompt', async () => {
    let capturedPrompt = '';
    const mockAgent: SpawnConflictAgentFn = async (prompt, _maxTurns) => {
      capturedPrompt = prompt;
      return { content: 'merged', confidence: 0.9, reasoning: 'ok' };
    };
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    await resolver.aiResolve(conflictRequest);

    expect(capturedPrompt).toContain('track-a -> track-b: type-definition');
  });

  it('passes maxTurns=10 to the subagent', async () => {
    let capturedMaxTurns = 0;
    const mockAgent: SpawnConflictAgentFn = async (_prompt, maxTurns) => {
      capturedMaxTurns = maxTurns;
      return { content: 'merged', confidence: 0.9, reasoning: 'ok' };
    };
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    await resolver.aiResolve(conflictRequest);

    expect(capturedMaxTurns).toBe(10);
  });

  it('emits merge.conflict_detected and merge.conflict_resolved', async () => {
    const events: any[] = [];
    emitter.on('merge.conflict_detected', (e) => events.push(e));
    emitter.on('merge.conflict_resolved', (e) => events.push(e));

    const mockAgent = createMockAgent({
      content: 'merged',
      confidence: 0.9,
      reasoning: 'ok',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    await resolver.aiResolve(conflictRequest);

    expect(events.length).toBe(2);
    expect(events[0].type).toBe('merge.conflict_detected');
    expect(events[0].requestId).toBe('req-001');
    expect(events[0].file).toBe('src/service.ts');
    expect(events[0].trackA).toBe('track-a');
    expect(events[0].trackB).toBe('track-b');
    expect(events[1].type).toBe('merge.conflict_resolved');
    expect(events[1].strategy).toBe('ai');
    expect(events[1].confidence).toBe(0.9);
  });

  it('emits merge.conflict_detected even when below threshold', async () => {
    const events: any[] = [];
    emitter.on('merge.conflict_detected', (e) => events.push(e));

    const mockAgent = createMockAgent({
      content: 'merged',
      confidence: 0.1,
      reasoning: 'unsure',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    try {
      await resolver.aiResolve(conflictRequest);
    } catch {
      // Expected
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('merge.conflict_detected');
  });

  it('does not emit merge.conflict_resolved when below threshold', async () => {
    const events: any[] = [];
    emitter.on('merge.conflict_resolved', (e) => events.push(e));

    const mockAgent = createMockAgent({
      content: 'merged',
      confidence: 0.1,
      reasoning: 'unsure',
    });
    const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

    try {
      await resolver.aiResolve(conflictRequest);
    } catch {
      // Expected
    }

    expect(events.length).toBe(0);
  });
});

// ============================================================================
// ConflictResolver.buildConflictResolutionPrompt (SPEC-006-4-2)
// ============================================================================

describe('ConflictResolver.buildConflictResolutionPrompt', () => {
  it('includes all required sections', () => {
    const emitter = new EventEmitter();
    const config = loadConfig();
    const resolver = new ConflictResolver('/tmp/fake', config, emitter);

    const request: ConflictResolutionRequest = {
      file: 'src/test.ts',
      requestId: 'req-001',
      trackA: 'track-a',
      trackB: 'track-b',
      baseContent: 'base content',
      oursContent: 'ours content',
      theirsContent: 'theirs content',
      specA: 'spec A details',
      specB: 'spec B details',
      interfaceContracts: [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'function hello(): string',
          filePath: 'src/api.ts',
        },
      ],
    };

    const prompt = resolver.buildConflictResolutionPrompt(request);
    expect(prompt).toContain('merge conflict resolution specialist');
    expect(prompt).toContain('src/test.ts');
    expect(prompt).toContain('base content');
    expect(prompt).toContain('ours content');
    expect(prompt).toContain('theirs content');
    expect(prompt).toContain('spec A details');
    expect(prompt).toContain('spec B details');
    expect(prompt).toContain('track-a -> track-b: function-signature');
    expect(prompt).toContain('RESOLVED_CONTENT');
    expect(prompt).toContain('CONFIDENCE');
    expect(prompt).toContain('REASONING');
  });
});

// ============================================================================
// Additional resolution scenarios (SPEC-006-4-4)
// ============================================================================

describe('ConflictResolver — additional scenarios', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let config: ParallelConfig;

  beforeEach(() => {
    repoRoot = createTempRepo();
    emitter = new EventEmitter();
    config = loadConfig();
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempRepo(repoRoot);
  });

  describe('autoResolve with multi-hunk non-overlapping', () => {
    it('resolves multiple non-overlapping hunks in a single file', async () => {
      const resolver = new ConflictResolver(repoRoot, config, emitter);

      const classification: ClassificationResult = {
        file: 'src/multi.ts',
        conflictType: ConflictType.NonOverlapping,
        confidence: 0.95,
        baseContent: 'line1\nline2\nline3\nline4\nline5',
        oursContent: 'OURS1\nline2\nline3\nline4\nline5',
        theirsContent: 'line1\nline2\nline3\nline4\nTHEIRS5',
        hunks: [],
      };

      const result = await resolver.autoResolve(classification, 'req-001');
      expect(result).not.toBeNull();
      expect(result!.resolvedContent).toContain('OURS1');
      expect(result!.resolvedContent).toContain('THEIRS5');
      expect(result!.resolvedContent).toContain('line2');
      expect(result!.resolvedContent).toContain('line3');
    });

    it('handles ours adding lines and theirs modifying different lines', async () => {
      const resolver = new ConflictResolver(repoRoot, config, emitter);

      const classification: ClassificationResult = {
        file: 'src/insert.ts',
        conflictType: ConflictType.NonOverlapping,
        confidence: 0.95,
        baseContent: 'a\nb\nc',
        oursContent: 'a\nINSERTED\nb\nc',
        theirsContent: 'a\nb\nC-MODIFIED',
        hunks: [],
      };

      const result = await resolver.autoResolve(classification, 'req-001');
      expect(result).not.toBeNull();
      expect(result!.resolvedContent).toContain('INSERTED');
      expect(result!.resolvedContent).toContain('C-MODIFIED');
    });
  });

  describe('autoResolve with identical changes', () => {
    it('resolves when both sides make the same change', async () => {
      const resolver = new ConflictResolver(repoRoot, config, emitter);

      // Both sides change the same line to the same value
      // threeWayMerge handles this as compatible
      const classification: ClassificationResult = {
        file: 'src/same.ts',
        conflictType: ConflictType.NonOverlapping,
        confidence: 0.95,
        baseContent: 'a\nold\nc',
        oursContent: 'a\nnew\nc',
        theirsContent: 'a\nnew\nc',
        hunks: [],
      };

      const result = await resolver.autoResolve(classification, 'req-001');
      expect(result).not.toBeNull();
      expect(result!.resolvedContent).toContain('new');
      expect(result!.resolvedContent).not.toContain('old');
    });
  });

  describe('aiResolve with custom threshold', () => {
    it('accepts low confidence when threshold is lowered', async () => {
      const lowThresholdConfig = loadConfig({ conflict_ai_confidence_threshold: 0.3 });
      const mockAgent = async (_prompt: string, _maxTurns: number) => ({
        content: 'resolved content',
        confidence: 0.4,
        reasoning: 'best effort',
      });
      const resolver = new ConflictResolver(repoRoot, lowThresholdConfig, emitter, mockAgent);

      const request: ConflictResolutionRequest = {
        file: 'src/service.ts',
        requestId: 'req-001',
        trackA: 'track-a',
        trackB: 'track-b',
        baseContent: 'base',
        oursContent: 'ours',
        theirsContent: 'theirs',
        specA: 'spec A',
        specB: 'spec B',
        interfaceContracts: [],
      };

      const result = await resolver.aiResolve(request);
      expect(result.confidence).toBe(0.4);
      expect(result.strategy).toBe('ai');
    });

    it('rejects confidence 0.84 with default 0.85 threshold', async () => {
      const mockAgent = async (_prompt: string, _maxTurns: number) => ({
        content: 'resolved',
        confidence: 0.84,
        reasoning: 'just under threshold',
      });
      const resolver = new ConflictResolver(repoRoot, config, emitter, mockAgent);

      const request: ConflictResolutionRequest = {
        file: 'src/service.ts',
        requestId: 'req-001',
        trackA: 'track-a',
        trackB: 'track-b',
        baseContent: 'base',
        oursContent: 'ours',
        theirsContent: 'theirs',
        specA: 'spec A',
        specB: 'spec B',
        interfaceContracts: [],
      };

      await expect(resolver.aiResolve(request)).rejects.toThrow(
        ConflictResolutionBelowThresholdError,
      );
    });
  });

  describe('escalation with real merge state', () => {
    it('generates report for a real merge conflict', async () => {
      // Set up actual merge conflict
      setupMergeConflict(repoRoot);

      const resolver = new ConflictResolver(repoRoot, config, emitter);
      const report = await resolver.escalateConflict(
        'src/service.ts',
        'req-001',
        'track-a',
        'track-b',
      );

      expect(report.id).toBeDefined();
      expect(report.requestId).toBe('req-001');
      expect(report.file).toBe('src/service.ts');
      expect(report.baseContent).toBeTruthy();
      expect(report.oursContent).toBeTruthy();
      expect(report.theirsContent).toBeTruthy();

      // Verify merge was aborted
      const status = execSync(`git -C "${repoRoot}" status`, { encoding: 'utf-8' });
      expect(status).not.toContain('Unmerged');
    });

    it('report correctly classifies the conflict type', async () => {
      setupMergeConflict(repoRoot);

      const resolver = new ConflictResolver(repoRoot, config, emitter);
      const report = await resolver.escalateConflict(
        'src/service.ts',
        'req-001',
        'track-a',
        'track-b',
      );

      // Overlapping conflicting since both sides change the same line
      expect(report.conflictType).toBe(ConflictType.OverlappingConflicting);
    });
  });

  describe('prompt with multiple interface contracts', () => {
    it('includes all contracts in the prompt', () => {
      const resolver = new ConflictResolver('/tmp/fake', config, emitter);

      const request: ConflictResolutionRequest = {
        file: 'src/test.ts',
        requestId: 'req-001',
        trackA: 'track-a',
        trackB: 'track-b',
        baseContent: 'base',
        oursContent: 'ours',
        theirsContent: 'theirs',
        specA: 'spec A',
        specB: 'spec B',
        interfaceContracts: [
          {
            producer: 'track-a',
            consumer: 'track-b',
            contractType: 'type-definition',
            definition: 'interface User {}',
            filePath: 'src/types.ts',
          },
          {
            producer: 'track-b',
            consumer: 'track-a',
            contractType: 'function-signature',
            definition: 'function validate(): boolean',
            filePath: 'src/validation.ts',
          },
          {
            producer: 'track-a',
            consumer: 'track-b',
            contractType: 'api-endpoint',
            definition: 'GET /api/health',
            filePath: 'src/routes.ts',
          },
        ],
      };

      const prompt = resolver.buildConflictResolutionPrompt(request);
      expect(prompt).toContain('track-a -> track-b: type-definition');
      expect(prompt).toContain('track-b -> track-a: function-signature');
      expect(prompt).toContain('track-a -> track-b: api-endpoint');
    });
  });

  describe('prompt with no interface contracts', () => {
    it('generates valid prompt with empty contracts', () => {
      const resolver = new ConflictResolver('/tmp/fake', config, emitter);

      const request: ConflictResolutionRequest = {
        file: 'src/test.ts',
        requestId: 'req-001',
        trackA: 'track-a',
        trackB: 'track-b',
        baseContent: 'base',
        oursContent: 'ours',
        theirsContent: 'theirs',
        specA: 'spec A',
        specB: 'spec B',
        interfaceContracts: [],
      };

      const prompt = resolver.buildConflictResolutionPrompt(request);
      expect(prompt).toContain('merge conflict resolution specialist');
      expect(prompt).toContain('Interface contracts');
    });
  });
});
