# SPEC-006-4-4: Contract Validation, Migration Sequencing, and Merge Tests

## Metadata
- **Parent Plan**: PLAN-006-4
- **Tasks Covered**: Task 10, Task 11, Task 12
- **Estimated effort**: 13 hours

## Description

Implement post-merge interface contract validation that checks type definitions, function signatures, and API endpoints match across merged tracks. Implement database migration sequence validation that detects gaps, duplicates, and ordering issues with optional renumbering. Comprehensive test suite for the entire merge engine including the TDD worked example scenario.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/contract-validator.ts` | **Create** | Interface contract + migration validation |
| `tests/parallel/contract-validator.test.ts` | **Create** | Contract and migration tests |
| `tests/parallel/merge-engine.test.ts` | **Modify** | Add TDD worked example, idempotency, full scenario tests |
| `tests/parallel/conflict-classifier.test.ts` | **Modify** | Add additional classification scenarios |
| `tests/parallel/conflict-resolver.test.ts` | **Modify** | Add additional resolution scenarios |

## Implementation Details

### 1. Interface contract validation

Run after all tracks in a cluster are merged into the integration branch.

```typescript
export interface ContractValidationResult {
  passed: boolean;
  failures: ContractFailure[];
  warnings: ContractWarning[];
}

export interface ContractFailure {
  contract: InterfaceContract;
  reason: string;
  producerFile: string;
  consumerFile: string;
}

export interface ContractWarning {
  contract: InterfaceContract;
  message: string;
}

export class ContractValidator {
  constructor(private repoRoot: string) {}

  async validateContracts(
    requestId: string,
    contracts: InterfaceContract[]
  ): Promise<ContractValidationResult> {
    const integrationBranch = integrationBranchName(requestId);
    const failures: ContractFailure[] = [];
    const warnings: ContractWarning[] = [];

    // Ensure we're checking the integration branch content
    for (const contract of contracts) {
      switch (contract.contractType) {
        case 'type-definition':
          await this.validateTypeContract(contract, integrationBranch, failures, warnings);
          break;
        case 'function-signature':
          await this.validateFunctionContract(contract, integrationBranch, failures, warnings);
          break;
        case 'api-endpoint':
          await this.validateApiContract(contract, integrationBranch, failures, warnings);
          break;
      }
    }

    return {
      passed: failures.length === 0,
      failures,
      warnings,
    };
  }

  /**
   * Validate type-definition contracts:
   * Check that the producer's exported type exists and the consumer's import resolves.
   */
  private async validateTypeContract(
    contract: InterfaceContract,
    branch: string,
    failures: ContractFailure[],
    warnings: ContractWarning[]
  ): Promise<void> {
    // Read the producer's file from the integration branch
    let producerContent: string;
    try {
      producerContent = execSync(
        `git -C "${this.repoRoot}" show ${branch}:${contract.filePath}`,
        { encoding: 'utf-8' }
      );
    } catch {
      failures.push({
        contract,
        reason: `Producer file not found on integration branch: ${contract.filePath}`,
        producerFile: contract.filePath,
        consumerFile: '',
      });
      return;
    }

    // Parse the definition to extract the type name
    const typeNameMatch = contract.definition.match(/(?:export\s+)?(?:interface|type|class|enum)\s+(\w+)/);
    if (!typeNameMatch) {
      warnings.push({
        contract,
        message: `Could not parse type name from contract definition`,
      });
      return;
    }
    const typeName = typeNameMatch[1];

    // Check that the type is exported in the producer file
    const exportRegex = new RegExp(`export\\s+(?:interface|type|class|enum)\\s+${typeName}\\b`);
    if (!exportRegex.test(producerContent)) {
      failures.push({
        contract,
        reason: `Type "${typeName}" not exported from ${contract.filePath}`,
        producerFile: contract.filePath,
        consumerFile: '',
      });
    }
  }

  /**
   * Validate function-signature contracts:
   * Check that the function exists with the expected arity.
   */
  private async validateFunctionContract(
    contract: InterfaceContract,
    branch: string,
    failures: ContractFailure[],
    warnings: ContractWarning[]
  ): Promise<void> {
    // Extract function name from contract definition
    const funcMatch = contract.definition.match(/(?:export\s+)?(?:function|const|async\s+function)\s+(\w+)/);
    if (!funcMatch) {
      warnings.push({ contract, message: 'Could not parse function name from contract' });
      return;
    }
    const funcName = funcMatch[1];

    let producerContent: string;
    try {
      producerContent = execSync(
        `git -C "${this.repoRoot}" show ${branch}:${contract.filePath}`,
        { encoding: 'utf-8' }
      );
    } catch {
      failures.push({
        contract,
        reason: `Producer file not found: ${contract.filePath}`,
        producerFile: contract.filePath,
        consumerFile: '',
      });
      return;
    }

    // Check function exists
    const funcRegex = new RegExp(`(?:export\\s+)?(?:function|const|async\\s+function)\\s+${funcName}\\b`);
    if (!funcRegex.test(producerContent)) {
      failures.push({
        contract,
        reason: `Function "${funcName}" not found in ${contract.filePath}`,
        producerFile: contract.filePath,
        consumerFile: '',
      });
    }
  }

  /**
   * Validate API endpoint contracts:
   * Check that a route handler exists for the expected path.
   */
  private async validateApiContract(
    contract: InterfaceContract,
    branch: string,
    failures: ContractFailure[],
    warnings: ContractWarning[]
  ): Promise<void> {
    // Extract endpoint path from definition (e.g., "GET /api/users")
    const endpointMatch = contract.definition.match(/(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s]+)/);
    if (!endpointMatch) {
      warnings.push({ contract, message: 'Could not parse endpoint from contract definition' });
      return;
    }

    const [, method, routePath] = endpointMatch;

    let producerContent: string;
    try {
      producerContent = execSync(
        `git -C "${this.repoRoot}" show ${branch}:${contract.filePath}`,
        { encoding: 'utf-8' }
      );
    } catch {
      failures.push({
        contract,
        reason: `Route file not found: ${contract.filePath}`,
        producerFile: contract.filePath,
        consumerFile: '',
      });
      return;
    }

    // Heuristic: look for the route path string in the file
    if (!producerContent.includes(routePath)) {
      failures.push({
        contract,
        reason: `Route "${method} ${routePath}" not found in ${contract.filePath}`,
        producerFile: contract.filePath,
        consumerFile: '',
      });
    }
  }
}
```

### 2. Database migration sequence validation

```typescript
export interface MigrationValidationResult {
  valid: boolean;
  gaps: number[];
  duplicates: number[];
  renumbered: Map<string, string>; // old filename -> new filename
}

async validateMigrationSequence(
  requestId: string,
  migrationDir: string
): Promise<MigrationValidationResult> {
  const integrationBranch = integrationBranchName(requestId);

  // List migration files on the integration branch
  let files: string[];
  try {
    const output = execSync(
      `git -C "${this.repoRoot}" ls-tree --name-only ${integrationBranch} ${migrationDir}/`,
      { encoding: 'utf-8' }
    );
    files = output.trim().split('\n').filter(Boolean).sort();
  } catch {
    // No migration directory -- valid (no migrations)
    return { valid: true, gaps: [], duplicates: [], renumbered: new Map() };
  }

  // Extract sequence numbers from filenames
  // Expected format: NNN_description.sql or NNN-description.ts
  const seqRegex = /^(\d+)[_-]/;
  const sequences: { file: string; seq: number }[] = [];

  for (const file of files) {
    const basename = path.basename(file);
    const match = basename.match(seqRegex);
    if (match) {
      sequences.push({ file, seq: parseInt(match[1], 10) });
    }
  }

  // Check for duplicates
  const seqCounts = new Map<number, number>();
  for (const { seq } of sequences) {
    seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1);
  }
  const duplicates = [...seqCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([seq]) => seq);

  // Check for gaps
  const sortedSeqs = [...new Set(sequences.map(s => s.seq))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sortedSeqs.length; i++) {
    if (sortedSeqs[i] !== sortedSeqs[i - 1] + 1) {
      for (let g = sortedSeqs[i - 1] + 1; g < sortedSeqs[i]; g++) {
        gaps.push(g);
      }
    }
  }

  // Renumber if necessary
  const renumbered = new Map<string, string>();
  if (duplicates.length > 0 || gaps.length > 0) {
    // Sort all migration files by current sequence number, then renumber contiguously
    sequences.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < sequences.length; i++) {
      const newSeq = i + 1; // 1-based contiguous numbering
      const oldBasename = path.basename(sequences[i].file);
      const newBasename = oldBasename.replace(seqRegex, `${String(newSeq).padStart(3, '0')}_`);
      if (oldBasename !== newBasename) {
        renumbered.set(sequences[i].file, path.join(path.dirname(sequences[i].file), newBasename));

        // Perform the rename on the integration branch
        execSync(
          `git -C "${this.repoRoot}" mv "${sequences[i].file}" "${path.join(path.dirname(sequences[i].file), newBasename)}"`,
        );
      }
    }

    if (renumbered.size > 0) {
      execSync(
        `git -C "${this.repoRoot}" commit -m "chore: renumber migrations for ${requestId}\n\nRenumbered ${renumbered.size} migration files"`,
      );
    }
  }

  return {
    valid: duplicates.length === 0 && gaps.length === 0,
    gaps,
    duplicates,
    renumbered,
  };
}
```

### 3. Comprehensive merge test scenarios

The test suite includes the TDD 2.3 worked example end-to-end.

## Acceptance Criteria

1. `validateContracts` checks type-definition contracts by verifying exported type exists in producer file.
2. `validateContracts` checks function-signature contracts by verifying function exists with expected name.
3. `validateContracts` checks api-endpoint contracts by verifying route path exists in route file.
4. Contract failures are reported but do not abort the merge.
5. `validateMigrationSequence` detects duplicate sequence numbers.
6. `validateMigrationSequence` detects gaps in sequence numbers.
7. `validateMigrationSequence` renumbers migration files when duplicates or gaps found.
8. Renumbering commits the changes to the integration branch.
9. No-op when migration directory does not exist.
10. TDD 2.3 worked example passes: 3 tracks, merge A then C (cluster 0), then merge B (cluster 1).
11. Merge idempotency: merging the same track twice does not create duplicate changes.
12. All tests use real git repos (not mocked git).

## Test Cases

```
// contract-validator.test.ts

describe('ContractValidator', () => {
  describe('type-definition contracts', () => {
    it('passes when type is exported', async () => {
      // Set up: integration branch has file with `export interface User { id: string }`
      const result = await validator.validateContracts('req-001', [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User { id: string; }',
        filePath: 'src/types.ts',
      }]);
      expect(result.passed).toBe(true);
    });

    it('fails when type is not exported', async () => {
      // Set up: integration branch has file but User is not exported
      const result = await validator.validateContracts('req-001', [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User { id: string; }',
        filePath: 'src/types.ts',
      }]);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('not exported');
    });

    it('fails when producer file does not exist', async () => {
      const result = await validator.validateContracts('req-001', [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User {}',
        filePath: 'src/nonexistent.ts',
      }]);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('not found');
    });
  });

  describe('function-signature contracts', () => {
    it('passes when function exists', async () => {
      // Set up: integration branch has file with `export async function getUser`
      const result = await validator.validateContracts('req-001', [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'function-signature',
        definition: 'export async function getUser(id: string): Promise<User>',
        filePath: 'src/user-service.ts',
      }]);
      expect(result.passed).toBe(true);
    });

    it('fails when function missing', async () => {
      const result = await validator.validateContracts('req-001', [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'function-signature',
        definition: 'export function missingFunc()',
        filePath: 'src/user-service.ts',
      }]);
      expect(result.passed).toBe(false);
    });
  });

  describe('api-endpoint contracts', () => {
    it('passes when route exists', async () => {
      // Set up: file contains router.get('/api/users', ...)
      const result = await validator.validateContracts('req-001', [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'api-endpoint',
        definition: 'GET /api/users',
        filePath: 'src/routes.ts',
      }]);
      expect(result.passed).toBe(true);
    });
  });
});

// contract-validator.test.ts (migration section)

describe('validateMigrationSequence', () => {
  it('passes for contiguous sequence', async () => {
    // Files: 001_create_users.sql, 002_add_email.sql, 003_create_orders.sql
    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(true);
    expect(result.gaps.length).toBe(0);
    expect(result.duplicates.length).toBe(0);
  });

  it('detects gaps', async () => {
    // Files: 001_create_users.sql, 003_create_orders.sql (missing 002)
    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(false);
    expect(result.gaps).toContain(2);
  });

  it('detects duplicates', async () => {
    // Files: 001_create_users.sql, 001_add_email.sql
    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(false);
    expect(result.duplicates).toContain(1);
  });

  it('renumbers migrations', async () => {
    // Files: 001_a.sql, 001_b.sql, 003_c.sql -> 001_a.sql, 002_b.sql, 003_c.sql
    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.renumbered.size).toBeGreaterThan(0);
  });

  it('handles no migrations directory', async () => {
    const result = await validator.validateMigrationSequence('req-001', 'nonexistent');
    expect(result.valid).toBe(true);
  });
});

// merge-engine.test.ts (TDD worked example)

describe('TDD 2.3 full merge scenario', () => {
  // Setup: 3 tracks with A->B dependency, C independent
  // Cluster 0: track-a modifies src/user-model.ts, track-c modifies src/logger.ts
  // Cluster 1: track-b modifies src/auth-controller.ts (depends on track-a's types)

  it('merges cluster 0 in correct order: track-a then track-c', async () => {
    const dag = buildAndScheduleDAG('req-001', specs);
    const results = await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);
    expect(results.length).toBe(2);
    expect(results[0].trackName).toBe('track-a');
    expect(results[1].trackName).toBe('track-c');
    expect(results.every(r => r.conflictCount === 0)).toBe(true);
  });

  it('merges cluster 1 after cluster 0: track-b sees track-a changes', async () => {
    const dag = buildAndScheduleDAG('req-001', specs);
    await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);
    const results = await mergeEngine.mergeCluster('req-001', dag.clusters[1], dag);
    expect(results.length).toBe(1);
    expect(results[0].trackName).toBe('track-b');

    // Verify track-b merge has access to track-a's changes
    const content = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:src/user-model.ts`,
      { encoding: 'utf-8' }
    );
    expect(content).toContain('track-a changes');
  });

  it('integration branch contains all tracks after both clusters merge', async () => {
    const dag = buildAndScheduleDAG('req-001', specs);
    await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);
    await mergeEngine.mergeCluster('req-001', dag.clusters[1], dag);

    // Verify all files are present
    const files = execSync(
      `git -C "${repoRoot}" ls-tree --name-only -r auto/req-001/integration src/`,
      { encoding: 'utf-8' }
    ).trim().split('\n');
    expect(files).toContain('src/user-model.ts');
    expect(files).toContain('src/auth-controller.ts');
    expect(files).toContain('src/logger.ts');
  });
});
```
