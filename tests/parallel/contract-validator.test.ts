/**
 * Tests for ContractValidator (SPEC-006-4-4 Tasks 10-11).
 *
 * Verifies:
 *   - type-definition contract validation (exported type exists in producer file)
 *   - function-signature contract validation (function exists with expected name)
 *   - api-endpoint contract validation (route path exists in route file)
 *   - Contract failures reported but do not abort the merge
 *   - Migration sequence validation: duplicates, gaps, renumbering
 *   - No-op when migration directory does not exist
 *
 * All tests use real git repos (not mocked git).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ContractValidator,
  ContractValidationResult,
  MigrationValidationResult,
} from '../../src/parallel/contract-validator';
import { InterfaceContract } from '../../src/parallel/types';

// ============================================================================
// Helpers
// ============================================================================

/** Run a git command inside a repo. */
function git(repoRoot: string, args: string): string {
  return execSync(`git -C "${repoRoot}" ${args}`, { encoding: 'utf-8' }).trim();
}

/**
 * Create a temp git repo with an initial commit on main,
 * plus an integration branch at auto/req-001/integration.
 */
function createTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-validator-test-'));
  git(dir, 'init -b main');
  git(dir, 'config user.email "test@test.com"');
  git(dir, 'config user.name "Test"');

  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  git(dir, 'add .');
  git(dir, 'commit -m "initial"');

  // Create integration branch
  git(dir, 'checkout -b auto/req-001/integration');

  return dir;
}

function cleanupRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Add files to the integration branch and commit.
 */
function addFilesToIntegration(
  repoRoot: string,
  files: Record<string, string>,
): void {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    git(repoRoot, `add "${filePath}"`);
  }
  git(repoRoot, 'commit -m "add files to integration"');
}

// ============================================================================
// ContractValidator — type-definition contracts
// ============================================================================

describe('ContractValidator', () => {
  let repoRoot: string;
  let validator: ContractValidator;

  afterEach(() => {
    if (repoRoot) cleanupRepo(repoRoot);
  });

  describe('type-definition contracts', () => {
    beforeEach(() => {
      repoRoot = createTestRepo();
      addFilesToIntegration(repoRoot, {
        'src/types.ts': [
          'export interface User { id: string; name: string; }',
          '',
          'export type UserId = string;',
          '',
          'interface InternalType { secret: boolean; }',
          '',
          'export class UserModel { id: string = ""; }',
          '',
          'export enum UserRole { Admin = "admin", User = "user" }',
        ].join('\n'),
      });
      validator = new ContractValidator(repoRoot);
    });

    it('passes when type is exported', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface User { id: string; }',
          filePath: 'src/types.ts',
        },
      ]);
      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('passes for exported type alias', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export type UserId = string',
          filePath: 'src/types.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('passes for exported class', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export class UserModel',
          filePath: 'src/types.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('passes for exported enum', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export enum UserRole',
          filePath: 'src/types.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('fails when type is not exported', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface InternalType { secret: boolean; }',
          filePath: 'src/types.ts',
        },
      ]);
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].reason).toContain('not exported');
    });

    it('fails when producer file does not exist', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface User {}',
          filePath: 'src/nonexistent.ts',
        },
      ]);
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].reason).toContain('not found');
    });

    it('warns when definition cannot be parsed', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'some unparseable content',
          filePath: 'src/types.ts',
        },
      ]);
      expect(result.passed).toBe(true); // warnings don't cause failure
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain('Could not parse');
    });
  });

  // --------------------------------------------------------------------------
  // function-signature contracts
  // --------------------------------------------------------------------------

  describe('function-signature contracts', () => {
    beforeEach(() => {
      repoRoot = createTestRepo();
      addFilesToIntegration(repoRoot, {
        'src/user-service.ts': [
          'export async function getUser(id: string): Promise<User> {',
          '  return { id, name: "test" };',
          '}',
          '',
          'export function deleteUser(id: string): void {',
          '  // delete logic',
          '}',
          '',
          'export const createUser = async (name: string): Promise<User> => {',
          '  return { id: "1", name };',
          '};',
          '',
          'function internalHelper(): void {}',
        ].join('\n'),
      });
      validator = new ContractValidator(repoRoot);
    });

    it('passes when async function exists', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'export async function getUser(id: string): Promise<User>',
          filePath: 'src/user-service.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('passes when regular function exists', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'export function deleteUser(id: string): void',
          filePath: 'src/user-service.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('passes when const function exists', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'export const createUser',
          filePath: 'src/user-service.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('fails when function missing', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'export function missingFunc()',
          filePath: 'src/user-service.ts',
        },
      ]);
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].reason).toContain('not found');
    });

    it('fails when producer file does not exist', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'export function getUser()',
          filePath: 'src/nonexistent.ts',
        },
      ]);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('not found');
    });

    it('warns when definition cannot be parsed', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'unparseable garbage',
          filePath: 'src/user-service.ts',
        },
      ]);
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain('Could not parse');
    });
  });

  // --------------------------------------------------------------------------
  // api-endpoint contracts
  // --------------------------------------------------------------------------

  describe('api-endpoint contracts', () => {
    beforeEach(() => {
      repoRoot = createTestRepo();
      addFilesToIntegration(repoRoot, {
        'src/routes.ts': [
          "import { Router } from 'express';",
          '',
          'const router = Router();',
          '',
          "router.get('/api/users', (req, res) => {",
          '  res.json([]);',
          '});',
          '',
          "router.post('/api/users', (req, res) => {",
          '  res.status(201).json({});',
          '});',
          '',
          "router.delete('/api/users/:id', (req, res) => {",
          '  res.status(204).send();',
          '});',
          '',
          'export default router;',
        ].join('\n'),
      });
      validator = new ContractValidator(repoRoot);
    });

    it('passes when GET route exists', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'api-endpoint',
          definition: 'GET /api/users',
          filePath: 'src/routes.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('passes when POST route exists', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'api-endpoint',
          definition: 'POST /api/users',
          filePath: 'src/routes.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('passes when DELETE route with param exists', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'api-endpoint',
          definition: 'DELETE /api/users/:id',
          filePath: 'src/routes.ts',
        },
      ]);
      expect(result.passed).toBe(true);
    });

    it('fails when route does not exist', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'api-endpoint',
          definition: 'PUT /api/orders',
          filePath: 'src/routes.ts',
        },
      ]);
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].reason).toContain('not found');
    });

    it('fails when route file does not exist', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'api-endpoint',
          definition: 'GET /api/users',
          filePath: 'src/nonexistent-routes.ts',
        },
      ]);
      expect(result.passed).toBe(false);
      expect(result.failures[0].reason).toContain('not found');
    });

    it('warns when endpoint definition cannot be parsed', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'api-endpoint',
          definition: 'not a valid endpoint',
          filePath: 'src/routes.ts',
        },
      ]);
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toContain('Could not parse');
    });
  });

  // --------------------------------------------------------------------------
  // Mixed contract scenarios
  // --------------------------------------------------------------------------

  describe('mixed contract validation', () => {
    beforeEach(() => {
      repoRoot = createTestRepo();
      addFilesToIntegration(repoRoot, {
        'src/types.ts': 'export interface User { id: string; }\n',
        'src/service.ts': 'export async function getUser(id: string) { return null; }\n',
        'src/routes.ts': "router.get('/api/users', handler);\n",
      });
      validator = new ContractValidator(repoRoot);
    });

    it('all pass when all contracts are satisfied', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface User { id: string; }',
          filePath: 'src/types.ts',
        },
        {
          producer: 'track-a',
          consumer: 'track-c',
          contractType: 'function-signature',
          definition: 'export async function getUser(id: string)',
          filePath: 'src/service.ts',
        },
        {
          producer: 'track-b',
          consumer: 'track-c',
          contractType: 'api-endpoint',
          definition: 'GET /api/users',
          filePath: 'src/routes.ts',
        },
      ]);
      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('reports multiple failures without aborting', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface User { id: string; }',
          filePath: 'src/types.ts',
        },
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface Missing {}',
          filePath: 'src/types.ts',
        },
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'function-signature',
          definition: 'export function nonexistent()',
          filePath: 'src/service.ts',
        },
      ]);
      expect(result.passed).toBe(false);
      // Two failures: Missing type not found, nonexistent function not found
      expect(result.failures).toHaveLength(2);
    });

    it('failures do not prevent other contracts from being checked', async () => {
      const result = await validator.validateContracts('req-001', [
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface Missing {}',
          filePath: 'src/nonexistent.ts',
        },
        {
          producer: 'track-a',
          consumer: 'track-b',
          contractType: 'type-definition',
          definition: 'export interface User { id: string; }',
          filePath: 'src/types.ts',
        },
      ]);
      // First contract fails (file not found), second passes
      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
    });
  });
});

// ============================================================================
// Migration sequence validation
// ============================================================================

describe('validateMigrationSequence', () => {
  let repoRoot: string;
  let validator: ContractValidator;

  afterEach(() => {
    if (repoRoot) cleanupRepo(repoRoot);
  });

  /**
   * Create a test repo with migrations on the integration branch.
   */
  function createMigrationRepo(migrationFiles: Record<string, string>): void {
    repoRoot = createTestRepo();
    const migDir = path.join(repoRoot, 'migrations');
    fs.mkdirSync(migDir, { recursive: true });

    for (const [filename, content] of Object.entries(migrationFiles)) {
      fs.writeFileSync(path.join(migDir, filename), content);
    }

    git(repoRoot, 'add .');
    git(repoRoot, 'commit -m "add migrations"');
    validator = new ContractValidator(repoRoot);
  }

  it('passes for contiguous sequence', async () => {
    createMigrationRepo({
      '001_create_users.sql': 'CREATE TABLE users;',
      '002_add_email.sql': 'ALTER TABLE users ADD email;',
      '003_create_orders.sql': 'CREATE TABLE orders;',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(true);
    expect(result.gaps).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(result.renumbered.size).toBe(0);
  });

  it('detects gaps', async () => {
    createMigrationRepo({
      '001_create_users.sql': 'CREATE TABLE users;',
      '003_create_orders.sql': 'CREATE TABLE orders;',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(false);
    expect(result.gaps).toContain(2);
  });

  it('detects duplicates', async () => {
    createMigrationRepo({
      '001_create_users.sql': 'CREATE TABLE users;',
      '001_add_email.sql': 'ALTER TABLE users ADD email;',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(false);
    expect(result.duplicates).toContain(1);
  });

  it('renumbers migrations when duplicates found', async () => {
    createMigrationRepo({
      '001_a.sql': 'A',
      '001_b.sql': 'B',
      '003_c.sql': 'C',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.renumbered.size).toBeGreaterThan(0);

    // Verify the rename happened in git
    const lsOutput = git(repoRoot, 'ls-tree --name-only HEAD migrations/');
    const filenames = lsOutput.split('\n').map((f) => path.basename(f)).sort();
    // After renumbering: 001_a.sql, 002_b.sql, 003_c.sql
    expect(filenames).toContain('001_a.sql');
    expect(filenames).toContain('002_b.sql');
    expect(filenames).toContain('003_c.sql');
  });

  it('renumbering commits to the integration branch', async () => {
    createMigrationRepo({
      '001_a.sql': 'A',
      '001_b.sql': 'B',
    });

    await validator.validateMigrationSequence('req-001', 'migrations');

    // Check latest commit message
    const msg = git(repoRoot, 'log -1 --format=%B');
    expect(msg).toContain('renumber migrations');
    expect(msg).toContain('req-001');
  });

  it('handles no migrations directory', async () => {
    repoRoot = createTestRepo();
    validator = new ContractValidator(repoRoot);

    const result = await validator.validateMigrationSequence('req-001', 'nonexistent');
    expect(result.valid).toBe(true);
    expect(result.gaps).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(result.renumbered.size).toBe(0);
  });

  it('handles migrations with dash separators', async () => {
    createMigrationRepo({
      '001-create_users.sql': 'CREATE TABLE users;',
      '002-add_email.sql': 'ALTER TABLE users ADD email;',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(true);
  });

  it('detects multiple gaps', async () => {
    createMigrationRepo({
      '001_a.sql': 'A',
      '003_b.sql': 'B',
      '006_c.sql': 'C',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(false);
    expect(result.gaps).toContain(2);
    expect(result.gaps).toContain(4);
    expect(result.gaps).toContain(5);
  });

  it('detects multiple duplicates', async () => {
    createMigrationRepo({
      '001_a.sql': 'A',
      '001_b.sql': 'B',
      '002_c.sql': 'C',
      '002_d.sql': 'D',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(false);
    expect(result.duplicates).toContain(1);
    expect(result.duplicates).toContain(2);
  });

  it('does not renumber when sequence is already valid', async () => {
    createMigrationRepo({
      '001_a.sql': 'A',
      '002_b.sql': 'B',
      '003_c.sql': 'C',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.renumbered.size).toBe(0);
  });

  it('single migration is always valid', async () => {
    createMigrationRepo({
      '001_init.sql': 'CREATE TABLE init;',
    });

    const result = await validator.validateMigrationSequence('req-001', 'migrations');
    expect(result.valid).toBe(true);
  });
});
