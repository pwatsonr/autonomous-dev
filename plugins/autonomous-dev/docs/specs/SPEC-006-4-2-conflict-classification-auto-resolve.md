# SPEC-006-4-2: Conflict Classification and Auto-Resolution

## Metadata
- **Parent Plan**: PLAN-006-4
- **Tasks Covered**: Task 4, Task 5, Task 6
- **Estimated effort**: 14 hours

## Description

Implement the conflict classifier that categorizes merge conflicts into five types based on the relationship between base, ours, and theirs versions. Implement the auto-resolver for non-overlapping hunks that applies both change sets independently. Implement the AI conflict resolution agent that handles overlapping conflicts using both specs as context with a confidence threshold gate.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/conflict-classifier.ts` | **Create** | Conflict type classification using git stage extraction |
| `src/parallel/conflict-resolver.ts` | **Create** | Auto-resolve for non-overlapping, AI resolve for overlapping |
| `tests/parallel/conflict-classifier.test.ts` | **Create** | Classification tests with known file samples |
| `tests/parallel/conflict-resolver.test.ts` | **Create** | Resolution tests |

## Implementation Details

### 1. Conflict classifier (`src/parallel/conflict-classifier.ts`)

```typescript
export interface ClassificationResult {
  file: string;
  conflictType: ConflictType;
  confidence: number;
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  hunks: HunkAnalysis[];
}

export interface HunkAnalysis {
  baseRange: LineRange;
  oursRange: LineRange;
  theirsRange: LineRange;
  overlaps: boolean;
}

export interface LineRange {
  start: number;
  end: number;
}

export class ConflictClassifier {
  constructor(private repoRoot: string) {}

  async classifyConflict(file: string, requestId: string): Promise<ClassificationResult> {
    // Extract the three stages from git's index
    const baseContent = await this.getStageContent(file, 1);   // common ancestor
    const oursContent = await this.getStageContent(file, 2);   // integration branch (ours)
    const theirsContent = await this.getStageContent(file, 3); // track branch (theirs)

    // If any stage is missing, it's a structural conflict (add/delete)
    if (!baseContent || !oursContent || !theirsContent) {
      return {
        file,
        conflictType: ConflictType.Structural,
        confidence: 1.0,
        baseContent: baseContent ?? '',
        oursContent: oursContent ?? '',
        theirsContent: theirsContent ?? '',
        hunks: [],
      };
    }

    // Compute hunks: diff base->ours and base->theirs
    const oursHunks = this.computeHunks(baseContent, oursContent);
    const theirsHunks = this.computeHunks(baseContent, theirsContent);

    // Check for overlap between hunk ranges
    const hunkAnalysis = this.analyzeHunkOverlaps(oursHunks, theirsHunks);
    const hasOverlap = hunkAnalysis.some(h => h.overlaps);

    if (!hasOverlap) {
      return {
        file,
        conflictType: ConflictType.NonOverlapping,
        confidence: 0.95,
        baseContent,
        oursContent,
        theirsContent,
        hunks: hunkAnalysis,
      };
    }

    // Overlapping changes -- determine compatible vs conflicting
    // Compare the overlapping hunks: are they making the same change?
    const isCompatible = this.checkOverlapCompatibility(
      baseContent, oursContent, theirsContent, hunkAnalysis
    );

    return {
      file,
      conflictType: isCompatible ? ConflictType.OverlappingCompatible : ConflictType.OverlappingConflicting,
      confidence: isCompatible ? 0.7 : 0.9,
      baseContent,
      oursContent,
      theirsContent,
      hunks: hunkAnalysis,
    };
  }

  /**
   * Extract content from a specific git merge stage.
   * Stage 1 = base (common ancestor)
   * Stage 2 = ours (integration branch)
   * Stage 3 = theirs (track branch)
   */
  private async getStageContent(file: string, stage: 1 | 2 | 3): Promise<string | null> {
    try {
      return execSync(
        `git -C "${this.repoRoot}" show :${stage}:${file}`,
        { encoding: 'utf-8' }
      );
    } catch {
      return null; // stage does not exist (file added/deleted)
    }
  }

  /**
   * Compute changed hunks between two file versions.
   * Uses a line-based diff algorithm.
   */
  private computeHunks(base: string, modified: string): HunkInfo[] {
    const baseLines = base.split('\n');
    const modifiedLines = modified.split('\n');

    // Use a diff library (e.g., 'diff' npm package) to get line-level changes
    // Convert to HunkInfo[] with start/end line ranges in the base
    const changes = diffLines(base, modified);
    const hunks: HunkInfo[] = [];
    let baseLine = 0;
    let modLine = 0;

    for (const change of changes) {
      if (change.added) {
        hunks.push({
          baseStart: baseLine,
          baseEnd: baseLine,
          modStart: modLine,
          modEnd: modLine + change.count!,
        });
        modLine += change.count!;
      } else if (change.removed) {
        hunks.push({
          baseStart: baseLine,
          baseEnd: baseLine + change.count!,
          modStart: modLine,
          modEnd: modLine,
        });
        baseLine += change.count!;
      } else {
        baseLine += change.count!;
        modLine += change.count!;
      }
    }

    return hunks;
  }

  /**
   * Compare ours-hunks and theirs-hunks for range overlap.
   */
  private analyzeHunkOverlaps(oursHunks: HunkInfo[], theirsHunks: HunkInfo[]): HunkAnalysis[] {
    const analysis: HunkAnalysis[] = [];

    for (const ours of oursHunks) {
      for (const theirs of theirsHunks) {
        const overlaps =
          ours.baseStart < theirs.baseEnd && theirs.baseStart < ours.baseEnd;

        if (overlaps) {
          analysis.push({
            baseRange: { start: Math.min(ours.baseStart, theirs.baseStart),
                         end: Math.max(ours.baseEnd, theirs.baseEnd) },
            oursRange: { start: ours.modStart, end: ours.modEnd },
            theirsRange: { start: theirs.modStart, end: theirs.modEnd },
            overlaps: true,
          });
        }
      }
    }

    // Also include non-overlapping hunks for completeness
    // (These can be auto-resolved independently)

    return analysis;
  }

  /**
   * Check if overlapping hunks are making compatible changes
   * (i.e., both sides made the exact same modification).
   */
  private checkOverlapCompatibility(
    base: string, ours: string, theirs: string,
    hunks: HunkAnalysis[]
  ): boolean {
    // Extract the overlapping regions and compare
    // If ours and theirs produce identical content in the overlap, it's compatible
    const oursLines = ours.split('\n');
    const theirsLines = theirs.split('\n');

    for (const hunk of hunks.filter(h => h.overlaps)) {
      const oursSlice = oursLines.slice(hunk.oursRange.start, hunk.oursRange.end).join('\n');
      const theirsSlice = theirsLines.slice(hunk.theirsRange.start, hunk.theirsRange.end).join('\n');
      if (oursSlice !== theirsSlice) return false;
    }
    return true;
  }
}
```

### 2. Auto-resolver for non-overlapping conflicts

```typescript
export class ConflictResolver {
  constructor(
    private repoRoot: string,
    private config: ParallelConfig,
    private eventEmitter: EventEmitter
  ) {}

  /**
   * Attempt to auto-resolve a non-overlapping conflict.
   * Applies both change sets to the base independently.
   */
  async autoResolve(
    classification: ClassificationResult,
    requestId: string
  ): Promise<ConflictResolutionResult | null> {
    if (classification.conflictType !== ConflictType.NonOverlapping) {
      return null; // cannot auto-resolve overlapping conflicts
    }

    const { baseContent, oursContent, theirsContent, file } = classification;

    // Apply ours-changes to base, then apply theirs-changes to the result
    // Since hunks don't overlap, order doesn't matter
    const baseLines = baseContent.split('\n');
    const oursLines = oursContent.split('\n');
    const theirsLines = theirsContent.split('\n');

    // Use a 3-way merge algorithm:
    // For each line range in base:
    //   - If unchanged in both: keep base
    //   - If changed in ours only: take ours
    //   - If changed in theirs only: take theirs
    //   - If changed in both (should not happen for non-overlapping): fail
    const merged = threeWayMerge(baseLines, oursLines, theirsLines);

    if (!merged.success) {
      return null; // unexpected overlap detected during merge
    }

    const resolvedContent = merged.result.join('\n');

    // Stage the resolved file
    const filePath = path.join(this.repoRoot, file);
    await fs.writeFile(filePath, resolvedContent, 'utf-8');
    execSync(`git -C "${this.repoRoot}" add "${file}"`);

    this.eventEmitter.emit('merge.conflict_resolved', {
      type: 'merge.conflict_resolved',
      requestId,
      file,
      strategy: 'auto',
      confidence: 0.95,
      timestamp: new Date().toISOString(),
    });

    return {
      resolvedContent,
      confidence: 0.95,
      reasoning: 'Non-overlapping hunks: both change sets applied independently to base',
      strategy: 'auto',
    };
  }
}
```

### 3. AI conflict resolution agent

```typescript
  /**
   * Spawn a specialized conflict resolution subagent.
   * Provides base/ours/theirs and both specs; expects resolved content + confidence.
   */
  async aiResolve(
    request: ConflictResolutionRequest
  ): Promise<ConflictResolutionResult> {
    this.eventEmitter.emit('merge.conflict_detected', {
      type: 'merge.conflict_detected',
      requestId: request.requestId,
      file: request.file,
      trackA: request.trackA,
      trackB: request.trackB,
      timestamp: new Date().toISOString(),
    });

    const prompt = this.buildConflictResolutionPrompt(request);

    // Spawn a subagent with bounded turn budget (10 turns max)
    const resolution = await this.spawnConflictAgent(prompt, 10);

    // Parse the response
    const result: ConflictResolutionResult = {
      resolvedContent: resolution.content,
      confidence: resolution.confidence,
      reasoning: resolution.reasoning,
      strategy: 'ai',
    };

    // Enforce confidence threshold
    if (result.confidence >= this.config.conflict_ai_confidence_threshold) {
      // Accept resolution: write file and stage
      const filePath = path.join(this.repoRoot, request.file);
      await fs.writeFile(filePath, result.resolvedContent, 'utf-8');
      execSync(`git -C "${this.repoRoot}" add "${request.file}"`);

      this.eventEmitter.emit('merge.conflict_resolved', {
        type: 'merge.conflict_resolved',
        requestId: request.requestId,
        file: request.file,
        strategy: 'ai',
        confidence: result.confidence,
        timestamp: new Date().toISOString(),
      });

      return result;
    }

    // Below threshold: escalate to human
    throw new ConflictResolutionBelowThresholdError(
      request.file,
      result.confidence,
      this.config.conflict_ai_confidence_threshold,
      result
    );
  }

  private buildConflictResolutionPrompt(request: ConflictResolutionRequest): string {
    return `You are a merge conflict resolution specialist.

## Conflict in file: ${request.file}

### Base version (common ancestor):
\`\`\`
${request.baseContent}
\`\`\`

### "Ours" version (integration branch, ${request.trackA}):
\`\`\`
${request.oursContent}
\`\`\`

### "Theirs" version (track branch, ${request.trackB}):
\`\`\`
${request.theirsContent}
\`\`\`

### Spec for ${request.trackA}:
${request.specA}

### Spec for ${request.trackB}:
${request.specB}

### Interface contracts:
${request.interfaceContracts.map(c => `- ${c.producer} -> ${c.consumer}: ${c.contractType}`).join('\n')}

## Instructions
1. Merge both sets of changes into a coherent result that satisfies BOTH specs.
2. Resolve any contradictions in favor of maintaining type safety and interface contracts.
3. Return your response in this exact format:

RESOLVED_CONTENT:
<the merged file content>

CONFIDENCE: <0.0-1.0>
REASONING: <explanation of merge decisions>`;
  }
```

## Acceptance Criteria

1. `classifyConflict` extracts base (stage 1), ours (stage 2), theirs (stage 3) via `git show :N:<file>`.
2. Missing stages (file add/delete) classified as `structural`.
3. Non-overlapping hunks correctly identified when changes are in different line ranges.
4. Overlapping compatible: both sides made the same change in the same region.
5. Overlapping conflicting: both sides made different changes in the same region.
6. Classification is deterministic for the same input.
7. `autoResolve` succeeds for non-overlapping conflicts, writing the merged file and staging it.
8. `autoResolve` returns confidence 0.95 on success.
9. `autoResolve` returns null for non-non-overlapping conflict types.
10. `aiResolve` spawns a subagent with base/ours/theirs, both specs, and interface contracts.
11. `aiResolve` accepts resolution when confidence >= threshold (0.85).
12. `aiResolve` throws `ConflictResolutionBelowThresholdError` when confidence < threshold.
13. AI conflict agent has a bounded turn budget of 10.
14. Events `merge.conflict_detected` and `merge.conflict_resolved` emitted correctly.
15. Resolution is recorded with strategy and confidence for auditing.

## Test Cases

```
// conflict-classifier.test.ts

describe('ConflictClassifier', () => {
  // Setup: real git repo with merge conflict scenarios

  describe('non-overlapping conflict', () => {
    beforeEach(() => {
      // Base: file with functions foo() on line 1-5 and bar() on line 10-15
      // Ours: modifies foo() (lines 1-5)
      // Theirs: modifies bar() (lines 10-15)
      // Git reports conflict because of context overlap
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
  });

  describe('overlapping conflicting', () => {
    beforeEach(() => {
      // Base: function returns "hello"
      // Ours: function returns "hello world"
      // Theirs: function returns "hello universe"
    });

    it('classifies as overlapping-conflicting', async () => {
      const result = await classifier.classifyConflict('src/greeting.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.OverlappingConflicting);
    });
  });

  describe('overlapping compatible', () => {
    beforeEach(() => {
      // Base: function returns "hello"
      // Ours: function returns "hello world"
      // Theirs: function returns "hello world" (same change)
    });

    it('classifies as overlapping-compatible', async () => {
      const result = await classifier.classifyConflict('src/greeting.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.OverlappingCompatible);
    });
  });

  describe('structural conflict', () => {
    beforeEach(() => {
      // Base: file exists
      // Ours: file deleted
      // Theirs: file modified
    });

    it('classifies as structural when stage missing', async () => {
      const result = await classifier.classifyConflict('src/removed.ts', 'req-001');
      expect(result.conflictType).toBe(ConflictType.Structural);
    });
  });

  it('is deterministic', async () => {
    const r1 = await classifier.classifyConflict('src/service.ts', 'req-001');
    const r2 = await classifier.classifyConflict('src/service.ts', 'req-001');
    expect(r1.conflictType).toBe(r2.conflictType);
    expect(r1.confidence).toBe(r2.confidence);
  });
});

// conflict-resolver.test.ts

describe('ConflictResolver.autoResolve', () => {
  it('resolves non-overlapping conflict', async () => {
    const classification = {
      file: 'src/service.ts',
      conflictType: ConflictType.NonOverlapping,
      confidence: 0.95,
      baseContent: 'line1\nline2\nline3\nline4\nline5',
      oursContent: 'MODIFIED1\nline2\nline3\nline4\nline5',
      theirsContent: 'line1\nline2\nline3\nline4\nMODIFIED5',
      hunks: [],
    };

    const result = await resolver.autoResolve(classification, 'req-001');
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

  it('returns null for overlapping conflicts', async () => {
    const classification = { ...nonOverlappingClassification, conflictType: ConflictType.OverlappingConflicting };
    const result = await resolver.autoResolve(classification, 'req-001');
    expect(result).toBeNull();
  });

  it('emits merge.conflict_resolved event', async () => {
    const events: any[] = [];
    emitter.on('merge.conflict_resolved', e => events.push(e));
    await resolver.autoResolve(nonOverlappingClassification, 'req-001');
    expect(events[0].strategy).toBe('auto');
  });
});

describe('ConflictResolver.aiResolve', () => {
  it('accepts resolution above confidence threshold', async () => {
    // Mock conflict agent to return confidence 0.9
    mockSubagent.resolve = () => ({ content: 'merged', confidence: 0.9, reasoning: 'ok' });
    const result = await resolver.aiResolve(conflictRequest);
    expect(result.strategy).toBe('ai');
    expect(result.confidence).toBe(0.9);
  });

  it('rejects resolution below confidence threshold', async () => {
    // Mock agent returns confidence 0.5
    mockSubagent.resolve = () => ({ content: 'merged', confidence: 0.5, reasoning: 'unsure' });
    await expect(resolver.aiResolve(conflictRequest)).rejects.toThrow(ConflictResolutionBelowThresholdError);
  });

  it('provides base/ours/theirs and both specs to agent', async () => {
    let capturedPrompt = '';
    mockSubagent.resolve = (prompt) => { capturedPrompt = prompt; return mockResult; };
    await resolver.aiResolve(conflictRequest);
    expect(capturedPrompt).toContain('Base version');
    expect(capturedPrompt).toContain('Ours');
    expect(capturedPrompt).toContain('Theirs');
    expect(capturedPrompt).toContain(conflictRequest.specA);
    expect(capturedPrompt).toContain(conflictRequest.specB);
  });

  it('emits merge.conflict_detected and merge.conflict_resolved', async () => {
    const events: any[] = [];
    emitter.on('merge.conflict_detected', e => events.push(e));
    emitter.on('merge.conflict_resolved', e => events.push(e));
    mockSubagent.resolve = () => ({ content: 'merged', confidence: 0.9, reasoning: 'ok' });
    await resolver.aiResolve(conflictRequest);
    expect(events[0].type).toBe('merge.conflict_detected');
    expect(events[1].type).toBe('merge.conflict_resolved');
  });
});
```
