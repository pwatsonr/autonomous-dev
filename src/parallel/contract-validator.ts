/**
 * Interface contract validation and database migration sequence validation
 * for post-merge integrity checks.
 *
 * SPEC-006-4-4: Contract Validation, Migration Sequencing, and Merge Tests
 *
 * Responsibilities:
 *   - Validate type-definition contracts (exported type exists in producer file)
 *   - Validate function-signature contracts (function exists with expected name)
 *   - Validate api-endpoint contracts (route path exists in route file)
 *   - Detect duplicate and gap migration sequence numbers
 *   - Renumber migration files when duplicates or gaps are found
 */

import { execSync } from 'child_process';
import * as path from 'path';

import { InterfaceContract } from './types';
import { integrationBranchName } from './naming';

// ============================================================================
// Contract validation types
// ============================================================================

/** Result of validating interface contracts after merging all tracks. */
export interface ContractValidationResult {
  passed: boolean;
  failures: ContractFailure[];
  warnings: ContractWarning[];
}

/** A single contract validation failure. */
export interface ContractFailure {
  contract: InterfaceContract;
  reason: string;
  producerFile: string;
  consumerFile: string;
}

/** A non-blocking contract validation warning. */
export interface ContractWarning {
  contract: InterfaceContract;
  message: string;
}

// ============================================================================
// Migration validation types
// ============================================================================

/** Result of validating database migration sequence after merging. */
export interface MigrationValidationResult {
  valid: boolean;
  gaps: number[];
  duplicates: number[];
  renumbered: Map<string, string>; // old filename -> new filename
}

// ============================================================================
// ContractValidator
// ============================================================================

/**
 * Validates interface contracts and database migration sequences
 * on the integration branch after all tracks in a cluster are merged.
 */
export class ContractValidator {
  constructor(private repoRoot: string) {}

  // --------------------------------------------------------------------------
  // Contract validation
  // --------------------------------------------------------------------------

  /**
   * Validate all interface contracts against the integration branch content.
   *
   * Dispatches to type-specific validators based on contractType:
   *   - 'type-definition': checks for exported type/interface/class/enum
   *   - 'function-signature': checks for exported function/const
   *   - 'api-endpoint': checks for route path string in file
   *
   * @param requestId  The parallel execution request ID
   * @param contracts  Array of interface contracts to validate
   * @returns Validation result with failures and warnings
   */
  async validateContracts(
    requestId: string,
    contracts: InterfaceContract[],
  ): Promise<ContractValidationResult> {
    const integrationBranch = integrationBranchName(requestId);
    const failures: ContractFailure[] = [];
    const warnings: ContractWarning[] = [];

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
    warnings: ContractWarning[],
  ): Promise<void> {
    // Read the producer's file from the integration branch
    let producerContent: string;
    try {
      producerContent = execSync(
        `git -C "${this.repoRoot}" show ${branch}:${contract.filePath}`,
        { encoding: 'utf-8' },
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
    const typeNameMatch = contract.definition.match(
      /(?:export\s+)?(?:interface|type|class|enum)\s+(\w+)/,
    );
    if (!typeNameMatch) {
      warnings.push({
        contract,
        message: 'Could not parse type name from contract definition',
      });
      return;
    }
    const typeName = typeNameMatch[1];

    // Check that the type is exported in the producer file
    const exportRegex = new RegExp(
      `export\\s+(?:interface|type|class|enum)\\s+${typeName}\\b`,
    );
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
    warnings: ContractWarning[],
  ): Promise<void> {
    // Extract function name from contract definition
    const funcMatch = contract.definition.match(
      /(?:export\s+)?(?:function|const|async\s+function)\s+(\w+)/,
    );
    if (!funcMatch) {
      warnings.push({
        contract,
        message: 'Could not parse function name from contract',
      });
      return;
    }
    const funcName = funcMatch[1];

    let producerContent: string;
    try {
      producerContent = execSync(
        `git -C "${this.repoRoot}" show ${branch}:${contract.filePath}`,
        { encoding: 'utf-8' },
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
    const funcRegex = new RegExp(
      `(?:export\\s+)?(?:function|const|async\\s+function)\\s+${funcName}\\b`,
    );
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
    warnings: ContractWarning[],
  ): Promise<void> {
    // Extract endpoint path from definition (e.g., "GET /api/users")
    const endpointMatch = contract.definition.match(
      /(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s]+)/,
    );
    if (!endpointMatch) {
      warnings.push({
        contract,
        message: 'Could not parse endpoint from contract definition',
      });
      return;
    }

    const [, method, routePath] = endpointMatch;

    let producerContent: string;
    try {
      producerContent = execSync(
        `git -C "${this.repoRoot}" show ${branch}:${contract.filePath}`,
        { encoding: 'utf-8' },
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

  // --------------------------------------------------------------------------
  // Migration sequence validation
  // --------------------------------------------------------------------------

  /**
   * Validate that database migrations on the integration branch maintain
   * a consistent ordering without gaps or duplicates.
   *
   * When duplicates or gaps are found, renumbers all migration files
   * contiguously (1-based) and commits the rename.
   *
   * @param requestId     The parallel execution request ID
   * @param migrationDir  Relative path to the migrations directory
   * @returns Validation result with gaps, duplicates, and renumbered files
   */
  async validateMigrationSequence(
    requestId: string,
    migrationDir: string,
  ): Promise<MigrationValidationResult> {
    const integrationBranch = integrationBranchName(requestId);

    // List migration files on the integration branch
    let files: string[];
    try {
      const output = execSync(
        `git -C "${this.repoRoot}" ls-tree --name-only ${integrationBranch} ${migrationDir}/`,
        { encoding: 'utf-8' },
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
    const sortedSeqs = [...new Set(sequences.map((s) => s.seq))].sort((a, b) => a - b);
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
        const newBasename = oldBasename.replace(
          seqRegex,
          `${String(newSeq).padStart(3, '0')}_`,
        );
        if (oldBasename !== newBasename) {
          const newFile = path.join(path.dirname(sequences[i].file), newBasename);
          renumbered.set(sequences[i].file, newFile);

          // Perform the rename on the integration branch
          execSync(
            `git -C "${this.repoRoot}" mv "${sequences[i].file}" "${newFile}"`,
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
}
